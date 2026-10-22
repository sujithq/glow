using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Glow.Cli.Conversion;

public sealed partial class InfrastructurePlanConverter : IInputConverter
{
    private const int MaximumInputBytes = 25_000_000;
    private const int MaximumIconBytes = 100_000;
    private const int MaximumIconMapBytes = 100_000;
    private const int MaximumSvgCharacters = 100_000;
    private const int MaximumNestedDeploymentDepth = 10;
    private static readonly IReadOnlyDictionary<string, string> AzureTerraformTypes =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["azurerm_resource_group"] = "Microsoft.Resources/resourceGroups",
            ["azurerm_storage_account"] = "Microsoft.Storage/storageAccounts",
            ["azurerm_storage_container"] = "Microsoft.Storage/storageAccounts/blobServices/containers",
            ["azurerm_virtual_network"] = "Microsoft.Network/virtualNetworks",
            ["azurerm_subnet"] = "Microsoft.Network/virtualNetworks/subnets",
            ["azurerm_network_security_group"] = "Microsoft.Network/networkSecurityGroups",
            ["azurerm_network_interface"] = "Microsoft.Network/networkInterfaces",
            ["azurerm_public_ip"] = "Microsoft.Network/publicIPAddresses",
            ["azurerm_linux_virtual_machine"] = "Microsoft.Compute/virtualMachines",
            ["azurerm_windows_virtual_machine"] = "Microsoft.Compute/virtualMachines",
            ["azurerm_key_vault"] = "Microsoft.KeyVault/vaults",
            ["azurerm_app_service_plan"] = "Microsoft.Web/serverfarms",
            ["azurerm_service_plan"] = "Microsoft.Web/serverfarms",
            ["azurerm_linux_web_app"] = "Microsoft.Web/sites",
            ["azurerm_windows_web_app"] = "Microsoft.Web/sites",
            ["azurerm_linux_function_app"] = "Microsoft.Web/sites",
            ["azurerm_windows_function_app"] = "Microsoft.Web/sites",
            ["azurerm_cosmosdb_account"] = "Microsoft.DocumentDB/databaseAccounts",
            ["azurerm_mssql_server"] = "Microsoft.Sql/servers",
            ["azurerm_mssql_database"] = "Microsoft.Sql/servers/databases",
            ["azurerm_kubernetes_cluster"] = "Microsoft.ContainerService/managedClusters",
            ["azurerm_servicebus_namespace"] = "Microsoft.ServiceBus/namespaces",
            ["azurerm_redis_cache"] = "Microsoft.Cache/Redis",
            ["azurerm_log_analytics_workspace"] = "Microsoft.OperationalInsights/workspaces",
            ["azurerm_application_insights"] = "Microsoft.Insights/components",
            ["azurerm_container_registry"] = "Microsoft.ContainerRegistry/registries",
            ["azurerm_cognitive_account"] = "Microsoft.CognitiveServices/accounts",
        };

    public IReadOnlyCollection<string> FileExtensions { get; } = Array.AsReadOnly([".json"]);

    public async Task<GlowConfiguration> ConvertAsync(
        string inputPath, ConversionOptions options, CancellationToken cancellationToken = default)
    {
        if (!inputPath.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            throw new ConversionException("Infrastructure plans and ARM templates must be JSON files.");
        }
        if (!File.Exists(inputPath))
        {
            throw new FileNotFoundException($"Input file not found: {inputPath}", inputPath);
        }
        using var document = await ReadJsonAsync(inputPath, cancellationToken);
        var root = document.RootElement;
        var icons = await ReadIconMapAsync(options.IconMapPath, cancellationToken);

        if (TryProperty(root, "resource_changes", out _))
        {
            if (options.WhatIfPath is not null)
            {
                throw new ConversionException("--what-if is only valid with an ARM template JSON input.");
            }
            return await ConvertTerraformAsync(root, Path.GetFileNameWithoutExtension(inputPath), icons, cancellationToken);
        }

        if (TryProperty(root, "resources", out var resources)
            && resources.ValueKind is JsonValueKind.Array or JsonValueKind.Object
            && TryProperty(root, "$schema", out _))
        {
            return await ConvertArmTemplateAsync(
                root, resources, Path.GetFileNameWithoutExtension(inputPath), options.WhatIfPath, icons, cancellationToken);
        }

        throw new ConversionException("JSON input is not a Terraform plan or compiled ARM template.");
    }

    private static async Task<GlowConfiguration> ConvertTerraformAsync(
        JsonElement root, string project, IReadOnlyDictionary<string, string> icons, CancellationToken cancellationToken)
    {
        var formatVersion = RequiredText(root, "format_version", "Terraform plan");
        if (!int.TryParse(formatVersion.Split('.')[0], out var majorVersion) || majorVersion != 1)
        {
            throw new ConversionException($"Unsupported Terraform plan JSON format version: {formatVersion}.");
        }
        if (TryProperty(root, "errored", out var errored) && errored.ValueKind == JsonValueKind.True)
        {
            throw new ConversionException("Terraform plan reports an error and cannot be visualized.");
        }
        var changes = Property(root, "resource_changes");
        if (changes.ValueKind != JsonValueKind.Array)
        {
            throw new ConversionException("Terraform plan is missing its resource_changes array.");
        }

        var resources = new List<ResourceRecord>();
        foreach (var change in changes.EnumerateArray())
        {
            cancellationToken.ThrowIfCancellationRequested();
            var address = RequiredText(change, "address", "Terraform resource change");
            var type = RequiredText(change, "type", address);
            var mode = OptionalText(change, "mode") ?? "managed";
            if (mode is not ("managed" or "data"))
            {
                throw new ConversionException($"{address}: unsupported Terraform resource mode '{mode}'.");
            }
            var actions = Property(Property(change, "change"), "actions");
            if (actions.ValueKind != JsonValueKind.Array || actions.GetArrayLength() == 0
                || actions.EnumerateArray().Any(action => action.ValueKind != JsonValueKind.String))
            {
                throw new ConversionException($"{address}: Terraform change has invalid actions.");
            }
            var addressKey = OptionalText(change, "deposed") is { } deposed
                ? $"{address} (deposed {deposed})" : address;
            var resourceType = AzureTerraformTypes.GetValueOrDefault(type);
            resources.Add(new ResourceRecord
            {
                Name = addressKey,
                Address = address,
                Type = type,
                ResourceType = resourceType,
                Description = $"{(mode == "data" ? "Terraform data source" : "Terraform resource")} · {type}",
                PlanChange = TerraformAction(actions),
            });
        }
        if (resources.Count == 0)
        {
            throw new ConversionException("Terraform plan contains no resource changes.");
        }
        if (resources.Count > GlowYamlWriter.MaximumComponents)
        {
            throw new ConversionException("Maximum 300 components.");
        }

        var configuration = Property(root, "configuration");
        var references = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        CollectTerraformReferences(Property(configuration, "root_module"), references);
        foreach (var source in resources)
        {
            if (!references.TryGetValue(source.Address, out var referencesForSource))
            {
                continue;
            }
            foreach (var reference in referencesForSource)
            {
                var targets = resources.Where(candidate =>
                    !candidate.Name.Contains(" (deposed ", StringComparison.Ordinal)
                    && candidate.Address != source.Address
                    && IsTerraformReference(reference, candidate.Address));
                foreach (var target in targets)
                {
                    source.Dependencies.Add(target.Name);
                }
            }
        }

        await AttachIconsAsync(resources, icons, cancellationToken);
        return new GlowConfiguration(project, [], resources.Select(ToComponent).ToArray());
    }

    private static void CollectTerraformReferences(JsonElement module, IDictionary<string, HashSet<string>> references)
    {
        var resources = Property(module, "resources");
        if (resources.ValueKind == JsonValueKind.Array)
        {
            foreach (var resource in resources.EnumerateArray())
            {
                var address = OptionalText(resource, "address");
                if (address is null)
                {
                    continue;
                }
                var values = new HashSet<string>(StringComparer.Ordinal);
                CollectReferences(Property(resource, "expressions"), values);
                references[address] = values;
            }
        }
        var modules = Property(module, "child_modules");
        if (modules.ValueKind == JsonValueKind.Array)
        {
            foreach (var child in modules.EnumerateArray())
            {
                CollectTerraformReferences(child, references);
            }
        }
    }

    private static void CollectReferences(JsonElement element, ISet<string> references)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (property.NameEquals("references") && property.Value.ValueKind == JsonValueKind.Array)
                {
                    foreach (var reference in property.Value.EnumerateArray())
                    {
                        if (reference.ValueKind == JsonValueKind.String)
                        {
                            references.Add(reference.GetString()!);
                        }
                    }
                }
                else
                {
                    CollectReferences(property.Value, references);
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                CollectReferences(item, references);
            }
        }
    }

    private static string TerraformAction(JsonElement actions)
    {
        var values = actions.EnumerateArray().Select(action => action.GetString()!).ToHashSet(StringComparer.Ordinal);
        if (values.Contains("create") && values.Contains("delete")) return "replace";
        if (values.Contains("create")) return "create";
        if (values.Contains("delete")) return "delete";
        if (values.Contains("update")) return "update";
        if (values.Contains("read")) return "read";
        if (values.Contains("forget")) return "forget";
        if (values.Contains("no-op")) return "no-change";
        return "unknown";
    }

    private static bool IsTerraformReference(string reference, string address)
    {
        var normalizedReference = TerraformInstanceKey().Replace(reference, "");
        var normalizedAddress = TerraformInstanceKey().Replace(address, "");
        return normalizedReference.Equals(normalizedAddress, StringComparison.Ordinal)
            || normalizedReference.StartsWith(normalizedAddress + ".", StringComparison.Ordinal);
    }

    private static async Task<GlowConfiguration> ConvertArmTemplateAsync(
        JsonElement root, JsonElement rootResources, string project, string? whatIfPath,
        IReadOnlyDictionary<string, string> icons, CancellationToken cancellationToken)
    {
        var resources = new List<ResourceRecord>();
        CollectArmTemplate(rootResources, resources, depth: 0);
        if (resources.Count == 0 && whatIfPath is null)
        {
            throw new ConversionException("ARM template contains no resources.");
        }

        if (whatIfPath is not null)
        {
            using var whatIf = await ReadJsonAsync(whatIfPath, cancellationToken);
            ApplyWhatIf(whatIf.RootElement, resources);
        }
        if (resources.Count == 0)
        {
            throw new ConversionException("ARM template and what-if result contain no resources.");
        }
        if (resources.Count > GlowYamlWriter.MaximumComponents)
        {
            throw new ConversionException("Maximum 300 components.");
        }
        AddArmDependencies(resources);
        await AttachIconsAsync(resources, icons, cancellationToken);
        return new GlowConfiguration(project, [], resources.Select(ToComponent).ToArray());
    }

    // Supports classic resource arrays and languageVersion 2.0 symbolic-name objects. Inline nested
    // deployments (Bicep modules) are flattened into their deployed resources.
    private static List<ResourceRecord> CollectArmTemplate(JsonElement templateResources, List<ResourceRecord> all, int depth)
    {
        if (depth > MaximumNestedDeploymentDepth)
        {
            throw new ConversionException($"ARM template nests resources more than {MaximumNestedDeploymentDepth} levels deep.");
        }
        var symbols = new Dictionary<string, List<ResourceRecord>>(StringComparer.OrdinalIgnoreCase);
        var pending = new List<(List<ResourceRecord> Records, List<string> Dependencies, bool IsDeployment)>();
        var collected = new List<ResourceRecord>();
        foreach (var (symbol, element) in EnumerateArmResources(templateResources))
        {
            if (Property(element, "existing").ValueKind == JsonValueKind.True)
            {
                continue;
            }
            var type = RequiredText(element, "type", symbol is null ? "ARM resource" : $"ARM resource '{symbol}'");
            var versionSeparator = type.IndexOf('@');
            if (versionSeparator >= 0)
            {
                type = type[..versionSeparator];
            }
            var dependencies = StringArray(Property(element, "dependsOn"), $"{symbol ?? type}.dependsOn");
            var innerResources = Property(Property(Property(element, "properties"), "template"), "resources");
            List<ResourceRecord> records;
            var isDeployment = type.Equals("Microsoft.Resources/deployments", StringComparison.OrdinalIgnoreCase)
                && innerResources.ValueKind is JsonValueKind.Array or JsonValueKind.Object;
            if (isDeployment)
            {
                records = CollectArmTemplate(innerResources, all, depth + 1);
            }
            else
            {
                var name = RequiredText(element, "name", type);
                var record = new ResourceRecord
                {
                    Name = $"{type}/{name}",
                    Address = $"{type}/{name}",
                    Type = type,
                    ResourceType = type,
                    Description = $"Azure resource · {type}",
                    PlanChange = "unknown",
                    RawName = name,
                    IsCopy = Property(element, "copy").ValueKind == JsonValueKind.Object,
                };
                all.Add(record);
                records = [record];
                var nested = Property(element, "resources");
                if (nested.ValueKind == JsonValueKind.Array)
                {
                    collected.AddRange(CollectArmTemplate(nested, all, depth + 1));
                }
            }
            collected.AddRange(records);
            if (symbol is not null)
            {
                symbols[symbol] = records;
            }
            pending.Add((records, dependencies, isDeployment));
        }

        foreach (var (records, dependencies, isDeployment) in pending)
        {
            // A module's dependencies apply to its entry resources, not to every resource inside it.
            var dependents = isDeployment
                ? records.Where(record => !record.DependencyRecords.Any(records.Contains)).ToList()
                : records;
            foreach (var dependency in dependencies)
            {
                if (symbols.TryGetValue(dependency, out var targets))
                {
                    foreach (var source in dependents)
                    {
                        source.DependencyRecords.UnionWith(targets.Where(target => !ReferenceEquals(source, target)));
                    }
                }
                else
                {
                    foreach (var source in dependents)
                    {
                        source.RawDependencies.Add(dependency);
                    }
                }
            }
        }
        return collected;
    }

    private static IEnumerable<(string? Symbol, JsonElement Element)> EnumerateArmResources(JsonElement resources) =>
        resources.ValueKind switch
        {
            JsonValueKind.Array => resources.EnumerateArray().Select(element => ((string?)null, element)),
            JsonValueKind.Object => resources.EnumerateObject().Select(property => ((string?)property.Name, property.Value)),
            _ => throw new ConversionException("ARM template resources must be an array or a symbolic-name object."),
        };

    private static void AddArmDependencies(IReadOnlyCollection<ResourceRecord> resources)
    {
        foreach (var source in resources)
        {
            foreach (var dependency in source.RawDependencies)
            {
                var matches = resources.Where(candidate => !ReferenceEquals(source, candidate)
                        && dependency.Contains(candidate.Type, StringComparison.OrdinalIgnoreCase)
                        && dependency.Contains(NormalizeArmExpression(candidate.RawName), StringComparison.OrdinalIgnoreCase))
                    .ToArray();
                source.DependencyRecords.UnionWith(matches);
            }
        }
    }

    private static void ApplyWhatIf(JsonElement root, List<ResourceRecord> resources)
    {
        var changes = root.ValueKind == JsonValueKind.Array
            ? root
            : Property(Property(root, "properties"), "changes") is { ValueKind: JsonValueKind.Array } nested
                ? nested
                : Property(root, "changes");
        if (changes.ValueKind != JsonValueKind.Array)
        {
            throw new ConversionException("Azure what-if input must contain a changes array (or be an array itself).");
        }

        var matched = new List<(ResourceRecord Resource, JsonElement Change, string ResourceId)>();
        foreach (var change in changes.EnumerateArray())
        {
            var resourceId = RequiredText(change, "resourceId", "Azure what-if result");
            var changeType = RequiredText(change, "changeType", resourceId);
            var identity = ParseResourceId(resourceId);
            var resource = FindArmResource(resources, identity.Type, identity.Name, resourceId);
            if (resource is null)
            {
                resource = new ResourceRecord
                {
                    Name = $"{identity.Type}/{identity.Name}",
                    Address = resourceId,
                    Type = identity.Type,
                    ResourceType = identity.Type,
                    Description = $"Azure resource · {identity.Type}",
                    PlanChange = "unknown",
                    RawName = identity.Name,
                    CopySource = resources.FirstOrDefault(candidate => candidate.IsCopy
                        && candidate.Type.Equals(identity.Type, StringComparison.OrdinalIgnoreCase)),
                };
                if (resource.CopySource is { } copySource)
                {
                    resource.RawDependencies.AddRange(copySource.RawDependencies);
                    resource.DependencyRecords.UnionWith(copySource.DependencyRecords);
                }
                resources.Add(resource);
            }
            else
            {
                // Show the deployed name instead of the template expression.
                resource.Name = $"{identity.Type}/{identity.Name}";
            }
            resource.MatchedResourceId = resourceId;
            resource.PlanChange = AzureAction(changeType);
            matched.Add((resource, change, resourceId));
        }

        foreach (var (resource, change, resourceId) in matched)
        {
            foreach (var dependencyId in StringArray(Property(change, "dependsOn"), $"{resourceId}.dependsOn"))
            {
                var dependencyIdentity = ParseResourceId(dependencyId);
                var target = resources.FirstOrDefault(candidate =>
                        dependencyId.Equals(candidate.MatchedResourceId, StringComparison.OrdinalIgnoreCase))
                    ?? FindArmResource(resources, dependencyIdentity.Type, dependencyIdentity.Name, dependencyId);
                if (target is not null && !ReferenceEquals(target, resource))
                {
                    resource.DependencyRecords.Add(target);
                }
            }
        }

        foreach (var resource in resources)
        {
            foreach (var copyTemplate in resource.DependencyRecords.Where(dependency => dependency.IsCopy).ToArray())
            {
                resource.DependencyRecords.UnionWith(resources.Where(candidate =>
                    ReferenceEquals(candidate.CopySource, copyTemplate) && !ReferenceEquals(candidate, resource)));
            }
        }
    }

    private static ResourceRecord? FindArmResource(
        IEnumerable<ResourceRecord> resources, string type, string name, string resourceId)
    {
        var typeMatches = resources.Where(resource => resource.Type.Equals(type, StringComparison.OrdinalIgnoreCase)
                && (resource.MatchedResourceId is null
                    || resource.MatchedResourceId.Equals(resourceId, StringComparison.OrdinalIgnoreCase)))
            .ToArray();
        return typeMatches.FirstOrDefault(resource => resource.MatchedResourceId is not null)
            ?? typeMatches.FirstOrDefault(resource =>
                NormalizeArmExpression(resource.RawName).Equals(name, StringComparison.OrdinalIgnoreCase)
                || resource.RawName.Equals(name, StringComparison.OrdinalIgnoreCase))
            ?? (typeMatches.Length == 1 ? typeMatches[0] : null);
    }

    private static (string Type, string Name) ParseResourceId(string resourceId)
    {
        var segments = resourceId.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var providerIndex = Array.FindLastIndex(segments, segment => segment.Equals("providers", StringComparison.OrdinalIgnoreCase));
        if (providerIndex < 0 && segments.Length == 4
            && segments[0].Equals("subscriptions", StringComparison.OrdinalIgnoreCase)
            && segments[2].Equals("resourceGroups", StringComparison.OrdinalIgnoreCase))
        {
            return ("Microsoft.Resources/resourceGroups", segments[3]);
        }
        if (providerIndex < 0 || providerIndex + 2 >= segments.Length)
        {
            throw new ConversionException($"Invalid Azure resource ID in what-if input: {resourceId}.");
        }
        var provider = segments[providerIndex + 1];
        var typeSegments = new List<string>();
        var nameSegments = new List<string>();
        for (var index = providerIndex + 2; index < segments.Length; index++)
        {
            if (typeSegments.Count == nameSegments.Count)
            {
                typeSegments.Add(segments[index]);
            }
            else
            {
                nameSegments.Add(segments[index]);
            }
        }
        if (nameSegments.Count == 0 || typeSegments.Count != nameSegments.Count)
        {
            throw new ConversionException($"Invalid Azure resource ID in what-if input: {resourceId}.");
        }
        return ($"{provider}/{string.Join('/', typeSegments)}", string.Join('/', nameSegments));
    }

    private static string AzureAction(string action) => action.ToLowerInvariant() switch
    {
        "create" => "create",
        "modify" => "update",
        "delete" => "delete",
        "nochange" => "no-change",
        "ignore" => "ignore",
        "deploy" => "deploy",
        "noeffect" => "no-effect",
        "unsupported" => "unsupported",
        _ => "unknown",
    };

    private static string NormalizeArmExpression(string value)
    {
        var normalized = value.Trim();
        if (normalized.StartsWith('[') && normalized.EndsWith(']'))
        {
            normalized = normalized[1..^1];
        }
        return normalized;
    }

    private static async Task AttachIconsAsync(
        IEnumerable<ResourceRecord> resources, IReadOnlyDictionary<string, string> icons, CancellationToken cancellationToken)
    {
        var iconCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var resource in resources)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var iconPath = icons.GetValueOrDefault(resource.ResourceType ?? "")
                ?? icons.GetValueOrDefault(resource.Type);
            if (iconPath is null)
            {
                continue;
            }
            if (!iconCache.TryGetValue(iconPath, out var icon))
            {
                icon = await ReadIconAsync(iconPath, cancellationToken);
                iconCache.Add(iconPath, icon);
            }
            resource.Icon = icon;
        }
    }

    private static async Task<IReadOnlyDictionary<string, string>> ReadIconMapAsync(
        string? mapPath, CancellationToken cancellationToken)
    {
        if (mapPath is null)
        {
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
        var fullMapPath = Path.GetFullPath(mapPath);
        if (!File.Exists(fullMapPath))
        {
            throw new FileNotFoundException($"Icon map not found: {fullMapPath}", fullMapPath);
        }
        if (new FileInfo(fullMapPath).Length > MaximumIconMapBytes)
        {
            throw new ConversionException("Azure icon map exceeds 100 KB.");
        }
        using var document = await ReadJsonAsync(fullMapPath, cancellationToken, MaximumIconMapBytes);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            throw new ConversionException("Azure icon map must be a JSON object from resource type to relative icon path.");
        }
        var baseDirectory = Path.GetDirectoryName(fullMapPath)!;
        var comparer = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var prefix = baseDirectory.EndsWith(Path.DirectorySeparatorChar)
            ? baseDirectory : baseDirectory + Path.DirectorySeparatorChar;
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in document.RootElement.EnumerateObject())
        {
            if (entry.Value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(entry.Name))
            {
                throw new ConversionException("Azure icon map values must be relative SVG/PNG file paths.");
            }
            var relative = entry.Value.GetString()!;
            if (Path.IsPathRooted(relative))
            {
                throw new ConversionException("Azure icon map paths must be relative to the map file.");
            }
            var iconPath = Path.GetFullPath(Path.Combine(baseDirectory, relative));
            if (!iconPath.StartsWith(prefix, comparer))
            {
                throw new ConversionException("Azure icon map paths must stay inside the map file's directory.");
            }
            if (!result.TryAdd(entry.Name, iconPath))
            {
                throw new ConversionException($"Duplicate Azure icon map key: {entry.Name}.");
            }
        }
        return result;
    }

    private static async Task<string> ReadIconAsync(string path, CancellationToken cancellationToken)
    {
        var extension = Path.GetExtension(path);
        if (!extension.Equals(".svg", StringComparison.OrdinalIgnoreCase)
            && !extension.Equals(".png", StringComparison.OrdinalIgnoreCase))
        {
            throw new ConversionException($"Azure icon must be an SVG or PNG file: {path}.");
        }
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"Azure icon file not found: {path}", path);
        }
        var info = new FileInfo(path);
        if (info.Length is 0 or > MaximumIconBytes)
        {
            throw new ConversionException($"Azure icon must be between 1 byte and 100 KB: {path}.");
        }
        var bytes = await File.ReadAllBytesAsync(path, cancellationToken);
        if (extension.Equals(".png", StringComparison.OrdinalIgnoreCase))
        {
            ReadOnlySpan<byte> signature = [137, 80, 78, 71, 13, 10, 26, 10];
            if (!bytes.AsSpan().StartsWith(signature))
            {
                throw new ConversionException($"Invalid PNG icon: {path}.");
            }
            return $"data:image/png;base64,{Convert.ToBase64String(bytes)}";
        }

        try
        {
            using var stream = new MemoryStream(bytes, writable: false);
            using var reader = XmlReader.Create(stream, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
                MaxCharactersInDocument = MaximumSvgCharacters,
            });
            var xml = XDocument.Load(reader);
            var root = xml.Root ?? throw new ConversionException($"SVG icon has no root element: {path}.");
            if (root.Name.LocalName != "svg")
            {
                throw new ConversionException($"SVG icon must have an <svg> root element: {path}.");
            }
            foreach (var element in root.DescendantsAndSelf())
            {
                if (element.Name.LocalName is "script" or "foreignObject" or "iframe" or "object" or "embed" or "audio" or "video")
                {
                    throw new ConversionException($"SVG icon contains active content: {path}.");
                }
                if (element.Name.LocalName == "style"
                    && (UrlReference().IsMatch(element.Value) || CssImport().IsMatch(element.Value)))
                {
                    throw new ConversionException($"SVG icon contains an external stylesheet reference: {path}.");
                }
                foreach (var attribute in element.Attributes())
                {
                    if (attribute.Name.LocalName.StartsWith("on", StringComparison.OrdinalIgnoreCase)
                        || attribute.Name.LocalName is "href" or "src"
                        && !attribute.Value.StartsWith('#')
                        || attribute.Name.LocalName == "style"
                        && UrlReference().IsMatch(attribute.Value)
                        || UrlReference().IsMatch(attribute.Value))
                    {
                        throw new ConversionException($"SVG icon contains an event handler or external reference: {path}.");
                    }
                }
            }
            var safeSvg = Encoding.UTF8.GetBytes(root.ToString(SaveOptions.DisableFormatting));
            if (safeSvg.Length > MaximumIconBytes)
            {
                throw new ConversionException($"Sanitized SVG icon exceeds 100 KB: {path}.");
            }
            return $"data:image/svg+xml;base64,{Convert.ToBase64String(safeSvg)}";
        }
        catch (XmlException exception)
        {
            throw new ConversionException($"Invalid SVG icon '{path}': {exception.Message}");
        }
    }

    private static GlowComponent ToComponent(ResourceRecord resource) => new()
    {
        Name = resource.Name,
        Status = "warning",
        Type = resource.Type,
        Description = resource.Description,
        PlanChange = resource.PlanChange,
        ResourceType = resource.ResourceType,
        Icon = resource.Icon,
        Dependencies = resource.Dependencies
            .Concat(resource.DependencyRecords.Select(dependency => dependency.Name))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray(),
    };

    private static List<string> StringArray(JsonElement element, string label)
    {
        if (element.ValueKind == JsonValueKind.Undefined)
        {
            return [];
        }
        if (element.ValueKind != JsonValueKind.Array
            || element.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String))
        {
            throw new ConversionException($"{label} must be an array of strings.");
        }
        return element.EnumerateArray().Select(item => item.GetString()!).ToList();
    }

    private static async Task<JsonDocument> ReadJsonAsync(
        string path, CancellationToken cancellationToken, int maximumBytes = MaximumInputBytes)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"Input file not found: {path}", path);
        }
        if (new FileInfo(path).Length > maximumBytes)
        {
            throw new ConversionException($"JSON input exceeds {maximumBytes / 1_000_000} MB: {path}.");
        }
        var source = await File.ReadAllTextAsync(path, cancellationToken);
        return JsonDocument.Parse(source, new JsonDocumentOptions { MaxDepth = 64 });
    }

    private static JsonElement Property(JsonElement element, string name) =>
        TryProperty(element, name, out var value) ? value : default;

    private static bool TryProperty(JsonElement element, string name, out JsonElement value)
    {
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out value))
        {
            return true;
        }
        value = default;
        return false;
    }

    private static string RequiredText(JsonElement element, string name, string context)
    {
        var value = OptionalText(element, name);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ConversionException($"{context}: missing or invalid '{name}'.");
        }
        return value;
    }

    private static string? OptionalText(JsonElement element, string name) =>
        Property(element, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    [GeneratedRegex(@"url\(\s*(?!#)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UrlReference();

    [GeneratedRegex(@"\[[^\]]*\]", RegexOptions.CultureInvariant)]
    private static partial Regex TerraformInstanceKey();

    [GeneratedRegex(@"@import\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CssImport();

    private sealed class ResourceRecord
    {
        public required string Name { get; set; }
        public required string Address { get; init; }
        public required string Type { get; init; }
        public string? ResourceType { get; init; }
        public required string Description { get; init; }
        public required string PlanChange { get; set; }
        public string RawName { get; init; } = "";
        public List<string> RawDependencies { get; init; } = [];
        public HashSet<string> Dependencies { get; } = new(StringComparer.Ordinal);
        // Record references stay correct when what-if later replaces a template expression name.
        public HashSet<ResourceRecord> DependencyRecords { get; } = new(ReferenceEqualityComparer.Instance);
        public bool IsCopy { get; init; }
        public ResourceRecord? CopySource { get; init; }
        public string? MatchedResourceId { get; set; }
        public string? Icon { get; set; }
    }
}
