# Configuration and JavaScript API

## YAML schema

The root is an object with `project` (string), `dependencies` (array), and/or `services` (array). At least one component is required.

| Component field | Meaning |
| --- | --- |
| `name` | Required unique string, maximum 200 characters; also used as graph ID |
| `version` | String; exact resolved versions enable OSV queries |
| `ecosystem` | `npm` (default) or `PyPI`; applies to packages |
| `status` | `healthy` (default), `warning`, `critical`; `running` maps to healthy |
| `type` | Optional descriptive category |
| `description` | Optional plain text |
| `license` | Optional plain text, otherwise `Unknown` |
| `repository` | Optional public GitHub `owner/repo` for combined commit status |
| `dependencies` | Array of existing component names this component depends on |
| `deprecated` | Optional boolean |
| `vulnerabilities` | Nonnegative integer count or array of `{id, summary?, severity?}` |

Component names must be globally unique, including across ecosystems and services. Unknown references and duplicate names fail validation. Cycles are supported. A component's `kind` is determined by its placement in `dependencies` or `services`.

Duplicate YAML keys and aliases are rejected. The parser accepts only data, never executes tags or input code. Text is inserted using DOM `textContent`, not HTML. User-provided URLs are not used as API endpoints; repository inputs are validated before constructing a fixed GitHub endpoint.

## Parser (`src/parser.js`)

```js
import { parseInput, health, affectedBy } from './src/parser.js';
const graph = parseInput(yamlText, 'glow.config.yaml');
const status = health(graph.nodes[0], 'security');
const consumers = affectedBy(graph, graph.nodes[0].id);
```

- `parseInput(text, filename = 'glow.config.yaml') → Graph`: dispatches YAML, package JSON, requirements text, or exported graph JSON; throws on invalid data.
- `normalizeConfig(object) → Graph`: validates and normalizes configuration.
- `parsePackageJson(object) → Graph`, `parseRequirements(text) → Graph`: format-specific conversion.
- `health(node, view = 'health') → 'healthy' | 'warning' | 'critical'`: derives display status. Any reported vulnerability is critical regardless of advisory severity. In Security, only a successful clean scan is green.
- `affectedBy(graph, id) → string[]`: reverse-reachable components, excluding the source; cycle-safe.
- `MAX_INPUT_BYTES`: one million bytes; maximum 300 total components.

`Graph` is `{ project, nodes, edges, refreshedAt? }`. Edges are `{source, target}` meaning “source depends on target.” Nodes contain `id`, `name`, `kind`, `ecosystem`, `version`, `status`, `type`, `description`, `license`, `repository`, `deprecated`, `dependencies`, `advisories`, `vulnerabilityCount`, `scan`, and `errors`.

## Live API (`src/data-fetcher.js`)

```js
import { refreshGraph } from './src/data-fetcher.js';
const controller = new AbortController();
const updated = await refreshGraph(graph, { signal: controller.signal });
```

- `exactVersion(node) → boolean`: conservative npm semver/Python-version check. Unsupported exact version syntaxes are left unscanned rather than guessed.
- `enrichNode(node, {fetcher = fetch, signal} = {}) → Promise<Node>`: npm metadata, exact-version OSV, and optional GitHub status; clones input and records per-source errors.
- `refreshGraph(graph, options) → Promise<Graph>`: immutable snapshot enrichment, four concurrent workers; request timeout 12 seconds. Aborted queued work rejects.

Scan states: `not checked`, `unresolved version`, `unavailable`, `clean`, `findings`. Optional live fields: `latest`, `updateAvailable`, `githubStatus`, `checkedAt`. The browser orchestrator schedules subsequent polls 60 seconds after completion and cancels stale requests when a project changes.

The OSV query is `{package: {name, ecosystem}, version}`. Registry metadata comes from `https://registry.npmjs.org/{encoded-name}/latest`, not an installed-version endpoint: its license/deprecation fields describe the latest release. The version comparison is deliberately only “different from latest,” not a semver upgrade recommendation. GitHub uses `GET /repos/{owner}/{repo}/commits/HEAD/status`; empty status sets do not imply success.

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
