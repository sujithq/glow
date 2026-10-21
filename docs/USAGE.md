# Using Glow

## Load a project

Use **Import config** for `.yaml`, `.yml`, `.json`, or `.txt`, or **Paste config** to choose a format and paste text. Imports are limited to 1 MB and 300 components. Invalid configurations show an error without replacing the current graph. Choosing a new valid configuration disables live polling.

`package.json` merges dependencies, devDependencies, peerDependencies, and optionalDependencies. Duplicate names use the first occurrence in that order, except optionalDependencies override other entries, matching npm's regular/optional precedence. Version ranges are retained, not resolved. No dependency relationships are invented.

`requirements.txt` supports names, extras, exact `==` pins, and simple version specifiers. Names are normalized according to Python package naming conventions. Includes, URLs, editable installs, hashes, line continuations, and environment markers are deliberately rejected. Use YAML for these cases with independently verified resolved package names/versions.

Use `dependencies` inside individual YAML components to model transitive packages and service consumption. All references must point to named components in the same file.

## Explore

- **Health:** configured healthy/warning/critical status, configured/live findings, metadata differences, deprecation, and API errors.
- **Security:** red for reported findings, green only for a successful exact-version OSV scan with no configured findings, yellow otherwise. Services with no package scan remain yellow.
- **Dependency:** neutral green topology; does not indicate security clearance. Vulnerability animations still identify reported risks.
- **Audience:** shortcuts to a useful view, not access control. Developer/Architect select Dependency; DevOps selects Health; Security selects Security.
- **Layer:** show all nodes, packages, or services. Edges with hidden endpoints disappear.
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

All scenario findings are illustrative. Export JSON saves the current graph, findings, scan/error states, and refresh timestamp, if any. Treat exports as potentially sensitive. JSON snapshots can be reimported, but are normalized as configuration: live scan clearance/timestamps are not trusted as a fresh security assessment.
