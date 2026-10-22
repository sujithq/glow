---
name: prepare-cli-release
description: Automate Glow CLI release preparation. Use whenever the user asks to bump, calculate, prepare, commit, or release the CLI, or to update the CLI version and changelog. Calculates the semantic version from Conventional Commits since the latest cli-v tag.
---

# Prepare a Glow CLI release

Prepare the next release of the .NET tool without guessing its version.

## Inputs

- Default behavior: calculate and prepare the next stable semantic version.
- Stable bump rules use Conventional Commits since the latest `cli-v*` tag:
  - `feat!:` or a commit body/footer containing `BREAKING CHANGE:` => major
  - `feat:` or `feat(scope):` => minor
  - `fix:`, `perf:`, or `refactor:` => patch
- No qualifying commits means stop and report that no release is needed.
- Existing changelog notes may be placed only under `## Unreleased`.
- Do not include merge commits, tags, or generated artifacts when calculating the version.

## Workflow

1. Run:

   ```powershell
   node scripts/prepare-cli-release.mjs
   ```

   This prints the current version, calculated bump, next version, and changelog preview without changing files.

2. If the user confirms preparation, run:

   ```powershell
   node scripts/prepare-cli-release.mjs --apply
   ```

   The script updates:
   - `<Version>` in `tools/Glow.Cli/Glow.Cli.csproj`
   - `## Unreleased` into `## <next-version>` in `CHANGELOG.md`
   - Adds a fresh `## Unreleased` section above the release section

3. Run focused validation:

   ```powershell
   npm test
   dotnet test tools/Glow.slnx -c Release
   git diff --check
   node scripts/cli-release.mjs --notes $env:TEMP\glow-release-notes.md
   ```

4. Review only the four release surfaces changed: the csproj, changelog, package tests, and release automation files. Do not alter the version manually after calculation.

5. If validation passes and the user requests a commit or push:

   ```powershell
   git add CHANGELOG.md tools\Glow.Cli\Glow.Cli.csproj
   git commit -m "chore(cli): prepare release <next-version>"
   git push origin main
   ```

   Use the exact version printed by the script. Never create or push a `cli-v*` tag manually: pushing the version change to `main` triggers `.github/workflows/release-cli.yml`, which creates and publishes the tag/release only if it does not already exist.

## Error handling

- Stop if the worktree has unrelated uncommitted changes.
- Stop if `## Unreleased` is missing or empty.
- Stop if a remote `cli-v<calculated-version>` tag already exists.
- Stop if Conventional Commits provide only chore, docs, test, style, build, or ci changes; these do not bump the version unless explicitly marked breaking.
- If the requested prerelease type is unclear, ask before applying a prerelease and do not infer a version suffix.
- If validation fails, leave the partial version bump uncommitted and report the failing command.

## Output

Report:

- Current version
- Highest bump type
- Calculated next version
- Unreleased changelog entries moved into the release
- Files changed
- Validation result
- Whether a commit/push was performed
