# Using Glow

For a quick start without leaving the dashboard, choose **User manual** in its header or footer. The built-in manual includes a sample configuration, CLI installation and conversion, graph controls, live-check privacy guidance, saving and reopening snapshots, and troubleshooting. Its expandable sections work without JavaScript.

## Load a project

Use **Import config** for `.yaml`, `.yml`, `.json`, `.txt`, `.csproj`, or `packages.config`, or **Paste config** to choose a format and paste text. Imports are limited to 1 MB and 300 components. Invalid configurations show an error without replacing the current graph. Choosing a new valid configuration disables live polling. For infrastructure plans, first use the .NET CLI to produce the single YAML file; it can embed optional user-supplied Azure icons.

`package.json` merges dependencies, devDependencies, peerDependencies, and optionalDependencies. Duplicate names use the first occurrence in that order, except optionalDependencies override other entries, matching npm's regular/optional precedence. Version ranges are retained, not resolved. No dependency relationships are invented.

`requirements.txt` supports names, extras, exact `==` pins, and simple version specifiers. Names are normalized according to Python package naming conventions. Includes, URLs, editable installs, hashes, line continuations, and environment markers are deliberately rejected. Use YAML for these cases with independently verified resolved package names/versions.

Use `dependencies` inside individual YAML components to model transitive packages and service consumption. All references must point to named components in the same file.

### NuGet / C#

- `.csproj` imports direct, unconditional `PackageReference` entries, including attribute/child versions and version overrides. Bare versions are minimum constraints (`1.2.3` becomes `>=1.2.3`), not restored versions. Exact `[1.2.3]` constraints become bare exact versions. Ranges, floating versions, and `$(Property)` references remain unresolved; missing versions become `*`.
- `packages.config` imports package IDs and installed version strings. IDs become lowercase in both formats. Conflicting duplicate declarations are rejected; no target framework is selected or evaluated.
- Conditions, central `PackageVersion` definitions, unsupported update constructs, and `ProjectReference` entries are rejected. Use explicit YAML service nodes for projects and supply independently verified package versions. No MSBuild execution, file imports/property evaluation, restore, lockfile, or transitive graph resolution occurs.
- The reader accepts plain `PropertyGroup` values and direct `ItemGroup` package references only. Explicit imports, other MSBuild item types/targets, unknown metadata, and namespace-prefixed elements reject with an error; legacy default XML namespaces are supported. Package asset/alias/path/warning metadata is accepted but does not affect the graph. Parent `Directory.Build.props`/`Directory.Packages.props` files are never loaded, so imports are not a complete evaluated project snapshot.
- XML is parsed as data with `fast-xml-parser`; malformed XML, DTD/entity declarations, and non-XML processing instructions are rejected.
- YAML supports `ecosystem: NuGet`; use quoted exact version strings only when independently verified. NuGet package IDs are case-insensitive, normalized lowercase, and globally unique across the graph. Multiple versions/target-framework-specific instances require a richer model and are not supported.
- Refresh sends NuGet package IDs to NuGet.org for the latest stable version and exact versions to OSV for security findings. Registry metadata alone never clears security status. No private feeds or credentials are supported.
- Original NuGet spelling is preserved as `packageName` for OSV queries. OSV's NuGet matching is case-sensitive, so empty results show `limited coverage` and remain yellow in Security; they are never treated as clean scans.

### Local solution converter

Install the `Glow.Cli` .NET tool using the [CLI setup guide](CLI.md). Separately restore your **trusted** solution using your configured NuGet feeds, then run the installed converter:

```powershell
dotnet restore "C:\src\App\App.slnx"
glow convert "C:\src\App\App.slnx" --output "C:\src\App\glow.config.yaml"
```

Upload the resulting file through **Import config**; the browser needs only that YAML, not the solution directory. `.sln` works with the same command. `glow convert --help` shows all options. For a tool-path installation, use the installed executable's full path instead of `glow`. `--output` (`-o`) defaults to `glow.config.yaml` in the current directory and refuses to overwrite an existing file.

The CLI reads solution project paths and existing `obj\project.assets.json` files (assets versions 3 and 4). It makes no network calls, executes no projects, and never restores or builds. Restoring is a separate user action and can execute MSBuild logic; do not restore untrusted projects just to visualize them.

- C#, F#, and Visual Basic projects with PackageReference restore assets are supported. Referenced projects outside the solution are included recursively. Solution folders are organizational only, not graph nodes.
- Each project becomes a service named `project:<solution-relative-project-path>`, with `type: project`. These are project nodes, not claims about deployed services. Path-based names distinguish projects with identical filenames.
- Resolved packages become NuGet nodes with exact versions and original spelling preserved for advisory queries. Project-reference edges, direct project-to-package edges, and package-to-package edges come from restore metadata; transitive packages are not falsely attached as direct project dependencies. Identical package versions are shared across projects, with the union of their declared package edges.
- A project with one restore target uses that target. Multiple frameworks or runtime targets require `--target` (`-t`) with an **exact** key from `targets` in the assets file, such as `net8.0` or `net8.0/win-x64`. Errors list available keys. An explicit target must exist in every included project; the CLI does not guess compatible frameworks or merge target graphs. Without the option, different projects may each use their own sole target.
- Restore the solution locally after dependency, framework, configuration, or central-package changes. Conditions and centrally managed versions are represented only as resolved in those existing assets; the CLI cannot prove that assets are current. Shared/custom intermediate directories are unsupported: each project's assets must be in its default `obj` directory. Legacy `packages.config` projects without these assets and other project types are rejected.
- Missing/malformed assets, restore errors, unsupported assets versions, dangling dependencies, conflicting versions of one package, and browser limits (300 total nodes, 1 MB YAML, component-name limits) fail rather than produce a partial graph. Split a large/conflicting solution or align versions before conversion. No vulnerability findings or live scan clearance are invented.

