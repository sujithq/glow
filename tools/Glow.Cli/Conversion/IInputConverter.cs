namespace Glow.Cli.Conversion;

public sealed record ConversionOptions(
    string? Target = null,
    string? WhatIfPath = null,
    string? IconMapPath = null);

public interface IInputConverter
{
    IReadOnlyCollection<string> FileExtensions { get; }

    Task<GlowConfiguration> ConvertAsync(
        string inputPath,
        ConversionOptions options,
        CancellationToken cancellationToken = default);
}
