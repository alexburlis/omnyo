import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import type { JsonValue } from "@omnyo/plugin-sdk";
import plugin from "../server.ts";
import { changedPayloadSchema } from "../lib/records.ts";
import { tagRecordSchema, tagSchema } from "../lib/tags.ts";
import { gate, paused } from "./gates.ts";

const hosts: FakePluginHost[] = [];

const resultSchema = z.object({
  applied: z.boolean(),
  title: z.string().nullable(),
  tag: z.string().nullable().optional(),
  reason: z.string().optional(),
});

const requestSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  experimental_titleIfUntitled: z.literal(true),
  signal: z.instanceof(AbortSignal),
});

const tagsSchema = z.object({ tags: z.array(tagSchema) });

const suggestSchema = z.object({ applied: z.boolean() });

type DispatchOverrides = NonNullable<Parameters<typeof makeMessageDispatchHookContext>[0]>;

async function fixture(
  options: { activatedAt?: JsonValue; tags?: JsonValue } = { activatedAt: 1000 },
) {
  const metadata = new Map<string, Record<string, JsonValue>>();

  let thread = makeThreadResponse({
    id: "thread-1",
    title: null,
    status: "pending",
    visibility: "visible",
    createdAt: 2000,
    archivedAt: null,
    deletedAt: null,
  });

  const state = {
    beforeUpdate: async () => {},
    beforeGet: async () => {},
    beforeMetadataWrite: async (_threadId: string) => {},
    failTag: false,
    omitResponseFlag: false,
  };

  const requests: z.output<typeof requestSchema>[] = [];

  const host = createFakePluginHost({
    pluginId: "chat-topics",
    sdk: {
      threads: {
        get: async () => {
          await state.beforeGet();

          return thread;
        },
        list: async () => [thread],
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
        experimental_listPluginMetadata: async ({ threadIds }) => ({
          threads: threadIds.map((threadId) => ({
            threadId,
            metadata: metadata.get(threadId) ?? {},
          })),
        }),
        updatePluginMetadata: async ({ threadId, set }) => {
          await state.beforeMetadataWrite(threadId);

          if (state.failTag && set?.tag !== undefined) throw new Error("Tag storage unavailable");
          const next = { ...metadata.get(threadId), ...set };
          metadata.set(threadId, next);

          return next;
        },
        update: async (input) => {
          const request = requestSchema.parse(input);
          requests.push(request);
          await state.beforeUpdate();
          request.signal.throwIfAborted();
          const applied = thread.title === null;

          if (applied) thread = { ...thread, title: request.title };

          return state.omitResponseFlag
            ? thread
            : { ...thread, experimental_titleApplied: applied };
        },
      },
    },
  });

  hosts.push(host);

  if (options.activatedAt !== undefined)
    await host.api.storage.kv.set("activatedAt", options.activatedAt);

  if (options.tags !== undefined) await host.api.storage.kv.set("tags", options.tags);
  await plugin(host.api);

  async function dispatch(overrides: DispatchOverrides = {}, activeHost = host) {
    const handler = activeHost.harness.registrations.hooks["message.dispatch"];
    assert.ok(handler, "The first-turn eligibility hook must be registered");

    return handler(
      makeMessageDispatchHookContext({
        attempt: "start-turn",
        initiator: "user",
        senderThreadId: null,
        ...overrides,
        thread: { ...thread, ...overrides.thread },
      }),
    );
  }

  async function configure(activeHost = host) {
    return activeHost.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: thread.id, title: thread.title },
        pluginMetadata: metadata.get(thread.id),
      }),
    );
  }

  async function tool(
    input: Record<string, JsonValue> = { title: "Fix worker updates", tag: "fix" },
    signal = new AbortController().signal,
  ) {
    const output = await host.harness.callAgentTool("chat_topics_set_name", input, {
      threadId: thread.id,
      signal,
    });

    return resultSchema.parse(JSON.parse(z.string().parse(output)));
  }

  function storedTag() {
    const record = metadata.get(thread.id)?.tag;

    return record === undefined ? undefined : tagRecordSchema.parse(record);
  }

  async function setTag(tagId: string | null) {
    return tagRecordSchema.parse(
      await host.harness.callRpc("tag.set", { threadId: thread.id, tagId }),
    );
  }

  async function suggest(tagId: string | null) {
    return suggestSchema.parse(
      await host.harness.callRpc("tag.suggest", { threadId: thread.id, tagId }),
    ).applied;
  }

  async function tags(method = "tags.list", input: JsonValue = {}) {
    return tagsSchema.parse(await host.harness.callRpc(method, input)).tags.map((tag) => tag.id);
  }

  return {
    host,
    metadata,
    state,
    requests,
    dispatch,
    configure,
    tool,
    storedTag,
    setTag,
    suggest,
    tags,
    current: () => thread,
    rename: (title: string) => {
      thread = { ...thread, title };
    },
  };
}

