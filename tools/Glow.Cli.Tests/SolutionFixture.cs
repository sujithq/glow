using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace Glow.Cli.Tests;

internal sealed class SolutionFixture : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), $"glow-tests-{Guid.NewGuid():N}");

    public SolutionFixture() => Directory.CreateDirectory(Root);

    public string ProjectPath(string name, string extension = ".csproj") =>
        Path.Combine(Root, name, Path.GetFileName(name) + extension);

    public async Task<ProjectFixture> ProjectAsync(
        string name, JsonObject? packages = null, string[]? direct = null, string[]? references = null,
        int version = 3, string extension = ".csproj")
    {
        var filename = ProjectPath(name, extension);
        var assetsPath = Path.Combine(Path.GetDirectoryName(filename)!, "obj", "project.assets.json");
        Directory.CreateDirectory(Path.GetDirectoryName(assetsPath)!);
        await File.WriteAllTextAsync(filename, "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        var target = packages?.DeepClone().AsObject() ?? [];
        var libraries = new JsonObject();
        foreach (var package in target)
        {
            libraries.Add(package.Key, new JsonObject { ["type"] = "package" });
        }
        var projectReferences = new JsonObject();
        foreach (var reference in references ?? [])
        {
            var referencePath = ProjectPath(reference);
            var key = $"{Path.GetFileName(reference)}/1.0.0";
            target.Add(key, new JsonObject { ["type"] = "project" });
            libraries.Add(key, new JsonObject
            {
                ["type"] = "project",
                ["msbuildProject"] = Path.GetRelativePath(Path.GetDirectoryName(filename)!, referencePath)
            });
            projectReferences.Add(referencePath, new JsonObject { ["projectPath"] = referencePath });
        }
        var dependencies = new JsonObject();
        foreach (var dependency in direct ?? [])
        {
            dependencies.Add(dependency, new JsonObject { ["target"] = "Package", ["version"] = "[1.0.0, )" });
        }
        var assets = new JsonObject
        {
            ["version"] = version,
            ["targets"] = new JsonObject { ["net10.0"] = target },
            ["libraries"] = libraries,
            ["project"] = new JsonObject
            {
                ["restore"] = new JsonObject
                {
                    ["projectPath"] = filename,
                    ["frameworks"] = new JsonObject { ["net10.0"] = new JsonObject { ["projectReferences"] = projectReferences } }
                },
                ["frameworks"] = new JsonObject
                {
                    ["net10.0"] = new JsonObject { ["targetAlias"] = "net10.0", ["dependencies"] = dependencies }
                }
            }
        };
        var fixture = new ProjectFixture(filename, assetsPath, assets);
        await fixture.SaveAsync();
        return fixture;
    }

    public async Task<string> SolutionAsync(string[] projects, string format = "slnx", string extension = ".csproj")
    {
        var filename = Path.Combine(Root, $"Sample.{format}");
        var paths = projects.Select(name => Path.GetRelativePath(Root, ProjectPath(name, extension))).ToArray();
        var source = format.Equals("sln", StringComparison.OrdinalIgnoreCase)
            ? "Microsoft Visual Studio Solution File, Format Version 12.00\n" +
              "Project(\"{2150E333-8FDC-42A3-9474-1A3956D46DE8}\") = \"src\", \"src\", \"{folder}\"\nEndProject\n" +
              string.Join('\n', paths.Select(project =>
                  $"Project(\"{{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}}\") = \"Project\", \"{project.Replace('/', '\\')}\", \"{{id}}\"\nEndProject"))
            : new XElement("Solution",
                new XElement("Folder", new XAttribute("Name", "/src/"),
                    paths.Select(project => new XElement("Project", new XAttribute("Path", project.Replace('\\', '/')))))).ToString();
        await File.WriteAllTextAsync(filename, source);
        return filename;
    }

    public void Dispose() => Directory.Delete(Root, recursive: true);

    public static JsonObject Packages(string version = "2.1.0") => new()
    {
        [$"Logging/{version}"] = new JsonObject
        {
            ["type"] = "package",
            ["dependencies"] = new JsonObject { ["Logging.Abstractions"] = "1.2.0" }
        },
        ["Logging.Abstractions/1.2.0"] = new JsonObject { ["type"] = "package" }
    };
}

internal sealed record ProjectFixture(string Filename, string AssetsPath, JsonObject Assets)
{
    public Task SaveAsync() => File.WriteAllTextAsync(AssetsPath, Assets.ToJsonString());
}
