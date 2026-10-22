# Glow

**See your stack. Know its impact.** An interactive isometric dependency dashboard and distributable Claude skill for developers, DevOps, architects, and security teams.

**Pages URL (after deployment): https://sujithq.github.io/glow/**

## Quick start

```sh
npm ci
npm test
npm run dev
```

Open http://127.0.0.1:4173. Node.js 24 is recommended. The dashboard starts with clearly labeled **illustrative data** and makes no registry/security requests until you opt in.

1. Choose a healthy, vulnerable, or mixed example.
2. Import `glow.config.yaml`, `package.json`, `requirements.txt`, a C# `.csproj`, or `packages.config`, or paste the contents.
3. Switch **Health / Security / Dependency** views; select blocks to inspect versions, licenses, advisories, and reverse-dependency impact.
4. Filter packages/services, search, zoom, or use the audience shortcuts.
5. Choose **Refresh once** or enable 60-second polling for public npm/NuGet metadata, OSV advisories, and configured GitHub commit statuses.
6. Export a JSON snapshot for an audit or incident handoff.

## Configuration

```yaml
project: Example application
dependencies:
  - name: express
    version: 4.18.0
    status: healthy
    ecosystem: npm
services:
  - name: api
    status: running
    dependencies: [express]
    # Optional public repository for GitHub's combined commit status API:
    repository: owner/repo
```

Green = configured healthy; yellow = warning/deprecated/version difference/API error; red = critical status or reported vulnerability. In **Security**, unscanned components are yellow, not green. Shapes, text details, and keyboard interaction supplement color. Respecting reduced-motion preferences disables glow animations.

### Developer velocity

| Workflow | How Glow helps |
| --- | --- |
| Visual security audit | Highlight packages with configured or live OSV findings |
| Update planning | Select a package to trace all direct and transitive consumers |
| Incident response | Find services affected by a vulnerable dependency or failed commit status |
| Onboarding | Explore numbered components, relationships, and descriptions |
| Architecture review | Filter service/package layers and inspect explicit topology |

Impact analysis traces declared relationships; it does **not** predict breaking changes or simulate upgrades.

## Live data and privacy

- **npm registry:** latest tag, description, license, and latest-release deprecation metadata for npm packages. A version different from the latest tag is a review hint, not a proven upgrade recommendation.
- **NuGet.org:** latest stable version from the public version index. No NuGet license, description, or deprecation metadata is fetched. NuGet IDs are normalized to lowercase; names must remain globally unique. Private feeds and credentials are unsupported.
- **OSV:** vulnerability queries for exact npm/PyPI/NuGet versions only. Ranges, aliases, URLs, MSBuild properties, and unknown versions remain unscanned. PyPI registry release metadata is not fetched.
- **NuGet security coverage:** OSV matches NuGet names case-sensitively. Glow preserves imported package spelling for queries, separately from lowercase graph IDs. Empty NuGet results are labeled `limited coverage` and remain yellow in Security, never clean; advisory spelling can still differ.
- **GitHub:** optional public `owner/repo` combined commit status on `HEAD`. This is not Actions check-run monitoring, service uptime, or a deployment health probe.
- Polling waits 60 seconds **after completion**, with at most four concurrent requests and 12-second request timeouts. There is no background monitoring after closing the page.
- No API tokens, cookies, analytics, or persistent configuration storage. Imports are rendered locally. Live mode shares package names/versions and configured repository names with the services above.
- Source errors, rate limits, CORS restrictions, and unresolved versions remain visible. A successful empty scan is **not a security guarantee**. Configured findings remain visible even when OSV returns no findings; edit the config to remove stale configured evidence.
- Manifests enumerate direct dependencies only. Supply nested package/service relationships in YAML; Glow does not resolve lockfiles or fetch a transitive dependency tree.

### C# / NuGet imports

Import `.csproj` for unconditional `PackageReference` declarations or `packages.config` for installed versions. A bare `.csproj` version is a minimum constraint, not an installed version, so `1.2.3` becomes `>=1.2.3` and remains unscanned; an exact `[1.2.3]` constraint becomes `1.2.3`. Missing versions and MSBuild properties remain unresolved. Use `ecosystem: NuGet` and an independently verified exact version in YAML for resolved snapshots.

The browser never evaluates MSBuild, imports files, or restores packages. Conditional package references, project references, central package definitions, and unsupported update constructs in uploaded `.csproj` files are rejected rather than guessed. Model projects as explicit YAML services, or use the local solution converter below. The browser does not directly import restore assets or lockfiles, and multiple versions of the same package are not supported.

### Convert a .NET solution locally

