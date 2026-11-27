import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

function allowedGhArgs(args: string[]): boolean {
  if (args[0] === "api" && args[1] === "--method") {
    return (
      args.length === 8 &&
      args[2] === "PUT" &&
      /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/merge$/.test(args[3]) &&
      args[4] === "-f" &&
      /^sha=[a-f0-9]{40}$/.test(args[5]) &&
      args[6] === "-f" &&
      /^merge_method=(merge|squash|rebase)$/.test(args[7])
    );
  }

  if (args[0] === "api") {
    let endpoint: string | undefined;

    for (let index = 1; index < args.length; index++) {
      const arg = args[index];

      if (arg === "--paginate" || arg === "--slurp") continue;

      if (arg === "--hostname") {
        if (args[++index] !== "github.com") return false;
        continue;
      }

      if (arg === "-f") {
        if (!args[++index]?.includes("=")) return false;
        continue;
      }

      if (arg.startsWith("-") || endpoint !== undefined) return false;
      endpoint = arg;
    }

    return (
      endpoint === "user" ||
      endpoint === "graphql" ||
      /^repos\/[\w.-]+\/[\w.-]+\/(?:assignees|labels|pulls\/\d+\/(?:comments|files))(?:\?[^\s]*)?$/.test(
        endpoint ?? "",
      )
    );
  }

  if (
    (args[0] !== "issue" && args[0] !== "pr") ||
    !["view", "comment", "create", "close", "reopen", "edit"].includes(args[1])
  )
    return false;
  let repository = false;
  let number = false;

  for (let index = 2; index < args.length; index++) {
    const arg = args[index];

    if (arg === "-R") {
      if (repository || !/^[\w.-]+\/[\w.-]+$/.test(args[++index] ?? "")) return false;
      repository = true;
    } else if (
      [
        "--json",
        "--body",
        "--title",
        "--add-assignee",
        "--remove-assignee",
        "--add-label",
        "--remove-label",
      ].includes(arg)
    ) {
      if (args[++index] === undefined) return false;
    } else {
      if (number || !/^\d+$/.test(arg)) return false;
      number = true;
    }
  }

  return repository && (args[1] === "create" ? !number : number);
}

export const discoveryContract = defineRpcContract({
  authStatus: {
    input: z.null(),
    output: z
      .object({
        state: z.enum(["ready", "needs_configuration", "unavailable"]),
        error: z.string().nullable(),
      })
      .strict(),
  },
  gh: {
    input: z
      .object({
        args: z.array(z.string()).min(1).refine(allowedGhArgs, "Unsupported GitHub capability"),
        timeoutMs: z.number().int().min(1).max(120_000),
      })
      .strict(),
    output: z.object({ stdout: z.string() }).strict(),
  },
  discover: {
    input: z.object({ roots: z.array(z.string().min(1)).max(100) }).strict(),
    output: z
      .object({
        repos: z.array(z.object({ repo: z.string(), path: z.string() }).strict()),
        problems: z.array(z.string()),
      })
      .strict(),
  },
});
