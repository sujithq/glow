# Glow CLI changelog

Changes to the `glow` .NET tool. Add entries under **Unreleased** as you work. To release, rename that heading to the new version and set the same `<Version>` in `tools/Glow.Cli/Glow.Cli.csproj`. After merge to `main`, the release workflow publishes `cli-v<version>` automatically. See [Create a CLI release](docs/CLI.md#create-a-cli-release).

## Unreleased

## 1.1.0

- Release automation: bumping `<Version>` publishes the GitHub release; release notes come from this changelog.
- Dedicated tool README with Bicep, Terraform, and .NET solution workflows, embedded in the package.
- `glow --version` reports the package version.

## 1.0.0

- First GitHub release of the `glow` .NET tool for .NET 10 and .NET 11.
- Converts restored .NET solutions, ARM/Bicep templates with what-if results, and Terraform plan JSON into Glow YAML.
