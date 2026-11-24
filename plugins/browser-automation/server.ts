import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import type {
  PluginApi,
  PluginCliContext,
  PluginRpcHandlers,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  hostContract,
  rpcContract,
  sessionSchema,
  nativeViewportSchema,
  viewportSchema,
  type NativeViewport,
  type VisualImage,
  type PreviewOutput,
  type RunOutput,
  type Session,
} from "./contracts.js";
import {
  browserCliFailure,
  createBrowserAutomationCli,
  type BrowserCliMethod,
  type BrowserCliRequest,
} from "./cli.js";
import {
  observeScript,
  inspectScript,
  viewportScript,
} from "./visual-scripts.js";
import { previewDirective } from "./preview-directive.js";

const desktopSchema = z
  .object({
    hostId: z.string(),
    instanceId: z.string(),
    generation: z.string(),
    threadId: z.string(),
    leaseId: z.string(),
    tabId: z.string(),
    owned: z.boolean(),
    leasedTabIds: z.array(z.string()),
  })
  .strict();

const recordSchema = z
  .object({
    session: sessionSchema,
    desktop: desktopSchema.nullable(),
    lastUsed: z.number(),
    cleanupPending: z.boolean(),
    threadDeleted: z.boolean().default(false),
  })
  .strict();

type RecordEntry = z.infer<typeof recordSchema>;

type DesktopTarget = z.infer<typeof desktopSchema>;

const idleTimeoutMs = 30 * 60_000;

const maxLifetimeMs = 8 * 60 * 60_000;

const hardDeadline = (session: Session) =>
  session.backend === "desktop"
    ? Math.min(session.expiresAt, session.createdAt + maxLifetimeMs)
    : session.createdAt + maxLifetimeMs;

const previewWaitMs = 5_000;

const runCallGraceMs = 10_000;

const SCREENSHOT_FOLDER = "Screenshots";

const keyFor = (threadId: string, sessionId: string) =>
  `sessions/${encodeURIComponent(threadId)}/${sessionId}`;