The converter is a separate **.NET tool** using Spectre.Console, targeting .NET 10 and 11. Build and install it locally from the Glow checkout (a .NET 11 SDK is required to build both targets):

```powershell
dotnet pack tools\Glow.Cli\Glow.Cli.csproj -c Release -o artifacts\packages
dotnet tool install Glow.Cli --tool-path artifacts\tools --source artifacts\packages --version 1.0.0
.\artifacts\tools\glow convert "C:\src\App\App.slnx" --output "C:\src\App\glow.config.yaml"
```

Restore your trusted input solution separately first. Both `.sln` and `.slnx` are supported. The CLI reads each project's existing `obj\project.assets.json`, including referenced projects outside the solution, and writes projects as services plus resolved NuGet packages and dependency edges. It does not execute MSBuild, restore packages, or contact a feed. Upload the generated YAML with **Import config**. Node.js is not required to run the tool.

For multiple restore targets, specify the exact assets target key, for example `--target net8.0`. Conflicting package versions, missing assets, and configurations exceeding 300 components or 1 MB fail explicitly. Existing output files are never overwritten. See [solution converter usage](docs/USAGE.md#local-solution-converter) for target selection and limitations.

See [.NET tool setup and extension guide](docs/CLI.md) for .NET 10-only builds, installation, unit tests, and adding future input formats through `IInputConverter`.

## Claude skill and iso-glow

```sh
npm run package:skill
tar -tzf dist/downloads/glow.tar.gz  # inspect before installing
mkdir -p ~/.claude/skills
tar -xzf dist/downloads/glow.tar.gz -C ~/.claude/skills
```

The archive contains `glow/SKILL.md`, generated from `skill-manifest.json`, plus a prebuilt dashboard, examples, documentation, and license. Ask Claude to “Use Glow to map my dependencies and explain the impact of updating express.” The dashboard can also run independently of Claude.

Glow's renderer is original SVG code inspired by [iso-glow](https://iso-glow.vercel.app/). The adapter exports its `FIGS`-compatible `createIsoGlowFigure` interface for use inside an installed iso-glow gallery. **Glow does not bundle, automatically install, or claim to be the upstream runtime.** The advertised archive was unavailable during implementation; the figure interface was checked against a [public skill copy](https://github.com/irfanfaraaz/claude-kit/blob/main/skills/iso-glow/SKILL.md). See [API](docs/API.md) for integration and limitations.

## Build and deploy

```sh
npm run package:skill
# Publish dist/ as a static site, including downloads/glow.tar.gz.
```

The [deployment workflow](.github/workflows/deploy.yml) tests and builds every PR. On `main`, it deploys `dist/` to GitHub Pages with a downloadable skill archive. **A repository administrator must select Settings → Pages → Source → GitHub Actions first.** Merging the PR then publishes the site; deployment does not happen merely by creating the PR. See [setup](docs/SETUP.md).

## Documentation and sources

- [Setup and Pages deployment](docs/SETUP.md)
- [Usage and stakeholder workflows](docs/USAGE.md)
- [Configuration schema and module API](docs/API.md)
- [.NET CLI setup, testing, and extension guide](docs/CLI.md)
- [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
- [NuGet version index API](https://learn.microsoft.com/en-us/nuget/api/package-base-address-resource)
- [NuGet version ranges](https://learn.microsoft.com/en-us/nuget/concepts/package-versioning)
- [NuGet PackageReference](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files)
- [NuGet restore dependency graphs and project.assets.json](https://learn.microsoft.com/en-us/nuget/concepts/dependency-resolution)
- [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)
- [OSV query API](https://google.github.io/osv.dev/api/#tag/vulnerability/operation/OSV_Query)
- [OSV ecosystem identifiers](https://github.com/ossf/osv-schema/blob/main/validation/schema.json) and [NuGet version support](https://github.com/google/osv.dev/blob/master/osv/ecosystems/nuget.py)
- [GitHub combined status API](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference)
- [GitHub Pages with Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Claude skills](https://docs.anthropic.com/en/docs/claude-code/skills)
- [iso-glow](https://iso-glow.vercel.app/) and its [advertised archive](https://iso-glow.vercel.app/iso-glow.tar.gz)

## Verification

`npm test` uses Node's built-in test runner for parser validation, examples, cyclic impact traversal, exact-version gating, mocked registry/security responses, API failures, cancellation, and request concurrency. `dotnet test tools\Glow.slnx` runs the CLI's xUnit tests on .NET 10 and 11; see the [CLI guide](docs/CLI.md) for browser interoperability tests. `npm run build` bundles local dependencies with esbuild; no runtime CDN is required. Run `npm audit` to check installed npm dependencies.

MIT licensed. No quantified productivity or security coverage guarantees are made.