async function lockDatabase(path: string) {
  const locker = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import Database from "better-sqlite3"; const database = new Database(process.argv[1]); database.exec("BEGIN IMMEDIATE"); process.stdout.write("locked"); process.stdin.resume(); process.stdin.once("end", () => { database.exec("ROLLBACK"); database.close(); });',
      path,
    ],
    { cwd: new URL("..", import.meta.url), stdio: ["pipe", "pipe", "pipe"] },
  );

  const exited = once(locker, "exit");
  const ready = once(locker.stdout, "data");
  await Promise.race([
    ready.then(([value]) => assert.equal(String(value), "locked")),
    exited.then(() => {
      throw new Error("SQLite lock helper exited before acquiring the lock");
    }),
  ]);

  return async () => {
    locker.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0);
  };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("first-turn naming", () => {
  it("marks the first eligible dispatch before offering its naming tool", async () => {
    const test = await fixture();
    assert.equal((await test.configure()).tools.length, 0);
    assert.deepEqual(await test.dispatch(), { action: "proceed" });
    assert.deepEqual(
      (await test.configure()).tools.map((tool) => tool.name),
      ["chat_topics_set_name"],
    );
  });

  it("starts a new chat while another chat's tag metadata remains blocked", async () => {
    const test = await fixture();
    const entered = gate();
    const release = gate();
    test.state.beforeMetadataWrite = async () => {
      entered.release();
      await release.promise;
    };

    const tagging = test.host.harness.callRpc("tag.suggest", {
      threadId: "other-thread",
      tagId: "ops",
    });

    await paused(entered.promise, tagging);
    let proceeded = false;

    const starting = test.dispatch().then((decision) => {
      proceeded = true;

      return decision;
    });

    await setImmediate();
    const proceededWhileMetadataWasBlocked = proceeded;
    release.release();
    await tagging;
    assert.deepEqual(await starting, { action: "proceed" });
    assert.equal(proceededWhileMetadataWasBlocked, true);
    assert.equal((await test.configure()).tools.length, 1);
  });

  it("starts without naming when the local eligibility write is locked", async () => {
    const test = await fixture();
    const unlock = await lockDatabase(test.host.api.storage.database().name);

    try {
      assert.deepEqual(await test.dispatch(), { action: "proceed" });
      assert.equal((await test.configure()).tools.length, 0);
      assert.equal((await test.tool()).applied, false);
      assert.equal(test.requests.length, 0);
      assert.equal(
        test.host.harness.logEntries.filter((entry) => entry.level === "warn").length,
        1,
      );
    } finally {
      await unlock();
    }
  });

  it("suppresses naming immediately when a locked store refuses retirement", async () => {
    const test = await fixture();
    await test.dispatch();
    const unlock = await lockDatabase(test.host.api.storage.database().name);

    try {
      const event = await test.host.harness.emitThreadEvent("thread.idle", {
        thread: { ...test.current(), status: "idle" },
        lastAssistantText: null,
      });

      assert.deepEqual(event.errors, []);
      assert.equal((await test.configure()).tools.length, 0);
      assert.equal((await test.tool()).applied, false);
      assert.equal(test.requests.length, 0);
    } finally {
      await unlock();
    }

    await test.dispatch({ thread: { id: "healthy-thread" } });

    const healthy = await test.host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "healthy-thread", title: null } }),
    );

    assert.equal(healthy.tools.length, 1);
  });

  it("preserves active first-turn eligibility across reload and retires it durably", async () => {
    const endings: ("idle" | "deleted")[] = ["idle", "deleted"];

    for (const ending of endings) {
      const test = await fixture();
      await test.dispatch();
      const reloaded = await test.host.harness.reload(plugin);
      hosts.push(reloaded);
      assert.equal((await test.configure(reloaded)).tools.length, 1);
      await test.dispatch({ thread: { status: "error" } }, reloaded);
      assert.equal((await test.configure(reloaded)).tools.length, 1);

      if (ending === "idle")
        await reloaded.harness.emitThreadEvent("thread.idle", {
          thread: { ...test.current(), status: "idle" },
          lastAssistantText: null,
        });
      else
        await reloaded.harness.emitThreadEvent("thread.deleted", {
          thread: { ...test.current(), deletedAt: 3000 },
        });

      const retired = await reloaded.harness.reload(plugin);
      hosts.push(retired);
      assert.equal((await test.configure(retired)).tools.length, 0, ending);
      await test.dispatch({ thread: { status: "error" } }, retired);
      assert.equal((await test.configure(retired)).tools.length, 0, ending);
    }
  });

  it("initializes absent activation once across reloads and rejects malformed markers", async (context) => {
    let now = 3000;
    context.mock.method(Date, "now", () => now);

    for (const activatedAt of [undefined, null]) {
      now = 3000;
      const test = await fixture({ activatedAt });
      assert.equal(await test.host.api.storage.kv.get("activatedAt"), 3000);
      assert.deepEqual(
        test.host.harness.registrations.agentTools.map((tool) => tool.name),
        ["chat_topics_set_name"],
      );
      assert.equal(test.host.harness.registrations.services.length, 0);
      assert.equal(test.host.harness.registrations.schedules.length, 0);
      now = 4000;
      const reloaded = await test.host.harness.reload(plugin);
      hosts.push(reloaded);
      assert.equal(await reloaded.api.storage.kv.get("activatedAt"), 3000);
    }

    for (const activatedAt of ["3000", -1, false, {}, []])
      await assert.rejects(fixture({ activatedAt }), z.ZodError);
  });

  it("excludes existing, hidden, archived, deleted, delegated and noninitial turns", async () => {
    const cases: DispatchOverrides[] = [
      { thread: { createdAt: 999 } },
      { thread: { title: "Manual title" } },
      { thread: { visibility: "hidden" } },
      { thread: { archivedAt: 1 } },
      { thread: { deletedAt: 1 } },
      { thread: { status: "idle" } },
      { initiator: "agent" },
      { senderThreadId: "thread-parent" },
      { attempt: "join-turn" },
      { thread: { status: "error" } },
    ];

    for (const input of cases) {
      const test = await fixture();
      assert.deepEqual(await test.dispatch(input), { action: "proceed" });
      assert.equal((await test.configure()).tools.length, 0);
    }
  });

  it("keeps repeated dispatch idempotent and stops eligibility on a later start-turn", async () => {
    const test = await fixture();
    await test.dispatch();
    await test.dispatch();
    assert.equal((await test.configure()).tools.length, 1);
    await test.dispatch({ thread: { status: "idle" } });
    assert.equal((await test.configure()).tools.length, 0);
    assert.equal((await test.tool()).applied, false);
    assert.equal(test.requests.length, 0);
  });

  it("keeps naming when Continue replays a first turn whose workspace setup failed", async () => {
    const test = await fixture();
    await test.dispatch();
    await test.dispatch({ thread: { status: "error" } });
    assert.deepEqual(
      (await test.configure()).tools.map((tool) => tool.name),
      ["chat_topics_set_name"],
    );
    assert.equal((await test.tool()).applied, true);
  });

  it("does not restore naming when an errored chat was ineligible or already answered", async () => {
    for (const earlier of ["agent", "idle"]) {
      const test = await fixture();

      if (earlier === "agent") await test.dispatch({ initiator: "agent" });
      else {
        await test.dispatch();
        await test.host.harness.emitThreadEvent("thread.idle", {
          thread: { ...test.current(), status: "idle" },
          lastAssistantText: null,
        });
      }

      await test.dispatch({ thread: { status: "error" } });
      assert.equal((await test.configure()).tools.length, 0, earlier);
    }
  });

  it("stops naming when another chat sends into a chat whose first turn failed", async () => {
    const test = await fixture();
    await test.dispatch();
    await test.dispatch({
      thread: { status: "error" },
      initiator: "agent",
      senderThreadId: "thread-parent",
    });
    assert.equal((await test.configure()).tools.length, 0);
  });

  it("stops offering an omitted tool after idle even when Send-now bypasses dispatch", async () => {
    const test = await fixture();
    await test.dispatch();
    await test.setTag("build");
    const before = test.storedTag();

    const event = await test.host.harness.emitThreadEvent("thread.idle", {
      thread: { ...test.current(), status: "idle" },
      lastAssistantText: null,
    });

    assert.deepEqual(event.errors, []);
    assert.equal((await test.configure()).tools.length, 0);
    assert.equal((await test.tool()).applied, false);
    assert.deepEqual(test.storedTag(), before);
    assert.equal(test.current().title, null);
    assert.equal(test.requests.length, 0);
  });

  it("writes the context chat through the conditional API and stores its first-turn tag", async () => {
    const test = await fixture();
    await test.dispatch();
    const signal = new AbortController().signal;
    assert.deepEqual(await test.tool(undefined, signal), {
      applied: true,
      title: "Fix worker updates",
      tag: "fix",
    });
    assert.equal(test.current().title, "Fix worker updates");
    assert.equal(test.requests[0]?.threadId, test.current().id);
    assert.equal(test.requests[0]?.experimental_titleIfUntitled, true);
    assert.equal(test.storedTag()?.tagId, "fix");
    assert.equal(test.storedTag()?.source, "first-turn");
    assert.equal(test.metadata.get(test.current().id)?.topic, undefined);

    for (const method of ["threads.spawn", "threads.send", "threads.output", "threads.events.list"])
      assert.equal(test.host.harness.sdk.callsTo(method).length, 0);
    assert.equal((await test.configure()).tools.length, 0);
  });

  it("names the chat without a tag when the tag is omitted or none", async () => {
    const inputs: Record<string, JsonValue>[] = [
      { title: "Fix worker updates" },
      { title: "Fix updates", tag: "none" },
    ];

    for (const input of inputs) {
      const test = await fixture();
      await test.dispatch();
      const result = await test.tool(input);
      assert.equal(result.applied, true);
      assert.equal(result.tag, undefined);
      assert.equal(test.storedTag(), undefined);
    }
  });

  it("applies the title but ignores a tag id that is not in the current list", async () => {
    const test = await fixture();
    await test.dispatch();
    await test.tags("tags.remove", { id: "fix" });
    assert.deepEqual(await test.tool({ title: "Fix worker updates", tag: "fix" }), {
      applied: true,
      title: "Fix worker updates",
      tag: null,
      reason: "unknown_tag",
    });
    assert.equal(test.storedTag(), undefined);
  });

  it("lists the current tags with their meaning in the first-turn instruction", async () => {
    const test = await fixture();
    await test.dispatch();
    const instructions = (await test.configure()).instructions ?? "";
    assert.match(instructions, /fix \(defects, regressions\), build \(features, refactors\)/u);
    assert.match(instructions, /design \(UI, copy, mockups\)\. Omit tag when none fits\./u);

    await test.tags("tags.add", { id: "docs", label: "Docs", icon: "📝", description: "" });
    await test.tags("tags.remove", { id: "design" });
    const updated = (await test.configure()).instructions ?? "";
    assert.match(updated, /research \(questions, audits, investigations\), docs\. Omit/u);
    assert.doesNotMatch(updated, /design/u);
  });

  it("preserves a tag the user chose when the first response names the chat", async () => {
    const test = await fixture();
    await test.dispatch();
    await test.setTag("ship");
    assert.equal((await test.tool()).tag, "ship");
    assert.equal(test.storedTag()?.tagId, "ship");
    assert.equal(test.storedTag()?.source, "user");
  });

  it("preserves a user tag written while the title request is delayed", async () => {
    const test = await fixture();
    await test.dispatch();
    const entered = gate();
    const release = gate();
    test.state.beforeUpdate = async () => {
      entered.release();
      await release.promise;
    };

    const naming = test.tool();
    await paused(entered.promise, naming);
    await test.setTag(null);
    release.release();
    assert.equal((await naming).applied, true);
    assert.equal(test.storedTag()?.tagId, null);
    assert.equal(test.storedTag()?.source, "user");
  });

  it("aborts a deferred naming read when the plugin is disposed", async () => {
    const test = await fixture();
    await test.dispatch();
    const entered = gate();
    const release = gate();
    test.state.beforeGet = async () => {
      entered.release();
      await release.promise;
    };

    const naming = test.tool();
    await paused(entered.promise, naming);
    await test.host.harness.dispose();
    release.release();
    const outcomes = await Promise.allSettled([naming]);
    assert.equal(test.current().title, null);
    assert.equal(test.requests.length, 0);
    const outcome = outcomes[0];
    assert.ok(outcome);
    assert.equal(outcome.status, "rejected");

    if (outcome.status === "rejected")
      assert.equal(z.object({ name: z.string() }).parse(outcome.reason).name, "AbortError");
  });

  it("waits for already-issued writes before disposal completes", async () => {
    for (const kind of ["metadata", "title"]) {
      const test = await fixture();
      await test.dispatch();
      const entered = gate();
      const release = gate();

      const pause = async () => {
        entered.release();
        await release.promise;
      };

      if (kind === "metadata") test.state.beforeMetadataWrite = pause;
      else test.state.beforeUpdate = pause;

      const writing = kind === "metadata" ? test.setTag("ops") : test.tool();

      await paused(entered.promise, writing);
      let disposed = false;

      const disposing = test.host.harness.dispose().then(() => {
        disposed = true;
      });

      await setImmediate();
      const disposedBeforeWriteFinished = disposed;
      release.release();
      await Promise.allSettled([writing, disposing]);
      assert.equal(disposedBeforeWriteFinished, false, kind);
      assert.equal(disposed, true);

      if (kind === "metadata") assert.equal(test.storedTag()?.tagId, "ops");
      else {
        assert.equal(test.requests[0]?.signal.aborted, true);
        assert.equal(test.current().title, null);
      }
    }
  });

  it("preserves a title renamed before the tool runs", async () => {
    const test = await fixture();
    await test.dispatch();
    test.rename("My chosen title");
    assert.equal((await test.tool()).applied, false);
    assert.equal(test.current().title, "My chosen title");
    assert.equal(test.requests.length, 0);
  });

  it("preserves a manual rename racing the conditional request", async () => {
    const test = await fixture();
    await test.dispatch();
    test.state.beforeUpdate = async () => test.rename("My chosen title");
    assert.deepEqual(await test.tool(), {
      applied: false,
      title: "My chosen title",
      reason: "title_exists",
    });
    assert.equal(test.storedTag(), undefined);
  });

  it("does not mutate for a pre-aborted request", async () => {
    const test = await fixture();
    await test.dispatch();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(test.tool(undefined, controller.signal), { name: "AbortError" });
    assert.equal(test.current().title, null);
    assert.equal(test.requests.length, 0);
  });

  it("forwards cancellation while the conditional request is in flight", async () => {
    const test = await fixture();
    await test.dispatch();
    const controller = new AbortController();
    test.state.beforeUpdate = async () => controller.abort();
    await assert.rejects(test.tool(undefined, controller.signal), { name: "AbortError" });
    assert.equal(test.requests[0]?.signal.aborted, true);
    assert.equal(test.current().title, null);
  });

  it("reports duplicate calls without replacing the first title or tag", async () => {
    const test = await fixture();
    await test.dispatch();

    const outcomes = await Promise.all([
      test.tool(),
      test.tool({ title: "Replace first title", tag: "ship" }),
    ]);

    assert.deepEqual(
      outcomes.map((outcome) => outcome.applied),
      [true, false],
    );
    assert.equal(test.current().title, "Fix worker updates");
    assert.equal(test.storedTag()?.tagId, "fix");
  });

  it("keeps an applied title if tag storage fails and surfaces the failure", async () => {
    const test = await fixture();
    await test.dispatch();
    test.state.failTag = true;
    await assert.rejects(test.tool(), /Tag storage unavailable/u);
    assert.equal(test.current().title, "Fix worker updates");
    assert.equal(test.storedTag(), undefined);
  });

  it("rejects a missing conditional response flag without claiming tag success", async () => {
    const test = await fixture();
    await test.dispatch();
    test.state.omitResponseFlag = true;
    await assert.rejects(test.tool());
    assert.equal(test.storedTag(), undefined);
  });
});

