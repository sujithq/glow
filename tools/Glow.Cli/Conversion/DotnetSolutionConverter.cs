using System.Text.Json;

namespace Glow.Cli.Conversion;

public sealed class DotnetSolutionConverter : IInputConverter
{
    public IReadOnlyCollection<string> FileExtensions { get; } = Array.AsReadOnly(new[] { ".sln", ".slnx" });

    public async Task<GlowConfiguration> ConvertAsync(
        string inputPath, ConversionOptions options, CancellationToken cancellationToken = default)
    {
        if (!FileExtensions.Contains(Path.GetExtension(inputPath), StringComparer.OrdinalIgnoreCase))
        {
            throw new ConversionException("Input must be a .sln or .slnx file.");
        }
        if (options.Target is not null && string.IsNullOrWhiteSpace(options.Target))
        {
            throw new ConversionException("Target must be a nonempty restore target key.");
        }
        var solution = Path.GetFullPath(inputPath);
        var directory = Path.GetDirectoryName(solution)!;
        var projects = new Dictionary<string, ProjectState>(
            OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        var packages = new Dictionary<string, PackageState>(StringComparer.OrdinalIgnoreCase);

        async Task<ProjectState> LoadProjectAsync(string filename)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (projects.TryGetValue(filename, out var existing))
            {
                return existing;
            }
            if (!new[] { ".csproj", ".fsproj", ".vbproj" }.Contains(Path.GetExtension(filename), StringComparer.OrdinalIgnoreCase))
            {
                throw new ConversionException($"Unsupported project: {filename}. Only C#, F#, and Visual Basic restore assets are supported.");
            }
            if (!File.Exists(filename))
            {
                throw new FileNotFoundException($"Project not found: {filename}", filename);
            }
            var relative = Path.GetRelativePath(directory, filename).Replace('\\', '/');
            var projectDirectory = Path.GetDirectoryName(filename)!;
            var assetsPath = Path.Combine(projectDirectory, "obj", "project.assets.json");
            if (!File.Exists(assetsPath))
            {
                throw new ConversionException($"Missing {assetsPath}. Run dotnet restore on the solution first (default obj path required).");
            }
            using var document = JsonDocument.Parse(await File.ReadAllTextAsync(assetsPath, cancellationToken));
            var assets = document.RootElement.Clone();
            var version = Property(assets, "version");
            if (version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var assetsVersion) || assetsVersion is not (3 or 4))
            {
                throw new ConversionException($"{relative}: unsupported restore assets version.");
            }
            var logs = Property(assets, "logs");
            if (logs.ValueKind == JsonValueKind.Array && logs.EnumerateArray().Any(log =>
                string.Equals(Text(log, "level"), "error", StringComparison.OrdinalIgnoreCase)))
            {
                throw new ConversionException($"{relative}: restore assets contain errors. Complete a successful dotnet restore first.");
            }
            var metadata = Property(assets, "project");
            var restore = Property(metadata, "restore");
            var restoredPath = Text(restore, "projectPath");
            if (restoredPath is null || !projects.Comparer.Equals(SolutionReader.Resolve(projectDirectory, restoredPath), filename))
            {
                throw new ConversionException($"{relative}: restore assets belong to a different project. Restore locally first.");
            }
            var selected = SelectTarget(assets, options.Target, relative);
            var libraryMetadata = Object(Property(assets, "libraries"), $"{relative} library metadata");
            var project = new ProjectState($"project:{relative}", $"{relative} (restore target: {selected.Name})", selected);
            projects.Add(filename, project);
            if (projects.Count + packages.Count > GlowYamlWriter.MaximumComponents)
            {
                throw new ConversionException("Maximum 300 components.");
            }
            foreach (var libraryEntry in Object(selected.Libraries, $"{relative} target libraries"))
            {
                var separator = libraryEntry.Name.LastIndexOf('/');
                if (separator <= 0 || separator == libraryEntry.Name.Length - 1)
                {
                    throw new ConversionException($"Invalid restored library identity: {libraryEntry.Name}.");
                }
                var name = libraryEntry.Name[..separator];
                var packageVersion = libraryEntry.Name[(separator + 1)..];
                var id = name.ToLowerInvariant();
                if (project.Resolved.ContainsKey(id))
                {
                    throw new ConversionException($"{relative}: duplicate restored library {name}.");
                }
                switch (Text(libraryEntry.Value, "type"))
                {
                    case "package":
                        if (packages.TryGetValue(id, out var package) && package.Version != packageVersion)
                        {
                            throw new ConversionException($"Conflicting versions for {name}: {package.Version} and {packageVersion}. " +
                                "Glow supports only one version per package; convert a smaller solution or align versions.");
                        }
                        if (package is null)
                        {
                            package = new PackageState(name, packageVersion);
                            packages.Add(id, package);
                            if (projects.Count + packages.Count > GlowYamlWriter.MaximumComponents)
                            {
                                throw new ConversionException("Maximum 300 components.");
                            }
                        }
                        project.Resolved.Add(id, new ResolvedLibrary(id, libraryEntry.Value, package));
                        break;
                    case "project":
                        var library = libraryMetadata.FirstOrDefault(entry => entry.Name == libraryEntry.Name).Value;
                        var reference = Text(library, "msbuildProject") ?? Text(library, "path");
                        if (reference is null)
                        {
                            throw new ConversionException($"{relative}: missing project path for {libraryEntry.Name}.");
                        }
                        var referenced = await LoadProjectAsync(SolutionReader.Resolve(projectDirectory, reference));
                        project.Resolved.Add(id, new ResolvedLibrary(referenced.Name, libraryEntry.Value, null));
                        break;
                    default:
                        throw new ConversionException($"{relative}: unsupported restored library type for {libraryEntry.Name}.");
                }
            }
            foreach (var reference in OptionalObject(selected.RestoreFramework, "projectReferences", $"{relative} project references"))
            {
                var referencePath = Text(reference.Value, "projectPath") ?? reference.Name;
                var referenced = await LoadProjectAsync(SolutionReader.Resolve(projectDirectory, referencePath));
                project.Dependencies.Add(referenced.Name);
            }
            return project;
        }

