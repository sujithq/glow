namespace Glow.Cli.Conversion;

public sealed record GlowConfiguration(
    string Project,
    IReadOnlyList<GlowComponent> Dependencies,
    IReadOnlyList<GlowComponent> Services);

public sealed record GlowComponent
{
    public required string Name { get; init; }
    public string? Version { get; init; }
    public string? Ecosystem { get; init; }
    public string? Type { get; init; }
    public string? Description { get; init; }
    public IReadOnlyList<string> Dependencies { get; init; } = [];
}

public sealed class ConversionException(string message) : Exception(message);