The output includes project paths and package identities; review it before sharing. Absolute restore paths, feed URLs, credentials, and package-cache paths are not copied into the YAML. Live refresh still uses the dashboard's public services and existing NuGet coverage limitations, including for packages originally restored from private feeds.

NuGet documents the restore graph and its default location in [How NuGet resolves package dependencies](https://learn.microsoft.com/en-us/nuget/concepts/dependency-resolution).

### Terraform and Bicep infrastructure plans

The local .NET tool also converts:

- Terraform JSON from `terraform show -json <plan>`: resource addresses and `change.actions` become service nodes and plan colors; Terraform configuration expression references become dependency edges.
- A compiled ARM template JSON plus Azure what-if JSON: template resources and dependencies become nodes/edges; `changeType` becomes the planned action. What-if-only resources (such as deletions) are included.

See the [CLI guide](CLI.md#convert-terraform-and-bicepazure-plans) for commands, optional Azure icon mapping, and supported change indicators. Glow reads the JSON files locally and never runs Terraform/Bicep/Azure CLI or deploys. Creating a what-if result separately requires Azure permissions equivalent to deployment. Plan output is not a health or security assessment. Resource property bags are omitted, but names and addresses may still reveal infrastructure details; review the generated YAML before sharing.

## Explore

- **Health:** configured healthy/warning/critical status, configured/live findings, metadata differences, deprecation, and API errors.
- **Security:** red for reported findings, green only for a successful exact-version OSV scan with no configured findings, yellow otherwise. NuGet's case-sensitive matching leaves empty results at limited coverage. Services with no package scan remain yellow.
- **Dependency:** neutral green topology; does not indicate security clearance. Vulnerability animations still identify reported risks.
- **Audience:** shortcuts to a useful view, not access control. Developer/Architect select Dependency; DevOps selects Health; Security selects Security.
- **Layer:** show all nodes, packages, or services. Edges with hidden endpoints disappear.
- **Shape:** packages render as compact boxes; services/projects render as taller two-tier towers. Shape identifies component type while color continues to indicate health/security status. The graph legend shows both cues.
- **Plan:** when an imported infrastructure graph contains planned changes, Glow opens in Plan view. Create, update, delete, and replacement actions have distinct colors; other reported actions remain visible. Optional Azure icons are displayed upright without changing their aspect ratio.
- **Find / zoom / reset:** filter components, adjust SVG size, and restore the map.
- **Select:** click or focus a block with Tab and press Enter/Space. The inspector shows versions, license, scan state, findings, configured dependencies, and affected dependents. Dashed outlines identify affected consumers. Hover/focus connections to highlight their source/target relationship.

The graph uses isometric projection, not a movable 3D camera. Maps can scroll horizontally/vertically at larger zoom levels. Reduced-motion preferences disable pulsing.

## Live checks

Choose **Refresh once** to authorize one network update, or enable **Poll every 60 seconds** for repeated updates while the page stays open. Switching configurations cancels outstanding work. Disabling polling cancels the in-flight refresh. A completed refresh replaces the displayed snapshot and gives its time, API error count, and unscanned package count.

Every refresh starts from the original configuration, so previous *live* findings can disappear if a new successful scan no longer reports them. Configured evidence is retained and cannot be cleared by an empty OSV result. Offline errors are never converted to clean security results.

For GitHub checks, set `repository: owner/repo` on a service/package. This queries the combined commit status API, not all Actions check runs. “No commit statuses” is distinct from a passing result.

## Workflows

### Security audit

Use exact installed versions in a YAML snapshot, refresh, select Security, and inspect red/yellow blocks. Follow advisory links and verify fixes in the original advisory. Upgrade validation and exploitability assessment remain external tasks.

### Dependency update impact

Select the package to update and examine **Update / incident blast radius**. Direct and indirect consumers are highlighted, even if the configuration contains cycles. Plan compatibility tests for those consumers; the graph cannot determine whether a version change is safe.

### Onboarding and architecture

Add service names, descriptions, package types, and explicit relationships. Choose Architect and the service layer for a high-level view, then show all components to explain shared libraries.

### Incident response

Mark an affected service `critical` or a package with verified vulnerability evidence in YAML. Follow reverse dependents to identify known affected services. GitHub status failures can supplement this map, but are not live service-health checks.

## Examples and export

- `examples/healthy.config.yaml`: all configured health statuses green; fake package names, no claimed security clearance.
- `examples/vulnerable.config.yaml`: synthetic vulnerable dependency chain for incident mapping.
- `examples/glow.config.yaml`: mixed package ecosystems and service relationships.
- `examples/package.json-example` and `examples/requirements.txt-example`: manifest conversion and unresolved ranges.
- `examples/sample.csproj` and `examples/packages.config`: NuGet declarations versus installed package versions.

All scenario findings are illustrative. Export JSON saves the current graph, findings, scan/error states, and refresh timestamp, if any. Treat exports as potentially sensitive. JSON snapshots can be reimported, but are normalized as configuration: live scan clearance/timestamps are not trusted as a fresh security assessment.
