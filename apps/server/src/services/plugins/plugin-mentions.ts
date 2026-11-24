import type { PromptInput } from "@omnyo/domain";
import { ApiError } from "../../errors.js";
import { resolvePluginMention } from "./plugin-agent-contributions.js";

type PluginMentionResource = Extract<
  Extract<PromptInput, { type: "text" }>["mentions"][number]["resource"],
  { kind: "plugin" }
>;

function collectPluginMentionResources(
  input: readonly PromptInput[],
): PluginMentionResource[] {
  const seen = new Set<string>();
  const resources: PluginMentionResource[] = [];

  for (const item of input) {
    if (item.type !== "text") continue;

    for (const mention of item.mentions) {
      const resource = mention.resource;

      if (resource.kind !== "plugin") continue;
      const key = `${resource.pluginId}::${resource.itemId}`;

      if (seen.has(key)) continue;
      seen.add(key);
      resources.push(resource);
    }
  }

  return resources;
}

export async function resolvePluginMentionContextInputs(
  input: readonly PromptInput[],
): Promise<PromptInput[]> {
  const resources = collectPluginMentionResources(input);

  if (resources.length === 0) return [];

  const byPlugin = new Map<
    string,
    {
      firstIndex: number;
      entries: { resource: PluginMentionResource; index: number }[];
    }
  >();

  for (const [index, resource] of resources.entries()) {
    const group = byPlugin.get(resource.pluginId);

    if (group) group.entries.push({ resource, index });
    else
      byPlugin.set(resource.pluginId, {
        firstIndex: index,
        entries: [{ resource, index }],
      });
  }

  const groups = [...byPlugin.values()];

  const outcomes = new Map<
    PluginMentionResource,
    PromiseSettledResult<Awaited<ReturnType<typeof resolvePluginMention>>>
  >();

  let cursor = 0;
  let firstFailure = Infinity;
  await Promise.all(
    Array.from({ length: Math.min(3, groups.length) }, async () => {
      for (;;) {
        const group = groups[cursor++];

        if (!group || group.firstIndex > firstFailure) return;

        for (const { resource, index } of group.entries) {
          if (index > firstFailure) break;

          try {
            const value = await resolvePluginMention({
              pluginId: resource.pluginId,
              itemId: resource.itemId,
            });

            outcomes.set(resource, { status: "fulfilled", value });

            if (!value.ok) {
              firstFailure = Math.min(firstFailure, index);
              break;
            }
          } catch (reason) {
            outcomes.set(resource, { status: "rejected", reason });
            firstFailure = Math.min(firstFailure, index);
            break;
          }
        }
      }
    }),
  );
  const contextInputs: PromptInput[] = [];

  for (const resource of resources) {
    const outcome = outcomes.get(resource);

    if (!outcome) throw new Error("Plugin mention resolution did not finish");

    if (outcome.status === "rejected") throw outcome.reason;
    const result = outcome.value;

    if (!result.ok) {
      throw new ApiError(
        422,
        "plugin_mention_resolve_failed",
        `Could not resolve @${resource.label} (plugin "${resource.pluginId}"): ${result.error}`,
      );
    }

    contextInputs.push({
      type: "text",
      text: `Context for @${resource.label} (resolved by plugin "${resource.pluginId}"):\n\n${result.context}`,
      mentions: [],
      visibility: "agent-only",
    });

    for (const image of result.images) {
      if (image.context?.trim()) {
        contextInputs.push({
          type: "text",
          text: image.context,
          mentions: [],
          visibility: "agent-only",
        });
      }

      contextInputs.push({
        ...(image.type === "image"
          ? { type: "image" as const, url: image.url }
          : { type: "localImage" as const, path: image.path }),
        visibility: "agent-only",
      });
    }
  }

  return contextInputs;
}
