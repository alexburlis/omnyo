import type {
  PluginApi,
  ExperimentalPluginRpcHandlerContext,
} from "@omnyo/plugin-sdk";
import {
  composerPredictionHostContract,
  composerPredictionRpcContract,
  composerPredictionTimeouts,
  type ComposerPredictionResult,
} from "./prediction-contract.js";
import { predictionContext } from "./prediction-context.js";

function isCodexExecutable(path: string): boolean {
  const name = "codex";

  return (
    path === name ||
    path === `${name}.exe` ||
    path === `${name}.cmd` ||
    new RegExp(
      `^(?:\\/|[A-Za-z]:[\\\\/]).*[\\\\/]${name}(?:\\.(?:exe|cmd))?$`,
      "u",
    ).test(path)
  );
}

export function registerComposerPredictions(api: PluginApi): void {
  const host = api.hosts.experimental_client({
    contract: composerPredictionHostContract,
  });

  const active = new Map<
    string,
    {
      requestId: string;
      controller: AbortController;
      done: Promise<ComposerPredictionResult> | null;
      hostId: string | null;
      validate: (() => Promise<void>) | null;
    }
  >();

  const cancelled = new Map<string, number>();
  let disposed = false;

  function authorize(context: ExperimentalPluginRpcHandlerContext): void {
    if (
      context.experimental_caller.kind !== "plugin" ||
      context.experimental_caller.pluginId !== "omnyo--composer-predictions"
    )
      throw new Error("Composer predictions caller is not authorized");
  }

  function stop(threadId: string, requestId?: string): boolean {
    const request = active.get(threadId);

    if (
      !request ||
      (requestId !== undefined && requestId !== request.requestId)
    )
      return false;
    request.controller.abort();
    active.delete(threadId);

    return true;
  }

  api.rpc.register(
    composerPredictionRpcContract,
    {
      "experimental_composer-predictions.v1.predict": async (
        input,
        context,
      ) => {
        authorize(context);

        if (disposed)
          throw new Error("Account Pooler predictions are unavailable");

        if (!isCodexExecutable(input.cliPath))
          throw new Error("Use a Codex executable for predictions");
        const identity = JSON.stringify([input.threadId, input.requestId]);

        for (const [key, expiresAt] of cancelled)
          if (expiresAt <= Date.now()) cancelled.delete(key);

        if (cancelled.has(identity)) throw new Error("Prediction canceled");
        const existing = active.get(input.threadId);

        if (existing?.requestId === input.requestId && existing.done !== null)
          return existing.done;
        stop(input.threadId);

        const request = {
          requestId: input.requestId,
          controller: new AbortController(),
          done: null as Promise<ComposerPredictionResult> | null,
          hostId: null as string | null,
          validate: null as (() => Promise<void>) | null,
        };

        active.set(input.threadId, request);

        const signal = AbortSignal.any([
          request.controller.signal,
          AbortSignal.timeout(composerPredictionTimeouts.operationMs),
        ]);

        function current(): void {
          if (
            disposed ||
            active.get(input.threadId) !== request ||
            signal.aborted
          )
            throw new Error("Prediction canceled");
        }

        function bounded<T>(promise: Promise<T>): Promise<T> {
          if (signal.aborted)
            return Promise.reject(new Error("Prediction canceled"));

          return new Promise((resolve, reject) => {
            const abort = () => reject(new Error("Prediction canceled"));
            signal.addEventListener("abort", abort, { once: true });
            promise.then(
              (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
              },
              (error: unknown) => {
                signal.removeEventListener("abort", abort);
                reject(error);
              },
            );
          });
        }

        const work = async () => {
          try {
            const threadId = input.threadId;

            const readThread = () =>
              bounded(
                api.sdk.threads.get({
                  threadId,
                  include: "environment",
                  signal,
                }),
              );

            const readCompletion = (beforeSeq?: number) =>
              bounded(
                api.sdk.threads.events.list({
                  threadId,
                  types: ["turn/completed"],
                  order: "desc",
                  limit: "1",
                  ...(beforeSeq === undefined
                    ? {}
                    : { beforeSeq: String(beforeSeq) }),
                  signal,
                }),
              ).then(([event]) => event);

            const [thread, latest] = await Promise.all([
              readThread(),
              readCompletion(),
            ]);

            current();

            if (
              thread.status !== "idle" ||
              thread.queuedMessageCount > 0 ||
              thread.archivedAt !== null ||
              thread.deletedAt !== null
            )
              throw new Error(
                "Predictions require an idle thread with no queued messages",
              );

            const environment =
              "environment" in thread ? thread.environment : null;

            if (!environment?.hostId || !environment.path)
              throw new Error("The thread has no available environment");
            const { hostId } = environment;
            request.hostId = hostId;

            const latestSequence = latest?.seq;

            const source =
              latestSequence === input.sourceSeq
                ? latest
                : await readCompletion(input.sourceSeq + 1);

            if (
              thread.work?.basis !== input.basis ||
              source?.seq !== input.sourceSeq ||
              source.type !== "turn/completed" ||
              source.data.status !== "completed"
            )
              throw new Error("Prediction source changed");

            const readHost = () =>
              bounded(api.sdk.hosts.get({ hostId, signal }));

            const assertSource = async () => {
              const [now, completion, machine] = await Promise.all([
                readThread(),
                readCompletion(),
                readHost(),
              ]);

              const latestEnvironment =
                "environment" in now ? now.environment : null;

              current();

              if (
                machine.status !== "connected" ||
                machine.lifecycle.phase !== "active"
              )
                throw new Error("The thread’s machine is unavailable");

              if (
                now.providerId !== thread.providerId ||
                now.status !== "idle" ||
                now.queuedMessageCount > 0 ||
                now.archivedAt !== null ||
                now.deletedAt !== null ||
                now.work?.basis !== input.basis ||
                latestEnvironment?.hostId !== hostId ||
                latestEnvironment.path !== environment.path ||
                completion?.seq !== latestSequence
              ) {
                request.controller.abort();
                throw new Error("Prediction source changed");
              }
            };

            request.validate = assertSource;

            const context = await bounded(
              predictionContext(api, threadId, source.seq, signal),
            );

            await assertSource();

            const result = await bounded(
              host.call(
                "predict",
                {
                  conversationContext: context,
                  cliPath: input.cliPath,
                  model: input.model,
                  tags: input.tags,
                  force: input.force,
                },
                {
                  hostId,
                  signal,
                  timeoutMs: composerPredictionTimeouts.hostMs,
                },
              ),
            );

            await assertSource();

            return result;
          } finally {
            if (active.get(input.threadId) === request)
              active.delete(input.threadId);
          }
        };

        const done = work();
        request.done = done;

        return done;
      },
      "experimental_composer-predictions.v1.cancel": (input, context) => {
        authorize(context);
        cancelled.set(
          JSON.stringify([input.threadId, input.requestId]),
          Date.now() + 60000,
        );

        while (cancelled.size > 1024) {
          const first = cancelled.keys().next();

          if (!first.done) cancelled.delete(first.value);
        }

        return { cancelled: stop(input.threadId, input.requestId) };
      },
    },
    { experimental_discoverable: false },
  );

  for (const event of [
    "thread.active",
    "thread.failed",
    "thread.archived",
    "thread.deleted",
  ] as const)
    api.events.on(event, ({ thread }) => {
      stop(thread.id);
    });

  const validate = (threadId: string) => {
    const request = active.get(threadId);

    if (request?.validate)
      void request.validate().catch(() => {
        stop(threadId, request.requestId);
      });
  };

  api.events.on("thread.idle", ({ thread }) => validate(thread.id));
  api.events.on(
    "experimental_thread.events",
    ({ thread }) => validate(thread.id),
    {
      experimental_eventTypes: [
        "thread/started",
        "thread/identity",
        "turn/started",
        "turn/completed",
        "turn/input/accepted",
        "thread/name/updated",
        "thread/compacted",
        "thread/context/cleared",
        "thread/goal/updated",
        "thread/goal/cleared",
        "item/started",
        "item/completed",
        "item/mcpToolCall/progress",
        "item/toolCall/progress",
        "item/backgroundTask/progress",
        "item/backgroundTask/completed",
        "item/delegation/progress",
        "item/delegation/completed",
        "thread/tokenUsage/updated",
        "thread/contextWindowUsage/updated",
        "turn/plan/updated",
        "turn/diff/updated",
        "turn/mainRun/updated",
        "provider/error",
        "provider/rateLimits/updated",
        "provider.env-resolved",
        "thread/extensionState/updated",
        "provider/warning",
        "provider/modelFallback",
        "provider/unhandled",
        "client/thread/start",
        "client/turn/requested",
        "client/turn/rejected",
        "client/turn/start",
        "system/error",
        "system/manager/user_message",
        "system/thread/interrupted",
        "system/operation",
        "system/interaction/lifecycle",
        "system/permissionGrant/lifecycle",
        "system/userQuestion/lifecycle",
        "system/thread-provisioning",
        "system/git-activity",
        "system/provider-turn-watchdog",
      ],
    },
  );
  api.events.on("experimental_host.deleted", ({ host: deleted }) => {
    for (const [threadId, request] of active)
      if (request.hostId === deleted.id) stop(threadId, request.requestId);
  });
  api.onDispose(async () => {
    disposed = true;
    const pending = [...active.values()];

    for (const request of pending) request.controller.abort();
    active.clear();
    await Promise.allSettled(pending.map((request) => request.done));
  });
}
