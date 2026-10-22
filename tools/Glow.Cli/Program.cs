using Glow.Cli;
using Spectre.Console;

var errors = AnsiConsole.Create(new AnsiConsoleSettings { Out = new AnsiConsoleOutput(Console.Error) });
return await ToolApplication.Create(AnsiConsole.Console, errors: errors).RunAsync(args);
