# Glow CLI

Convert **Bicep/Azure what-if**, **Terraform plans**, and **restored .NET solutions** into a single YAML file for the [Glow dashboard](https://sujithq.github.io/glow/).

Glow reads local input files. It does not deploy infrastructure, apply plans, restore/build projects, or contact Azure or package feeds during conversion. Generating the input files is a separate operation using your normal development tools and credentials.

- [Install](#install)
- [Bicep: visualize planned Azure changes](#bicep-visualize-planned-azure-changes)
- [Terraform: visualize a saved plan](#terraform-visualize-a-saved-plan)
- [.NET: visualize a restored solution](#net-visualize-a-restored-solution)
- [Optional Azure icons](#optional-azure-icons)
- [Limits and troubleshooting](#limits-and-troubleshooting)

## Install

Install the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0). Download `Glow.Cli.1.0.0.nupkg` and `SHA256SUMS` from the [CLI v1.0.0 release](https://github.com/sujithq/glow/releases/tag/cli-v1.0.0), and compare the package's SHA-256 hash with the published checksum before installing.

From the directory containing the downloaded package:

```powershell
dotnet tool install --global Glow.Cli --source . --version 1.0.0 --framework net10.0
glow --help
glow convert --help
```

No Node.js, Claude installation, or repository checkout is required. This is a GitHub release package, not a NuGet.org publication: keep the local `--source` option. The package also includes a .NET 11 target, which requires a matching runtime.

To upgrade an existing global installation, use `dotnet tool update` instead of `dotnet tool install` with the same source, version, and framework options.

The examples below use **PowerShell 7**, so redirected JSON is written as UTF-8. Run the preparation commands only against trusted projects and the intended environment.

## Bicep: visualize planned Azure changes

You need Azure CLI with Bicep support, a Bicep template, and access to the target Azure scope. Glow does **not** accept `.bicep` files directly: compile the template to ARM JSON and capture the Azure what-if result as JSON first.

In the directory containing `main.bicep`:

```powershell
az login
az account set --subscription "your-subscription-id"
az bicep build --file main.bicep --outfile main.json
az deployment group what-if --resource-group "your-resource-group" --template-file main.bicep --parameters '@main.parameters.json' --no-pretty-print --output json > what-if.json
glow convert main.json --what-if what-if.json --output bicep.config.yaml
```

Replace the subscription and resource-group placeholders. Supply an ARM JSON parameter file named `main.parameters.json` with the values for your environment, or omit `--parameters '@main.parameters.json'` if the template needs no parameter overrides. Confirm each preparation command succeeds before converting; do not use a partial or error output file as input.

For subscription-scoped templates, generate the result with `az deployment sub what-if` and its required `--location` instead of `az deployment group what-if`. Use the same template and parameter values for the environment you want to inspect.

Open the [dashboard](https://sujithq.github.io/glow/), choose **Import config**, and select `bicep.config.yaml`. Glow opens **Plan** view for planned changes. Select a resource to inspect its action and declared dependencies.

The ARM template supplies resource definitions and dependencies; the what-if JSON supplies planned actions, including deletions absent from the template. Create, update, delete, replacement, and other reported actions remain distinct. Classic and symbolic-name ARM templates are supported, including inline modules and copy-loop instances reported by what-if. Template-linked deployments remain single nodes.

What-if contacts Azure and requires deployment-level permissions; it does not deploy the resources. Glow's subsequent conversion is local and does not contact Azure. Planned actions are not live health or security findings.

See Microsoft's [Bicep what-if guidance](https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-what-if) for permissions and prediction limitations.

## Terraform: visualize a saved plan

You need Terraform, an initialized working configuration, and the provider credentials required to create its plan. Glow does **not** accept `.tf` source files, binary saved plans, or a Terraform state snapshot in place of a plan.

In your Terraform working directory:

```powershell
terraform init
terraform plan -out=tfplan
terraform show -json tfplan > tfplan.json
glow convert tfplan.json --output terraform.config.yaml
```

Confirm each command succeeds before proceeding. If you already have a saved plan, start with `terraform show -json` for that specific file. Do not omit the plan filename: plain `terraform show -json` shows state rather than the saved plan.

Open the [dashboard](https://sujithq.github.io/glow/), choose **Import config**, and select `terraform.config.yaml`. **Plan** view shows resource addresses and planned actions; configuration references supply dependency edges.

Terraform initialization and planning can download providers and contact your configured services. Glow only reads the exported JSON and never runs `terraform apply`. Common Azure provider types receive Azure resource-type mappings; other providers remain visible as service nodes.

**Treat the plan and exported JSON as sensitive.** `terraform show -json` can expose sensitive values in plain text. Glow omits resource property bags from its YAML, but resource names, addresses, and relationships remain. See Terraform's [show documentation](https://developer.hashicorp.com/terraform/cli/commands/show).

## .NET: visualize a restored solution

Restore only a **trusted** solution; restore can execute MSBuild logic. Then convert its existing restore assets:

```powershell
dotnet restore "C:\src\App\App.slnx"
glow convert "C:\src\App\App.slnx" --output "C:\src\App\glow.config.yaml"
```

Both `.sln` and `.slnx` are supported. Import the output using the dashboard's **Import config** button. Projects appear as service nodes, with resolved NuGet package versions and project/package dependency edges.

If assets contain multiple restore targets, pass the exact key shown in the error, for example `--target net10.0`. The selected key must exist in every included project. The converter reads existing `obj\project.assets.json` files and cannot prove they are current.

## Optional Azure icons

Supply your own local JSON map of Azure resource types to SVG/PNG files:

```json
{
  "Microsoft.Storage/storageAccounts": "storage.svg",
  "Microsoft.Web/sites": "web-app.svg"
}
```

Keep icon paths inside the map's directory, then add the map to either infrastructure conversion:

```powershell
glow convert main.json --what-if what-if.json --icon-map azure-icons.json --output bicep-icons.config.yaml
glow convert tfplan.json --icon-map azure-icons.json --output terraform-icons.config.yaml
```

Icons are embedded in the generated YAML; no extra icon files need to be uploaded. Microsoft's icon pack is not bundled. Obtain the [official Azure architecture icons](https://learn.microsoft.com/azure/architecture/icons/) separately and follow their usage terms.

## Limits and troubleshooting

- **Existing output:** Glow never overwrites a file. Use a different `--output` path or move the previous file.
- **Wrong input format:** Bicep needs compiled ARM JSON plus `--what-if`; Terraform needs JSON exported from a saved plan, not HCL, state, or a binary plan.
- **Conversion errors:** missing/malformed assets, invalid JSON, unsupported structures, or conflicting package versions fail explicitly rather than creating a partial graph.
- **Size:** the final YAML must fit the dashboard's 1 MB and 300-component limits. Split larger maps before importing.
- **Privacy:** review generated YAML before sharing; it can identify projects, packages, and infrastructure resources. Keep source plans and what-if output private.
- **Command not found:** reopen your terminal and ensure the .NET global tools directory is on PATH.

For complete format limitations, installation alternatives, and development instructions, see the [CLI guide](https://github.com/sujithq/glow/blob/main/docs/CLI.md).
