import { describe, expect, it } from "vitest";
import type { Disposition, ObservedProcess, ThreadState } from "../contract";
import {
  ARCHIVE_GRACE_MS,
  NOTICE_PERIOD_MS,
  decide,
  hasOpenWork,
  identityKey,
  indexByPid,
  isKeptByUser,
  isThreadBusy,
  nextStep,
  stopClosure,
  threadStateOf,
  type DecideInput,
  type WorkEvidence,
} from "../policy";

const HOUR = 3_600_000;

const NOW = 1_000 * HOUR;

const INSTALLED_LONG_AGO = NOW - 10 * NOTICE_PERIOD_MS;

const INSTALLED_JUST_NOW = NOW - HOUR;

const NOTICE_ENDS = INSTALLED_JUST_NOW + NOTICE_PERIOD_MS;

const IDLE_PAST: ThreadState = { kind: "idle", since: NOW - 25 * HOUR };

const IDLE_RECENT: ThreadState = { kind: "idle", since: NOW - HOUR };

const ARCHIVED_PAST: ThreadState = { kind: "archived", since: NOW - 2 * ARCHIVE_GRACE_MS };

const ARCHIVED_RECENT: ThreadState = { kind: "archived", since: NOW - 1000 };

const DELETED: ThreadState = { kind: "deleted" };

const RUNNING: ThreadState = { kind: "running" };

const BASE: DecideInput = {
  thread: IDLE_PAST,
  kept: false,
  keepRequested: false,
  openWork: false,
  threadBusy: false,
  now: NOW,
  installedAt: INSTALLED_LONG_AGO,
  settings: { autoStop: true, idleHours: 24 },
  ignoreTimers: false,
};

type DecideRow = [string, Partial<DecideInput>, Disposition];

const DECIDE_TABLE: DecideRow[] = [
  ["idle past its timer stops", {}, { kind: "stop", reason: "idle" }],
  [
    "idle before its timer waits for the timer",
    { thread: IDLE_RECENT },
    { kind: "waiting", reason: "timer", stopAt: IDLE_RECENT.since + 24 * HOUR },
  ],
  [
    "idleHours moves the idle timer",
    { thread: IDLE_RECENT, settings: { autoStop: true, idleHours: 2 } },
    { kind: "waiting", reason: "timer", stopAt: IDLE_RECENT.since + 2 * HOUR },
  ],
  ["archived past 60 s stops", { thread: ARCHIVED_PAST }, { kind: "stop", reason: "archived" }],
  [
    "archived inside the undo window waits",
    { thread: ARCHIVED_RECENT },
    { kind: "waiting", reason: "timer", stopAt: ARCHIVED_RECENT.since + ARCHIVE_GRACE_MS },
  ],
  ["deleted stops at once", { thread: DELETED }, { kind: "stop", reason: "deleted" }],
  ["running chat is in use", { thread: RUNNING }, { kind: "in-use", reason: "chat-running" }],
  ["user keep wins over a stop", { kept: true }, { kind: "kept", reason: "user" }],
  [
    "launch env keep wins over a stop",
    { keepRequested: true },
    { kind: "kept", reason: "launch-env" },
  ],
  [
    "user keep wins over launch env",
    { kept: true, keepRequested: true },
    { kind: "kept", reason: "user" },
  ],
  [
    "kept wins over a running chat",
    { kept: true, thread: RUNNING },
    { kind: "kept", reason: "user" },
  ],
  [
    "running wins over busy",
    { thread: RUNNING, threadBusy: true },
    { kind: "in-use", reason: "chat-running" },
  ],
  ["busy defers idle", { threadBusy: true }, { kind: "waiting", reason: "busy", stopAt: null }],
  [
    "busy defers archived",
    { thread: ARCHIVED_PAST, threadBusy: true },
    { kind: "waiting", reason: "busy", stopAt: null },
  ],
  [
    "busy defers deleted",
    { thread: DELETED, threadBusy: true },
    { kind: "waiting", reason: "busy", stopAt: null },
  ],
  [
    "busy wins over open work",
    { threadBusy: true, openWork: true },
    { kind: "waiting", reason: "busy", stopAt: null },
  ],
  [
    "open work defers idle",
    { openWork: true },
    { kind: "waiting", reason: "open-work", stopAt: null },
  ],
  [
    "open work wins over the notice period",
    { openWork: true, installedAt: INSTALLED_JUST_NOW },
    { kind: "waiting", reason: "open-work", stopAt: null },
  ],
  [
    "notice period holds an expired idle timer",
    { installedAt: INSTALLED_JUST_NOW },
    { kind: "waiting", reason: "notice-period", stopAt: NOTICE_ENDS },
  ],
  [
    "notice period holds a deleted chat",
    { thread: DELETED, installedAt: INSTALLED_JUST_NOW },
    { kind: "waiting", reason: "notice-period", stopAt: NOTICE_ENDS },
  ],
  [
    "notice period reports the later timer",
    { thread: { kind: "idle", since: NOW }, installedAt: INSTALLED_JUST_NOW },
    { kind: "waiting", reason: "notice-period", stopAt: NOW + 24 * HOUR },
  ],
  [
    "the first moment after the notice period can stop",
    { installedAt: NOW - NOTICE_PERIOD_MS },
    { kind: "stop", reason: "idle" },
  ],
  [
    "the exact timer end can stop",
    { thread: { kind: "idle", since: NOW - 24 * HOUR } },
    { kind: "stop", reason: "idle" },
  ],
  [
    "autoStop off never stops an expired timer",
    { settings: { autoStop: false, idleHours: 24 } },
    { kind: "waiting", reason: "timer", stopAt: null },
  ],
  [
    "autoStop off never stops a deleted chat",
    { thread: DELETED, settings: { autoStop: false, idleHours: 24 } },
    { kind: "waiting", reason: "timer", stopAt: null },
  ],
  [
    "autoStop off keeps reporting busy",
    { threadBusy: true, settings: { autoStop: false, idleHours: 24 } },
    { kind: "waiting", reason: "busy", stopAt: null },
  ],
  [
    "ignoreTimers skips an unexpired timer",
    { thread: IDLE_RECENT, ignoreTimers: true },
    { kind: "stop", reason: "idle" },
  ],
  [
    "ignoreTimers skips the notice period",
    { installedAt: INSTALLED_JUST_NOW, ignoreTimers: true },
    { kind: "stop", reason: "idle" },
  ],
  [
    "ignoreTimers respects a user keep",
    { kept: true, ignoreTimers: true },
    { kind: "kept", reason: "user" },
  ],
  [
    "ignoreTimers respects a launch env keep",
    { keepRequested: true, ignoreTimers: true },
    { kind: "kept", reason: "launch-env" },
  ],
  [
    "ignoreTimers respects busy",
    { threadBusy: true, ignoreTimers: true },
    { kind: "waiting", reason: "busy", stopAt: null },
  ],
  [
    "ignoreTimers respects open work",
    { openWork: true, ignoreTimers: true },
    { kind: "waiting", reason: "open-work", stopAt: null },
  ],
  [
    "ignoreTimers respects a running chat",
    { thread: RUNNING, ignoreTimers: true },
    { kind: "in-use", reason: "chat-running" },
  ],
  [
    "ignoreTimers does not override autoStop off",
    { ignoreTimers: true, settings: { autoStop: false, idleHours: 24 } },
    { kind: "waiting", reason: "timer", stopAt: null },
  ],
];

