using System.Reflection;
using Glow.Cli.Conversion;
using Microsoft.Extensions.DependencyInjection;
using Spectre.Console;
using Spectre.Console.Cli;

namespace Glow.Cli;

public static class ToolApplication
{
    public static string Version { get; } =
        (typeof(ToolApplication).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0")
        .Split('+')[0];

    public static CommandApp Create(
        IAnsiConsole console, IEnumerable<IInputConverter>? converters = null, IAnsiConsole? errors = null)
    {
        var services = new ServiceCollection();
        services.AddSingleton(console);
        foreach (var converter in converters ?? [new DotnetSolutionConverter(), new InfrastructurePlanConverter()])
        {
            services.AddSingleton(converter);
        }
        services.AddSingleton<ConversionService>();
        var app = new CommandApp(new TypeRegistrar(services, console));
        app.Configure(configuration =>
        {
            configuration.SetApplicationName("glow");
            configuration.SetApplicationVersion(Version);
            configuration.Settings.Console = console;
            configuration.AddCommand<ConvertCommand>("convert")
                .WithDescription("Convert local dependency sources to Glow YAML without deploying infrastructure or contacting feeds.");
            configuration.SetExceptionHandler((exception, _) =>
            {
                (errors ?? console).MarkupLineInterpolated($"[red]Glow conversion failed:[/] {exception.Message}");
                return exception is OperationCanceledException ? 130 : 1;
            });
        });
        return app;
    }

    private sealed class TypeRegistrar(IServiceCollection services, IAnsiConsole console) : ITypeRegistrar
    {
        public ITypeResolver Build() => new TypeResolver(services.BuildServiceProvider());
        public void Register(Type service, Type implementation) => services.AddSingleton(service, implementation);
        public void RegisterInstance(Type service, object implementation) => services.AddSingleton(service, implementation);
        public void RegisterLazy(Type service, Func<object> factory)
        {
            // Spectre's console is caller-owned, not a disposable factory-created service.
            if (service == typeof(IAnsiConsole))
            {
                services.AddSingleton(service, console);
            }
            else
            {
                services.AddSingleton(service, _ => factory());
            }
        }
    }

    private sealed class TypeResolver(ServiceProvider provider) : ITypeResolver, IDisposable
    {
        public object? Resolve(Type? type) => type is null ? null : provider.GetService(type);
        public void Dispose() => provider.Dispose();
    }
}
