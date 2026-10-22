using Glow.Cli.Conversion;
using Spectre.Console.Testing;

namespace Glow.Cli.Tests;

public sealed class ToolApplicationTests
{
    [Theory]
    [InlineData("--help")]
    [InlineData("convert", "--help")]
    public async Task ProvidesSpectreHelp(params string[] args)
    {
        using var console = new TestConsole();
        Assert.Equal(0, await ToolApplication.Create(console).RunAsync(args));
        Assert.Contains("convert", console.Output);
    }

    [Fact]
    public async Task CreatesYamlAndRefusesToOverwrite()
    {
        using var fixture = new SolutionFixture();
        await fixture.ProjectAsync("App");
        var input = await fixture.SolutionAsync(["App"]);
        var output = Path.Combine(fixture.Root, "config [test].yaml");
        using var console = new TestConsole();
        Assert.Equal(0, await ToolApplication.Create(console).RunAsync(["convert", input, "-o", output]));
        var yaml = await File.ReadAllTextAsync(output);
        Assert.Contains("project:App/App.csproj", yaml);
        Assert.Contains("Created", console.Output);
        Assert.Contains("config [test].yaml", console.Output);
        Assert.Equal(1, await ToolApplication.Create(console).RunAsync(["convert", input, "-o", output]));
        Assert.Equal(yaml, await File.ReadAllTextAsync(output));
        Assert.Contains("Glow conversion failed", console.Output);
        Assert.Empty(Directory.GetFiles(fixture.Root, "*.tmp"));
    }

    [Fact]
    public void UsesExpectedDefaultOutputName() => Assert.Equal("glow.config.yaml", new ConvertSettings().Output);

    [Fact]
    public async Task ReportsErrorsOnTheConfiguredErrorConsole()
    {
        using var console = new TestConsole();
        using var errors = new TestConsole();
        Assert.Equal(1, await ToolApplication.Create(console, errors: errors).RunAsync(["convert", "bad.json"]));
        Assert.Empty(console.Output);
        Assert.Contains("No converter supports", errors.Output);
    }

    [Fact]
    public async Task CancellationReturns130WithoutCreatingOutput()
    {
        using var fixture = new SolutionFixture();
        await fixture.ProjectAsync("App");
        var solution = await fixture.SolutionAsync(["App"]);
        var output = Path.Combine(fixture.Root, "cancelled.yaml");
        using var console = new TestConsole();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var exitCode = await ToolApplication.Create(console)
            .RunAsync(["convert", solution, "-o", output], cancellation.Token);
        Assert.Equal(130, exitCode);
        Assert.False(File.Exists(output));
        Assert.Empty(Directory.GetFiles(fixture.Root, "*.tmp"));
    }

    [Fact]
    public async Task FailsWithoutCreatingOutputForInvalidInput()
    {
        using var fixture = new SolutionFixture();
        var output = Path.Combine(fixture.Root, "invalid.yaml");
        using var console = new TestConsole();
        Assert.Equal(1, await ToolApplication.Create(console).RunAsync(["convert", Path.Combine(fixture.Root, "no.json"), "-o", output]));
        Assert.False(File.Exists(output));
        Assert.Contains("No converter supports", console.Output);
        Assert.NotEqual(0, await ToolApplication.Create(console).RunAsync(["convert"]));
        Assert.NotEqual(0, await ToolApplication.Create(console).RunAsync(["convert", "input.slnx", "--unknown"]));
    }

    [Fact]
    public async Task AddingAnotherConverterNeedsNoCommandOrWriterChanges()
    {
        using var fixture = new SolutionFixture();
        var output = Path.Combine(fixture.Root, "custom.yaml");
        var converter = new FakeConverter();
        using var console = new TestConsole();
        Assert.Equal(0, await ToolApplication.Create(console, [new DotnetSolutionConverter(), converter])
            .RunAsync(["convert", "future.CUSTOM", "-o", output]));
        Assert.Contains("project: Future", await File.ReadAllTextAsync(output));
        Assert.True(converter.Called);
    }

    [Fact]
    public async Task AmbiguousRegistrationsAndCancellationFailExplicitly()
    {
        var service = new ConversionService([new FakeConverter(), new FakeConverter()]);
        var error = await Assert.ThrowsAsync<ConversionException>(() => service.ConvertAsync("future.custom", new()));
        Assert.Contains("ambiguous", error.Message);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.ConvertAsync("future.custom", new(), cancellation.Token));
    }

    private sealed class FakeConverter : IInputConverter
    {
        public IReadOnlyCollection<string> FileExtensions { get; } = [".custom"];
        public bool Called { get; private set; }

        public Task<GlowConfiguration> ConvertAsync(string inputPath, ConversionOptions options, CancellationToken cancellationToken = default)
        {
            Called = true;
            return Task.FromResult(new GlowConfiguration("Future", [new GlowComponent { Name = "sample" }], []));
        }
    }
}
