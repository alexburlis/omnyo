import { cliCommand, PluginCliError } from "@omnyo/plugin-sdk";
import type { createPromptService } from "./prompt-service";

export function promptCommands(prompts: ReturnType<typeof createPromptService>) {
  return {
    "prompt-search": cliCommand({
      summary: "Search saved prompts and your prompt history",
      positionals: [{ name: "query", variadic: true, description: "Words to find" }],
      options: {
        project: { type: "string", description: "Search this project's prompts" },
        thread: { type: "string", description: "Search this thread's prompts" },
        json: { type: "boolean", description: "Print JSON" },
      },
      constraints: [{ kind: "at-most-one", options: ["project", "thread"] }],
      async run({ options, positionals }) {
        const result = await prompts.search({
          query: positionals.query.join(" "),
          scope: options.thread ? "thread" : options.project ? "project" : "global",
          projectId: options.project ?? null,
          threadId: options.thread ?? null,
          composer: "follow-up",
        });

        return {
          exitCode: 0,
          stdout: options.json
            ? JSON.stringify(result)
            : result.prompts.map((row) => `${row.id}  ${row.snippet.text}`).join("\n") ||
              "No prompts found",
        };
      },
    }),
    "prompt-list": cliCommand({
      summary: "List starred prompts",
      options: { json: { type: "boolean", description: "Print JSON" } },
      async run({ options }) {
        const rows = await prompts.listStarred();

        return {
          exitCode: 0,
          stdout: options.json
            ? JSON.stringify(rows)
            : rows.map((row) => `${row.id}  ${row.prompt.text}`).join("\n") || "No starred prompts",
        };
      },
    }),
    "prompt-star": cliCommand({
      summary: "Star a prompt",
      positionals: [{ name: "text", variadic: true, required: true, description: "Prompt text" }],
      options: { json: { type: "boolean", description: "Print JSON" } },
      async run({ options, positionals }) {
        const result = await prompts.star({
          prompt: { text: positionals.text.join(" "), mentions: [] },
        });

        return { exitCode: 0, stdout: options.json ? JSON.stringify(result) : result.id };
      },
    }),
    "prompt-unstar": cliCommand({
      summary: "Unstar a prompt",
      positionals: [{ name: "id", required: true, description: "Starred prompt ID" }],
      async run({ positionals }) {
        const result = await prompts.unstar({ id: positionals.id });

        if (!result.unstarred)
          throw new PluginCliError("Unknown starred prompt.", { code: "unknown_prompt" });

        return { exitCode: 0, stdout: `Unstarred ${positionals.id}` };
      },
    }),
  };
}