describe("decide", () => {
  it.each(DECIDE_TABLE)("%s", (_name, overrides, expected) => {
    expect(decide({ ...BASE, ...overrides })).toEqual(expected);
  });
});

describe("threadStateOf", () => {
  const thread = { status: "idle", archivedAt: null, deletedAt: null, updatedAt: 5 };

  it.each(["starting", "active", "stopping", "pending"])("treats %s as running", (status) => {
    expect(threadStateOf({ ...thread, status })).toEqual({ kind: "running" });
  });

  it.each(["idle", "error"])("treats %s as idle since updatedAt", (status) => {
    expect(threadStateOf({ ...thread, status })).toEqual({ kind: "idle", since: 5 });
  });

  it("uses archivedAt as the archive clock", () => {
    expect(threadStateOf({ ...thread, archivedAt: 9 })).toEqual({ kind: "archived", since: 9 });
  });

  it("does not stop a chat still running after its archive", () => {
    expect(threadStateOf({ ...thread, status: "stopping", archivedAt: 9 })).toEqual({
      kind: "running",
    });
  });

  it("treats a soft-deleted chat as deleted", () => {
    expect(threadStateOf({ ...thread, deletedAt: 3 })).toEqual({ kind: "deleted" });
  });
});

describe("hasOpenWork", () => {
  const closed: WorkEvidence = {
    activity: [],
    waits: [],
    requiredInput: [],
    postponement: null,
    primary: { reason: { code: "assessed-complete" } },
  };

  it("reports no open work for a settled chat, even after a failed run", () => {
    expect(hasOpenWork(closed)).toBe(false);
    expect(hasOpenWork({ ...closed, primary: { reason: { code: "run-failed" } } })).toBe(false);
  });

  it.each<[string, Partial<WorkEvidence>]>([
    ["background activity", { activity: [{ id: "command:1" }] }],
    ["an open wait", { waits: [{ id: "wait:1" }] }],
    ["a required answer", { requiredInput: [{ id: "question:1" }] }],
    ["a postponement", { postponement: { reason: "Back at noon" } }],
    ["unverified ownership", { primary: { reason: { code: "unverified-work" } } }],
  ])("reports open work for %s", (_name, evidence) => {
    expect(hasOpenWork({ ...closed, ...evidence })).toBe(true);
  });
});

function process(overrides: Partial<ObservedProcess> & { pid: number }): ObservedProcess {
  return {
    startedAt: `started-${overrides.pid}`,
    ppid: 1,
    threadId: "thr_one",
    role: "workload",
    executable: "node",
    command: "node",
    memoryBytes: 1024,
    memorySource: "footprint",
    cpuSeconds: 100,
    keepRequested: false,
    ...overrides,
  };
}