describe("chat tags", () => {
  it("isolates chat writes, tag-list edits and diagnostics while preserving same-chat order", async () => {
    const test = await fixture();
    const entered = gate();
    const release = gate();
    test.state.beforeMetadataWrite = async (threadId) => {
      if (threadId !== "other-thread") return;
      entered.release();
      await release.promise;
    };

    const first = test.host.harness.callRpc("tag.suggest", {
      threadId: "other-thread",
      tagId: "ops",
    });

    await paused(entered.promise, first);
    let secondFinished = false;

    const second = test.host.harness
      .callRpc("tag.suggest", {
        threadId: "other-thread",
        tagId: "ship",
      })
      .then(() => {
        secondFinished = true;
      });

    let independentFinished = false;

    const independent = Promise.all([
      test.suggest("build"),
      test.tags("tags.add", { id: "docs", label: "Docs", icon: "Book" }),
      test.host.harness.callRpc("diagnostics.record", {
        trace: {
          v: 1,
          session: randomUUID(),
          asset: null,
          platform: "browser",
          chromeVersion: null,
          electronVersion: null,
          startedAt: 1,
          samples: [
            {
              at: 1,
              reason: "hover",
              visibility: "visible",
              target: null,
              hit: null,
              scrollTop: 0,
              list: { width: 300, height: 700 },
              root: null,
              toolbar: null,
              rows: [],
            },
          ],
        },
      }),
    ]).then(() => {
      independentFinished = true;
    });

    await setImmediate();
    const independentFinishedWhileBlocked = independentFinished;
    const secondFinishedWhileBlocked = secondFinished;
    release.release();
    await Promise.all([first, second, independent]);
    assert.equal(independentFinishedWhileBlocked, true);
    assert.equal(secondFinishedWhileBlocked, false);
    assert.equal(test.storedTag()?.tagId, "build");
    assert.equal(tagRecordSchema.parse(test.metadata.get("other-thread")?.tag).tagId, "ship");
  });

  it("lets a user tag replace any source and a first-turn tag replace a prediction", async () => {
    const test = await fixture();
    assert.equal(await test.suggest("research"), true);
    assert.equal(test.storedTag()?.source, "prediction");
    await test.dispatch();
    assert.equal((await test.tool()).tag, "fix");
    assert.equal(test.storedTag()?.source, "first-turn");
    assert.equal((await test.setTag("ops")).source, "user");
    assert.equal(test.storedTag()?.tagId, "ops");
  });

  it("applies a suggestion only to an untagged chat or over its own earlier guess", async () => {
    const test = await fixture();
    assert.equal(await test.suggest("research"), true);
    assert.equal(await test.suggest("design"), true);
    assert.equal(test.storedTag()?.tagId, "design");

    await test.dispatch();
    await test.tool();
    assert.equal(await test.suggest("ship"), false);
    assert.equal(test.storedTag()?.tagId, "fix");

    await test.setTag(null);
    assert.equal(await test.suggest("ship"), false);
    assert.equal(test.storedTag()?.tagId, null);
    assert.equal(test.storedTag()?.source, "user");
  });

  it("rejects unknown suggestions and lets a null suggestion clear only its own guess", async () => {
    const test = await fixture();
    assert.equal(await test.suggest("nonsense"), false);
    assert.equal(await test.suggest(null), false);
    assert.equal(test.storedTag(), undefined);
    assert.equal(await test.suggest("build"), true);
    assert.equal(await test.suggest(null), true);
    assert.equal(test.storedTag()?.tagId, null);
    assert.equal(test.storedTag()?.source, "prediction");
  });

  it("treats a chat whose tag was removed as untagged, but keeps a user's choice", async () => {
    const test = await fixture();
    await test.dispatch();
    await test.tool();
    await test.tags("tags.remove", { id: "fix" });
    assert.equal(await test.suggest("build"), true);
    assert.equal(test.storedTag()?.tagId, "build");

    await test.setTag("ship");
    await test.tags("tags.remove", { id: "ship" });
    assert.equal(await test.suggest("build"), false);
    assert.equal(test.storedTag()?.tagId, "ship");
    assert.deepEqual(
      z.object({ withTag: z.number() }).parse(await test.host.harness.callRpc("status", {}))
        .withTag,
      0,
    );
  });

  it("rejects a user tag outside the list and publishes changes for open windows", async () => {
    const test = await fixture();
    await assert.rejects(test.setTag("nonsense"), /No tag "nonsense"/u);
    assert.equal(test.storedTag(), undefined);
    await test.setTag("fix");
    await test.tags("tags.update", { id: "fix", patch: { label: "Bugfix" } });

    const payloads = test.host.harness.realtimeSignals.map((signal) =>
      changedPayloadSchema.parse(signal.payload),
    );

    assert.deepEqual(payloads[0], { kind: "threads", threadIds: [test.current().id] });
    assert.equal(payloads[1]?.kind, "tags");

    if (payloads[1]?.kind === "tags") assert.equal(payloads[1].tags[0]?.label, "Bugfix");
  });

  it("starts from the default list and persists edits across reloads", async () => {
    const test = await fixture();
    assert.deepEqual(await test.tags(), ["fix", "build", "ship", "ops", "research", "design"]);
    await test.tags("tags.add", { id: "docs", label: "Docs", icon: "📝" });
    await test.tags("tags.move", { id: "docs", index: 0 });
    await test.tags("tags.remove", { id: "ops" });
    const reloaded = await test.host.harness.reload(plugin);
    hosts.push(reloaded);
    assert.deepEqual(
      tagsSchema.parse(await reloaded.harness.callRpc("tags.list", {})).tags.map((tag) => tag.id),
      ["docs", "fix", "build", "ship", "research", "design"],
    );
  });

  it("refuses duplicate, reserved and malformed tags", async () => {
    const test = await fixture();
    await assert.rejects(
      test.tags("tags.add", { id: "fix", label: "Fix", icon: "🐞" }),
      /already exists/u,
    );

    for (const id of ["none", "Fix", "-fix", "a b"])
      await assert.rejects(test.tags("tags.add", { id, label: "Label", icon: "🏷️" }));
    await assert.rejects(test.tags("tags.update", { id: "fix", patch: { label: "" } }));
    await assert.rejects(test.tags("tags.remove", { id: "nonsense" }), /No tag "nonsense"/u);
    await assert.rejects(fixture({ activatedAt: 1000, tags: [{ id: "fix" }] }), z.ZodError);
  });

  it("changes tags and the list from the CLI without touching the title", async () => {
    const test = await fixture();
    test.rename("Keep this title");

    const tagged = await test.host.harness.runCli(["tag", test.current().id, "--tag", "ship"]);
    assert.deepEqual(tagged, { exitCode: 0, stdout: "Tag: Ship", stderr: "" });
    await test.host.harness.runCli(["tag", test.current().id, "--tag", "none", "--json"]);
    assert.equal(test.storedTag()?.tagId, null);
    assert.equal(test.current().title, "Keep this title");
    assert.equal(test.requests.length, 0);

    const unknown = await test.host.harness.runCli(["tag", test.current().id, "--tag", "x"]);
    assert.equal(unknown.exitCode, 1);

    const added = await test.host.harness.runCli([
      "tags",
      "add",
      "docs",
      "--label",
      "Docs",
      "--icon",
      "📝",
      "--description",
      "READMEs, guides",
    ]);

    assert.equal(added.exitCode, 0);
    assert.match(added.stdout, /7\. 📝 Docs \[docs\] \(READMEs, guides\)/u);
    await test.host.harness.runCli(["tags", "move", "docs", "--to", "1"]);
    await test.host.harness.runCli(["tags", "update", "docs", "--label", "Writing"]);
    await test.host.harness.runCli(["tags", "remove", "ops"]);

    const listed = await test.host.harness.runCli(["tags", "list", "--json"]);
    const list = tagsSchema.parse(JSON.parse(listed.stdout)).tags;
    assert.deepEqual(
      list.map((tag) => tag.id),
      ["docs", "fix", "build", "ship", "research", "design"],
    );
    assert.equal(list[0]?.label, "Writing");

    const empty = await test.host.harness.runCli(["tags", "update", "docs"]);
    assert.equal(empty.exitCode, 1);
    const invalid = await test.host.harness.runCli(["tags", "add", "Bad Id", "--label", "X"]);
    assert.equal(invalid.exitCode, 1);
  });
});
