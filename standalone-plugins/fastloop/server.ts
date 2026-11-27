import {
  cliCommand,
  defineCli,
  defineRpcContract,
  PluginCliError,
  type PluginApi,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  bindingSchema,
  hostContract,
  hostSignals,
  uiContract,
  type ContextBinding,
  type JsonPayload,
  type OwnershipStore,
  type RuntimeMethod,
} from "./contracts.js";
import {
  createRouting,
  sdkContextReader,
  sdkRoutingTransport,
  RoutingError,
  type Caller,
  type Selectors,
} from "./routing.js";
import { runtimeInfo } from "./generated/runtime-info.js";
import { CompletionOutbox, createCompletionPort } from "./completion.js";
import { ThreadLifecycle } from "./lifecycle.js";
import { PayloadError } from "./package-payload.js";
import { registerTools, browserCommands, type CommandPort } from "./commands.js";

type SetupOptions = {
  nodeExecutable: string;
  nativeBinaryPath?: string;
  nativeLicensePaths?: string[];
};

const ownerInput = z.strictObject({
  threadId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
  payload: z.json().default({}),
});

export const ownerContract = defineRpcContract({
  doctor: { input: ownerInput, output: z.json() },
  setup: { input: ownerInput, output: z.json() },
  status: { input: ownerInput, output: z.json() },
});

const runOwner = z.strictObject({
  runId: z.string(),
  sessionId: z.string(),
  binding: bindingSchema,
});

const sessionOwner = z.strictObject({ sessionId: z.string(), binding: bindingSchema });

const acceptedSchema = z.object({ runId: z.string(), sessionId: z.string(), state: z.string() });

const failureCode = (error: Error): string =>
  error instanceof PayloadError || error instanceof RoutingError
    ? error.code
    : "LIFECYCLE_BOUNDARY_FAILED";

type DispatchCall = {
  caller: Caller;
  selectors: Selectors;
  method: RuntimeMethod;
  payload: JsonPayload;
  signal: AbortSignal;
};

