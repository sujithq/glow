# Configuration and JavaScript API

## YAML schema

The root is an object with `project` (string), `dependencies` (array), and/or `services` (array). At least one component is required.

| Component field | Meaning |
| --- | --- |
| `name` | Required unique string, maximum 200 characters; also used as graph ID |
| `version` | String; exact resolved versions enable OSV queries |
| `ecosystem` | `npm` (default), `PyPI`, or `NuGet`; package provider identifier |
| `status` | `healthy` (default), `warning`, `critical`; `running` maps to healthy |
| `type` | Optional descriptive category |
| `description` | Optional plain text |
| `license` | Optional plain text, otherwise `Unknown` |
| `repository` | Optional public GitHub `owner/repo` for combined commit status |
| `dependencies` | Array of existing component names this component depends on |
| `deprecated` | Optional boolean |
| `vulnerabilities` | Nonnegative integer count or array of `{id, summary?, severity?}` |

Component names must be globally unique, including across ecosystems and services. Unknown references and duplicate names fail validation. Cycles are supported. A component's `kind` is determined by its placement in `dependencies` or `services`.

NuGet package names/IDs are case-insensitive and normalized to lowercase; references to those packages are canonicalized too. IDs contain only ASCII letters, digits, `.`, `_`, or `-`, with a maximum of 100 characters. Duplicate case variants are rejected. Other ecosystems and service names keep their existing case-sensitive identity. Multiple versions of a package cannot coexist under one ID.

NuGet nodes also retain `packageName`, the original package spelling used for advisory queries. An explicitly supplied `packageName` must match the graph name case-insensitively; it cannot redirect a query to a different package. JSON snapshots preserve it.

Duplicate YAML keys and aliases are rejected. The parser accepts only data, never executes tags or input code. Text is inserted using DOM `textContent`, not HTML. User-provided URLs are not used as API endpoints; repository inputs are validated before constructing a fixed GitHub endpoint.

## Parser (`src/parser.js`)

```js
import { parseInput, health, affectedBy } from './src/parser.js';
const graph = parseInput(yamlText, 'glow.config.yaml');
const status = health(graph.nodes[0], 'security');
const consumers = affectedBy(graph, graph.nodes[0].id);
```

- `parseInput(text, filename = 'glow.config.yaml') → Graph`: dispatches YAML, package JSON, requirements text, `.csproj`, `packages.config`, or exported graph JSON; throws on invalid data.
- `normalizeConfig(object) → Graph`: validates and normalizes configuration.
- `parsePackageJson(object) → Graph`, `parseRequirements(text) → Graph`: format-specific conversion.
- `parseNugetManifest(text, filename) → Graph`: static XML conversion for `.csproj` or `packages.config`; normally call through `parseInput()` to enforce the input-size limit.
- `health(node, view = 'health') → 'healthy' | 'warning' | 'critical'`: derives display status. Any reported vulnerability is critical regardless of advisory severity. In Security, only a successful clean scan is green.
- `affectedBy(graph, id) → string[]`: reverse-reachable components, excluding the source; cycle-safe.
- `MAX_INPUT_BYTES`: one million bytes; maximum 300 total components.

`Graph` is `{ project, nodes, edges, refreshedAt? }`. Edges are `{source, target}` meaning “source depends on target.” Nodes contain `id`, `name`, `kind`, `ecosystem`, `version`, `status`, `type`, `description`, `license`, `repository`, `deprecated`, `dependencies`, `advisories`, `vulnerabilityCount`, `scan`, and `errors`.

## Local solution converter (`src/solution-converter.js`)

This Node.js-only module is separate from the browser bundle:

```js
import { convertSolution } from './src/solution-converter.js';
const yamlText = await convertSolution(solutionPath, { target: 'net8.0' });
const graph = parseInput(yamlText);
```

`convertSolution(filename, {target?} = {}) → Promise<string>` reads `.sln`/`.slnx` and local NuGet assets versions 3/4 from each project's default `obj` directory. It returns deterministic YAML validated through `parseInput`, or throws without returning a partial configuration. It performs filesystem reads only, never builds/restores or network requests. Projects are path-qualified service nodes; package IDs retain NuGet spelling and references normalize on import.

