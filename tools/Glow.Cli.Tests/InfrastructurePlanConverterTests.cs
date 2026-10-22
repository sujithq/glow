using Glow.Cli.Conversion;

namespace Glow.Cli.Tests;

public sealed class InfrastructurePlanConverterTests
{
    private readonly InfrastructurePlanConverter _converter = new();

    [Fact]
    public async Task TerraformPlanCreatesAzureNodesChangesAndReferenceEdgesWithoutCopyingValues()
    {
        using var fixture = new InfrastructureFixture();
        var plan = await fixture.WriteAsync("plan.json", """
            {
              "format_version": "1.2",
              "resource_changes": [
                {
                  "address": "azurerm_resource_group.main",
                  "mode": "managed",
                  "type": "azurerm_resource_group",
                  "name": "main",
                  "change": { "actions": ["no-op"], "before": { "secret": "do-not-export" } }
                },
                {
                  "address": "azurerm_storage_account.data",
                  "mode": "managed",
                  "type": "azurerm_storage_account",
                  "name": "data",
                  "change": { "actions": ["delete", "create"], "after": { "secret": "do-not-export" } }
                }
              ],
              "configuration": {
                "root_module": {
                  "resources": [
                    { "address": "azurerm_resource_group.main", "expressions": {} },
                    {
                      "address": "azurerm_storage_account.data",
                      "expressions": { "resource_group_name": { "references": ["azurerm_resource_group.main.name"] } }
                    }
                  ]
                }
              }
            }
            """);

        var configuration = await _converter.ConvertAsync(plan, new());

        Assert.Equal("plan", configuration.Project);
        Assert.Empty(configuration.Dependencies);
        var group = Assert.Single(configuration.Services, node => node.Name == "azurerm_resource_group.main");
        Assert.Equal("warning", group.Status);
        Assert.Equal("no-change", group.PlanChange);
        Assert.Equal("Microsoft.Resources/resourceGroups", group.ResourceType);
        var storage = Assert.Single(configuration.Services, node => node.Name == "azurerm_storage_account.data");
        Assert.Equal("replace", storage.PlanChange);
        Assert.Equal("Microsoft.Storage/storageAccounts", storage.ResourceType);
        Assert.Equal(["azurerm_resource_group.main"], storage.Dependencies);
        var yaml = GlowYamlWriter.Serialize(configuration);
        Assert.DoesNotContain("do-not-export", yaml);
    }

    [Fact]
    public async Task TerraformReferencesConnectEveryInstanceOfCountedResources()
    {
        using var fixture = new InfrastructureFixture();
        var plan = await fixture.WriteAsync("plan.json", """
            {
              "format_version": "1.2",
              "resource_changes": [
                {
                  "address": "azurerm_resource_group.main[0]",
                  "mode": "managed",
                  "type": "azurerm_resource_group",
                  "change": { "actions": ["no-op"] }
                },
                {
                  "address": "azurerm_resource_group.main[1]",
                  "mode": "managed",
                  "type": "azurerm_resource_group",
                  "change": { "actions": ["no-op"] }
                },
                {
                  "address": "azurerm_storage_account.data",
                  "mode": "managed",
                  "type": "azurerm_storage_account",
                  "change": { "actions": ["create"] }
                }
              ],
              "configuration": {
                "root_module": {
                  "resources": [
                    {
                      "address": "azurerm_resource_group.main",
                      "expressions": {}
                    },
                    {
                      "address": "azurerm_storage_account.data",
                      "expressions": { "resource_group_name": { "references": ["azurerm_resource_group.main.name"] } }
                    }
                  ]
                }
              }
            }
            """);

        var configuration = await _converter.ConvertAsync(plan, new());
        var storage = Assert.Single(configuration.Services, node => node.Name == "azurerm_storage_account.data");

        Assert.Equal(["azurerm_resource_group.main[0]", "azurerm_resource_group.main[1]"], storage.Dependencies);
    }

    [Fact]
    public async Task ArmTemplateUsesWhatIfActionsAndDeploymentDependencies()
    {
        using var fixture = new InfrastructureFixture();
        var template = await fixture.WriteAsync("main.json", """
            {
              "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
              "resources": [
                {
                  "type": "Microsoft.Storage/storageAccounts",
                  "apiVersion": "2023-01-01",
                  "name": "[parameters('accountName')]"
                },
                {
                  "type": "Microsoft.Web/sites",
                  "apiVersion": "2023-01-01",
                  "name": "api",
                  "dependsOn": [
                    "[resourceId('Microsoft.Storage/storageAccounts', parameters('accountName'))]"
                  ]
                }
              ]
            }
            """);
        var whatIf = await fixture.WriteAsync("whatif.json", """
            {
              "status": "Succeeded",
              "properties": {
                "changes": [
                  {
                    "resourceId": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/data1",
                    "changeType": "Create",
                    "after": { "secret": "do-not-export" }
                  },
                  {
                    "resourceId": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo/providers/Microsoft.Web/sites/api",
                    "changeType": "Modify"
                  }
                ]
              }
            }
            """);

        var configuration = await _converter.ConvertAsync(template, new(WhatIfPath: whatIf));

        var storage = Assert.Single(configuration.Services, node => node.ResourceType == "Microsoft.Storage/storageAccounts");
        var app = Assert.Single(configuration.Services, node => node.Name == "Microsoft.Web/sites/api");
        Assert.Equal("create", storage.PlanChange);
        Assert.Equal("update", app.PlanChange);
        Assert.Equal([storage.Name], app.Dependencies);
        Assert.DoesNotContain("do-not-export", GlowYamlWriter.Serialize(configuration));
    }

