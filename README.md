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
2. Import `glow.config.yaml`, `package.json`, or `requirements.txt`, or paste the contents.
3. Switch **Health / Security / Dependency** views; select blocks to inspect versions, licenses, advisories, and reverse-dependency impact.
4. Filter packages/services, search, zoom, or use the audience shortcuts.
5. Choose **Refresh once** or enable 60-second polling for public npm metadata, OSV advisories, and configured GitHub commit statuses.
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
- **OSV:** vulnerability queries for exact npm/PyPI versions only. Ranges, aliases, URLs, and unknown versions remain unscanned. PyPI registry release metadata is not fetched.
- **GitHub:** optional public `owner/repo` combined commit status on `HEAD`. This is not Actions check-run monitoring, service uptime, or a deployment health probe.
- Polling waits 60 seconds **after completion**, with at most four concurrent requests and 12-second request timeouts. There is no background monitoring after closing the page.
- No API tokens, cookies, analytics, or persistent configuration storage. Imports are rendered locally. Live mode shares package names/versions and configured repository names with the services above.
- Source errors, rate limits, CORS restrictions, and unresolved versions remain visible. A successful empty scan is **not a security guarantee**. Configured findings remain visible even when OSV returns no findings; edit the config to remove stale configured evidence.
- Manifests enumerate direct dependencies only. Supply nested package/service relationships in YAML; Glow does not resolve lockfiles or fetch a transitive dependency tree.

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
- [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
- [OSV query API](https://google.github.io/osv.dev/api/#tag/vulnerability/operation/OSV_Query)
- [GitHub combined status API](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference)
- [GitHub Pages with Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Claude skills](https://docs.anthropic.com/en/docs/claude-code/skills)
- [iso-glow](https://iso-glow.vercel.app/) and its [advertised archive](https://iso-glow.vercel.app/iso-glow.tar.gz)

## Verification

`npm test` uses Node's built-in test runner for parser validation, examples, cyclic impact traversal, exact-version gating, mocked registry/security responses, API failures, cancellation, and request concurrency. `npm run build` bundles local dependencies with esbuild; no runtime CDN is required. Run `npm audit` to check installed npm dependencies.

MIT licensed. No quantified productivity or security coverage guarantees are made.
