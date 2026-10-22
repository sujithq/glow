# Glow .NET tool

`Glow.Cli` is a packable .NET tool with the command name `glow`. It uses Spectre.Console and Spectre.Console.Cli for help, argument validation, and terminal output. The tool targets **.NET 10 and .NET 11**; .NET 11 currently requires a matching preview SDK/runtime. It is independent of Node.js and the browser dashboard.

## Build and install from source

From the repository root, with a .NET 11 SDK and the .NET 10/11 runtimes installed:

```powershell
dotnet test tools\Glow.slnx -c Release
dotnet pack tools\Glow.Cli\Glow.Cli.csproj -c Release -o artifacts\packages
dotnet tool install Glow.Cli --tool-path artifacts\tools --source artifacts\packages --version 1.0.0
.\artifacts\tools\glow --help
```

The package contains both framework builds; the tool installer chooses a compatible framework. To build and test with **only .NET 10**, append `-p:TargetFrameworks=net10.0` to `dotnet test` and `dotnet pack`. That package contains just the .NET 10 build. To select a framework explicitly while installing, add `--framework net10.0` (or `net11.0` with a compatible runtime).

Dependencies restore through the Microsoft package feed proxy in `tools\NuGet.Config`. The tool itself does not contact this feed or restore the input solution. The package is built locally; this repository does not automatically publish it to a public feed.

For a global installation, replace `--tool-path artifacts\tools` with `--global`. For a repository-local tool manifest, use `dotnet new tool-manifest` in the consuming repository, then `dotnet tool install Glow.Cli --local --source <absolute-package-directory> --version 1.0.0`. Do not commit the package binaries or generated configurations containing private data.

## Convert a solution

Restore a **trusted** solution separately using its configured feeds, then convert its existing assets:

```powershell
dotnet restore "C:\src\App\App.slnx"
.\artifacts\tools\glow convert "C:\src\App\App.slnx" --output "C:\src\App\glow.config.yaml"
```

After a global installation the command is simply `glow convert ...`. `.sln` and `.slnx` are supported. Upload the generated YAML with Glow's **Import config** button; the browser does not need the solution directory.

| Option | Meaning |
| --- | --- |
| `<input>` | Local solution path; converter selection is based on file extension |
| `-o`, `--output <file>` | YAML output; defaults to `glow.config.yaml` in the current directory |
| `-t`, `--target <key>` | Exact `targets` key from restore assets, such as `net10.0` or `net10.0/win-x64` |
| `-h`, `--help` | Spectre-generated command help |

Output files are never overwritten. Errors return a nonzero exit code and an explicit message. Cancellation returns exit code 130. Redirected output works without an interactive terminal.

The converter reads existing `obj\project.assets.json` files (versions 3 and 4). Projects become path-qualified services; resolved NuGet packages retain exact versions and original ID spelling. Project-reference edges, direct project-to-package edges, and package dependency edges are preserved. Referenced projects outside the solution are included. Nothing executes MSBuild, evaluates project XML, restores, or contacts a network service during conversion.

Multiple restore targets require an explicit key available in every included project. Conflicting package versions, missing/invalid assets, unsupported project types, and Glow's browser limits fail instead of generating a partial graph. The CLI cannot verify that assets are current. See [detailed conversion limitations](USAGE.md#local-solution-converter), including custom intermediate directories and privacy.

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

The normal `npm test` remains browser-only and skips this integration test unless `GLOW_CLI_DLL` is set. CI runs .NET unit tests on both frameworks, verifies YAML through the browser parser, and installs the packed tool on Windows and Linux.

## Sources

- [.NET tool creation and packaging](https://learn.microsoft.com/en-us/dotnet/core/tools/global-tools-how-to-create)
- [.NET tool installation](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install)
- [NuGet restore dependency graphs](https://learn.microsoft.com/en-us/nuget/concepts/dependency-resolution)
- [Spectre.Console](https://spectreconsole.net/)
- [Spectre.Console.Cli](https://spectreconsole.net/cli/)
- [YamlDotNet](https://github.com/aaubry/YamlDotNet)