    [Fact]
    public async Task WhatIfOnlyDeletedResourcesAreIncluded()
    {
        using var fixture = new InfrastructureFixture();
        var template = await fixture.WriteAsync("empty.json", """
            {
              "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
              "resources": []
            }
            """);
        var whatIf = await fixture.WriteAsync("delete.json", """
            [
              {
                "resourceId": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo/providers/Microsoft.KeyVault/vaults/old",
                "changeType": "Delete"
              }
            ]
            """);

        var configuration = await _converter.ConvertAsync(template, new(WhatIfPath: whatIf));

        var deleted = Assert.Single(configuration.Services);
        Assert.Equal("Microsoft.KeyVault/vaults/old", deleted.Name);
        Assert.Equal("delete", deleted.PlanChange);
    }

    [Fact]
    public async Task SymbolicNameTemplatesFlattenModulesAndExpandCopyLoopsFromWhatIf()
    {
        using var fixture = new InfrastructureFixture();
        var template = await fixture.WriteAsync("main.json", """
            {
              "$schema": "https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#",
              "languageVersion": "2.0",
              "resources": {
                "rg": {
                  "type": "Microsoft.Resources/resourceGroups",
                  "apiVersion": "2024-03-01",
                  "name": "[parameters('resourceGroupName')]"
                },
                "durable": {
                  "type": "Microsoft.Resources/deployments",
                  "apiVersion": "2025-04-01",
                  "name": "durable-task-scheduler",
                  "properties": {
                    "template": {
                      "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
                      "languageVersion": "2.0",
                      "resources": {
                        "scheduler": {
                          "type": "Microsoft.DurableTask/schedulers",
                          "apiVersion": "2026-02-01",
                          "name": "[parameters('schedulerName')]"
                        },
                        "taskHubs": {
                          "copy": { "name": "taskHubs", "count": "[length(parameters('taskHubNames'))]" },
                          "type": "Microsoft.DurableTask/schedulers/taskHubs",
                          "apiVersion": "2026-02-01",
                          "name": "[format('{0}/{1}', parameters('schedulerName'), parameters('taskHubNames')[copyIndex()])]",
                          "dependsOn": ["scheduler"]
                        },
                        "lookup": {
                          "existing": true,
                          "type": "Microsoft.KeyVault/vaults",
                          "apiVersion": "2023-07-01",
                          "name": "shared"
                        }
                      }
                    }
                  },
                  "dependsOn": ["rg"]
                }
              }
            }
            """);
        var whatIf = await fixture.WriteAsync("what-if.json", """
            {
              "changes": [
                { "resourceId": "/subscriptions/0000/resourceGroups/rg-durable", "changeType": "NoChange" },
                { "resourceId": "/subscriptions/0000/resourceGroups/rg-durable/providers/Microsoft.DurableTask/schedulers/my-scheduler", "changeType": "Create" },
                { "resourceId": "/subscriptions/0000/resourceGroups/rg-durable/providers/Microsoft.DurableTask/schedulers/my-scheduler/taskHubs/hub-a", "changeType": "Create" },
                { "resourceId": "/subscriptions/0000/resourceGroups/rg-durable/providers/Microsoft.DurableTask/schedulers/my-scheduler/taskHubs/hub-b", "changeType": "Modify" }
              ]
            }
            """);

        var configuration = await _converter.ConvertAsync(template, new(WhatIfPath: whatIf));

        Assert.Equal(
            [
                "Microsoft.DurableTask/schedulers/my-scheduler",
                "Microsoft.DurableTask/schedulers/taskHubs/my-scheduler/hub-a",
                "Microsoft.DurableTask/schedulers/taskHubs/my-scheduler/hub-b",
                "Microsoft.Resources/resourceGroups/rg-durable",
            ],
            configuration.Services.Select(node => node.Name).Order(StringComparer.Ordinal));
        var group = Assert.Single(configuration.Services, node => node.Name == "Microsoft.Resources/resourceGroups/rg-durable");
        Assert.Equal("no-change", group.PlanChange);
        Assert.Empty(group.Dependencies);
        var scheduler = Assert.Single(configuration.Services, node => node.Name == "Microsoft.DurableTask/schedulers/my-scheduler");
        Assert.Equal("create", scheduler.PlanChange);
        Assert.Equal([group.Name], scheduler.Dependencies);
        var hubA = Assert.Single(configuration.Services, node => node.Name.EndsWith("/hub-a", StringComparison.Ordinal));
        var hubB = Assert.Single(configuration.Services, node => node.Name.EndsWith("/hub-b", StringComparison.Ordinal));
        Assert.Equal("create", hubA.PlanChange);
        Assert.Equal("update", hubB.PlanChange);
        Assert.Equal([scheduler.Name], hubA.Dependencies);
        Assert.Equal([scheduler.Name], hubB.Dependencies);
        Assert.DoesNotContain(configuration.Services, node => node.Name.Contains('[', StringComparison.Ordinal));
        GlowYamlWriter.Serialize(configuration);
    }

