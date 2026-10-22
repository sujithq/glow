using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Glow.Cli.Conversion;

internal static partial class SolutionReader
{
    public static async Task<IReadOnlyList<string>> ReadAsync(string filename, CancellationToken cancellationToken)
    {
        var source = await File.ReadAllTextAsync(filename, cancellationToken);
        var projects = new List<string>();
        if (Path.GetExtension(filename).Equals(".sln", StringComparison.OrdinalIgnoreCase))
        {
            if (!source.Contains("Microsoft Visual Studio Solution File", StringComparison.Ordinal))
            {
                throw new ConversionException("Invalid .sln file.");
            }
            foreach (var line in source.Split('\n'))
            {
                if (!line.TrimStart().StartsWith("Project(", StringComparison.Ordinal))
                {
                    continue;
                }
                var match = ProjectEntry().Match(line.TrimEnd('\r'));
                if (!match.Success)
                {
                    throw new ConversionException($"Invalid solution project entry: {line.Trim()}");
                }
                if (!match.Groups[1].Value.Equals("{2150E333-8FDC-42A3-9474-1A3956D46DE8}", StringComparison.OrdinalIgnoreCase))
                {
                    projects.Add(match.Groups[2].Value);
                }
            }
        }
        else
        {
            using var text = new StringReader(source);
            using var reader = XmlReader.Create(text, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null
            });
            var document = XDocument.Load(reader);
            if (document.Root?.Name != "Solution")
            {
                throw new ConversionException("Expected a single Solution XML root.");
            }
            foreach (var element in document.Root.Descendants("Project"))
            {
                var project = (string?)element.Attribute("Path");
                if (string.IsNullOrWhiteSpace(project))
                {
                    throw new ConversionException("Each solution Project requires a Path.");
                }
                projects.Add(project);
            }
        }
        if (projects.Count == 0)
        {
            throw new ConversionException("Solution contains no supported projects.");
        }
        return projects.Select(project => Resolve(Path.GetDirectoryName(filename)!, project)).ToArray();
    }

    internal static string Resolve(string directory, string value) =>
        Path.GetFullPath(Path.Combine(directory, value.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar)));

    [GeneratedRegex("^\\s*Project\\(\"([^\"]+)\"\\)\\s*=\\s*\"[^\"]*\",\\s*\"([^\"]+)\",\\s*\"[^\"]+\"\\s*$", RegexOptions.CultureInvariant)]
    private static partial Regex ProjectEntry();
}
