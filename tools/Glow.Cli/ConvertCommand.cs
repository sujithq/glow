using System.ComponentModel;
using System.Text;
using Glow.Cli.Conversion;
using Spectre.Console;
using Spectre.Console.Cli;

namespace Glow.Cli;

public sealed class ConvertSettings : CommandSettings
{
    [CommandArgument(0, "<input>")]
    [Description("Local input file. Currently supports .sln and .slnx solutions with existing restore assets.")]
    public string Input { get; init; } = "";

    [CommandOption("-o|--output <file>")]
    [DefaultValue("glow.config.yaml")]
    [Description("Output YAML path. Existing files are never overwritten.")]
    public string Output { get; init; } = "glow.config.yaml";

    [CommandOption("-t|--target <key>")]
    [Description("Exact restore target key; required when a project has multiple targets.")]
    public string? Target { get; init; }

    public override ValidationResult Validate() =>
        string.IsNullOrWhiteSpace(Input) || string.IsNullOrWhiteSpace(Output) || Target is not null && string.IsNullOrWhiteSpace(Target)
            ? ValidationResult.Error("Input, output, and an explicit target must not be empty.")
            : ValidationResult.Success();
}

public sealed class ConvertCommand(ConversionService conversions, IAnsiConsole console) : AsyncCommand<ConvertSettings>
{
    public override async Task<int> ExecuteAsync(
        CommandContext context, ConvertSettings settings, CancellationToken cancellationToken)
    {
        var yaml = await conversions.ConvertAsync(settings.Input, new ConversionOptions(settings.Target), cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        var outputPath = Path.GetFullPath(settings.Output);
        var temporaryPath = $"{outputPath}.{Guid.NewGuid():N}.tmp";
        var created = false;
        try
        {
            await using (var output = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                bufferSize: 4096, useAsync: true))
            {
                created = true;
                await output.WriteAsync(Encoding.UTF8.GetBytes(yaml), cancellationToken);
            }
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporaryPath, outputPath, overwrite: false);
        }
        finally
        {
            if (created && File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
        console.MarkupLineInterpolated($"[green]Created[/] {settings.Output}. Import this file with Glow's Import config button.");
        return 0;
    }
}
