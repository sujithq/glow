namespace Glow.Cli.Conversion;

public sealed class ConversionService(IEnumerable<IInputConverter> converters)
{
    private readonly IInputConverter[] _converters = converters.ToArray();

    public async Task<string> ConvertAsync(
        string inputPath,
        ConversionOptions options,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var candidates = _converters.Where(converter =>
            converter.FileExtensions.Contains(Path.GetExtension(inputPath), StringComparer.OrdinalIgnoreCase)).ToArray();
        if (candidates.Length != 1)
        {
            throw new ConversionException(candidates.Length == 0
                ? $"No converter supports '{Path.GetExtension(inputPath)}'. Supported inputs: " +
                    string.Join(", ", _converters.SelectMany(converter => converter.FileExtensions).Distinct(StringComparer.OrdinalIgnoreCase)) + "."
                : $"Multiple converters support {inputPath}; registration is ambiguous.");
        }
        var configuration = await candidates[0].ConvertAsync(inputPath, options, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        return GlowYamlWriter.Serialize(configuration);
    }
}
