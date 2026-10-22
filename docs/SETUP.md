# Setup

## Local development

Use Node.js 24 and npm:

```sh
npm ci
npm test
npm run dev
```

Open http://127.0.0.1:4173. JavaScript/CSS changes rebuild automatically. Restart after editing HTML/examples (these are copied at startup).

The optional solution converter is a separate .NET 10/11 tool, not an npm script. See [CLI setup](CLI.md) for packing, installing, and extending it. `dotnet test tools\Glow.slnx` runs its unit tests; building both targets requires the .NET 11 SDK and running all tests requires both runtimes.

For a production bundle and Claude archive:

```sh
npm run package:skill
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:8000. Serve over HTTP rather than opening `index.html` with `file://`; example loading and module imports require HTTP. Output in `dist/` is generated and must not be committed.

## GitHub Pages

1. A repository administrator opens **Settings → Pages** in `sujithq/glow`.
2. Under **Build and deployment**, select **GitHub Actions** as the source. Ensure repository/organization policy permits Pages and Actions.
3. Merge the implementation into `main`. Alternatively, run **Validate and deploy Glow** using **Run workflow**, selecting `main`.
4. Review the workflow's build, CLI, and deploy jobs. The build bundles the dashboard and skill download. The CLI matrix runs .NET 10/11 unit tests, browser interoperability, and packed-tool installation on Windows and Linux. Both validation jobs must pass before deployment.
5. Wait for the `github-pages` environment deployment to succeed.
6. Visit **https://sujithq.github.io/glow/** and verify examples, imports, views, and the skill download.

PRs run tests/build but do not deploy unreviewed changes. Deployment uses `pages: write` and `id-token: write` only in the deployment job; no long-lived token is required. All site asset URLs are relative, so the `/glow/` project-site path works. If the default branch is not `main`, update both branch conditions and the push branch in the workflow.

The application cannot change repository Pages settings. Shipping this workflow does not itself enable hosting. If deployment reports Pages is not enabled, repeat step 2 with administrator permissions. Deployment also depends on the repository's plan/visibility and any environment approval policies.

## Claude installation

Download the archive from the deployed site's **Download Claude skill** link, or build it locally with `npm run package:skill`. Inspect its entries, then extract it into your Claude skills directory:

```sh
tar -tzf glow.tar.gz
mkdir -p ~/.claude/skills
tar -xzf glow.tar.gz -C ~/.claude/skills
```

The archive contains `glow/SKILL.md` and prebuilt assets; no npm install is needed to use the packaged dashboard. In that extracted directory, use `python3 -m http.server 8000 --bind 127.0.0.1` and open http://127.0.0.1:8000. Follow your Claude client's instructions if it uses a different skills location.

`skill-manifest.json` is Glow's build metadata; Claude's discovery file is the generated `SKILL.md`. Change the manifest instructions, then rebuild to update it.

## Network and security

The bundled app loads its examples and code from the hosting origin. There are no external fonts, scripts, or analytics. Network enrichment is optional:

| Destination | Data sent |
| --- | --- |
| `registry.npmjs.org` | npm package name |
| `api.nuget.org` | lowercase NuGet package ID, for the public version index |
| `api.osv.dev` | package name, ecosystem, exact version |
| `api.github.com` | configured public repository name |

Browsers also reveal ordinary network metadata to the hosting origin and API providers. Do not enable live mode for confidential dependencies without approval. No proxy/backend, credentials, private-repository support, or persistent server monitoring is included. For offline use, serve the packaged files locally and leave refresh disabled.

NuGet metadata uses the anonymous [package version index](https://learn.microsoft.com/en-us/nuget/api/package-base-address-resource). Its response was checked for browser CORS (`Access-Control-Allow-Origin: *`). Only public NuGet.org is contacted; configured/custom feeds are never followed. The bundled `fast-xml-parser` validates .NET XML inputs without executing MSBuild or loading external resources.

API outages, rate limits, and browser CORS failures are displayed per component. GitHub's unauthenticated rate limits can be exhausted quickly by repeated polling. Disable polling or use one-shot refresh; do not paste tokens into configurations.
