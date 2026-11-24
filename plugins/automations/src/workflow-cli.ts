import {
  cliCommand,
  PluginCliError,
  type PluginCliCommand,
  type PluginCliContext,
  type PluginCliResult,
} from "@omnyo/plugin-sdk";
import {
  workflowRpcContract,
  type WorkflowHandlers,
} from "./workflow-contract.js";
import { openSeoRpcContract } from "./openseo-contract.js";
import type { OpenSeoHandlers } from "./openseo-access.js";

const project = {
  type: "string",
  required: true,
  description: "Project that owns the imported copy",
} as const;

const imported = {
  name: "importId",
  required: true,
  description: "Imported copy ID",
} as const;

const json = { type: "boolean", description: "Emit JSON" } as const;

const revision = {
  type: "integer",
  required: true,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  description: "Expected binding revision",
} as const;

const target = { project, json };

const text = {
  type: "string",
  stdin: true,
  description:
    "Reviewed package JSON; use --text-stdin to read a local file through stdin",
} as const;

const shareId = {
  type: "string",
  description: "Opaque share ID from an official Omnyo share link",
} as const;

const writeResult = (value: unknown): PluginCliResult => ({
  exitCode: 0,
  stdout: `${JSON.stringify(value, null, 2)}\n`,
});

async function attempt(
  run: () => unknown | Promise<unknown>,
): Promise<PluginCliResult> {
  try {
    return writeResult(await run());
  } catch (error) {
    throw new PluginCliError(
      error instanceof Error ? error.message : String(error),
      { code: "workflow_failed" },
    );
  }
}

function setupContext(context: PluginCliContext) {
  if (context.threadId)
    throw new PluginCliError(
      "Run OpenSEO setup from an owner terminal outside a chat.",
      { code: "owner_setup_required" },
    );

  return {
    experimental_caller: { kind: "client" } as const,
    experimental_signal: context.signal ?? new AbortController().signal,
  };
}

function openSeoCommands(handlers: OpenSeoHandlers) {
  const site = {
    type: "string",
    required: true,
    description: "Exact site hostname for this copy",
  } as const;

  const providerProject = {
    type: "string",
    required: true,
    description: "Matching OpenSEO project ID",
  } as const;

  const contract = openSeoRpcContract;

  return {
    "openseo-status": cliCommand({
      summary: "Show OpenSEO setup status for this copy",
      positionals: [imported],
      options: target,
      run: (input, context) =>
        attempt(() =>
          handlers.workflow_openseo_status(
            contract.workflow_openseo_status.input.parse({
              projectId: input.options.project,
              importId: input.positionals.importId,
            }),
            setupContext(context),
          ),
        ),
    }),
    "openseo-disconnect": cliCommand({
      summary: "Disconnect this copy and keep approved evidence",
      positionals: [imported],
      options: target,
      run: (input, context) =>
        attempt(() =>
          handlers.workflow_openseo_disconnect(
            contract.workflow_openseo_disconnect.input.parse({
              projectId: input.options.project,
              importId: input.positionals.importId,
            }),
            setupContext(context),
          ),
        ),
    }),
    "openseo-projects": cliCommand({
      summary:
        "List workspace projects matching a site, using the key from Automations settings",
      positionals: [imported],
      options: { ...target, site },
      run: (input, context) =>
        attempt(() =>
          handlers.workflow_openseo_projects(
            contract.workflow_openseo_projects.input.parse({
              projectId: input.options.project,
              importId: input.positionals.importId,
              site: input.options.site,
            }),
            setupContext(context),
          ),
        ),
    }),
    "openseo-connect": cliCommand({
      summary:
        "Authorize one site for this copy using the key from Automations settings",
      positionals: [imported],
      options: { ...target, site, "openseo-project": providerProject },
      run: (input, context) =>
        attempt(() =>
          handlers.workflow_openseo_connect(
            contract.workflow_openseo_connect.input.parse({
              projectId: input.options.project,
              importId: input.positionals.importId,
              site: input.options.site,
              openSeoProjectId: input.options["openseo-project"],
            }),
            setupContext(context),
          ),
        ),
    }),
    "openseo-keywords": cliCommand({
      summary: "Read up to 50 saved OpenSEO keywords using zero credits",
      positionals: [imported],
      options: { ...target, site, "openseo-project": providerProject },
      run: (input, context) =>
        attempt(() =>
          handlers.workflow_openseo_keywords(
            contract.workflow_openseo_keywords.input.parse({
              projectId: input.options.project,
              importId: input.positionals.importId,
              site: input.options.site,
              openSeoProjectId: input.options["openseo-project"],
            }),
            setupContext(context),
          ),
        ),
    }),
  };
}