The CLI entry point is `cli/glow-solution.js` (`npm run convert:solution -- ...`). It writes validated YAML using exclusive file creation and exits nonzero on errors. See [usage](USAGE.md#local-solution-converter) for target selection, restore prerequisites, and graph limitations.

## Live API (`src/data-fetcher.js`)

```js
import { refreshGraph } from './src/data-fetcher.js';
const controller = new AbortController();
const updated = await refreshGraph(graph, { signal: controller.signal });
```

- `exactVersion(node) → boolean`: explicit npm, Python, and NuGet rules; unknown ecosystems return false. NuGet accepts one to four numeric release segments with optional prerelease/build suffixes. Ranges, brackets, floating versions, and MSBuild properties are not exact versions.
- `enrichNode(node, {fetcher = fetch, signal} = {}) → Promise<Node>`: npm/NuGet metadata, exact-version OSV, and optional GitHub status; clones input and records per-source errors.
- `refreshGraph(graph, options) → Promise<Graph>`: immutable snapshot enrichment, four concurrent workers; request timeout 12 seconds. Aborted queued work rejects.

Scan states: `not checked`, `unresolved version`, `unsupported ecosystem`, `limited coverage`, `unavailable`, `clean`, `findings`. Unsupported ecosystems supplied directly to the enrichment API never query OSV or receive clearance (configuration imports reject them). Empty NuGet responses produce `limited coverage`, never `clean`, because name matching is case-sensitive. Optional live fields: `latest`, `updateAvailable`, `githubStatus`, `checkedAt`. Enriched nodes retain `configuredEvidence` separately, so refreshing a previous API result replaces live findings and GitHub failure states while preserving configured evidence. To change the configured baseline, normalize a new configuration rather than editing an enriched node. JSON snapshot imports intentionally treat their reported findings as configuration and discard old live scan clearance. The browser orchestrator schedules subsequent polls 60 seconds after completion and cancels stale requests when a project changes.

The OSV query is `{package: {name, ecosystem}, version}`. Registry metadata comes from `https://registry.npmjs.org/{encoded-name}/latest`, not an installed-version endpoint: its license/deprecation fields describe the latest release. The version comparison is deliberately only “different from latest,” not a semver upgrade recommendation. GitHub uses `GET /repos/{owner}/{repo}/commits/HEAD/status`; empty status sets do not imply success.

NuGet registry requests use `GET https://api.nuget.org/v3-flatcontainer/{lowercase-id}/index.json`. The ascending version index supplies the last stable version; prereleases are excluded, and prerelease-only indexes leave `latest` empty. NuGet comparison ignores build metadata, case, leading numeric zeros, and omitted/zero revision components. It is still only a difference hint, not an upgrade recommendation. License, description, and deprecation are not inferred from the version index. Requests use the shared timeout/cancellation helper without credentials. The public endpoint was checked with an Origin header and returned `Access-Control-Allow-Origin: *`; CORS/network errors still surface per node.

OSV's [schema](https://github.com/ossf/osv-schema/blob/main/validation/schema.json) recognizes `NuGet`, and its [NuGet implementation](https://github.com/google/osv.dev/blob/master/osv/ecosystems/nuget.py) supports ecosystem version ordering. API failures remain unavailable, not clean; no findings is not proof of safety.

However, OSV's [package lookup](https://github.com/google/osv.dev/blob/902dd4b5c50e0323fe49942d810ac7e21b342c0c/go/internal/database/datastore/vulnerability_matching.go#L181-L211) matches exact package names; its [NuGet helper](https://github.com/google/osv.dev/blob/902dd4b5c50e0323fe49942d810ac7e21b342c0c/go/osv/ecosystem/nuget.go) does not implement package-name normalization. Queries therefore use `packageName` (falling back to `name` for direct API callers), but imported spelling is not guaranteed to match every advisory. Empty results are explicitly partial coverage, not security clearance. This behavior was verified against upstream source; the live OSV endpoint was unreachable from the implementation environment.

## Rendering and iso-glow adapter

`src/iso-glow-adapter.js` exports:

- `renderGraph(svg, graph, {view, selected, affected, layer, search, zoom, onSelect})`
- `createIsoGlowFigure(graph, {onSelect, view} = {})`

The adapter uses an original SVG implementation. The iso-glow authoring contract is a figure object with `id`, `name`, `hint`, `aria`, and `mount(stage, api)`, which may return lifecycle handlers. Glow returns an `unmount()` handler to remove its scene.

To integrate with an **existing installed iso-glow gallery**:

1. Build Glow, or use the prebuilt archive.
2. Copy `assets/iso-glow-adapter.js` and `assets/visualizer.css` beside your gallery.
3. Load the stylesheet. It includes dashboard-level selectors; isolate the gallery in an iframe if you need complete style separation.
4. In the gallery's module script, after its `FIGS` registry is defined and before initial mounting:

```js
import { createIsoGlowFigure } from './assets/iso-glow-adapter.js';
// graph must have Glow's normalized Graph shape.
FIGS.push(createIsoGlowFigure(graph, {
  view: 'health',
  onSelect(id) { console.log('Selected component:', id); },
}));
```

This supplies a figure to iso-glow's gallery lifecycle. It does not use its optional audio, projection helpers, or Three.js path. The main Glow dashboard runs independently. The adapter contract was checked against a [public iso-glow skill copy](https://github.com/irfanfaraaz/claude-kit/blob/main/skills/iso-glow/SKILL.md); compatibility with the currently advertised archive has not been end-to-end verified because that endpoint was unreachable. Follow your installed skill's interface if it differs. Glow does not redistribute upstream implementation code or its templates.

## Skill packaging

`skill-manifest.json` holds Glow's metadata and authoring instructions. `npm run package:skill`:

1. Builds local JS/CSS into `dist/assets`.
2. Creates `dist/skill/glow/SKILL.md` with Claude's name/description frontmatter.
3. Includes the prebuilt app, examples, docs, and MIT license.
4. Archives `glow/` into `dist/downloads/glow.tar.gz`.

The manifest is not an official Claude discovery format; the generated `SKILL.md` is the entry point. No upstream skill installation or remote code execution occurs.
