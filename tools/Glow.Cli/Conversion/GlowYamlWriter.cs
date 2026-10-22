using System.Text;
using System.Text.RegularExpressions;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Glow.Cli.Conversion;

public static partial class GlowYamlWriter
{
    public const int MaximumComponents = 300;
    public const int MaximumBytes = 1_000_000;
    private const int MaximumIconCharacters = 200_000;
    private static readonly HashSet<string> Statuses = new(StringComparer.Ordinal) { "healthy", "warning", "critical" };
    private static readonly HashSet<string> PlanChanges = new(StringComparer.Ordinal)
    {
        "create", "update", "delete", "replace", "read", "forget", "no-change", "ignore",
        "deploy", "no-effect", "unsupported", "unknown",
    };

    public static string Serialize(GlowConfiguration configuration)
    {
        var components = configuration.Dependencies.Concat(configuration.Services).ToArray();
        if (components.Length is 0 or > MaximumComponents)
        {
            throw new ConversionException("A Glow configuration requires 1 to 300 components.");
        }

        var names = new HashSet<string>(StringComparer.Ordinal);
        var nugetNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (component, isPackage) in configuration.Dependencies.Select(node => (node, true))
            .Concat(configuration.Services.Select(node => (node, false))))
        {
            if (string.IsNullOrEmpty(component.Name) || component.Name.Length > 200)
            {
                throw new ConversionException("Each component needs a name of at most 200 characters.");
            }
            if (component.Status is not null && !Statuses.Contains(component.Status))
            {
                throw new ConversionException($"Invalid status for {component.Name}.");
            }
            if (component.PlanChange is not null && !PlanChanges.Contains(component.PlanChange))
            {
                throw new ConversionException($"Invalid planned change for {component.Name}.");
            }
            if (component.ResourceType is { Length: > 200 })
            {
                throw new ConversionException($"Resource type for {component.Name} exceeds 200 characters.");
            }
            if (component.Icon is not null && (component.Icon.Length > MaximumIconCharacters || !DataIcon().IsMatch(component.Icon)))
            {
                throw new ConversionException($"Invalid embedded icon for {component.Name}; only bounded PNG or SVG data icons are supported.");
            }
            var ecosystem = component.Ecosystem ?? "npm";
            if (ecosystem is not ("npm" or "PyPI" or "NuGet"))
            {
                throw new ConversionException($"Unsupported ecosystem: {ecosystem}.");
            }
            var name = component.Name;
            if (isPackage && ecosystem == "NuGet")
            {
                if (!NugetId().IsMatch(name))
                {
                    throw new ConversionException($"Invalid NuGet package ID: {name}.");
                }
                name = name.ToLowerInvariant();
                nugetNames.Add(name);
            }
            if (!names.Add(name))
            {
                throw new ConversionException($"Duplicate component: {name}.");
            }
        }
        foreach (var component in components)
        {
            foreach (var reference in component.Dependencies)
            {
                if (!names.Contains(reference) && !nugetNames.Contains(reference.ToLowerInvariant()))
                {
                    throw new ConversionException($"{component.Name} references unknown component {reference}.");
                }
            }
        }

        var yaml = new SerializerBuilder()
            .WithNamingConvention(CamelCaseNamingConvention.Instance)
            .ConfigureDefaultValuesHandling(DefaultValuesHandling.OmitNull)
            .DisableAliases()
            .WithQuotingNecessaryStrings()
            .Build()
            .Serialize(configuration)
            .ReplaceLineEndings("\n");
        if (Encoding.UTF8.GetByteCount(yaml) > MaximumBytes)
        {
            throw new ConversionException("Generated YAML exceeds Glow's 1 MB import limit.");
        }
        return yaml;
    }

    [GeneratedRegex(@"^[A-Za-z0-9_.-]{1,100}$", RegexOptions.CultureInvariant)]
    private static partial Regex NugetId();

    [GeneratedRegex(@"^data:image/(?:png|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$", RegexOptions.CultureInvariant)]
    private static partial Regex DataIcon();
}
