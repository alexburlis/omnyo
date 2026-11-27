import { cliCommand, type PluginCliContext } from "@omnyo/plugin-sdk";
import type { Workspace } from "./library-contract.ts";
import { searchCurated } from "./curated-contract.ts";
import type { createCuratedService } from "./curated-service.ts";

const selectionOptions = {
  id: { type: "string", required: true, description: "Exact curated catalog ID" },
  generation: {
    type: "string",
    required: true,
    description: "Catalog generation returned by catalog-search",
  },
} as const;

export function curatedCommands(
  catalog: ReturnType<typeof createCuratedService>,
  workspaceFor: (
    options: { project?: string; environment?: string },
    context: PluginCliContext,
  ) => Promise<Workspace>,
) {
  return {
    "catalog-search": cliCommand({
      summary: "Search the shipped curated skill catalog without contacting publishers",
      options: {
        query: {
          type: "string",
          default: "",
          description: "Words in the skill name, description or publisher",
        },
        limit: {
          type: "integer",
          min: 1,
          max: 200,
          default: 30,
          description: "Maximum returned results (1-200)",
        },
      },
      run(input) {
        const snapshot = catalog.get();

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            generation: snapshot.generation,
            entries: searchCurated(snapshot.entries, input.options.query, input.options.limit),
          }),
        };
      },
    }),
    "catalog-prepare": cliCommand({
      summary: "Verify a curated skill for one-time use and return its draft mention reference",
      options: selectionOptions,
      async run(input) {
        return { exitCode: 0, stdout: JSON.stringify(await catalog.prepare(input.options)) };
      },
    }),
    "catalog-review": cliCommand({
      summary: "Review a curated skill's exact files and workspace destination without installing",
      options: {
        ...selectionOptions,
        project: { type: "string", description: "Project ID; defaults to the invoking project" },
        environment: {
          type: "string",
          description: "Environment ID; defaults to the invoking environment",
        },
      },
      async run(input, context) {
        const workspace = await workspaceFor(input.options, context);

        const result = await catalog.review({
          id: input.options.id,
          generation: input.options.generation,
          ...workspace,
        });

        return { exitCode: 0, stdout: JSON.stringify(result) };
      },
    }),
    "catalog-confirm": cliCommand({
      summary: "Install the exact reviewed curated skill into its confirmed workspace",
      options: {
        review: {
          type: "string",
          required: true,
          description: "Review ID returned by catalog-review",
        },
        digest: {
          type: "string",
          required: true,
          description: "SHA-256 returned by catalog-review",
        },
        yes: { type: "boolean", description: "Confirm the reviewed files and destination" },
      },
      async run(input) {
        if (!input.options.yes)
          throw new Error("Review the destination and files, then pass --yes to install.");

        const result = await catalog.confirm({
          reviewId: input.options.review,
          digest: input.options.digest,
        });

        return { exitCode: 0, stdout: JSON.stringify(result) };
      },
    }),
  };
}
