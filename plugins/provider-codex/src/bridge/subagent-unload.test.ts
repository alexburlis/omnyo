import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerConnection } from "./app-server-connection.js";
import {
  SUBAGENT_UNLOAD_WAIT_LIMIT_MS,
  SubAgentUnloader,
} from "./subagent-unload.js";

const MAIN = "main-thread";

interface FakeThread {
  parentThreadId: string | null;
  status: string;
  unreadable?: boolean;
  terminals?: number;
}

interface FakeOptions {
  open?: string[];
  unsubscribeStatus?: "notLoaded" | "notSubscribed" | "unsubscribed";
  readGate?: Promise<void>;
}

function unloader(
  threads: Record<string, FakeThread>,
  options: FakeOptions = {},
) {
  const requests: string[] = [];
  const warnings: string[] = [];

  const connection: CodexAppServerConnection = {
    exited: false,
    kill: async () => {},
    async request(args) {
      const params = (args.params ?? {}) as { threadId?: string };
      requests.push(`${args.method}:${params.threadId ?? ""}`);

      if (args.method === "thread/loaded/list")
        return args.resultSchema.parse({ data: Object.keys(threads) });

      if (args.method === "thread/read") {
        if (options.readGate !== undefined) await options.readGate;

        const thread = threads[params.threadId ?? ""];

        if (thread === undefined || thread.unreadable)
          throw new Error("thread is not loaded");

        return args.resultSchema.parse({
          thread: {
            id: params.threadId,
            parentThreadId: thread.parentThreadId,
            status: { type: thread.status },
          },
        });
      }

      if (args.method === "thread/backgroundTerminals/list")
        return args.resultSchema.parse({
          data: Array.from(
            { length: threads[params.threadId ?? ""]?.terminals ?? 0 },
            (_, index) => ({ processId: String(index) }),
          ),
        });

      if (args.method === "thread/unsubscribe")
        return args.resultSchema.parse({
          status: options.unsubscribeStatus ?? "unsubscribed",
        });

      if (args.method === "thread/resume")
        return args.resultSchema.parse({ thread: { id: params.threadId } });

      throw new Error(`unexpected ${args.method}`);
    },
  };

  const subject = new SubAgentUnloader({
    mainThreadId: () => MAIN,
    connection: () => connection,
    isSubAgentOpen: (threadId) => (options.open ?? []).includes(threadId),
    warn: (message) => warnings.push(message),
  });

  return { subject, requests, warnings };
}

function statusChanged(
  subject: SubAgentUnloader,
  threadId: string,
  type: string,
) {
  subject.observe("thread/status/changed", { threadId, status: { type } });
}

const sent = (requests: string[], method: string) =>
  requests.filter((request) => request.startsWith(`${method}:`));

const unsubscribed = (requests: string[]) =>
  sent(requests, "thread/unsubscribe");

