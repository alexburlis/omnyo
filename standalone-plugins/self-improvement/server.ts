import type { PluginApi } from "@omnyo/plugin-sdk";
import { configSchema, rpcContract, type Config } from "./contract";

export default function plugin(api: PluginApi) {
  async function read(): Promise<Config | null> {
    const stored = await api.storage.kv.get<Config>("config");

    return stored === null ? null : configSchema.parse(stored);
  }

  async function save(config: Config): Promise<Config> {
    const target = await api.sdk.environments.get({ environmentId: config.environmentId });

    if (target.status !== "ready" || target.path === null)
      throw new Error("Choose a ready folder.");
    await api.storage.kv.set("config", config);
    api.realtime.publish("config-changed", null);

    return config;
  }

  api.rpc.register(rpcContract, {
    config: read,
    save,
    targets: async () => {
      const environments = await api.sdk.environments.list({ status: "ready" });

      return environments.flatMap((environment) =>
        environment.path === null
          ? []
          : [
              {
                id: environment.id,
                projectId: environment.projectId,
                path: environment.path,
                name: environment.name ?? environment.path,
              },
            ],
      );
    },
  });
  api.cli.register({
    name: "self-improvement",
    summary: "Inspect or configure element-to-chat defaults",
    commands: [
      { name: "config", summary: "Show defaults", usage: "omnyo self-improvement config [--json]" },
      {
        name: "configure",
        summary: "Set defaults",
        usage: "omnyo self-improvement configure '<JSON>' [--json]",
      },
      {
        name: "targets",
        summary: "List ready folders",
        usage: "omnyo self-improvement targets [--json]",
      },
    ],
    async run(argv) {
      const args = argv.filter((arg) => arg !== "--json");

      if (args[0] === "config") return { exitCode: 0, stdout: JSON.stringify(await read()) };

      if (args[0] === "configure" && args.length === 2) {
        const config = configSchema.parse(JSON.parse(args[1]));

        return { exitCode: 0, stdout: JSON.stringify(await save(config)) };
      }

      if (args[0] === "targets") {
        const environments = await api.sdk.environments.list({ status: "ready" });

        return {
          exitCode: 0,
          stdout: JSON.stringify(
            environments.flatMap((environment) =>
              environment.path === null
                ? []
                : [
                    {
                      id: environment.id,
                      path: environment.path,
                      projectId: environment.projectId,
                    },
                  ],
            ),
          ),
        };
      }

      return { exitCode: 1, stderr: "Use config, configure '<JSON>', or targets." };
    },
  });
}