    [Fact]
    public async Task SymbolicDependenciesOnCopyLoopsReachEveryInstance()
    {
        using var fixture = new InfrastructureFixture();
        var template = await fixture.WriteAsync("main.json", """
            {
              "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
              "languageVersion": "2.0",
              "resources": {
                "accounts": {
                  "copy": { "name": "accounts", "count": 2 },
                  "type": "Microsoft.Storage/storageAccounts",
                  "name": "[format('data{0}', copyIndex())]"
                },
                "app": {
                  "type": "Microsoft.Web/sites",
                  "name": "api",
                  "dependsOn": ["accounts"]
                }
              }
            }
            """);
        var whatIf = await fixture.WriteAsync("what-if.json", """
            [
              { "resourceId": "/subscriptions/0/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/data0", "changeType": "Create" },
              { "resourceId": "/subscriptions/0/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/data1", "changeType": "Create" },
              { "resourceId": "/subscriptions/0/resourceGroups/demo/providers/Microsoft.Web/sites/api", "changeType": "Create" }
            ]
            """);

        var configuration = await _converter.ConvertAsync(template, new(WhatIfPath: whatIf));

        var app = Assert.Single(configuration.Services, node => node.Name == "Microsoft.Web/sites/api");
        Assert.Equal(
            ["Microsoft.Storage/storageAccounts/data0", "Microsoft.Storage/storageAccounts/data1"],
            app.Dependencies);
    }

    [Fact]
    public async Task OptionalIconMapEmbedsSanitizedLocalIconsForTheBrowser()
    {
        using var fixture = new InfrastructureFixture();
        var template = await fixture.WriteAsync("main.json", """
            {
              "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
              "resources": [
                { "type": "Microsoft.Storage/storageAccounts", "name": "data" }
              ]
            }
            """);
        await fixture.WriteAsync("icons/storage.svg", """
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1 1h8v8H1z"/></svg>
            """);
        var map = await fixture.WriteAsync("icons/map.json", """
            { "Microsoft.Storage/storageAccounts": "storage.svg" }
            """);

        var configuration = await _converter.ConvertAsync(template, new(IconMapPath: map));
        var icon = Assert.Single(configuration.Services).Icon;

        Assert.StartsWith("data:image/svg+xml;base64,", icon);
        var yaml = GlowYamlWriter.Serialize(configuration);
        Assert.Contains("data:image/svg+xml;base64,", yaml);
        Assert.DoesNotContain("storage.svg", yaml);
    }

    [Theory]
    [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")]
    [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"https://example.com/a.png\"/></svg>")]
    [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\"><style>@import url(https://example.com/a.css);</style></svg>")]
    public async Task RejectsActiveOrExternalContentInMappedSvgIcons(string svg)
    {
        using var fixture = new InfrastructureFixture();
        var template = await fixture.WriteAsync("main.json", """
            {
              "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
              "resources": [
                { "type": "Microsoft.Storage/storageAccounts", "name": "data" }
              ]
            }
            """);
        await fixture.WriteAsync("icons/storage.svg", svg);
        var map = await fixture.WriteAsync("icons/map.json", """
            { "Microsoft.Storage/storageAccounts": "storage.svg" }
            """);

        var error = await Assert.ThrowsAsync<ConversionException>(() =>
            _converter.ConvertAsync(template, new(IconMapPath: map)));
        Assert.Contains("SVG icon", error.Message);
    }

    [Theory]
    [InlineData("""{"format_version":"2.0","resource_changes":[]}""", "format version")]
    [InlineData("""{"format_version":"1.0","errored":true,"resource_changes":[]}""", "reports an error")]
    [InlineData("""{"format_version":"1.0","resource_changes":[{"address":"x","type":"azurerm_storage_account","change":{"actions":[]}}]}""", "invalid actions")]
    public async Task RejectsUnsupportedOrErroredTerraformPlans(string json, string expected)
    {
        using var fixture = new InfrastructureFixture();
        var path = await fixture.WriteAsync("plan.json", json);

        var error = await Assert.ThrowsAsync<ConversionException>(() => _converter.ConvertAsync(path, new()));

        Assert.Contains(expected, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class InfrastructureFixture : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), $"glow-iac-{Guid.NewGuid():N}");

        public async Task<string> WriteAsync(string relativePath, string contents)
        {
            var path = Path.Combine(Root, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllTextAsync(path, contents);
            return path;
        }

        public void Dispose()
        {
            if (Directory.Exists(Root))
            {
                Directory.Delete(Root, recursive: true);
            }
        }
    }
}
