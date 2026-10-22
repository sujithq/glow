using System.Text.Json.Nodes;
using System.Xml;
using Glow.Cli.Conversion;

namespace Glow.Cli.Tests;

public sealed class DotnetSolutionConverterTests
{
    private readonly DotnetSolutionConverter _converter = new();

    [Theory]
    [InlineData("sln", 3)]
    [InlineData("slnx", 4)]
    [InlineData("SLN", 4)]
    [InlineData("SLNX", 3)]
    public async Task ConvertsProjectAndTransitivePackageEdges(string format, int assetsVersion)
    {
        using var fixture = new SolutionFixture();
        await fixture.ProjectAsync(Path.Combine("src", "Core"), SolutionFixture.Packages(), ["Logging"], version: assetsVersion);
        await fixture.ProjectAsync("App", SolutionFixture.Packages(), references: [Path.Combine("src", "Core")]);
        var solution = await fixture.SolutionAsync(["App"], format);

        var graph = await _converter.ConvertAsync(solution, new());

        Assert.Equal("Sample", graph.Project);
        Assert.Equal(2, graph.Services.Count);
        Assert.Equal(2, graph.Dependencies.Count);
        Assert.Equal("Logging", graph.Dependencies[0].Name);
        Assert.Equal("2.1.0", graph.Dependencies[0].Version);
        Assert.Equal("NuGet", graph.Dependencies[0].Ecosystem);
        Assert.Equal(["logging.abstractions"], graph.Dependencies[0].Dependencies);
        Assert.Equal(["project:src/Core/Core.csproj"], graph.Services[0].Dependencies);
        Assert.Equal(["logging"], graph.Services[1].Dependencies);
        var yaml = GlowYamlWriter.Serialize(graph);
        Assert.DoesNotContain(fixture.Root, yaml);
        Assert.Equal(yaml, GlowYamlWriter.Serialize(await _converter.ConvertAsync(solution, new())));
    }

    [Theory]
    [InlineData(".csproj")]
    [InlineData(".fsproj")]
    [InlineData(".vbproj")]
    public async Task SupportsManagedProjectTypes(string extension)
    {
        using var fixture = new SolutionFixture();
        await fixture.ProjectAsync("App", extension: extension);
        var graph = await _converter.ConvertAsync(await fixture.SolutionAsync(["App"], extension: extension), new());
        Assert.Single(graph.Services);
    }

    [Fact]
    public async Task PreservesDuplicateProjectFilenamesAndDeduplicatesRepeatedEntries()
    {
        using var fixture = new SolutionFixture();
        var one = Path.Combine("one", "Common");
        var two = Path.Combine("two", "Common");
        await fixture.ProjectAsync(one);
        await fixture.ProjectAsync(two);
        var graph = await _converter.ConvertAsync(await fixture.SolutionAsync([one, two, one]), new());
        Assert.Equal(["project:one/Common/Common.csproj", "project:two/Common/Common.csproj"], graph.Services.Select(node => node.Name));
    }

