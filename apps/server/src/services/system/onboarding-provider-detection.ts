import { z } from "zod";
import { basename } from "node:path";

const configuredAgentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  displayName: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

export function resolveOnboardingAcpDetection(
  plugins: readonly {
    id: string;
    enabled: boolean;
    customAgents: unknown;
  }[],
) {
  const selected = plugins.find(
    (plugin) => plugin.id === "omnyo--provider-acp-next",
  );

  const customAgents: z.infer<typeof configuredAgentSchema>[] = [];

  if (
    typeof selected?.customAgents === "string" &&
    selected.customAgents.trim() !== ""
  ) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(selected.customAgents);
    } catch {
      parsed = null;
    }

    if (Array.isArray(parsed)) {
      const seen = new Set<string>();

      for (const entry of parsed) {
        const agent = configuredAgentSchema.safeParse(entry);

        if (
          !agent.success ||
          agent.data.id === "cursor" ||
          seen.has(agent.data.id)
        )
          continue;
        seen.add(agent.data.id);

        if (
          !["npx", "npx.cmd", "npx.exe", "uvx", "uvx.exe"].includes(
            basename(agent.data.command.replaceAll("\\", "/")),
          )
        )
          customAgents.push(agent.data);
      }
    }
  }

  return {
    acpPluginId:
      selected === undefined ? null : ("omnyo--provider-acp-next" as const),
    customAgents: customAgents.map((agent) => ({
      ...agent,
      id: `acp-${agent.id}`,
    })),
  };
}