async function sweepSettles(subject: SubAgentUnloader, trigger: string) {
  statusChanged(subject, trigger, "idle");
  await subject.settled();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("finished sub-agent unloading", () => {
  it("adds no app-server requests to a chat that has shown no sub-agent", async () => {
    const { subject, requests } = unloader({
      [MAIN]: { parentThreadId: null, status: "idle" },
    });

    subject.observe("turn/completed", { threadId: MAIN, turn: { id: "t" } });
    statusChanged(subject, MAIN, "idle");
    await subject.settled();
    expect(requests).toEqual([]);
  });

  it("unloads idle and failed sub-agents, nested ones included, once the chat is not working", async () => {
    for (const mainStatus of ["idle", "systemError"]) {
      const { subject, requests } = unloader({
        [MAIN]: { parentThreadId: null, status: mainStatus },
        first: { parentThreadId: MAIN, status: "idle" },
        failed: { parentThreadId: MAIN, status: "systemError" },
        nested: { parentThreadId: "first", status: "idle" },
      });

      statusChanged(subject, "nested", "idle");
      await vi.waitFor(() =>
        expect(unsubscribed(requests)).toEqual([
          "thread/unsubscribe:first",
          "thread/unsubscribe:failed",
          "thread/unsubscribe:nested",
        ]),
      );
    }
  });

  it("leaves everything loaded while the chat or any sub-agent is still working", async () => {
    const cases: Record<string, FakeThread>[] = [
      {
        [MAIN]: { parentThreadId: null, status: "active" },
        done: { parentThreadId: MAIN, status: "idle" },
      },
      {
        [MAIN]: { parentThreadId: null, status: "idle" },
        done: { parentThreadId: MAIN, status: "idle" },
        working: { parentThreadId: MAIN, status: "active" },
      },
    ];

    for (const threads of cases) {
      const { subject, requests } = unloader(threads);

      await sweepSettles(subject, "done");
      expect(requests).toContain("thread/loaded/list:");
      expect(unsubscribed(requests)).toEqual([]);
    }
  });

  it("keeps a sub-agent the chat still shows as running, and every sub-agent above it", async () => {
    const { subject, requests } = unloader(
      {
        [MAIN]: { parentThreadId: null, status: "idle" },
        parent: { parentThreadId: MAIN, status: "idle" },
        shown: { parentThreadId: "parent", status: "idle" },
        done: { parentThreadId: MAIN, status: "idle" },
      },
      { open: ["shown"] },
    );

    await sweepSettles(subject, "done");
    expect(unsubscribed(requests)).toEqual(["thread/unsubscribe:done"]);
  });

  it("keeps a sub-agent with a running background terminal, and every sub-agent above it", async () => {
    const { subject, requests } = unloader({
      [MAIN]: { parentThreadId: null, status: "idle" },
      parent: { parentThreadId: MAIN, status: "idle" },
      server: { parentThreadId: "parent", status: "idle", terminals: 1 },
      done: { parentThreadId: MAIN, status: "idle" },
    });

    await sweepSettles(subject, "done");
    expect(sent(requests, "thread/backgroundTerminals/list")).toHaveLength(3);
    expect(unsubscribed(requests)).toEqual(["thread/unsubscribe:done"]);
  });

  it("reports a thread it cannot read and unloads nothing", async () => {
    const { subject, requests, warnings } = unloader({
      [MAIN]: { parentThreadId: null, status: "idle" },
      done: { parentThreadId: MAIN, status: "idle" },
      unknown: { parentThreadId: MAIN, status: "active", unreadable: true },
    });

    await sweepSettles(subject, "done");
    expect(unsubscribed(requests)).toEqual([]);
    expect(warnings).toEqual([
      expect.stringContaining("codex could not unload finished sub-agents"),
    ]);
  });

  it("does not wait for a sub-agent Codex did not unsubscribe", async () => {
    const { subject, requests } = unloader(
      {
        [MAIN]: { parentThreadId: null, status: "idle" },
        done: { parentThreadId: MAIN, status: "idle" },
      },
      { unsubscribeStatus: "notSubscribed" },
    );

    statusChanged(subject, "done", "idle");

    const started = Date.now();

    await subject.settled();
    expect(unsubscribed(requests)).toEqual(["thread/unsubscribe:done"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("asks once per sub-agent while its unload is pending", async () => {
    const { subject, requests } = unloader({
      [MAIN]: { parentThreadId: null, status: "idle" },
      done: { parentThreadId: MAIN, status: "idle" },
    });

    statusChanged(subject, "done", "idle");
    await vi.waitFor(() =>
      expect(unsubscribed(requests)).toEqual(["thread/unsubscribe:done"]),
    );
    statusChanged(subject, MAIN, "idle");
    await vi.waitFor(() =>
      expect(sent(requests, "thread/loaded/list")).toHaveLength(2),
    );
    expect(unsubscribed(requests)).toEqual(["thread/unsubscribe:done"]);
  });

  it("holds the next turn through a sweep that was queued behind a running one", async () => {
    let openGate = () => {};

    const readGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const threads: Record<string, FakeThread> = {
      [MAIN]: { parentThreadId: null, status: "active" },
      done: { parentThreadId: MAIN, status: "idle" },
    };

    const { subject, requests } = unloader(threads, { readGate });

    statusChanged(subject, "done", "idle");
    await vi.waitFor(() =>
      expect(sent(requests, "thread/read").length).toBeGreaterThan(0),
    );
    threads[MAIN] = { parentThreadId: null, status: "idle" };
    statusChanged(subject, MAIN, "idle");

    let released = false;

    const waiting = subject.settled().then(() => {
      released = true;
    });

    openGate();
    await vi.waitFor(() =>
      expect(unsubscribed(requests)).toEqual(["thread/unsubscribe:done"]),
    );
    expect(released).toBe(false);
    subject.observe("thread/closed", { threadId: "done" });
    await waiting;
    expect(released).toBe(true);
  });

  it("never unsubscribes while the chat is starting a turn or after Codex starts one", async () => {
    let openGate = () => {};

    const readGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const { subject, requests } = unloader(
      {
        [MAIN]: { parentThreadId: null, status: "idle" },
        done: { parentThreadId: MAIN, status: "idle" },
      },
      { readGate },
    );

    statusChanged(subject, "done", "idle");

    const release = subject.hold();

    openGate();
    await subject.settled();
    expect(unsubscribed(requests)).toEqual([]);
    release();

    let reopen = () => {};

    const second = unloader(
      {
        [MAIN]: { parentThreadId: null, status: "idle" },
        done: { parentThreadId: MAIN, status: "idle" },
      },
      {
        readGate: new Promise<void>((resolve) => {
          reopen = resolve;
        }),
      },
    );

    statusChanged(second.subject, "done", "idle");
    second.subject.observe("turn/started", {
      threadId: MAIN,
      turn: { id: "codex-started" },
    });
    reopen();
    await second.subject.settled();
    expect(unsubscribed(second.requests)).toEqual([]);
  });

  it("reattaches a sub-agent that starts working again before Codex unloads it", async () => {
    const { subject, requests } = unloader({
      [MAIN]: { parentThreadId: null, status: "idle" },
      done: { parentThreadId: MAIN, status: "idle" },
    });

    statusChanged(subject, "done", "idle");
    await vi.waitFor(() =>
      expect(unsubscribed(requests)).toEqual(["thread/unsubscribe:done"]),
    );
    statusChanged(subject, "done", "active");
    await vi.waitFor(() =>
      expect(sent(requests, "thread/resume")).toEqual(["thread/resume:done"]),
    );

    const started = Date.now();

    await subject.settled();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("caps the wait for an unload Codex never confirms", async () => {
    vi.useFakeTimers();

    const { subject, requests } = unloader({
      [MAIN]: { parentThreadId: null, status: "idle" },
      done: { parentThreadId: MAIN, status: "idle" },
    });

    statusChanged(subject, "done", "idle");
    await vi.waitFor(() =>
      expect(unsubscribed(requests)).toEqual(["thread/unsubscribe:done"]),
    );

    let bounded = false;

    const capped = subject.settled().then(() => {
      bounded = true;
    });

    await vi.advanceTimersByTimeAsync(SUBAGENT_UNLOAD_WAIT_LIMIT_MS - 100);
    expect(bounded).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await capped;
    expect(bounded).toBe(true);

    let again = false;

    const immediate = subject.settled().then(() => {
      again = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    await immediate;
    expect(again).toBe(true);
  });
});
