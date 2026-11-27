import { expect, it } from "vitest";
import { type ContextBinding, type JsonPayload } from "../contracts.js";
import { ThreadLifecycle, type LifecyclePort } from "../lifecycle.js";

const binding: ContextBinding = {
  threadId: "thread-a",
  projectId: "project-a",
  environmentId: "environment-a",
  hostId: "host-a",
  canonicalRoot: "/workspace",
  workspaceId: "workspace",
  policyHash: "a".repeat(64),
  platform: "darwin",
  arch: "arm64",
};

function fixture() {
  const data = new Map<string, JsonPayload>();
  const events: { seq: number; reason: string }[] = [{ seq: 1, reason: "manual-stop" }];
  const calls: string[] = [];
  const completions = new Map<string, string>();
  let admitted = false;
  let finished = false;
  let cancelled = false;
  const accepted = { runId: "run-a", sessionId: "session-a", state: "accepted" };

  const port: LifecyclePort = {
    async load(key) {
      return data.get(key);
    },
    async save(key, value) {
      data.set(key, structuredClone(value));
    },
    async keys(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
    async latest() {
      return events.at(-1)?.seq ?? 0;
    },
    async interruptions(_thread, after) {
      return events.filter((e) => e.seq > after);
    },
    async invoke(method, _binding): Promise<JsonPayload> {
      calls.push(method);

      if (method === "submission") return admitted ? accepted : null;

      if (method === "releaseClient") {
        cancelled = true;

        return { released: true };
      }

      if (cancelled || finished)
        return {
          runId: "run-a",
          state: cancelled ? "cancelled" : "completed",
          result: {
            sessionId: "session-a",
            verdict: cancelled ? "CANCELLED" : "FAILED",
            checks: [],
            evidence: [{ id: "evidence-a" }],
          },
        };

      return { runId: "run-a", state: "running" };
    },
    async remember() {
      calls.push("remember");
    },
    async suppressCompletion() {},
    async completion(input) {
      completions.set(input.runId, input.summary);
    },
  };

  const life = new ThreadLifecycle(port);

  return {
    life,
    port,
    data,
    events,
    calls,
    completions,
    admit() {
      admitted = true;
    },
    finish() {
      finished = true;
    },
    accepted,
  };
}

it("ignores historical Stop and ordinary idle, then cancels a fresh detached job after tool settlement", async () => {
  const f = fixture();
  const payload = { requestId: "request-a" };
  await f.life.prepare(binding, payload, new AbortController().signal);
  f.admit();
  await f.life.accepted(binding, payload, f.accepted);
  await f.life.detached(binding, "request-a");
  expect(f.calls).not.toContain("releaseClient");
  await f.life.hint(binding.threadId);
  expect(f.calls).not.toContain("releaseClient");
  f.events.push({ seq: 2, reason: "manual-stop" });
  await f.life.hint(binding.threadId);
  expect(f.calls).toContain("releaseClient");
  expect(f.completions.size).toBe(0);
  expect(await f.life.index(binding.threadId)).toMatchObject([
    { runId: "run-a", state: "cancelled" },
  ]);
  const count = f.calls.filter((c) => c === "releaseClient").length;
  await f.life.hint(binding.threadId);
  expect(f.calls.filter((c) => c === "releaseClient")).toHaveLength(count);
});

it("preserves a Stop arriving between durable preparation and accepted reply", async () => {
  const f = fixture();
  const payload = { requestId: "request-a" };
  await f.life.prepare(binding, payload, new AbortController().signal);
  f.events.push({ seq: 2, reason: "manual-stop" });
  await f.life.hint(binding.threadId);
  f.admit();
  await f.life.accepted(binding, payload, f.accepted);
  await f.life.detached(binding, "request-a");
  expect(f.calls.filter((c) => c === "releaseClient").length).toBeGreaterThanOrEqual(2);
  expect(f.completions.size).toBe(0);
  expect(await f.life.index(binding.threadId)).toMatchObject([{ state: "cancelled" }]);
});

it("does not enqueue synchronous completion and retains the engine's failed verdict for a detached callback", async () => {
  const f = fixture();
  const payload = { requestId: "request-a" };
  await f.life.prepare(binding, payload, new AbortController().signal);
  f.admit();
  await f.life.accepted(binding, payload, f.accepted);
  f.finish();
  await f.life.hint(binding.threadId);
  expect(f.completions.size).toBe(0);
  await f.life.detached(binding, "request-a");
  await f.life.hint(binding.threadId);
  expect(f.completions.size).toBe(1);
  expect(f.completions.get("run-a")).toContain("FAILED");
});

it("recovers a reply-lost admission by lookup and disposal with no submit route", async () => {
  const f = fixture();
  await f.life.prepare(binding, { requestId: "request-a" }, new AbortController().signal);
  f.admit();
  const recovered = new ThreadLifecycle(f.port);
  await recovered.recover();
  expect(f.calls).toContain("submission");
  expect(f.calls).toContain("releaseClient");
  expect(f.calls).not.toContain("submit");
  expect(await recovered.index(binding.threadId)).toMatchObject([
    { runId: "run-a", state: "cancelled" },
  ]);
});

it("refuses a cancelled admission before writing ownership or invoking the host", async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(f.life.prepare(binding, { requestId: "request-a" }, abort.signal)).rejects.toThrow();
  expect(f.data.size).toBe(0);
  expect(f.calls).toEqual([]);
});
