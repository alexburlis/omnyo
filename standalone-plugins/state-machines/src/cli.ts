import {
  cliCommand,
  defineCli,
  PluginCliError,
  type PluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@omnyo/plugin-sdk";
import { z } from "zod";

import {
  isJsonObject,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./contracts/definition.js";
import { stateMachinesRpc } from "./contracts/rpc.js";
import { canonicalJson } from "./definition/canonical.js";

const jsonOption = { type: "boolean", description: "Print machine-readable JSON." } as const;

const machineOption = {
  type: "string",
  required: true,
  description: "Exact machine ID.",
} as const;

const requestOption = {
  type: "string",
  required: true,
  description: "Unique request ID; reuse it only when retrying the same action.",
} as const;

const revisionOption = {
  type: "integer",
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  required: true,
  description: "Expected revision from the latest read; never force-overwrites.",
} as const;

const instancePositionals = [
  { name: "instance", required: true, description: "Exact instance ID." },
] as const;

const pagingOptions = {
  after: {
    type: "integer",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    default: 0,
    description: "Exclusive sequence cursor; starts at retained history when omitted.",
  },
  limit: {
    type: "integer",
    min: 1,
    max: 100,
    default: 100,
    description: "Maximum returned rows (1–100).",
  },
} as const;

function inputJson(source: string, maxBytes: number): JsonValue {
  if (new TextEncoder().encode(source).length > maxBytes) {
    throw new PluginCliError(`JSON input exceeds ${maxBytes} UTF-8 bytes.`, {
      code: "OUTPUT_LIMIT",
    });
  }

  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(source));

    if (parsed.success) return parsed.data;
  } catch {
    throw new PluginCliError("Input must contain valid bounded JSON.", {
      code: "VALIDATION_FAILED",
    });
  }

  throw new PluginCliError("Input must contain bounded JSON without unsafe keys.", {
    code: "VALIDATION_FAILED",
  });
}

function contextJson(source: string): JsonObject {
  const value = inputJson(source, 65_536);

  if (!isJsonObject(value)) {
    throw new PluginCliError("Context must be a JSON object.", { code: "VALIDATION_FAILED" });
  }

  return value;
}

async function invoke(
  api: PluginApi,
  method: keyof typeof stateMachinesRpc,
  input: JsonObject,
  context: PluginCliContext,
  exportDocument = false,
): Promise<PluginCliResult> {
  const validated = stateMachinesRpc[method].input.safeParse(input);

  if (!validated.success) {
    return {
      exitCode: 1,
      stdout: `${JSON.stringify({
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "Command fields do not match the State Machines contract.",
          issues: validated.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        },
      })}\n`,
      stderr: "VALIDATION_FAILED: Command fields do not match the State Machines contract.\n",
    };
  }

  let response: unknown;

  try {
    response = await api.sdk.plugins.callRpc({
      pluginId: api.pluginId,
      method,
      input,
      outputSchema: z.unknown(),
      signal: context.signal,
    });
  } catch {
    throw new PluginCliError(
      "State Machines RPC is unavailable. Inspect plugin status before retrying.",
      {
        code: "CAPABILITY_UNAVAILABLE",
      },
    );
  }

  const decoded = stateMachinesRpc[method].output.safeParse(response);

  if (!decoded.success) {
    throw new PluginCliError(
      "State Machines returned an invalid RPC response. Inspect plugin status.",
      {
        code: "CAPABILITY_UNAVAILABLE",
      },
    );
  }

  const result = decoded.data;

  if (!result.ok) {
    return {
      exitCode: 1,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: `${result.error.code}: ${result.error.message}\n`,
    };
  }

  let stdout: string;

  try {
    if (exportDocument) {
      const exported = stateMachinesRpc.sm_machine_export.output.parse(response);

      if (!exported.ok) throw new Error("Export failed");
      stdout = `${canonicalJson(exported.value.definition)}\n`;
    } else stdout = `${JSON.stringify(result)}\n`;
  } catch {
    throw new PluginCliError("The result is too large to export. Narrow the query.", {
      code: "OUTPUT_LIMIT",
    });
  }

  if (new TextEncoder().encode(stdout).length > 983_040) {
    throw new PluginCliError("The result exceeds 960 KiB. Narrow the query.", {
      code: "OUTPUT_LIMIT",
    });
  }

  return { exitCode: 0, stdout };
}