describe("isThreadBusy", () => {
  const workload = process({ pid: 10, cpuSeconds: 106 });
  const key = identityKey(workload);
  const window = 100_000;

  it("is busy above 5% of one core", () => {
    const baseline = new Map([[key, { cpuSeconds: 100, sampledAt: NOW - window }]]);

    expect(isThreadBusy([workload], baseline, NOW)).toBe(true);
  });

  it("is not busy at or below 5% of one core", () => {
    const baseline = new Map([[key, { cpuSeconds: 101, sampledAt: NOW - window }]]);

    expect(isThreadBusy([{ ...workload, cpuSeconds: 106 }], baseline, NOW)).toBe(false);
  });

  it("treats a process with no previous sample as busy", () => {
    expect(isThreadBusy([workload], new Map(), NOW)).toBe(true);
  });

  it("treats a zero-length window as busy", () => {
    expect(
      isThreadBusy([workload], new Map([[key, { cpuSeconds: 106, sampledAt: NOW }]]), NOW),
    ).toBe(true);
  });

  it("is thread-wide: one busy child marks the thread", () => {
    const quiet = process({ pid: 11, cpuSeconds: 100 });

    const baseline = new Map([
      [key, { cpuSeconds: 100, sampledAt: NOW - window }],
      [identityKey(quiet), { cpuSeconds: 100, sampledAt: NOW - window }],
    ]);

    expect(isThreadBusy([quiet, workload], baseline, NOW)).toBe(true);
  });
});

describe("keep coverage", () => {
  const parent = process({ pid: 20 });
  const child = process({ pid: 21, ppid: 20 });
  const grandchild = process({ pid: 22, ppid: 21 });
  const stranger = process({ pid: 30 });
  const byPid = indexByPid([parent, child, grandchild, stranger]);
  const keeps = new Set([identityKey(parent)]);

  it("covers the process and every descendant", () => {
    expect(isKeptByUser(parent, byPid, keeps)).toBe(true);
    expect(isKeptByUser(grandchild, byPid, keeps)).toBe(true);
  });

  it("does not cover an unrelated process or a keep on a reused pid", () => {
    expect(isKeptByUser(stranger, byPid, keeps)).toBe(false);
    expect(isKeptByUser({ ...parent, startedAt: "later" }, new Map(), keeps)).toBe(false);
  });

  it("survives a ppid cycle", () => {
    const first = process({ pid: 40, ppid: 41 });
    const second = process({ pid: 41, ppid: 40 });

    expect(isKeptByUser(first, indexByPid([first, second]), new Set())).toBe(false);
  });
});

describe("stopClosure", () => {
  const root = process({ pid: 50 });
  const child = process({ pid: 51, ppid: 50 });
  const grandchild = process({ pid: 52, ppid: 51 });
  const helper = process({ pid: 53, ppid: 50, role: "helper" });
  const stranger = process({ pid: 60 });
  const all = [root, child, grandchild, helper, stranger];
  const pids = (selected: ObservedProcess[]) => selected.map((entry) => entry.pid);

  it("adds workload descendants, deepest first, so children are not orphaned", () => {
    expect(pids(stopClosure([root], all, new Set()))).toEqual([52, 51, 50]);
  });

  it("leaves a descendant the user kept itself", () => {
    expect(pids(stopClosure([root], all, new Set([identityKey(child)])))).toEqual([52, 50]);
  });

  it("leaves a descendant that asked to keep running on its own", () => {
    const requested = { ...child, keepRequested: true };

    expect(pids(stopClosure([root], [root, requested, grandchild], new Set()))).toEqual([52, 50]);
  });

  it("stops a descendant whose keep request it inherited from the stopped parent", () => {
    const parentAsked = { ...root, keepRequested: true };
    const childAsked = { ...child, keepRequested: true };

    expect(pids(stopClosure([parentAsked], [parentAsked, childAsked], new Set()))).toEqual([
      51, 50,
    ]);
  });
});

describe("nextStep", () => {
  it.each<[Disposition, string]>([
    [{ kind: "in-use", reason: "chat-running" }, "Chat is running"],
    [{ kind: "kept", reason: "user" }, "Kept"],
    [{ kind: "kept", reason: "launch-env" }, "Kept"],
    [{ kind: "waiting", reason: "busy", stopAt: null }, "Busy"],
    [{ kind: "waiting", reason: "open-work", stopAt: null }, "Waiting on open work"],
    [{ kind: "waiting", reason: "timer", stopAt: null }, "Auto-stop is off"],
    [{ kind: "waiting", reason: "timer", stopAt: NOW + 23 * HOUR }, "Stops in 23 h"],
    [{ kind: "waiting", reason: "notice-period", stopAt: NOW + 30 * 60_000 }, "Stops in 30 min"],
    [{ kind: "waiting", reason: "timer", stopAt: NOW - 1 }, "Stops at the next sweep"],
    [{ kind: "stop", reason: "idle" }, "Stopping now"],
  ])("%j reads %s", (disposition, expected) => {
    expect(nextStep(disposition, NOW)).toBe(expected);
  });
});