    [Fact]
    public async Task RequiresExactTargetWhenFrameworkOrRuntimeIsAmbiguous()
    {
        using var fixture = new SolutionFixture();
        var project = await fixture.ProjectAsync("App");
        project.Assets["targets"]!["net10.0/win-x64"] = new JsonObject { ["Native/1.0.0"] = new JsonObject { ["type"] = "package" } };
        project.Assets["libraries"]!["Native/1.0.0"] = new JsonObject { ["type"] = "package" };
        await project.SaveAsync();
        var solution = await fixture.SolutionAsync(["App"]);
        var error = await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(solution, new()));
        Assert.Contains("net10.0/win-x64", error.Message);
        Assert.Contains("--target", error.Message);
        Assert.Empty((await _converter.ConvertAsync(solution, new("net10.0"))).Dependencies);
        Assert.Single((await _converter.ConvertAsync(solution, new("net10.0/win-x64"))).Dependencies);
        await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(solution, new("missing")));
        await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(solution, new("")));
    }

    [Fact]
    public async Task ExplicitTargetCannotSilentlySelectADifferentReferencedTarget()
    {
        using var fixture = new SolutionFixture();
        await fixture.ProjectAsync("App", references: ["Core"]);
        var core = await fixture.ProjectAsync("Core");
        core.Assets["targets"] = new JsonObject { ["net11.0"] = new JsonObject() };
        core.Assets["project"]!["frameworks"] = new JsonObject { ["net11.0"] = new JsonObject { ["targetAlias"] = "net11.0" } };
        core.Assets["project"]!["restore"]!["frameworks"] = new JsonObject { ["net11.0"] = new JsonObject() };
        await core.SaveAsync();
        var solution = await fixture.SolutionAsync(["App"]);
        Assert.Equal(2, (await _converter.ConvertAsync(solution, new())).Services.Count);
        var error = await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(solution, new("net10.0")));
        Assert.Contains("net10.0", error.Message);
        Assert.Contains("not found", error.Message);
    }

    [Fact]
    public async Task RejectsConflictingPackageVersionsAcrossProjects()
    {
        using var fixture = new SolutionFixture();
        await fixture.ProjectAsync("App", SolutionFixture.Packages("2.1.0"));
        await fixture.ProjectAsync("Core", SolutionFixture.Packages("3.0.0"));
        var solution = await fixture.SolutionAsync(["App", "Core"]);
        var error = await Assert.ThrowsAsync<ConversionException>(() =>
            _converter.ConvertAsync(solution, new()));
        Assert.Contains("Conflicting versions", error.Message);
        Assert.Contains("2.1.0 and 3.0.0", error.Message);
    }

    [Fact]
    public async Task HandlesProjectReferenceCyclesWithoutRecursingForever()
    {
        using var fixture = new SolutionFixture();
        await fixture.ProjectAsync("App", references: ["Core"]);
        await fixture.ProjectAsync("Core", references: ["App"]);
        var graph = await _converter.ConvertAsync(await fixture.SolutionAsync(["App"]), new());
        Assert.Equal(2, graph.Services.Count);
        Assert.All(graph.Services, service => Assert.Single(service.Dependencies));
    }

    [Fact]
    public async Task MissingAssetsRequireRestoreAndMalformedJsonFails()
    {
        using var fixture = new SolutionFixture();
        var project = await fixture.ProjectAsync("App");
        var solution = await fixture.SolutionAsync(["App"]);
        File.Delete(project.AssetsPath);
        var error = await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(solution, new()));
        Assert.Contains("dotnet restore", error.Message);
        await File.WriteAllTextAsync(project.AssetsPath, "{");
        await Assert.ThrowsAnyAsync<System.Text.Json.JsonException>(() => _converter.ConvertAsync(solution, new()));
    }

    [Theory]
    [InlineData("version", "unsupported restore assets version")]
    [InlineData("logs", "restore assets contain errors")]
    [InlineData("foreign", "different project")]
    [InlineData("libraries", "library metadata")]
    [InlineData("frameworks", "missing framework metadata")]
    [InlineData("references", "missing project-reference metadata")]
    [InlineData("targets", "none")]
    [InlineData("type", "unsupported restored library type")]
    [InlineData("projectPath", "missing project path")]
    [InlineData("dangling", "missing from the selected restore target")]
    [InlineData("identity", "Invalid restored library identity")]
    public async Task RejectsInvalidRestoreMetadata(string mutation, string message)
    {
        using var fixture = new SolutionFixture();
        var project = await fixture.ProjectAsync("App");
        switch (mutation)
        {
            case "version": project.Assets["version"] = 99; break;
            case "logs": project.Assets["logs"] = new JsonArray(new JsonObject { ["level"] = "Error" }); break;
            case "foreign": project.Assets["project"]!["restore"]!["projectPath"] = Path.Combine(fixture.Root, "Other.csproj"); break;
            case "libraries": project.Assets["libraries"] = null; break;
            case "frameworks": project.Assets["project"]!["frameworks"] = new JsonObject(); break;
            case "references": project.Assets["project"]!["restore"]!["frameworks"] = new JsonObject(); break;
            case "targets": project.Assets["targets"] = new JsonObject(); break;
            case "type": project.Assets["targets"]!["net10.0"]!["Other/1.0.0"] = new JsonObject { ["type"] = "reference" }; break;
            case "projectPath": project.Assets["targets"]!["net10.0"]!["Other/1.0.0"] = new JsonObject { ["type"] = "project" }; break;
            case "identity": project.Assets["targets"]!["net10.0"]!["Other"] = new JsonObject { ["type"] = "package" }; break;
            case "dangling":
                project.Assets["project"]!["frameworks"]!["net10.0"]!["dependencies"] =
                    new JsonObject { ["Missing"] = new JsonObject { ["target"] = "Package" } };
                break;
        }
        await project.SaveAsync();
        var solution = await fixture.SolutionAsync(["App"]);
        var error = await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(solution, new()));
        Assert.Contains(message, error.Message);
    }

    [Fact]
    public async Task RejectsDanglingTransitiveDependencies()
    {
        using var fixture = new SolutionFixture();
        var packages = new JsonObject
        {
            ["Logging/1.0.0"] = new JsonObject
            {
                ["type"] = "package",
                ["dependencies"] = new JsonObject { ["Missing"] = "1.0.0" }
            }
        };
        await fixture.ProjectAsync("App", packages);
        var solution = await fixture.SolutionAsync(["App"]);
        var error = await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(solution, new()));
        Assert.Contains("Missing", error.Message);
    }

    [Theory]
    [InlineData("<NotSolution />", false)]
    [InlineData("<Solution />", false)]
    [InlineData("<Solution><Project /></Solution>", false)]
    [InlineData("<Solution><Project Path=\"native.vcxproj\" /></Solution>", false)]
    [InlineData("<Solution>", true)]
    [InlineData("<!DOCTYPE Solution [<!ENTITY file SYSTEM \"file:///secret\">]><Solution />", true)]
    public async Task RejectsMalformedOrUnsupportedSolutionXml(string source, bool xmlError)
    {
        using var fixture = new SolutionFixture();
        var filename = Path.Combine(fixture.Root, "Bad.slnx");
        await File.WriteAllTextAsync(filename, source);
        if (xmlError)
        {
            await Assert.ThrowsAsync<XmlException>(() => _converter.ConvertAsync(filename, new()));
        }
        else
        {
            await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(filename, new()));
        }
    }

    [Fact]
    public async Task DoesNotExecuteOrEvaluateProjectContents()
    {
        using var fixture = new SolutionFixture();
        var project = await fixture.ProjectAsync("App");
        await File.WriteAllTextAsync(project.Filename, "This is deliberately not MSBuild XML.");
        Assert.Single((await _converter.ConvertAsync(await fixture.SolutionAsync(["App"]), new())).Services);
    }

    [Theory]
    [InlineData("not a solution")]
    [InlineData("Microsoft Visual Studio Solution File, Format Version 12.00\nProject(broken)")]
    [InlineData("Microsoft Visual Studio Solution File, Format Version 12.00\n")]
    public async Task RejectsInvalidSlnFiles(string source)
    {
        using var fixture = new SolutionFixture();
        var filename = Path.Combine(fixture.Root, "Invalid.sln");
        await File.WriteAllTextAsync(filename, source);
        await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(filename, new()));
    }

    [Fact]
    public async Task StopsWhenTheRestoredGraphExceeds300Components()
    {
        using var fixture = new SolutionFixture();
        var packages = new JsonObject();
        for (var index = 0; index < 300; index++)
        {
            packages.Add($"Package{index}/1.0.0", new JsonObject { ["type"] = "package" });
        }
        await fixture.ProjectAsync("App", packages);
        var solution = await fixture.SolutionAsync(["App"]);
        var error = await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(solution, new()));
        Assert.Contains("300 components", error.Message);
    }

    [Fact]
    public async Task HonorsCancellation()
    {
        using var fixture = new SolutionFixture();
        await fixture.ProjectAsync("App");
        var solution = await fixture.SolutionAsync(["App"]);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            _converter.ConvertAsync(solution, new(), cancellation.Token));
    }
}