function controlCommand(api: PluginApi, kind: "pause" | "pause-after-step" | "resume" | "stop") {
  return cliCommand({
    summary: `${kind === "pause-after-step" ? "Pause after the current step in" : kind[0]!.toUpperCase() + kind.slice(1)} an instance.`,
    options: {
      "expected-revision": revisionOption,
      "request-id": requestOption,
      json: jsonOption,
    },
    positionals: instancePositionals,
    run({ options, positionals }, context) {
      return invoke(
        api,
        "sm_instance_control",
        {
          instanceId: positionals.instance,
          expectedControlRevision: options["expected-revision"],
          operation: { kind },
          requestId: options["request-id"],
        },
        context,
      );
    },
  });
}

export function registerStateMachineCli(api: PluginApi): void {
  api.cli.register(
    defineCli({
      name: "state-machines",
      summary: "Create and operate durable cyclic workflows.",
      description:
        "All commands use the shared State Machines RPC policy. JSON input options support --<option>-stdin through omnyo. Export writes definition JSON to stdout; redirect it on the invoking machine. No command reads coordinator file paths. A client action does not prove human approval or grant effect authority.",
      commands: {
        list: cliCommand({
          summary: "List machines in one project or all accessible projects.",
          options: {
            project: {
              type: "string",
              description: "Project ID; omit to list accessible machines.",
            },
            json: jsonOption,
          },
          run({ options }, context) {
            return invoke(api, "sm_machine_list", { projectId: options.project ?? null }, context);
          },
        }),
        create: cliCommand({
          summary: "Create a draft machine without starting any work.",
          options: {
            project: { type: "string", required: true, description: "Owning project ID." },
            name: { type: "string", required: true, description: "Machine name." },
            description: { type: "string", default: "", description: "Machine description." },
            template: {
              type: "enum",
              values: ["blank", "local-check-loop", "release-loop"],
              default: "blank",
              description: "Draft template; release effects remain subject to exact authority.",
            },
            "request-id": requestOption,
            environment: {
              type: "string",
              description: "Persistent environment ID required by the local-check-loop template.",
            },
            json: jsonOption,
          },
          run({ options }, context) {
            const input: JsonObject = {
              projectId: options.project,
              name: options.name,
              description: options.description,
              template: options.template,
              requestId: options["request-id"],
            };

            if (options.environment !== undefined) input.environmentId = options.environment;

            return invoke(api, "sm_machine_create", input, context);
          },
        }),
        draft: cliCommand({
          summary: "Read the current draft and its revision.",
          options: { machine: machineOption, json: jsonOption },
          run({ options }, context) {
            return invoke(api, "sm_machine_draft_get", { machineId: options.machine }, context);
          },
        }),
        import: cliCommand({
          summary: "Replace one draft at its exact revision with bounded JSON.",
          description:
            "Use --document-stdin < compact-definition.json for one JSON line up to 16 KiB. Inline --document supports up to 256 KiB. The document must carry the target machine ID; import does not publish or start it.",
          options: {
            machine: machineOption,
            document: {
              type: "string",
              required: true,
              stdin: true,
              description: "Draft JSON; inline maximum 262144 bytes, stdin maximum 16384 bytes.",
            },
            "expected-revision": revisionOption,
            "request-id": requestOption,
            json: jsonOption,
          },
          run({ options }, context) {
            return invoke(
              api,
              "sm_machine_draft_save",
              {
                machineId: options.machine,
                document: inputJson(options.document, 262_144),
                expectedRevision: options["expected-revision"],
                requestId: options["request-id"],
              },
              context,
            );
          },
        }),
        validate: cliCommand({
          summary: "Validate one exact draft revision without publishing.",
          options: { machine: machineOption, revision: revisionOption, json: jsonOption },
          run({ options }, context) {
            return invoke(
              api,
              "sm_machine_validate",
              { machineId: options.machine, revision: options.revision },
              context,
            );
          },
        }),
        publish: cliCommand({
          summary: "Publish an immutable version from one exact draft revision.",
          description: "Existing instances remain pinned to their current version.",
          options: {
            machine: machineOption,
            "expected-revision": revisionOption,
            note: { type: "string", default: "", description: "Version note." },
            "request-id": requestOption,
            json: jsonOption,
          },
          run({ options }, context) {
            return invoke(
              api,
              "sm_machine_publish",
              {
                machineId: options.machine,
                expectedRevision: options["expected-revision"],
                note: options.note,
                requestId: options["request-id"],
              },
              context,
            );
          },
        }),
        versions: cliCommand({
          summary: "List published versions of a machine.",
          options: { machine: machineOption, json: jsonOption },
          run({ options }, context) {
            return invoke(api, "sm_machine_versions", { machineId: options.machine }, context);
          },
        }),
        version: cliCommand({
          summary: "Inspect one immutable published version.",
          options: {
            machine: machineOption,
            version: { type: "string", required: true, description: "Exact published version ID." },
            json: jsonOption,
          },
          run({ options }, context) {
            return invoke(
              api,
              "sm_machine_version_get",
              { machineId: options.machine, versionId: options.version },
              context,
            );
          },
        }),
        export: cliCommand({
          summary: "Write canonical definition JSON to stdout for local redirection.",
          description:
            "Without --version exports the current draft. Use > new-definition.json on the invoking machine. This command never creates or overwrites a coordinator file.",
          options: {
            machine: machineOption,
            version: {
              type: "string",
              description: "Published version ID; omit for current draft.",
            },
            json: jsonOption,
          },
          run({ options }, context) {
            const input: JsonObject = { machineId: options.machine };

            if (options.version !== undefined) input.versionId = options.version;

            return invoke(api, "sm_machine_export", input, context, true);
          },
        }),
        start: cliCommand({
          summary: "Start one instance pinned to an exact published version.",
          options: {
            machine: machineOption,
            version: { type: "string", required: true, description: "Published version ID." },
            environment: {
              type: "string",
              required: true,
              description: "Existing persistent environment ID.",
            },
            context: {
              type: "string",
              required: true,
              stdin: true,
              description:
                "Context JSON object; inline maximum 65536 bytes, stdin maximum 16384 bytes.",
            },
            "home-thread": {
              type: "string",
              description:
                "Visible chat in the machine's project that becomes this run's home: its questions open there and its step chats nest under it. Omit to create a new home chat.",
            },
            "request-id": requestOption,
            json: jsonOption,
          },
          run({ options }, context) {
            const input: JsonObject = {
              machineId: options.machine,
              versionId: options.version,
              environmentId: options.environment,
              context: contextJson(options.context),
              requestId: options["request-id"],
            };

            if (options["home-thread"] !== undefined)
              input.home = { kind: "thread", threadId: options["home-thread"] };

            return invoke(api, "sm_instance_start", input, context);
          },
        }),
        instances: cliCommand({
          summary: "List instances using bounded server-side filters.",
          options: {
            machine: { type: "string", description: "Machine ID filter." },
            project: { type: "string", description: "Project ID filter." },
            status: { type: "string", description: "Lifecycle filter, such as running or paused." },
            cursor: { type: "string", description: "Exclusive instance cursor." },
            limit: pagingOptions.limit,
            json: jsonOption,
          },
          run({ options }, context) {
            const input: JsonObject = { limit: options.limit };

            if (options.machine !== undefined) input.machineId = options.machine;

            if (options.project !== undefined) input.projectId = options.project;

            if (options.status !== undefined) input.status = options.status;

            if (options.cursor !== undefined) input.cursor = options.cursor;

            return invoke(api, "sm_instance_list", input, context);
          },
        }),
        status: cliCommand({
          summary: "Read durable instance status, current entry and control revision.",
          options: { json: jsonOption },
          positionals: instancePositionals,
          run({ positionals }, context) {
            return invoke(
              api,
              "sm_instance_inspect",
              { instanceId: positionals.instance },
              context,
            );
          },
        }),
        signal: cliCommand({
          summary: "Deliver one event to the exact current subscription window.",
          description:
            "Read events and status first. Reuse source/event/request IDs only for identical retries. Expired requests are never resent automatically. A signal is not proof of human authority.",
          positionals: instancePositionals,
          options: {
            entry: { type: "string", required: true, description: "Exact current entry ID." },
            subscription: {
              type: "string",
              required: true,
              description: "Exact subscription ID from events.",
            },
            epoch: { ...revisionOption, min: 1, description: "Current subscription epoch." },
            source: { type: "string", required: true, description: "Stable event source ID." },
            "event-id": {
              type: "string",
              required: true,
              description: "Stable event ID within the source and subscription window.",
            },
            subject: {
              type: "string",
              required: true,
              description: "Exact subject correlation ID.",
            },
            type: {
              type: "string",
              required: true,
              description: "Declared event type from events.",
            },
            payload: {
              type: "string",
              required: true,
              stdin: true,
              description: "Event payload JSON, at most 16384 UTF-8 bytes.",
            },
            "request-id": requestOption,
            json: jsonOption,
          },
          run({ options, positionals }, context) {
            return invoke(
              api,
              "sm_instance_signal",
              {
                instanceId: positionals.instance,
                entryId: options.entry,
                subscriptionId: options.subscription,
                epoch: options.epoch,
                sourceId: options.source,
                eventId: options["event-id"],
                subject: options.subject,
                eventType: options.type,
                payload: inputJson(options.payload, 16_384),
                requestId: options["request-id"],
              },
              context,
            );
          },
        }),
        pause: controlCommand(api, "pause"),
        "pause-after-step": controlCommand(api, "pause-after-step"),
        resume: controlCommand(api, "resume"),
        stop: controlCommand(api, "stop"),
        "cancel-step": cliCommand({
          summary: "Request cancellation of one exact current step.",
          positionals: instancePositionals,
          options: {
            invocation: { type: "string", required: true, description: "Exact invocation ID." },
            entry: { type: "string", required: true, description: "Exact current entry ID." },
            "expected-revision": revisionOption,
            "request-id": requestOption,
            json: jsonOption,
          },
          run({ options, positionals }, context) {
            return invoke(
              api,
              "sm_instance_control",
              {
                instanceId: positionals.instance,
                expectedControlRevision: options["expected-revision"],
                operation: {
                  kind: "cancel-step",
                  invocationId: options.invocation,
                  entryId: options.entry,
                },
                requestId: options["request-id"],
              },
              context,
            );
          },
        }),
        "mark-unknown": cliCommand({
          summary: "Acknowledge an unknown outcome for an exact stopping step.",
          description:
            "Does not hide a known live process or release ownership. The shared service rejects confirmed-live work; restart remains blocked until reconciliation.",
          positionals: instancePositionals,
          options: {
            invocation: { type: "string", required: true, description: "Exact invocation ID." },
            entry: { type: "string", required: true, description: "Exact current entry ID." },
            "expected-revision": revisionOption,
            "instance-revision": revisionOption,
            reason: { type: "string", required: true, description: "Why the outcome is unknown." },
            evidence: {
              type: "string",
              required: true,
              stdin: true,
              description: "Non-secret outcome evidence (at most 16384 UTF-8 bytes).",
            },
            "request-id": requestOption,
            json: jsonOption,
          },
          run({ options, positionals }, context) {
            return invoke(
              api,
              "sm_instance_control",
              {
                instanceId: positionals.instance,
                expectedControlRevision: options["expected-revision"],
                operation: {
                  kind: "mark-unknown",
                  invocationId: options.invocation,
                  entryId: options.entry,
                  expectedRevision: options["instance-revision"],
                  reason: options.reason,
                  evidence: options.evidence,
                  acknowledged: true,
                },
                requestId: options["request-id"],
              },
              context,
            );
          },
        }),
        attention: cliCommand({
          summary: "List current gates and unresolved outcomes.",
          options: {
            machine: { type: "string", description: "Machine ID filter." },
            instance: { type: "string", description: "Instance ID filter." },
            json: jsonOption,
          },
          run({ options }, context) {
            return invoke(
              api,
              "sm_attention_list",
              { machineId: options.machine ?? null, instanceId: options.instance ?? null },
              context,
            );
          },
        }),
        resolve: cliCommand({
          summary: "Choose one server-listed decision for the exact current gate.",
          positionals: instancePositionals,
          options: {
            attention: { type: "string", required: true, description: "Exact attention item ID." },
            entry: { type: "string", required: true, description: "Exact current entry ID." },
            "expected-revision": revisionOption,
            decision: {
              type: "string",
              required: true,
              description: "Server-listed decision name.",
            },
            evidence: {
              type: "string",
              required: true,
              stdin: true,
              description: "Non-secret decision evidence; use an empty string if permitted.",
            },
            "request-id": requestOption,
            json: jsonOption,
          },
          run({ options, positionals }, context) {
            return invoke(
              api,
              "sm_attention_resolve",
              {
                instanceId: positionals.instance,
                attentionId: options.attention,
                entryId: options.entry,
                expectedRevision: options["expected-revision"],
                decision: options.decision,
                evidence: options.evidence,
                requestId: options["request-id"],
              },
              context,
            );
          },
        }),
        history: cliCommand({
          summary: "Read a bounded page of durable transitions, events and controls.",
          positionals: instancePositionals,
          options: { ...pagingOptions, json: jsonOption },
          run({ options, positionals }, context) {
            return invoke(
              api,
              "sm_history_list",
              {
                instanceId: positionals.instance,
                before: null,
                after: options.after,
                limit: options.limit,
                kinds: [],
              },
              context,
            );
          },
        }),
        "state-history": cliCommand({
          summary: "Read retained state visits and checkpoint bounds.",
          positionals: instancePositionals,
          options: {
            ...pagingOptions,
            state: { type: "string", description: "Optional state ID filter." },
            json: jsonOption,
          },
          run({ options, positionals }, context) {
            return invoke(
              api,
              "sm_state_history",
              {
                instanceId: positionals.instance,
                stateId: options.state ?? null,
                before: null,
                after: options.after,
                limit: options.limit,
              },
              context,
            );
          },
        }),
        events: cliCommand({
          summary: "Read declared events and current subscription IDs and epochs.",
          positionals: instancePositionals,
          options: { json: jsonOption },
          run({ positionals }, context) {
            return invoke(api, "sm_events_catalog", { instanceId: positionals.instance }, context);
          },
        }),
        logs: cliCommand({
          summary: "Read a bounded page of one invocation's output.",
          positionals: [
            { name: "invocation", required: true, description: "Exact invocation ID." },
          ],
          options: {
            cursor: {
              type: "integer",
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              default: 0,
              description: "Byte cursor from the previous page.",
            },
            limit: {
              type: "integer",
              min: 1,
              max: 32_768,
              default: 32_768,
              description: "Maximum page bytes (1–32768).",
            },
            json: jsonOption,
          },
          run({ options, positionals }, context) {
            return invoke(
              api,
              "sm_log_read",
              {
                invocationId: positionals.invocation,
                cursor: options.cursor,
                limit: options.limit,
              },
              context,
            );
          },
        }),
        environments: cliCommand({
          summary: "List existing environments and their availability.",
          options: {
            project: { type: "string", required: true, description: "Owning project ID." },
            json: jsonOption,
          },
          run({ options }, context) {
            return invoke(api, "sm_environment_list", { projectId: options.project }, context);
          },
        }),
      },
    }),
  );
}