export default async function browserAutomationPlugin(api: PluginApi) {
  const host = api.hosts.experimental_client({ contract: hostContract });
  const desktop = api.sdk.experimental_desktopBrowsers;
  const active = new Map<string, RecordEntry>();
  const busy = new Map<string, number>();

  const viewports = new Map<
    string,
    { original: NativeViewport; applied: NativeViewport }
  >();

  const changingViewport = new Set<string>();
  const pending = new Set<Promise<void>>();

  const cleanup = new Map<
    string,
    { state: "stopped" | "closed"; work: Promise<Session> }
  >();

  const opening = new Map<string, AbortController>();
  const subscriptions = new Map<string, { dispose(): void }>();
  const lifecycle = new AbortController();
  const threadLifecycles = new Map<string, AbortController>();

  const save = (record: RecordEntry) =>
    api.storage.kv.set(
      keyFor(record.session.threadId, record.session.id),
      record,
    );

  function trackLeasedTabs(
    target: DesktopTarget,
    tabs: Array<{ tabId: string; control: { leaseId: string } | null }>,
  ) {
    const added = tabs.filter(
      (tab) =>
        tab.control?.leaseId === target.leaseId &&
        !target.leasedTabIds.includes(tab.tabId),
    );

    target.leasedTabIds.push(...added.map((tab) => tab.tabId));

    return added.length > 0;
  }

  async function owned(threadId: string, sessionId: string) {
    const record = recordSchema.parse(
      await api.storage.kv.get(keyFor(threadId, sessionId)),
    );

    if (record.session.threadId !== threadId || record.session.id !== sessionId)
      throw new Error("Session does not belong to this thread");

    return active.get(sessionId) ?? record;
  }

  async function releaseDesktop(
    target: DesktopTarget,
    state: "stopped" | "closed",
    threadDeleted: boolean,
  ): Promise<PromiseSettledResult<unknown>[]> {
    const scope = {
      hostId: target.hostId,
      instanceId: target.instanceId,
      generation: target.generation,
      threadId: target.threadId,
    };

    if (threadDeleted)
      return Promise.allSettled([
        desktop.releaseControl({ ...scope, leaseId: target.leaseId }),
      ]);

    await desktop.listTabs(scope).then(
      ({ tabs }) => trackLeasedTabs(target, tabs),
      () => {},
    );

    const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([
      desktop.releaseControl({ ...scope, leaseId: target.leaseId }),
    ]);

    const createdTabIds = new Set(target.leasedTabIds);

    if (target.owned) createdTabIds.add(target.tabId);
    else createdTabIds.delete(target.tabId);

    if (state === "closed" && createdTabIds.size > 0)
      results.push(
        ...(await desktop.listTabs(scope).then(
          ({ tabs }) =>
            Promise.allSettled(
              tabs
                .filter((tab) => createdTabIds.has(tab.tabId))
                .map((tab) => desktop.closeTab({ ...scope, tabId: tab.tabId })),
            ),
          (reason) => [{ status: "rejected" as const, reason }],
        )),
      );

    return results;
  }

  async function finish(
    record: RecordEntry,
    requested: "stopped" | "closed",
  ): Promise<Session> {
    const existing = cleanup.get(record.session.id);

    if (existing) {
      if (existing.state === "closed" || existing.state === requested)
        return existing.work;
      await existing.work.catch(() => {});

      return finish(record, requested);
    }

    const previous = recordSchema.safeParse(
      await api.storage.kv.get(
        keyFor(record.session.threadId, record.session.id),
      ),
    );

    if (cleanup.has(record.session.id)) return finish(record, requested);

    const closed =
      record.session.state === "closed" ||
      (previous.success && previous.data.session.state === "closed");

    if (
      previous.success &&
      previous.data.session.state === "closed" &&
      !previous.data.cleanupPending
    )
      return previous.data.session;
    const state = closed ? "closed" : requested;

    const work = (async () => {
      const { session } = record;
      opening.get(session.id)?.abort();

      for (const key of viewports.keys())
        if (key.startsWith(`${session.id}:`)) viewports.delete(key);

      if (state === "closed") active.delete(session.id);
      else active.set(session.id, record);
      subscriptions.get(session.id)?.dispose();
      subscriptions.delete(session.id);
      session.state = state;
      record.cleanupPending = true;
      await save(record);

      const results = (
        await Promise.all([
          Promise.allSettled([
            host.call(
              "close",
              { sessionId: session.id },
              { hostId: session.hostId, signal: AbortSignal.timeout(10_000) },
            ),
          ]),
          record.desktop
            ? releaseDesktop(record.desktop, state, record.threadDeleted)
            : [],
        ])
      ).flat();

      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );

      record.cleanupPending = failures.length > 0;
      await save(record);

      if (failures.length > 0) {
        const reasons = failures
          .map((reason) =>
            reason instanceof Error ? reason.message : String(reason),
          )
          .join("; ");

        api.log.warn(
          `Browser Automation cleanup on host ${session.hostId} failed: ${reasons}`,
        );
        throw new Error(
          `Browser session ${state}, but cleanup on host ${session.hostId} failed: ${reasons}. Run close to retry.`,
        );
      }

      return session;
    })();

    cleanup.set(record.session.id, { state, work });

    try {
      return await work;
    } finally {
      cleanup.delete(record.session.id);
    }
  }

  const unfinished: RecordEntry[] = [];

  for (const key of await api.storage.kv.list("sessions/")) {
    const parsed = recordSchema.safeParse(await api.storage.kv.get(key));

    if (!parsed.success) continue;

    if (parsed.data.session.state === "closed" && !parsed.data.cleanupPending)
      continue;
    unfinished.push(parsed.data);
  }

  api.background.service("restart-cleanup", {
    async start() {
      for (const record of unfinished.splice(0)) {
        try {
          if (record.desktop && !record.threadDeleted) {
            try {
              await api.sdk.threads.get({ threadId: record.session.threadId });
            } catch (error) {
              const missing = z
                .object({
                  status: z.literal(404),
                  code: z.literal("thread_not_found"),
                })
                .safeParse(error);

              if (!missing.success) throw error;
              record.threadDeleted = true;
              await save(record);
            }
          }

          await finish(record, "closed");
        } catch (error) {
          api.log.warn(
            `Browser Automation restart cleanup is pending for session ${record.session.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  });

  async function open(
    input: z.output<typeof rpcContract.open.input>,
    signal: AbortSignal,
  ): Promise<Session> {
    let threadLifecycle = threadLifecycles.get(input.threadId);

    if (!threadLifecycle) {
      threadLifecycle = new AbortController();
      threadLifecycles.set(input.threadId, threadLifecycle);
    }

    signal = AbortSignal.any([signal, threadLifecycle.signal]);
    signal.throwIfAborted();
    await api.sdk.threads.get({ threadId: input.threadId });

    if (active.size >= 64)
      throw new Error(
        "Browser session limit reached; close an existing session",
      );
    const now = Date.now();

    const session: Session = {
      id: randomUUID(),
      threadId: input.threadId,
      hostId: input.selection.hostId,
      backend: input.selection.backend,
      state: "ready",
      createdAt: now,
      expiresAt: now + idleTimeoutMs,
    };

    const record: RecordEntry = {
      session,
      desktop: null,
      lastUsed: now,
      cleanupPending: false,
      threadDeleted: false,
    };

    const retirement = new AbortController();
    opening.set(session.id, retirement);
    signal = AbortSignal.any([signal, retirement.signal]);
    let connectionUrl: string | undefined;

    let created: {
      hostId: string;
      instanceId: string;
      generation: string;
      threadId: string;
      tabId: string;
    } | null = null;

    try {
      if (input.selection.backend === "desktop") {
        const selection = input.selection;

        const { instances } = await desktop.listInstances({
          hostId: selection.hostId,
        });

        const instance = instances.find(
          (candidate) => candidate.instanceId === selection.instanceId,
        );

        if (!instance)
          throw new Error(
            "Selected desktop is unavailable; choose a connected instance explicitly",
          );

        const scope = {
          hostId: selection.hostId,
          instanceId: instance.instanceId,
          generation: instance.generation,
          threadId: input.threadId,
        };

        let tabId = selection.tabId;

        if (!tabId) {
          const result = await desktop.createTab({
            ...scope,
            url: "about:blank",
            presentation: "hidden",
          });

          tabId = result.tab.tabId;
          created = { ...scope, tabId };
        }

        const lease = await desktop.acquireControl({
          ...scope,
          tabIds: [tabId],
          controllerLabel: "Browser Automation",
          ttlMs: idleTimeoutMs,
        });

        record.desktop = {
          ...scope,
          leaseId: lease.leaseId,
          tabId,
          owned: selection.tabId === undefined,
          leasedTabIds: [],
        };

        const connection = await desktop.openConnection({
          ...scope,
          leaseId: lease.leaseId,
        });

        if (connection.hostId !== scope.hostId)
          throw new Error(
            "Desktop connection returned a different execution host",
          );
        connectionUrl = connection.wsEndpoint;
        session.expiresAt = Math.min(
          session.expiresAt,
          lease.expiresAt,
          connection.expiresAt,
        );
      }

      await save(record);
      active.set(session.id, record);

      while (true) {
        const runtime = await host.call(
          "prepare",
          {},
          { hostId: session.hostId, signal },
        );

        if (runtime.status === "ready") break;
        api.log.info(
          `DevBrowser runtime on host ${session.hostId}: ${runtime.detail}`,
        );
      }

      await host.call(
        "open",
        {
          sessionId: session.id,
          ...(connectionUrl === undefined ? {} : { connectionUrl }),
          expiresAt: hardDeadline(session),
          idleTimeoutMs,
        },
        { hostId: session.hostId, signal },
      );
      signal.throwIfAborted();

      if (record.desktop) {
        const target = record.desktop;
        subscriptions.set(
          session.id,
          desktop.subscribe({
            hostId: target.hostId,
            instanceId: target.instanceId,
            generation: target.generation,
            threadId: target.threadId,
            onChange(result) {
              if (trackLeasedTabs(target, result.tabs))
                void save(record).catch(() => {});

              if (
                !result.tabs.some(
                  (tab) => tab.control?.leaseId === target.leaseId,
                )
              )
                void finish(record, "stopped").catch(() => {});
            },
            onError() {
              void finish(record, "stopped").catch(() => {});
            },
          }),
        );
      }

      return session;
    } catch (error) {
      await finish(record, "closed").catch(() => {});

      if (created && !record.desktop)
        await desktop.closeTab(created).catch(() => {});
      throw error;
    } finally {
      opening.delete(session.id);
    }
  }

  async function touch(record: RecordEntry) {
    record.lastUsed = Date.now();
    record.session.expiresAt = Math.min(
      record.lastUsed + idleTimeoutMs,
      hardDeadline(record.session),
    );

    try {
      await save(record);
    } catch (error) {
      api.log.warn(
        `Browser Automation could not persist session activity: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function run(
    input: z.output<typeof rpcContract.run.input>,
    signal: AbortSignal,
  ): Promise<RunOutput> {
    const record = await owned(input.threadId, input.sessionId);

    if (
      record.session.state !== "ready" ||
      Date.now() >= hardDeadline(record.session) ||
      (!busy.get(input.sessionId) && Date.now() >= record.session.expiresAt)
    )
      throw new Error("Session stopped or expired; open a new session");
    busy.set(input.sessionId, (busy.get(input.sessionId) ?? 0) + 1);

    try {
      await touch(record);

      const result = await host.call(
        "run",
        {
          sessionId: input.sessionId,
          script: input.script,
          timeoutMs: input.timeoutMs,
        },
        {
          hostId: record.session.hostId,
          signal,
          timeoutMs: input.timeoutMs + runCallGraceMs,
        },
      );

      if (result.exitCode === 124)
        await finish(record, "stopped").catch(() => {});

      return result;
    } catch (error) {
      await finish(record, "stopped").catch(() => {});
      throw error;
    } finally {
      const remaining = (busy.get(input.sessionId) ?? 1) - 1;

      if (remaining > 0) busy.set(input.sessionId, remaining);
      else busy.delete(input.sessionId);
      const current = active.get(input.sessionId);

      if (current?.session.state === "ready") await touch(current);
    }
  }

  async function preview(
    input: z.output<typeof rpcContract.preview.input>,
    signal: AbortSignal,
  ): Promise<PreviewOutput> {
    const { session } = await owned(input.threadId, input.sessionId);

    if (
      session.backend !== "local" ||
      session.state !== "ready" ||
      Date.now() >= session.expiresAt
    )
      return { session, frame: null };

    const { frame } = await host.call(
      "preview",
      {
        sessionId: session.id,
        afterSequence: input.afterSequence,
        waitMs: previewWaitMs,
        size: input.size,
      },
      { hostId: session.hostId, signal },
    );

    return { session, frame };
  }

  async function localTarget(input: {
    threadId: string;
    sessionId: string;
    targetId: string;
  }) {
    const record = await owned(input.threadId, input.sessionId);

    if (record.session.backend !== "local")
      throw new Error(
        "Visual preview controls require a local headless session. Use desktop Design Mode for a desktop tab.",
      );

    return record;
  }

  async function visualImage(
    record: RecordEntry,
    output: RunOutput,
    signal: AbortSignal,
  ): Promise<VisualImage> {
    if (output.exitCode !== 0)
      throw new Error(
        output.text || "Visual capture failed; your notes are kept.",
      );
    const image = output.images[0];

    if (!image || output.images.length !== 1)
      throw new Error("Visual capture must return exactly one bounded JPEG.");

    const file = await api.sdk.files.read({
      hostId: record.session.hostId,
      path: image.path,
      signal,
    });

    if (file.contentEncoding !== "base64")
      throw new Error("Visual capture did not return binary image bytes.");

    return {
      path: image.path,
      hostId: record.session.hostId,
      mimeType: "image/jpeg",
      data: file.content,
      width: image.width,
      height: image.height,
    };
  }

  async function keepImages(
    input: { threadId: string; sessionId: string },
    output: RunOutput,
    signal: AbortSignal,
  ): Promise<RunOutput> {
    if (output.images.length === 0) return output;
    const { session } = await owned(input.threadId, input.sessionId);

    const storage = await api.sdk.threads.storageLocation({
      threadId: input.threadId,
    });

    const paths = posix.isAbsolute(storage.storageRootPath) ? posix : win32;
    const stamp = Date.now();

    const images = await Promise.all(
      output.images.map(async (image, index) => {
        const file = await api.sdk.files.read({
          hostId: session.hostId,
          path: image.path,
          signal,
        });

        if (file.contentEncoding !== "base64")
          throw new Error("Screenshot did not return binary image bytes.");

        const path = paths.join(
          storage.storageRootPath,
          SCREENSHOT_FOLDER,
          `${session.id}-${stamp}-${index + 1}.jpg`,
        );

        await api.sdk.files.write({
          hostId: storage.hostId,
          rootPath: storage.storageRootPath,
          path,
          content: file.content,
          contentEncoding: "base64",
          createParents: true,
        });

        return { ...image, path };
      }),
    );

    return { ...output, images };
  }

  function handlers(
    signal: AbortSignal,
  ): PluginRpcHandlers<typeof rpcContract> {
    return {
      open: (input) => open(input, signal),
      async list({ threadId }) {
        const records = await Promise.all(
          (
            await api.storage.kv.list(
              `sessions/${encodeURIComponent(threadId)}/`,
            )
          )
            .slice(-64)
            .map(
              async (key) =>
                recordSchema.parse(await api.storage.kv.get(key)).session,
            ),
        );

        return records;
      },
      run: async (input) => keepImages(input, await run(input, signal), signal),
      pages: (input) =>
        run(
          { ...input, script: "await browser.listPages()", timeoutMs: 30_000 },
          signal,
        ),
      screenshot: async (input) =>
        keepImages(
          input,
          await run(
            {
              ...input,
              script: `const page = await browser.getPage(${JSON.stringify(input.page)}); await page.shot({ type: "jpeg", maxEdge: 960, quality: 70 }); undefined`,
              timeoutMs: 30_000,
            },
            signal,
          ),
          signal,
        ),
      preview: (input) => preview(input, signal),
      async observe(input) {
        const record = await localTarget(input);

        const output = await run(
          {
            ...input,
            script: observeScript(input.targetId, randomUUID()),
            timeoutMs: 15000,
          },
          signal,
        );

        const image = await visualImage(record, output, signal);

        return rpcContract.observe.output.parse({
          observation: JSON.parse(output.text),
          image,
        });
      },
      async inspect(input) {
        const record = await localTarget(input);

        const output = await run(
          {
            ...input,
            script: inspectScript(
              input.targetId,
              input.observationId,
              input.elementId,
            ),
            timeoutMs: 15000,
          },
          signal,
        );

        const image = await visualImage(record, output, signal);

        const context = rpcContract.inspect.output
          .omit({ image: true })
          .parse(JSON.parse(output.text));

        return { ...context, image };
      },
      async viewport(input) {
        await localTarget(input);
        const key = `${input.sessionId}:${input.targetId}`;

        if (changingViewport.has(key))
          throw new Error(
            "A viewport change is already in progress for this target.",
          );
        changingViewport.add(key);

        try {
          const saved = viewports.get(key);

          if (input.preset === "original" && !saved)
            throw new Error("No preset owned by this preview can be restored.");

          const output = await run(
            {
              ...input,
              script: viewportScript({
                targetId: input.targetId,
                preset: input.preset,
                ...(saved
                  ? { original: saved.original, expected: saved.applied }
                  : {}),
              }),
              timeoutMs: 15000,
            },
            signal,
          );

          if (output.exitCode !== 0)
            throw new Error(output.text || "Viewport change failed.");

          const result = z
            .object({
              previous: nativeViewportSchema,
              applied: nativeViewportSchema,
              viewport: viewportSchema,
            })
            .strict()
            .parse(JSON.parse(output.text));

          if (input.preset === "original") viewports.delete(key);
          else
            viewports.set(key, {
              original: saved ? saved.original : result.previous,
              applied: result.applied,
            });

          return { preset: input.preset, viewport: result.viewport };
        } finally {
          changingViewport.delete(key);
        }
      },
      stop: async (input) =>
        finish(await owned(input.threadId, input.sessionId), "stopped"),
      close: async (input) =>
        finish(await owned(input.threadId, input.sessionId), "closed"),
    };
  }

  api.rpc.register(rpcContract, handlers(lifecycle.signal));

  function dispatch(
    method: BrowserCliMethod,
    input: unknown,
    signal: AbortSignal,
  ) {
    const h = handlers(signal);

    switch (method) {
      case "open":
        return h.open(rpcContract.open.input.parse(input));
      case "list":
        return h.list(rpcContract.list.input.parse(input));
      case "run":
        return h.run(rpcContract.run.input.parse(input));
      case "pages":
        return h.pages(rpcContract.pages.input.parse(input));
      case "screenshot":
        return h.screenshot(rpcContract.screenshot.input.parse(input));
      case "preview":
        return h.preview(rpcContract.preview.input.parse(input));
      case "observe":
        return h.observe(rpcContract.observe.input.parse(input));
      case "inspect":
        return h.inspect(rpcContract.inspect.input.parse(input));
      case "viewport":
        return h.viewport(rpcContract.viewport.input.parse(input));
      case "stop":
        return h.stop(rpcContract.stop.input.parse(input));
      case "close":
        return h.close(rpcContract.close.input.parse(input));
    }
  }

  api.agents.configure(() => ({
    tools: [],
    skills: ["browser-automation"],
    instructions:
      "When `omnyo browser-automation open` returns a previewDirective, copy it into your next response exactly once as a standalone line before you continue working. Do not wrap it in backticks or a code fence, and do not invent or edit the session ID. The directive shows the user a live view of that headless browser in Omnyo chat. Desktop sessions return no directive.",
  }));

  async function executeCli(
    request: BrowserCliRequest,
    context: PluginCliContext,
  ) {
    try {
      const input = { ...request.input };

      if (request.method === "open" && input.selection) {
        const target = input.selection.hostId.trim();
        const hosts = await api.sdk.hosts.list({ signal: context.signal });
        const idMatch = hosts.find((candidate) => candidate.id === target);

        const matches = idMatch
          ? [idMatch]
          : hosts.filter((candidate) => candidate.name === target);

        if (matches.length === 0)
          throw new Error(`Machine '${target}' was not found`);

        if (matches.length > 1)
          throw new Error(
            `Machine name '${target}' is ambiguous; use an exact host ID`,
          );
        input.selection = { ...input.selection, hostId: matches[0].id };
      }

      if (request.scriptFile) {
        if (!request.scriptHost)
          throw new Error("Script file requires an explicit source host");

        const pathApi =
          context.cwd && win32.isAbsolute(context.cwd) ? win32 : posix;

        const path =
          win32.isAbsolute(request.scriptFile) ||
          posix.isAbsolute(request.scriptFile)
            ? request.scriptFile
            : pathApi.resolve(context.cwd ?? ".", request.scriptFile);

        if (
          !context.cwd &&
          !posix.isAbsolute(request.scriptFile) &&
          !win32.isAbsolute(request.scriptFile)
        )
          throw new Error(
            "Relative script files require the invoking CLI working directory",
          );

        const file = await api.sdk.files.read({
          hostId: request.scriptHost,
          path,
          signal: context.signal,
        });

        if (file.contentEncoding !== "utf8")
          throw new Error("Script file must be UTF-8 text");
        input.script = file.content;
      }

      const result = await dispatch(
        request.method,
        input,
        AbortSignal.any([
          context.signal ?? new AbortController().signal,
          lifecycle.signal,
        ]),
      );

      const output = rpcContract.run.output.safeParse(result);
      const previewed = rpcContract.preview.output.safeParse(result);

      const visual = z
        .union([rpcContract.observe.output, rpcContract.inspect.output])
        .safeParse(result);

      const opened =
        request.method === "open"
          ? rpcContract.open.output.safeParse(result)
          : null;

      const printable = opened?.success
        ? {
            ...opened.data,
            ...(opened.data.backend === "local"
              ? { previewDirective: previewDirective(opened.data.id) }
              : {}),
          }
        : visual.success
          ? { ...visual.data, image: { ...visual.data.image, data: undefined } }
          : output.success
            ? {
                ...output.data,
                hostId:
                  output.data.images.length > 0
                    ? (
                        await api.sdk.threads.storageLocation({
                          threadId: input.threadId,
                        })
                      ).hostId
                    : (await owned(input.threadId, input.sessionId ?? ""))
                        .session.hostId,
              }
            : previewed.success
              ? {
                  session: previewed.data.session,
                  frame: previewed.data.frame && {
                    sequence: previewed.data.frame.sequence,
                    targetId: previewed.data.frame.targetId,
                    mimeType: previewed.data.frame.mimeType,
                    width: previewed.data.frame.width,
                    height: previewed.data.frame.height,
                    url: previewed.data.frame.url,
                    title: previewed.data.frame.title,
                    bytes: Buffer.byteLength(
                      previewed.data.frame.data,
                      "base64",
                    ),
                  },
                }
              : result;

      return {
        exitCode: output.success ? output.data.exitCode : 0,
        stdout: JSON.stringify(printable),
      };
    } catch (error) {
      throw browserCliFailure(error);
    }
  }

  api.cli.register(createBrowserAutomationCli({ execute: executeCli }));

  for (const event of [
    "thread.archived",
    "thread.deleted",
    "thread.failed",
  ] as const) {
    api.events.on(event, async ({ thread }) => {
      threadLifecycles.get(thread.id)?.abort();
      threadLifecycles.delete(thread.id);

      const results = await Promise.allSettled(
        [...active.values()]
          .filter((record) => record.session.threadId === thread.id)
          .map(async (record) => {
            if (event === "thread.deleted") {
              record.threadDeleted = true;
              await save(record);
            }

            return finish(record, "closed");
          }),
      );

      if (results.some((result) => result.status === "rejected")) {
        api.log.warn(
          `Browser Automation cleanup for thread ${thread.id} is pending; see the cleanup failure for its cause`,
        );
      }
    });
  }

  const timer = setInterval(() => {
    for (const record of active.values()) {
      if (
        Date.now() < hardDeadline(record.session) &&
        (busy.get(record.session.id) ||
          Date.now() - record.lastUsed < idleTimeoutMs)
      )
        continue;

      const work = finish(record, "closed").then(
        () => {},
        () => {},
      );

      pending.add(work);
      void work.finally(() => pending.delete(work));
    }
  }, 1000);

  timer.unref();
  host.experimental_onWorkerExit(async ({ hostId }) => {
    await Promise.allSettled(
      [...active.values()]
        .filter((record) => record.session.hostId === hostId)
        .map((record) => finish(record, "closed")),
    );
  });
  api.onDispose(async () => {
    lifecycle.abort();
    clearInterval(timer);
    await Promise.allSettled(
      [...active.values()].map((record) => finish(record, "closed")),
    );
    await Promise.allSettled(pending);
  });
}
