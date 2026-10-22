# Glow .NET tool

`Glow.Cli` is a packable .NET tool with the command name `glow`. It uses Spectre.Console and Spectre.Console.Cli for help, argument validation, and terminal output. The tool targets **.NET 10 and .NET 11**; .NET 11 currently requires a matching preview SDK/runtime. It is independent of Node.js and the browser dashboard.

For task-oriented quick starts, see the [tool README](../tools/Glow.Cli/README.md), including [Bicep](../tools/Glow.Cli/README.md#bicep-visualize-planned-azure-changes), [Terraform](../tools/Glow.Cli/README.md#terraform-visualize-a-saved-plan), and [.NET solution](../tools/Glow.Cli/README.md#net-visualize-a-restored-solution) workflows. That end-user README is embedded in new tool packages and used for automated release notes.

## Install from a GitHub release

Install the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) first. Download `Glow.Cli.1.0.0.nupkg` and `SHA256SUMS` from the [CLI v1.0.0 release](https://github.com/sujithq/glow/releases/tag/cli-v1.0.0). The package is framework-dependent and works on Windows, Linux, and macOS with a compatible runtime. .NET 10 is the stable choice; the optional .NET 11 target requires a matching runtime.

For example, in PowerShell:

```powershell
New-Item -ItemType Directory -Path .\glow-release -Force
Invoke-WebRequest https://github.com/sujithq/glow/releases/download/cli-v1.0.0/Glow.Cli.1.0.0.nupkg -OutFile .\glow-release\Glow.Cli.1.0.0.nupkg
Invoke-WebRequest https://github.com/sujithq/glow/releases/download/cli-v1.0.0/SHA256SUMS -OutFile .\glow-release\SHA256SUMS
Get-FileHash .\glow-release\Glow.Cli.1.0.0.nupkg -Algorithm SHA256
Get-Content .\glow-release\SHA256SUMS
```

Compare the hash with the published checksum before installing:

```powershell
dotnet tool install --global Glow.Cli --source .\glow-release --version 1.0.0 --framework net10.0
glow --help
```

The source must be the directory containing the downloaded package. No repository checkout or Node.js installation is needed. On other shells, download the same files and supply your local directory to `--source`. The package is distributed through GitHub Releases, **not published to NuGet.org**.

If `glow` is not found, reopen your terminal and ensure the global tools directory (`%USERPROFILE%\.dotnet\tools` on Windows, `$HOME/.dotnet/tools` on Linux/macOS) is on PATH. To upgrade an existing installation, download the new release and use `dotnet tool update --global Glow.Cli` with its source directory, version, and framework options. `dotnet tool uninstall --global Glow.Cli` removes the global installation.

After installation, convert an input using the commands below, then import the generated YAML into the dashboard. The built-in **User manual** also includes these steps.

## Build and install from source

From the repository root, with a .NET 11 SDK and the .NET 10/11 runtimes installed:

```powershell
dotnet test tools\Glow.slnx -c Release
dotnet pack tools\Glow.Cli\Glow.Cli.csproj -c Release -o artifacts\packages
dotnet tool install Glow.Cli --tool-path artifacts\tools --source artifacts\packages --version 1.0.0
.\artifacts\tools\glow --help
```

The package contains both framework builds; the tool installer chooses a compatible framework. To build and test with **only .NET 10**, append `-p:TargetFrameworks=net10.0` to `dotnet test` and `dotnet pack`. That package contains just the .NET 10 build. To select a framework explicitly while installing, add `--framework net10.0` (or `net11.0` with a compatible runtime).

Dependencies restore through the Microsoft package feed proxy in `tools\NuGet.Config`. The tool itself does not contact this feed or restore the input solution. Source builds remain available independently of the downloadable release; no workflow publishes to a NuGet feed.

For a global installation, replace `--tool-path artifacts\tools` with `--global`. For a repository-local tool manifest, use `dotnet new tool-manifest` in the consuming repository, then `dotnet tool install Glow.Cli --local --source <absolute-package-directory> --version 1.0.0`. Do not commit the package binaries or generated configurations containing private data.

## Convert a solution

Restore a **trusted** solution separately using its configured feeds, then convert its existing assets:

```powershell
dotnet restore "C:\src\App\App.slnx"
glow convert "C:\src\App\App.slnx" --output "C:\src\App\glow.config.yaml"
```

For the source-build tool-path installation, replace `glow` with `.\artifacts\tools\glow`. `.sln` and `.slnx` are supported. Upload the generated YAML with Glow's **Import config** button; the browser does not need the solution directory.

| Option | Meaning |
| --- | --- |
| `<input>` | Local solution path; converter selection is based on file extension |
| `-o`, `--output <file>` | YAML output; defaults to `glow.config.yaml` in the current directory |
| `-t`, `--target <key>` | Exact `targets` key from restore assets, such as `net10.0` or `net10.0/win-x64` |
| `--what-if <file>` | Azure what-if JSON for a compiled ARM template input |
| `--icon-map <file>` | Optional local JSON map of Azure resource types to SVG/PNG icon files |
| `-h`, `--help` | Spectre-generated command help |

Output files are never overwritten. Errors return a nonzero exit code and an explicit message. Cancellation returns exit code 130. Redirected output works without an interactive terminal.

The solution converter reads existing `obj\project.assets.json` files (versions 3 and 4). Projects become path-qualified services; resolved NuGet packages retain exact versions and original ID spelling. Project-reference edges, direct project-to-package edges, and package dependency edges are preserved. Referenced projects outside the solution are included. Nothing executes MSBuild, evaluates project XML, restores, or contacts a network service during conversion.

## Convert Terraform and Bicep/Azure plans

Terraform plans must first be exported locally as JSON. The converter reads the Terraform resource addresses, change actions, and configuration references; it does not copy resource property values into the generated YAML.

```powershell
terraform plan -out=tfplan
terraform show -json tfplan > tfplan.json
glow convert tfplan.json --output glow.config.yaml
```

Terraform resource references become graph edges. Common `azurerm_*` types are mapped to their Azure Resource Manager resource type; other providers remain visible as service nodes but have no Azure icon unless the icon map includes their Terraform resource type.

For Bicep, compile to an ARM template and generate what-if JSON separately:

```powershell
az bicep build --file main.bicep --outfile main.json
az deployment group what-if --resource-group <resource-group> --template-file main.bicep --no-pretty-print --output json > what-if.json
glow convert main.json --what-if what-if.json --output glow.config.yaml
```

The ARM template provides resources and declared dependencies; the what-if result supplies planned actions, including resources scheduled for deletion that are absent from the template. Both classic resource arrays and Bicep's symbolic-name templates (`languageVersion: 2.0`) are supported, at resource-group or subscription scope. Inline module deployments are flattened into the resources they deploy, a module's `dependsOn` is applied to its entry resources, and copy loops expand into one node per instance reported by what-if. Template-linked deployments remain a single deployment node. The converter reads these local files only. It does not run Terraform, Bicep, Azure CLI, contact Azure, or deploy resources. Generating Azure what-if results is a separate Azure operation and requires the same permissions as deployment. Bicep what-if may report `Ignore`, `Deploy`, `NoEffect`, or `Unsupported` when a precise action cannot be predicted; the Plan view preserves those states rather than guessing.

### Optional Azure architecture icons

Glow does not bundle Microsoft's icon pack. Download the official [Azure architecture SVG icons](https://learn.microsoft.com/azure/architecture/icons/) and create a JSON file next to the downloaded icon files. Keys may be Azure resource types or Terraform resource types; values are relative SVG/PNG paths:

```json
{
  "Microsoft.Storage/storageAccounts": "Azure Storage.svg",
  "azurerm_storage_account": "Azure Storage.svg",
  "Microsoft.Web/sites": "Azure App Service.svg"
}
```

Then pass the map to either converter:

```powershell
glow convert main.json --what-if what-if.json --icon-map azure-icons.json
glow convert tfplan.json --icon-map azure-icons.json
```

Icons are embedded as data URLs in the generated YAML so that it remains a single uploadable file. Unmapped resources keep their normal service shape. Local map paths must stay inside the map's directory. Each icon is limited to 100 KB; SVG active content and external references are rejected, and the final YAML still must fit Glow's 1 MB import limit. Icons are shown upright with preserved aspect ratio, not skewed onto the isometric faces. Follow Microsoft's icon terms: use icons as they appear in Azure; don't crop, flip, rotate, distort, or use them to represent your own product.

Review generated configuration before sharing it. Terraform plan JSON and Azure what-if output can contain sensitive environment details even though the converter omits resource property bags; resource names and addresses remain in the graph.

Multiple restore targets require an explicit key available in every included project. Conflicting package versions, missing/invalid assets, unsupported project types, and Glow's browser limits fail instead of generating a partial graph. The CLI cannot verify that assets are current. See [detailed conversion limitations](USAGE.md#local-solution-converter), including custom intermediate directories and privacy.

## Create a CLI release

The [CLI release workflow](../.github/workflows/release-cli.yml) runs on tags matching `cli-v*`. The tag must match the package version in `tools\Glow.Cli\Glow.Cli.csproj`. For example, version `1.0.1` uses tag `cli-v1.0.1`.

Commit the version change and release workflow to the repository before tagging that commit. Then:

```powershell
git tag cli-v1.0.1
git push origin cli-v1.0.1
```

The workflow tests both framework builds, checks browser interoperability, packs and installs the tool, smoke-tests solution conversion, and publishes the `.nupkg` plus `SHA256SUMS` as GitHub release assets. Tags with a prerelease package version create prereleases. It uses the repository's built-in Actions token, with release-write permission scoped to the release job; no NuGet API key is needed.

Update the tool README and manual's versioned download links and installation commands for each release. Publishing to NuGet.org is a separate opt-in setup; a GitHub release does not make `dotnet tool install --global Glow.Cli` work without the downloaded local source.

## Add another input format

Implement `IInputConverter` in `tools\Glow.Cli\Conversion`:

```csharp
public sealed class AnotherConverter : IInputConverter
{
    public IReadOnlyCollection<string> FileExtensions { get; } = [".another"];

    public Task<GlowConfiguration> ConvertAsync(
        string inputPath, ConversionOptions options, CancellationToken cancellationToken = default)
    {
        // Read the input as data and return projects/packages with explicit edges.
        throw new NotImplementedException();
    }
}
```

Register the converter alongside `DotnetSolutionConverter` in `ToolApplication.Create`. `ConversionService` selects exactly one converter, and `GlowYamlWriter` applies shared naming/reference validation, YAML escaping, the 300-component limit, and the 1 MB UTF-8 limit. Adding a converter does not require changing the command or writer. Duplicate extension registrations fail as ambiguous rather than silently choosing one. This is a compile-time extension point, not a dynamic plugin loader.

Unit tests in `tools\Glow.Cli.Tests` cover solution formats, graphs, restore errors, exact limits, YAML serialization, Spectre commands, and a second fake converter. Browser interoperability can be exercised after building:

```powershell
$env:GLOW_CLI_DLL = (Resolve-Path tools\Glow.Cli\bin\Release\net10.0\Glow.Cli.dll).Path
node --test tests\dotnet-cli.test.js
```

The normal `npm test` remains browser-only and skips both CLI interoperability tests unless `GLOW_CLI_DLL` is set. CI runs .NET unit tests on both frameworks, verifies generated solution and infrastructure YAML through the browser parser, and installs the packed tool on Windows and Linux.

## Sources

- [Terraform JSON plan format](https://developer.hashicorp.com/terraform/internals/json-format)
- [Bicep what-if](https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-what-if)
- [Bicep build](https://learn.microsoft.com/azure/azure-resource-manager/bicep/bicep-cli)
- [Bicep resource dependencies](https://learn.microsoft.com/azure/azure-resource-manager/bicep/resource-dependencies)
- [Azure architecture icons and terms](https://learn.microsoft.com/azure/architecture/icons/)
- [.NET tool creation and packaging](https://learn.microsoft.com/en-us/dotnet/core/tools/global-tools-how-to-create)
- [.NET tool installation](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install)
- [NuGet restore dependency graphs](https://learn.microsoft.com/en-us/nuget/concepts/dependency-resolution)
- [Spectre.Console](https://spectreconsole.net/)
- [Spectre.Console.Cli](https://spectreconsole.net/cli/)
- [YamlDotNet](https://github.com/aaubry/YamlDotNet)