export function workflowCliCommands(
  handlers: WorkflowHandlers,
  openSeoHandlers?: OpenSeoHandlers,
): Record<string, PluginCliCommand> {
  const contract = workflowRpcContract;

  const commands = {
    ...(openSeoHandlers ? openSeoCommands(openSeoHandlers) : {}),
    options: cliCommand({
      summary:
        "List connected devices and available Codex or Claude Code models",
      options: {
        host: {
          type: "string",
          description: "Connected device ID for model choices",
        },
        json,
      },
      run: (input) =>
        attempt(() =>
          handlers.workflow_options(
            contract.workflow_options.input.parse({
              hostId: input.options.host,
            }),
          ),
        ),
    }),
    inspect: cliCommand({
      summary: "Review inert package data from stdin or an official share ID",
      options: {
        text,
        "share-id": shareId,
        template: {
          type: "enum",
          values: ["weekly-content-feed"],
          description: "Review a built-in template",
        },
        json,
      },
      constraints: [
        { kind: "exactly-one", options: ["text", "share-id", "template"] },
      ],
      run: (input) =>
        attempt(() =>
          handlers.workflow_inspect(
            contract.workflow_inspect.input.parse(
              input.options.text !== undefined
                ? { kind: "file", text: input.options.text }
                : input.options.template
                  ? { kind: "template", template: input.options.template }
                  : { kind: "link", shareId: input.options["share-id"] },
            ),
          ),
        ),
    }),
    import: cliCommand({
      summary: "Save a reviewed disabled copy with an idempotent request ID",
      options: {
        ...target,
        review: {
          type: "string",
          required: true,
          description: "Review ID returned by inspect",
        },
        digest: {
          type: "string",
          required: true,
          description: "Exact package digest returned by inspect",
        },
        request: {
          type: "string",
          required: true,
          description: "Stable request ID; reuse on retry",
        },
      },
      run: (input) =>
        attempt(() =>
          handlers.workflow_install(
            contract.workflow_install.input.parse({
              projectId: input.options.project,
              reviewId: input.options.review,
              packageDigest: input.options.digest,
              requestId: input.options.request,
            }),
          ),
        ),
    }),
    artifacts: cliCommand({
      summary: "Read the immutable manifest and files for a completed run",
      positionals: [imported],
      options: {
        ...target,
        run: {
          type: "string",
          required: true,
          description: "Automation run ID",
        },
      },
      run: (input) =>
        attempt(() =>
          handlers.workflow_artifacts(
            contract.workflow_artifacts.input.parse({
              projectId: input.options.project,
              importId: input.positionals.importId,
              runId: input.options.run,
            }),
          ),
        ),
    }),
    list: cliCommand({
      summary: "List imported project copies",
      options: target,
      run: (input) =>
        attempt(() =>
          handlers.workflow_list(
            contract.workflow_list.input.parse({
              projectId: input.options.project,
            }),
          ),
        ),
    }),
    bind: cliCommand({
      summary: "Bind a connected device, CLI model and explicit inputs",
      positionals: [imported],
      options: {
        ...target,
        revision,
        bindings: {
          type: "string",
          required: true,
          stdin: true,
          description:
            "JSON: hostId, providerId=codex|claude-code, model=<connected CLI model>, inputs, optional source selection. Use --bindings-stdin",
        },
      },
      run: (input, context) =>
        attempt(() => {
          const bind = contract.workflow_bind.input.parse({
            projectId: input.options.project,
            importId: input.positionals.importId,
            expectedRevision: input.options.revision,
            bindings: JSON.parse(input.options.bindings),
          });

          if (bind.bindings.source?.kind === "openseo") setupContext(context);

          return handlers.workflow_bind(bind);
        }),
    }),
    preview: cliCommand({
      summary: "Show a model-free preview",
      positionals: [imported],
      options: target,
      run: (input) =>
        attempt(() =>
          handlers.workflow_preview(
            contract.workflow_preview.input.parse({
              projectId: input.options.project,
              importId: input.positionals.importId,
            }),
          ),
        ),
    }),
    confirm: cliCommand({
      summary: "Confirm exact execution digest and current recipient bindings",
      positionals: [imported],
      options: {
        ...target,
        revision,
        digest: {
          type: "string",
          required: true,
          description: "Reviewed execution digest",
        },
      },
      run: (input) =>
        attempt(() =>
          handlers.workflow_confirm(
            contract.workflow_confirm.input.parse({
              projectId: input.options.project,
              importId: input.positionals.importId,
              expectedRevision: input.options.revision,
              executionDigest: input.options.digest,
            }),
          ),
        ),
    }),
    enable: cliCommand({
      summary: "Explicitly enable the confirmed workflow schedule",
      positionals: [imported],
      options: target,
      run: (input) =>
        attempt(() =>
          handlers.workflow_enable(
            contract.workflow_enable.input.parse({
              projectId: input.options.project,
              importId: input.positionals.importId,
            }),
          ),
        ),
    }),
    run: cliCommand({
      summary: "Start a confirmed restricted workflow",
      positionals: [imported],
      options: {
        ...target,
        request: {
          type: "string",
          required: true,
          description: "Stable request ID; reuse on retry",
        },
      },
      run: (input) =>
        attempt(() =>
          handlers.workflow_run(
            contract.workflow_run.input.parse({
              projectId: input.options.project,
              importId: input.positionals.importId,
              requestId: input.options.request,
            }),
          ),
        ),
    }),
    export: cliCommand({
      summary: "Write a portable package to stdout",
      positionals: [imported],
      options: target,
      run: async (input) => {
        const result = await handlers.workflow_export(
          contract.workflow_export.input.parse({
            projectId: input.options.project,
            importId: input.positionals.importId,
          }),
        );

        return input.options.json
          ? writeResult(result)
          : { exitCode: 0, stdout: result.text };
      },
    }),
    "export-automation": cliCommand({
      summary: "Export a sanitized automation as a local workflow file",
      options: {
        ...target,
        automation: {
          type: "string",
          required: true,
          description: "Existing automation ID",
        },
        prompt: {
          type: "string",
          stdin: true,
          description: "Explicit sanitized prompt for an agent automation",
        },
      },
      run: async (input) => {
        const result = await handlers.workflow_export_automation(
          contract.workflow_export_automation.input.parse({
            projectId: input.options.project,
            automationId: input.options.automation,
            sanitizedPrompt: input.options.prompt,
          }),
        );

        return input.options.json
          ? writeResult(result)
          : { exitCode: 0, stdout: result.text };
      },
    }),
  };

  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      "workflow " + name,
      command,
    ]),
  );
}
