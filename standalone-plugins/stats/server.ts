import type { PluginApi } from "@omnyo/plugin-sdk";
import { reportInputSchema, rpcContract, type ReportInput } from "./contract.ts";
import { Collector } from "./lib/collector.ts";

export { rpcContract } from "./contract.ts";

const usage =
  "omnyo stats summary|health|report|refresh [--json] [--range hour|day|week|month|year|all] [--group machine|project|chat|provider|model|effort|mode|account|chatRole|agentRole] [--filter dimension=value] [--limit 1..100] [--offset N]";

export default function plugin(api: PluginApi): void {
  const collector = new Collector(api);
  api.background.service("collector", { start: (signal) => collector.start(signal) });
  api.rpc.register(rpcContract, {
    summary: () => collector.summary(),
    health: () => collector.health(),
    report: (input) => collector.report(input),
    refresh: () => {
      collector.refresh();

      return { accepted: true };
    },
  });
  api.cli.register({
    name: "stats",
    summary: "Durable local agent and token analytics",
    commands: [
      {
        name: "summary",
        summary: "Global live agents, five-minute throughput and lifetime tokens",
        usage,
      },
      { name: "report", summary: "Bounded analytics with ten dimension filters", usage },
      { name: "health", summary: "Collector, retained history and SQLite storage health", usage },
      { name: "refresh", summary: "Reconcile available history from saved cursors", usage },
    ],
    run(argv) {
      const command = argv[0];

      if (!command || command === "--help" || command === "help")
        return { exitCode: 0, stdout: usage };
      let json = false;
      const input: ReportInput = reportInputSchema.parse({});

      for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === "--json") json = true;
        else if (arg === "--range") {
          const parsed = reportInputSchema.shape.range.safeParse(argv[++index]);

          if (!parsed.success) return { exitCode: 1, stderr: usage };
          input.range = parsed.data;
        } else if (arg === "--group") {
          const parsed = reportInputSchema.shape.groupBy.safeParse(argv[++index]);

          if (!parsed.success) return { exitCode: 1, stderr: usage };
          input.groupBy = parsed.data;
        } else if (arg === "--limit") input.limit = Number(argv[++index]);
        else if (arg === "--offset") input.offset = Number(argv[++index]);
        else if (arg === "--filter") {
          const pair = argv[++index] ?? "";
          const equals = pair.indexOf("=");

          if (equals < 1) return { exitCode: 1, stderr: usage };

          const parsed = reportInputSchema.shape.filters.safeParse({
            ...input.filters,
            [pair.slice(0, equals)]: pair.slice(equals + 1),
          });

          if (!parsed.success) return { exitCode: 1, stderr: usage };
          input.filters = parsed.data;
        } else return { exitCode: 1, stderr: usage };
      }

      const parsed = reportInputSchema.safeParse(input);

      if (!parsed.success) return { exitCode: 1, stderr: usage };

      if (command === "refresh") {
        collector.refresh();

        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ accepted: true })
            : "History reconciliation queued; collection continues in the background.",
        };
      }

      if (command === "summary") {
        const value = collector.summary();

        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify(value)
            : `${value.running} reported agents (${value.activeChats} chats + ${value.nestedAgents} native background agents)\n${value.tps5m.toFixed(2)} recorded output tokens/s · trailing 300 seconds\nLifetime: ${value.allTime.output.toLocaleString()} output · ${value.allTime.input.toLocaleString()} input · ${value.allTime.total.toLocaleString()} provider total tokens\n${value.liveReady ? "" : "Live inventory is still reconciling.\n"}History includes available source counters; gaps and inherited baselines can make totals a lower bound.`,
        };
      }

      if (command === "health") {
        const value = collector.health();

        return {
          exitCode: value.error ? 1 : 0,
          stdout: JSON.stringify(value, null, json ? undefined : 2),
        };
      }

      if (command === "report") {
        const value = collector.report(parsed.data);

        const lines = [
          `${input.range} · group by ${input.groupBy} · ${value.groupCount} groups`,
          ...value.groups.map(
            (group) =>
              `${group.label}: ${group.counters.output} output · ${group.counters.input} input · ${group.modelTps?.toFixed(1) ?? "—"} estimated model tok/s · ${group.active} active`,
          ),
          value.nextOffset === null ? "" : `More groups: --offset ${value.nextOffset}`,
        ];

        return {
          exitCode: value.health.error ? 1 : 0,
          stdout: json ? JSON.stringify(value) : lines.join("\n"),
        };
      }

      return { exitCode: 1, stderr: usage };
    },
  });
}
