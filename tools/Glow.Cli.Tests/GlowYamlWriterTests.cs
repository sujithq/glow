using System.Text;
using Glow.Cli.Conversion;
using YamlDotNet.Serialization;

namespace Glow.Cli.Tests;

public sealed class GlowYamlWriterTests
{
    [Fact]
    public void DoesNotEmitAliasesForSharedEmptyDependencyLists()
    {
        var yaml = GlowYamlWriter.Serialize(new("Shared",
            [new GlowComponent { Name = "one" }, new GlowComponent { Name = "two" }], []));
        Assert.DoesNotContain('&', yaml);
        Assert.DoesNotContain('*', yaml);
    }

    [Fact]
    public void RoundTripsStringsAndUsesBrowserSchema()
    {
        var configuration = new GlowConfiguration("A: # project\nname",
            [new GlowComponent { Name = "True", Version = "1.0", Ecosystem = "NuGet" }],
            [new GlowComponent { Name = "api", Type = "project", Dependencies = ["true"] }]);
        var yaml = GlowYamlWriter.Serialize(configuration);
        var decoded = new DeserializerBuilder().WithAttemptingUnquotedStringTypeDeserialization()
            .Build().Deserialize<Dictionary<string, object>>(yaml);
        Assert.Equal(configuration.Project, decoded["project"]);
        var packages = Assert.IsType<List<object>>(decoded["dependencies"]);
        Assert.Equal("1.0", Assert.IsType<Dictionary<object, object>>(packages[0])["version"]);
        Assert.DoesNotContain("version: null", yaml);
        Assert.DoesNotContain("scan:", yaml);
        Assert.DoesNotContain('\r', yaml);
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(300, true)]
    [InlineData(301, false)]
    public void EnforcesExactComponentLimit(int count, bool valid)
    {
        var configuration = new GlowConfiguration("Limit",
            Enumerable.Range(0, count).Select(index => new GlowComponent { Name = $"package{index}" }).ToArray(), []);
        if (valid)
        {
            Assert.NotEmpty(GlowYamlWriter.Serialize(configuration));
        }
        else
        {
            Assert.Throws<ConversionException>(() => GlowYamlWriter.Serialize(configuration));
        }
    }

    [Fact]
    public void EnforcesExactUtf8ByteLimit()
    {
        var node = new GlowComponent { Name = "package", Description = "x" };
        var baseline = Encoding.UTF8.GetByteCount(GlowYamlWriter.Serialize(new("Limit", [node], [])));
        var exact = node with { Description = new string('x', GlowYamlWriter.MaximumBytes - baseline + 1) };
        Assert.Equal(GlowYamlWriter.MaximumBytes, Encoding.UTF8.GetByteCount(GlowYamlWriter.Serialize(new("Limit", [exact], []))));
        Assert.Throws<ConversionException>(() => GlowYamlWriter.Serialize(new("Limit", [exact with { Description = exact.Description + "x" }], [])));
        Assert.Throws<ConversionException>(() => GlowYamlWriter.Serialize(new("Limit", [node with { Description = new string('\u00e9', 600_000) }], [])));
    }

    [Fact]
    public void RejectsInvalidNamesEcosystemsCollisionsAndDanglingReferences()
    {
        GlowComponent[] invalid =
        [
            new() { Name = "" },
            new() { Name = new string('x', 201) },
            new() { Name = "a", Ecosystem = "unknown" },
            new() { Name = "invalid/id", Ecosystem = "NuGet" },
            new() { Name = new string('x', 101), Ecosystem = "NuGet" },
            new() { Name = "a", Dependencies = ["missing"] }
        ];
        foreach (var node in invalid)
        {
            Assert.Throws<ConversionException>(() => GlowYamlWriter.Serialize(new("Invalid", [node], [])));
        }
        var package = new GlowComponent { Name = "Logging", Ecosystem = "NuGet" };
        Assert.Throws<ConversionException>(() => GlowYamlWriter.Serialize(new("Invalid", [package, package with { Name = "logging" }], [])));
        Assert.Throws<ConversionException>(() => GlowYamlWriter.Serialize(new("Invalid", [package], [new GlowComponent { Name = "logging" }])));
        Assert.NotEmpty(GlowYamlWriter.Serialize(new("Valid", [package], [new GlowComponent { Name = "api", Dependencies = ["LOGGING"] }])));
    }
}
