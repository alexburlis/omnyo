import type { InboxWaitView } from "@omnyo/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerWaitCommands } from "../../commands/wait.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");

function localTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const HOUR = 3_600_000;

const DAY = 24 * HOUR;

const MARKER = "[omnyo wait 11111111-2222-3333-4444-555555555555]";

function waitView(overrides: Partial<InboxWaitView> = {}): InboxWaitView {
  return {
    id: "wait-1",
    key: "ci-main",
    generation: 1,
    kind: "check",
    status: "live",
    forText: "CI on main",
    marker: MARKER,
    deadline: NOW + 7 * DAY,
    nextCheckAt: NOW + 2 * HOUR,
    checkCount: 0,
    createdBy: "agent",
    ownerAccepted: false,
    conditions: [
      { key: "check", kind: "check", label: "CI green", met: false },
    ],
    ...overrides,
  };
}

function logLines(): string[] {
  return collectLogLines(vi.mocked(console.log));
}

function errorLines(): string[] {
  return collectLogLines(vi.mocked(console.error));
}

describe("omnyo wait command output", () => {
  setupCommandOutputTestEnvironment();

  afterEach(() => {
    vi.useRealTimers();
  });

  const register: CommandRegistrar = (program) =>
    registerWaitCommands(
      program.enablePositionalOptions(),
      () => "http://server",
    );

  it("registers a timed check at the times it was given", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.stubEnv("OMNYO_THREAD_ID", "thr_self");

    const post = vi.fn(async (_request: { json: unknown }) => ({
      wait: waitView(),
      existing: false,
    }));

    stubServerApi({ "v1.threads.:id.waits.$post": post });
    await runCommand(
      [
        "wait",
        "--self",
        "--key",
        "ci-main",
        "--for",
        "CI on main",
        "--check",
        "CI green",
        "--at",
        "2h",
        "--by",
        "7d",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thr_self" },
        json: {
          key: "ci-main",
          for: "CI on main",
          chats: [],
          events: [],
          check: { what: "CI green", at: NOW + 2 * HOUR },
          report: null,
          readiness: "all",
          by: NOW + 7 * DAY,
          resume: null,
          after: null,
        },
      }),
    );
    expect(logLines()).toEqual([
      "Wait wait-1 registered (check): CI on main",
      `Deadline: ${localTime(NOW + 7 * DAY)}`,
      `Next check: ${localTime(NOW + 2 * HOUR)}`,
      `Marker: ${MARKER}`,
    ]);
  });

  it("prints the reply each source chat sends for a chat wait", async () => {
    const post = vi.fn(async (_request: { json: unknown }) => ({
      wait: waitView({
        kind: "join",
        conditions: [
          { key: "chat:thr_src", kind: "chat", label: "Review PR", met: false },
          { key: "chat:thr_ci", kind: "chat", label: "CI runner", met: false },
        ],
        nextCheckAt: null,
      }),
      existing: false,
    }));

    stubServerApi({ "v1.threads.:id.waits.$post": post });
    await runCommand(
      [
        "wait",
        "thr_waiter",
        "--key",
        "review",
        "--for",
        "Review and CI",
        "--chat",
        "thr_src",
        "--chat",
        "thr_ci",
        "--any",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thr_waiter" },
        json: expect.objectContaining({
          chats: ["thr_src", "thr_ci"],
          readiness: "any",
          check: null,
        }),
      }),
    );
    expect(logLines().slice(-2)).toEqual([
      "Ask Review PR, CI runner to reply with:",
      `  omnyo thread tell thr_waiter --mode auto "${MARKER} <result>"`,
    ]);
  });

  it("--json prints the server's wait with the chat it belongs to", async () => {
    stubServerApi({
      "v1.threads.:id.waits.$post": async () => ({
        wait: waitView(),
        existing: true,
      }),
    });

    await runCommand(
      [
        "wait",
        "thr_waiter",
        "--key",
        "ci-main",
        "--for",
        "CI on main",
        "--check",
        "CI green",
        "--at",
        "2h",
        "--json",
      ],
      register,
    );

    expect(JSON.parse(logLines()[0] ?? "")).toEqual({
      threadId: "thr_waiter",
      wait: waitView(),
      existing: true,
    });
  });

  it.each([
    [
      ["--for", "CI", "--check", "CI green", "--at", "2h"],
      "Error: Missing --key.",
    ],
    [
      ["--key", "ci", "--check", "CI green", "--at", "2h"],
      "Error: Missing --for.",
    ],
    [
      ["--key", "ci", "--for", "CI", "--check", "CI green"],
      "Error: --check and --at go together.",
    ],
    [
      ["--key", "ci", "--for", "CI", "--chat", "thr_src", "--all", "--any"],
      "Error: Pass --all or --any, not both.",
    ],
    [
      ["--key", "ci", "--for", "CI", "--check", "CI green", "--at", "10"],
      "Error: Invalid --at value '10'. It is neither a timestamp nor a duration. Expected an ISO 8601 timestamp such as 2026-08-25T09:00 or a duration such as 30s, 10m, 2h, or 7d.",
    ],
  ])(
    "refuses an incomplete registration %j before calling the server",
    async (flags, message) => {
      const post = vi.fn();
      stubServerApi({ "v1.threads.:id.waits.$post": post });

      await expect(
        runCommand(["wait", "thr_waiter", ...flags], register),
      ).rejects.toThrow("process.exit:1");

      expect(errorLines()[0]).toBe(message);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("answers the wake inside the chat it woke, as the wake prompt writes it", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thr_self");

    const rearmed = waitView({ nextCheckAt: NOW + 4 * HOUR, checkCount: 1 });

    const rearm = vi.fn(async () => ({ wait: rearmed, proposed: false }));
    stubServerApi({ "v1.threads.:id.waits.:waitId.rearm.$post": rearm });

    await runCommand(["wait", "rearm", "wait-1", "--json"], register);

    expect(rearm).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thr_self", waitId: "wait-1" },
      }),
    );
    expect(JSON.parse(logLines()[0] ?? "")).toEqual({
      threadId: "thr_self",
      wait: rearmed,
      proposed: false,
    });
  });

  it("records a met condition with its result and names what is pending", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thr_self");

    const met = vi.fn(async (_request: { json: unknown }) => ({
      wait: waitView({
        kind: "join",
        conditions: [
          { key: "chat:thr_src", kind: "chat", label: "Review PR", met: true },
          { key: "check", kind: "check", label: "CI green", met: false },
        ],
      }),
      proposed: false,
    }));

    stubServerApi({ "v1.threads.:id.waits.:waitId.met.$post": met });
    await runCommand(
      [
        "wait",
        "met",
        "wait-1",
        "--condition",
        "chat:thr_src",
        "--result",
        "Approved",
        "--self",
      ],
      register,
    );

    expect(met).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thr_self", waitId: "wait-1" },
        json: { condition: "chat:thr_src", result: "Approved" },
      }),
    );
    expect(logLines()).toEqual([
      "Condition chat:thr_src met on wait wait-1; pending: check.",
    ]);
  });

  it("reports an agent's cancel of the owner's wait as a proposal", async () => {
    stubServerApi({
      "v1.threads.:id.waits.:waitId.cancel.$post": async () => ({
        wait: waitView({ kind: "date", forText: "Your date" }),
        proposed: true,
      }),
    });

    await runCommand(["wait", "cancel", "wait-1", "thr_waiter"], register);

    expect(logLines()).toEqual([
      "Proposed to the owner: Stop waiting: Your date?",
    ]);
  });

  it("lists open waits with their conditions and marker", async () => {
    stubServerApi({
      "v1.threads.:id.waits.$get": async () => ({
        waits: [
          waitView({
            kind: "join",
            checkCount: 2,
            conditions: [
              {
                key: "chat:thr_src",
                kind: "chat",
                label: "Review PR",
                met: true,
              },
              { key: "check", kind: "check", label: "CI green", met: false },
            ],
          }),
        ],
      }),
    });

    await runCommand(["wait", "list", "thr_waiter"], register);

    expect(logLines()).toEqual([
      "wait-1 · join · live · CI on main",
      `  deadline ${localTime(NOW + 7 * DAY)} · next check ${localTime(NOW + 2 * HOUR)} · checked 2×`,
      '  Conditions: chat:thr_src "Review PR" met, check "CI green" pending',
      `  Marker: ${MARKER}`,
    ]);
  });

  it("lists event sources with their format, cadence and health", async () => {
    const health = {
      lastCheckAt: null,
      lastOkAt: null,
      lastError: null,
      consecutiveFailures: 0,
      proof: null,
    };

    stubServerApi({
      "v1.inbox.events.sources.$get": async () => ({
        sources: [
          {
            family: "host-reconnect",
            owner: "core",
            label: "A machine reconnects to Omnyo",
            keyFormat: "host-reconnect:<hostId>",
            examples: ["host-reconnect:host_1"],
            approval: "none",
            kind: "push",
            everyMs: null,
            pendingKeys: 0,
            health: { ...health, state: "idle" },
          },
          {
            family: "http",
            owner: "wait-sources",
            label: "A URL answers",
            keyFormat: "http:<url>[#<text>]",
            examples: ["http:https://example.com/health#ok"],
            approval: "owner",
            kind: "poll",
            everyMs: 120_000,
            pendingKeys: 2,
            health: {
              ...health,
              state: "failing",
              consecutiveFailures: 3,
              lastError: "fetch failed",
            },
          },
        ],
      }),
    });

    await runCommand(["wait", "sources"], register);

    expect(logLines()).toEqual([
      "host-reconnect · core · push",
      "  A machine reconnects to Omnyo",
      "  Format: host-reconnect:<hostId>",
      "  Example: host-reconnect:host_1",
      "http · plugin wait-sources · poll every 2 min · asks the owner",
      "  A URL answers",
      "  Format: http:<url>[#<text>]",
      "  Example: http:https://example.com/health#ok",
      "  Pending: 2 · failing 3×: fetch failed",
    ]);
  });

  it("dry-runs an event key and exits 1 when it is invalid", async () => {
    const check = vi.fn(async (request: { json: { key: string } }) =>
      request.json.key === "github-pr:a/b#1"
        ? {
            key: "github-pr:a/b#1",
            family: "github-pr",
            valid: true,
            error: null,
            describe: "a/b#1 merges or closes",
            kind: "poll",
            approval: "none",
            fired: true,
            result: "a/b#1 merged.",
          }
        : {
            key: request.json.key,
            family: "github-pr",
            valid: false,
            error: "github-pr:nope: expected <owner>/<repo>#<number>.",
            describe: null,
            kind: "poll",
            approval: "none",
            fired: null,
            result: null,
          },
    );

    stubServerApi({ "v1.inbox.events.check.$post": check });

    await runCommand(["wait", "check", "github-pr:a/b#1"], register);
    expect(logLines()).toEqual([
      "github-pr:a/b#1: a/b#1 merges or closes",
      "Source: github-pr (poll)",
      "Fires now: a/b#1 merged.",
    ]);
    expect(process.exitCode).toBeUndefined();

    vi.mocked(console.log).mockClear();
    await runCommand(["wait", "check", "github-pr:nope"], register);
    expect(logLines()).toEqual([
      "Invalid: github-pr:nope: expected <owner>/<repo>#<number>.",
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("asks for a chat outside an Omnyo chat", async () => {
    const get = vi.fn();
    stubServerApi({ "v1.threads.:id.waits.$get": get });

    await expect(runCommand(["wait", "list"], register)).rejects.toThrow(
      "process.exit:1",
    );

    expect(errorLines()).toEqual([
      "Error: Missing thread ID. Pass <threadId> or --self, or run inside an Omnyo chat.",
      "Pass a thread ID; --self is unavailable because OMNYO_THREAD_ID is not set.",
    ]);
    expect(get).not.toHaveBeenCalled();
  });
});