export default function server(api: PluginApi): void {
  const ownership: OwnershipStore = {
    async getRun(id) {
      const value = await api.storage.kv.get(`run:${id}`);

      return value === undefined ? undefined : runOwner.parse(value);
    },
    async getSession(id) {
      const value = await api.storage.kv.get(`session:${id}`);

      return value === undefined ? undefined : sessionOwner.parse(value);
    },
    async rememberRun(record) {
      await api.storage.kv.set(`run:${record.runId}`, record);
    },
    async rememberSession(record) {
      await api.storage.kv.set(`session:${record.sessionId}`, record);
    },
  };

  const reader = sdkContextReader(api.sdk);
  const transport = sdkRoutingTransport(api);

  const host = api.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  const completionPort = createCompletionPort(api);

  const outbox = new CompletionOutbox({
    ...completionPort,
    async save(record) {
      await completionPort.save(record);
      api.realtime.publish("fastloop.delivery", { runId: record.runId });
    },
  });

  const lifecycle = new ThreadLifecycle({
    async load(key) {
      const value = await api.storage.kv.get(key);

      return value === undefined ? undefined : z.json().parse(value);
    },
    save: (key, value) => api.storage.kv.set(key, value),
    keys: (prefix) => api.storage.kv.list(prefix),
    async latest(threadId, signal) {
      const rows = await api.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: "1",
        signal,
      });

      return rows[0]?.seq ?? 0;
    },
    async interruptions(threadId, after, signal) {
      const rows = await api.sdk.threads.events.list({
        threadId,
        afterSeq: String(after),
        order: "asc",
        limit: "100",
        types: ["system/thread/interrupted"],
        signal,
      });

      return rows.map((event) => ({
        seq: event.seq,
        reason: z.object({ reason: z.string() }).parse(event.data).reason,
      }));
    },
    invoke: (method, binding, payload) =>
      transport.invoke(
        method,
        { binding, payload },
        { hostId: binding.hostId, signal: AbortSignal.timeout(14000) },
      ),
    async remember(binding, accepted) {
      await ownership.rememberSession({ sessionId: accepted.sessionId, binding });
      await ownership.rememberRun({
        runId: accepted.runId,
        sessionId: accepted.sessionId,
        binding,
      });
    },
    suppressCompletion: (runId) => outbox.suppress(runId),
    async completion(input) {
      await outbox.enqueue(input);
      void outbox
        .drain()
        .catch((error) => lifecycle.faults.set(input.threadId, failureCode(error)));
    },
  });

  api.events.on("experimental_thread.events", ({ thread }) => lifecycle.hint(thread.id));
  api.events.on("thread.archived", ({ thread }) => lifecycle.stop(thread.id));
  api.events.on("thread.deleted", ({ thread }) => lifecycle.stop(thread.id));

  const stopSignal = host.experimental_onSignal("jobChanged", (event) =>
    lifecycle.hint(event.payload.threadId),
  );

  const stopExit = host.experimental_onWorkerExit(async ({ hostId }) => {
    for (const key of await api.storage.kv.list("run:")) {
      const record = runOwner.parse(await api.storage.kv.get(key));

      if (record.binding.hostId === hostId) await lifecycle.stop(record.binding.threadId);
    }
  });

  const stopReconnect = api.sdk.subscribe({
    event: "realtime:connection",
    callback: () => {
      void lifecycle
        .refresh()
        .then(() => outbox.drain())
        .catch((error) => lifecycle.faults.set("reconnect", failureCode(error)));
    },
  });

  const stopHostChanged = api.sdk.subscribe({
    event: "host:changed",
    callback: () => {
      void lifecycle.refresh().catch((error) => lifecycle.faults.set("host", failureCode(error)));
    },
  });

  const ready = lifecycle.recover();
  api.background.service("owned-runs", {
    async start(signal) {
      await ready;
      await outbox.drain();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await lifecycle.close();
      await outbox.close();
    },
  });
  api.onDispose(async () => {
    stopSignal();
    stopExit();
    stopReconnect();
    stopHostChanged();
    await lifecycle.close();
    await outbox.close();
  });

  const routing = (
    beforeSubmit?: (
      binding: ContextBinding,
      payload: JsonPayload,
      signal: AbortSignal,
    ) => Promise<void>,
  ) =>
    createRouting({
      reader,
      transport,
      ownership,
      supportedTargets: new Set(
        runtimeInfo.qualifiedPlatforms.map((target) => `${target.platform}:${target.arch}`),
      ),
      beforeSubmit,
      afterSubmit: (binding, payload, result) => lifecycle.accepted(binding, payload, result),
    });

  const dispatch = async (
    input: DispatchCall,
  ): Promise<{ result: JsonPayload; binding?: ContextBinding }> => {
    let prepared: ContextBinding | undefined;

    try {
      const result = await routing(async (binding, payload, signal) => {
        await ready;
        await lifecycle.prepare(binding, payload, signal);
        prepared = binding;
      }).dispatch(input);

      return { result, binding: prepared };
    } catch (error) {
      if (prepared) {
        const request = z.object({ requestId: z.string() }).parse(input.payload);

        try {
          await transport.invoke(
            "releaseClient",
            { binding: prepared, payload: {} },
            { hostId: prepared.hostId, signal: AbortSignal.timeout(14000) },
          );
          await lifecycle.admissionFailed(prepared, request.requestId, true);
        } catch (cleanup) {
          lifecycle.faults.set(
            prepared.threadId,
            cleanup instanceof Error ? failureCode(cleanup) : "ADMISSION_CLEANUP_UNCERTAIN",
          );
        }
      }

      throw error;
    }
  };

  const call = async (
    method: RuntimeMethod,
    input: z.infer<typeof ownerInput>,
  ): Promise<JsonPayload> =>
    (
      await dispatch({
        caller: { kind: "owner", surface: "ui" },
        selectors: {
          threadId: input.threadId,
          projectId: input.projectId,
          environmentId: input.environmentId,
        },
        method,
        payload: input.payload,
        signal: AbortSignal.timeout(14000),
      })
    ).result;

  api.rpc.register(ownerContract, {
    doctor: (input) => call("doctor", input),
    setup: (input) => call("setup", input),
    status: async (input) => ({
      ...z.record(z.string(), z.json()).parse(await call("status", input)),
      serverLifecycleFaults: [...lifecycle.faults],
    }),
  });

  const owned = async (threadId: string, runId: string): Promise<void> => {
    const record = await ownership.getRun(runId);

    if (!record || record.binding.threadId !== threadId) throw new PayloadError("RUN_NOT_FOUND");
    await call("result", { threadId, payload: { runId } });
  };

  api.rpc.register(uiContract, {
    async listRuns({ threadId }) {
      await ready;
      await reader.thread(threadId, AbortSignal.timeout(10000));

      return lifecycle.index(threadId);
    },
    async getRun({ threadId, runId }) {
      return call("result", { threadId, payload: { runId } });
    },
    async getDelivery({ threadId, runId }) {
      await owned(threadId, runId);
      const record = await completionPort.load(runId);

      return uiContract.getDelivery.output.parse({ state: record?.state ?? "none" });
    },
    async cancelRun({ threadId, runId }) {
      return call("cancel", { threadId, payload: { runId } });
    },
    async events({ threadId, runId, after, waitMs }) {
      return call("events", { threadId, payload: { runId, after, waitMs } });
    },
    async readArtifact({ threadId, runId, evidenceId, offset, maxBytes }) {
      const artifact = z
        .object({ evidence: z.json(), mimeType: z.string(), bytesBase64: z.string().max(13981016) })
        .parse(
          await call("artifact", { threadId, payload: { runId, evidenceId, maxBytes: 10485760 } }),
        );

      const identity = z
        .object({ id: z.string(), runId: z.string(), redacted: z.literal(true) })
        .parse(artifact.evidence);

      if (identity.id !== evidenceId || identity.runId !== runId)
        throw new PayloadError("ARTIFACT_OWNERSHIP_MISMATCH");
      const bytes = Buffer.from(artifact.bytesBase64, "base64");

      if (bytes.byteLength > 10485760 || bytes.toString("base64") !== artifact.bytesBase64)
        throw new PayloadError("ARTIFACT_BYTES_INVALID");

      if (offset > bytes.byteLength) throw new PayloadError("ARTIFACT_OFFSET_INVALID");
      const chunk = bytes.subarray(offset, offset + maxBytes);

      return {
        evidenceId,
        evidence: artifact.evidence,
        mimeType: artifact.mimeType,
        offset,
        totalBytes: bytes.byteLength,
        bytesBase64: chunk.toString("base64"),
        complete: offset + chunk.byteLength === bytes.byteLength,
      };
    },
  });

  const commandPort: CommandPort = {
    async submit(caller, selectors, submission, requestId, waitMs, signal) {
      const { result, binding } = await dispatch({
        caller,
        selectors,
        method: "submit",
        payload: { requestId, submission: z.json().parse(JSON.parse(JSON.stringify(submission))) },
        signal,
      });

      const accepted = acceptedSchema.parse(result);

      if (!binding) throw new PayloadError("ADMISSION_BINDING_MISSING");
      let waitFailureCode: string | undefined;

      if (waitMs > 0) {
        try {
          const batch = z
            .object({ job: z.object({ state: z.string() }) })
            .parse(
              await transport.invoke(
                "events",
                { binding, payload: { runId: accepted.runId, after: 0, waitMs } },
                { hostId: binding.hostId, signal },
              ),
            );

          if (["completed", "cancelled", "interrupted"].includes(batch.job.state))
            return transport.invoke(
              "result",
              { binding, payload: { runId: accepted.runId } },
              { hostId: binding.hostId, signal },
            );
        } catch (error) {
          waitFailureCode = error instanceof Error ? failureCode(error) : "BOUNDED_WAIT_FAILED";
        }
      }

      if (signal.aborted) {
        await lifecycle.stop(binding.threadId);
        throw new PayloadError("RUNTIME_ADMISSION_CANCELLED");
      }

      const observerFailureCode = await lifecycle.detached(binding, requestId);

      const handle: z.infer<typeof acceptedSchema> & {
        waitFailureCode?: string;
        observerFailureCode?: string;
      } = { ...accepted };

      if (waitFailureCode) handle.waitFailureCode = waitFailureCode;

      if (observerFailureCode) handle.observerFailureCode = observerFailureCode;

      return handle;
    },
    async read(method, caller, selectors, payload, signal) {
      return (await dispatch({ method, caller, selectors, payload, signal })).result;
    },
  };

  registerTools(api, commandPort);
  api.cli.register(
    defineCli({
      name: "fastloop",
      summary: "Inspect or explicitly set up the pinned FastLoop runtime",
      commands: {
        ...browserCommands(commandPort),
        setup: cliCommand({
          summary: "Explicitly materialize the pinned runtime and select a Node 24 executable",
          options: {
            thread: { type: "string", description: "Owner-selected thread" },
            project: {
              type: "string",
              description: "Explicit owner project for bootstrap control",
            },
            environment: {
              type: "string",
              description: "Explicit owner environment for bootstrap control",
            },
            node: {
              type: "string",
              required: true,
              description: "Absolute Node 24 executable on the selected host",
            },
            "native-binary": {
              type: "string",
              description: "Explicit trusted native binary path on the selected host",
            },
            "native-license": {
              type: "string",
              repeatable: true,
              description: "Native license path on the selected host",
            },
          },
          async run({ options }, context) {
            if (options.thread && context.threadId && options.thread !== context.threadId)
              throw new PluginCliError("Conflicting thread selectors", {
                code: "cli_context_conflict",
              });

            if (options.project && context.projectId && options.project !== context.projectId)
              throw new PluginCliError("Conflicting project selectors", {
                code: "cli_context_conflict",
              });

            const payload: SetupOptions = { nodeExecutable: options.node };

            if (options["native-binary"]) payload.nativeBinaryPath = options["native-binary"];

            if (options["native-license"]?.length)
              payload.nativeLicensePaths = options["native-license"];

            const result = await call("setup", {
              threadId: options.thread ?? context.threadId,
              projectId: options.project ?? context.projectId,
              environmentId: options.environment,
              payload,
            });

            return { exitCode: 0, stdout: JSON.stringify(result) };
          },
        }),
        doctor: cliCommand({
          summary: "Inspect the current thread's pinned host runtime",
          options: {
            thread: { type: "string", description: "Owner-selected thread" },
            project: {
              type: "string",
              description: "Explicit owner project for bootstrap control",
            },
            environment: {
              type: "string",
              description: "Explicit owner environment for bootstrap control",
            },
            "probe-service": {
              type: "boolean",
              description: "Run a bounded ephemeral public SDK startup/close diagnostic",
            },
          },
          async run({ options }, context) {
            if (options.thread && context.threadId && options.thread !== context.threadId)
              throw new PluginCliError("Conflicting thread selectors", {
                code: "cli_context_conflict",
              });

            if (options.project && context.projectId && options.project !== context.projectId)
              throw new PluginCliError("Conflicting project selectors", {
                code: "cli_context_conflict",
              });
            const threadId = options.thread ?? context.threadId;

            if (!threadId && !(options.project && options.environment))
              throw new PluginCliError("Select --thread or --project and --environment", {
                code: "context_required",
              });

            try {
              const result = await call("doctor", {
                threadId,
                projectId: options.project ?? context.projectId,
                environmentId: options.environment,
                payload:
                  options["probe-service"] === undefined
                    ? {}
                    : { probeService: options["probe-service"] },
              });

              return { exitCode: 0, stdout: JSON.stringify(result) };
            } catch (error) {
              if (error instanceof RoutingError)
                throw new PluginCliError(error.message, { code: error.code.toLowerCase() });
              throw error;
            }
          },
        }),
      },
    }),
  );
}