        foreach (var filename in await SolutionReader.ReadAsync(solution, cancellationToken))
        {
            await LoadProjectAsync(filename);
        }
        foreach (var project in projects.Values)
        {
            ResolvedLibrary ResolveDependency(string name) => project.Resolved.TryGetValue(name, out var dependency)
                ? dependency
                : throw new ConversionException($"{project.Name}: dependency {name} is missing from the selected restore target.");

            foreach (var dependency in OptionalObject(project.Target.Framework, "dependencies", $"{project.Name} direct dependencies"))
            {
                if (Text(dependency.Value, "target") != "Package")
                {
                    throw new ConversionException($"{project.Name}: unsupported direct dependency {dependency.Name}.");
                }
                project.Dependencies.Add(ResolveDependency(dependency.Name).Name);
            }
            foreach (var resolved in project.Resolved.Values)
            {
                foreach (var dependency in OptionalObject(resolved.Library, "dependencies", $"{project.Name} library dependencies"))
                {
                    var target = ResolveDependency(dependency.Name);
                    resolved.Package?.Dependencies.Add(target.Name);
                }
            }
        }
        return new GlowConfiguration(
            Path.GetFileNameWithoutExtension(solution),
            packages.Values.OrderBy(package => package.Name, StringComparer.Ordinal).Select(package => new GlowComponent
            {
                Name = package.Name,
                Version = package.Version,
                Ecosystem = "NuGet",
                Dependencies = package.Dependencies.Order(StringComparer.Ordinal).ToArray()
            }).ToArray(),
            projects.Values.OrderBy(project => project.Name, StringComparer.Ordinal).Select(project => new GlowComponent
            {
                Name = project.Name,
                Type = "project",
                Description = project.Description,
                Dependencies = project.Dependencies.Order(StringComparer.Ordinal).ToArray()
            }).ToArray());
    }

    private static SelectedTarget SelectTarget(JsonElement assets, string? requested, string project)
    {
        var targets = Object(Property(assets, "targets"), $"{project} restore targets");
        var selected = requested is null
            ? targets.Length == 1 ? targets[0] : default
            : targets.FirstOrDefault(target => target.Name == requested);
        if (selected.Value.ValueKind == JsonValueKind.Undefined)
        {
            throw new ConversionException($"{project}: {(requested is null ? "multiple restore targets" : $"target \"{requested}\" not found")}. " +
                $"Use --target with one of: {(targets.Length == 0 ? "(none)" : string.Join(", ", targets.Select(target => target.Name)))}.");
        }
        var frameworkName = selected.Name.Split('/')[0];
        var metadata = Property(assets, "project");
        var frameworks = Object(Property(metadata, "frameworks"), $"{project} framework metadata");
        var framework = frameworks.FirstOrDefault(entry => entry.Name == frameworkName || Text(entry.Value, "targetAlias") == frameworkName);
        if (framework.Value.ValueKind == JsonValueKind.Undefined)
        {
            throw new ConversionException($"{project}: missing framework metadata for {selected.Name}.");
        }
        var alias = Text(framework.Value, "targetAlias") ?? framework.Name;
        var restoreFrameworks = Object(Property(Property(metadata, "restore"), "frameworks"), $"{project} project-reference metadata");
        var restoreFramework = restoreFrameworks.FirstOrDefault(entry =>
            entry.Name == framework.Name || entry.Name == alias || Text(entry.Value, "targetAlias") == alias);
        if (restoreFramework.Value.ValueKind == JsonValueKind.Undefined)
        {
            throw new ConversionException($"{project}: missing project-reference metadata for {selected.Name}.");
        }
        return new SelectedTarget(selected.Name, selected.Value, framework.Value, restoreFramework.Value);
    }

    private static JsonElement Property(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) ? value : default;

    private static string? Text(JsonElement element, string name) =>
        Property(element, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    private static JsonProperty[] Object(JsonElement element, string label) =>
        element.ValueKind == JsonValueKind.Object ? element.EnumerateObject().ToArray() : throw new ConversionException($"Invalid {label}.");

    private static JsonProperty[] OptionalObject(JsonElement parent, string name, string label)
    {
        var element = Property(parent, name);
        return element.ValueKind == JsonValueKind.Undefined ? [] : Object(element, label);
    }

    private sealed record SelectedTarget(string Name, JsonElement Libraries, JsonElement Framework, JsonElement RestoreFramework);
    private sealed record ResolvedLibrary(string Name, JsonElement Library, PackageState? Package);
    private sealed record PackageState(string Name, string Version)
    {
        public HashSet<string> Dependencies { get; } = new(StringComparer.Ordinal);
    }
    private sealed record ProjectState(string Name, string Description, SelectedTarget Target)
    {
        public HashSet<string> Dependencies { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, ResolvedLibrary> Resolved { get; } = new(StringComparer.OrdinalIgnoreCase);
    }
}
