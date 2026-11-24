import fs from "node:fs/promises";
import path from "node:path";
import type { ThreadWorkSummary } from "@omnyo/domain";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createManagedHost } from "./managed-host.js";
import { createManagedService } from "./managed-service.js";
import {
  MANAGED_HOLDING_MS,
  managedHostContract,
  type ManagedAllocation,
  type ManagedPolicyDraft,
} from "./managed-contract.js";

const scratch = "/Users/developer/scratch/omnyo/codex-20261113--managed-cleanup";

const directories: string[] = [];

const hosts: ReturnType<typeof createFakePluginHost>[] = [];

const OWNER = "thr_owner";

const OTHER = "thr_other";

const CONSUMER = "thr_consumer";

const PROJECT = "proj_test";

const HOST = "host_test";

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));

  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true });
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

function settledWork(
  overrides: Partial<ThreadWorkSummary> = {},
): ThreadWorkSummary {
  return {
    revision: "fixture",
    basis: "fixture",
    primary: {
      label: "open",
      reason: { code: "fixture", text: "Current fixture facts." },
    },
    activity: [],
    requiredInput: [],
    optionalInput: [],
    failures: [],
    waits: [],
    nextActors: [],
    assessment: {
      availability: "missing",
      reason: "No model assessment is required.",
      sourceSeq: null,
      suggestion: "unavailable",
      noSuggestionReason: null,
      waitingOn: null,
      ask: null,
      recap: null,
    },
    postponement: null,
    archive: {
      eligible: true,
      recommended: false,
      reason: "The fixture is settled.",
    },
    ...overrides,
  };
}

function exact(item: ManagedAllocation) {
  return {
    id: item.id,
    revision: item.revision,
    snapshotDigest: item.snapshot?.digest ?? null,
  };
}

function adminExact(item: ManagedAllocation) {
  if (item.snapshot === null)
    throw new Error("Fixture needs an inspected allocation.");

  return {
    hostId: item.hostId,
    id: item.id,
    revision: item.revision,
    snapshotDigest: item.snapshot.digest,
  };
}

async function fixture(
  options: Pick<Parameters<typeof createManagedHost>[0], "fault"> = {},
) {
  const directory = await fs.mkdtemp(
    path.join(scratch, "managed-service-fixture-"),
  );

  directories.push(directory);
  const homeDirectory = path.join(directory, "home");
  await fs.mkdir(homeDirectory);
  let clock = 1_000;
  let failTransition: string | null = null;
  let failedOwnerEnd: "before" | "after" | null = null;
  let failedNativeRelease = false;
  let connected = true;
  const unavailable = new Set<string>();
  const factReads: string[] = [];
  let listed: ManagedAllocation[] | null = null;
  let reviewStarted: (() => void) | null = null;
  let resumeReview: (() => void) | null = null;
  let transitionStarted: (() => void) | null = null;

  const subscriptions = new Set<
    Parameters<
      ReturnType<typeof createFakePluginHost>["api"]["sdk"]["subscribe"]
    >[0]
  >();

  const threads = new Map(
    [OWNER, OTHER, CONSUMER].map((id) => [
      id,
      makeThreadResponse({
        id,
        projectId: PROJECT,
        status: "idle",
        work: settledWork(),
      }),
    ]),
  );

  const native = createManagedHost({
    dataDir: path.join(directory, "data"),
    homeDirectory,
    now: () => clock,
    inspectProcesses: async () => ({ kind: "idle" }),
    fault: options.fault,
  });

  const calls: string[] = [];

  const host = createFakePluginHost({
    pluginId: "storage-retention",
    experimental_hostEntry: true,
    experimental_callHostRpc: async (call) => {
      calls.push(call.method);

      switch (call.method) {
        case "managedAllocate":
          return native.managedAllocate(
            managedHostContract.managedAllocate.input.parse(call.input),
            call.signal,
          );
        case "managedInspect":
          return native.managedInspect(
            managedHostContract.managedInspect.input.parse(call.input),
            call.signal,
          );
        case "managedList":
          return listed ?? native.managedList();
        case "managedOwnerDecision": {
          const input = managedHostContract.managedOwnerDecision.input.parse(
            call.input,
          );

          if (
            input.decision.action === "owner-ended" &&
            failedOwnerEnd === "before"
          )
            throw new Error("Fixture owner-end grant outcome is unknown.");
          const result = await native.managedOwnerDecision(input, call.signal);

          if (input.decision.action === "release" && failedNativeRelease)
            throw new Error("Fixture native release outcome is unknown.");

          if (
            input.decision.action === "owner-ended" &&
            failedOwnerEnd === "after"
          )
            throw new Error("Fixture owner-end grant outcome is unknown.");

          return result;
        }

        case "managedReview":
          if (reviewStarted !== null) {
            reviewStarted();
            await new Promise<void>((resolve, reject) => {
              resumeReview = resolve;
              call.signal?.addEventListener(
                "abort",
                () => reject(new Error("Fixture review was cancelled.")),
                { once: true },
              );
            });
          }

          return native.managedReview(
            managedHostContract.managedReview.input.parse(call.input),
            call.signal,
          );
        case "managedTransition": {
          const input = managedHostContract.managedTransition.input.parse(
            call.input,
          );

          if (input.id === failTransition)
            throw new Error("Fixture transport failed.");

          if (transitionStarted !== null) {
            transitionStarted();
            await new Promise<void>((_resolve, reject) =>
              call.signal?.addEventListener(
                "abort",
                () => reject(new Error("Fixture transition was cancelled.")),
                { once: true },
              ),
            );
          }

          return native.managedTransition(input, call.signal);
        }

        case "managedReconcile":
          return native.managedReconcile(
            managedHostContract.managedReconcile.input.parse(call.input),
            call.signal,
          );
        default:
          throw new Error(`Unexpected host method ${call.method}`);
      }
    },
    sdk: {
      subscribe: (subscription) => {
        subscriptions.add(subscription);

        return () => {
          subscriptions.delete(subscription);
        };
      },
      hosts: {
        list: async () => [
          makeHostResponse({
            id: HOST,
            status: connected ? "connected" : "disconnected",
          }),
        ],
      },
      threads: {
        get: async ({ threadId }) => {
          factReads.push(threadId);
          const thread = threads.get(threadId);

          if (unavailable.has(threadId) || thread === undefined)
            throw new Error("Thread not found or temporarily unavailable.");

          return {
            ...thread,
            host: makeHostResponse({ id: HOST, status: "connected" }),
          };
        },
        experimental_work: async ({ threadId }) => {
          const thread = threads.get(threadId);

          if (unavailable.has(threadId) || thread?.work == null)
            throw new Error("Work facts unavailable.");

          return thread.work;
        },
      },
    },
  });

  hosts.push(host);
  let service = createManagedService(host.api, () => clock);

  const context = (
    threadId = OWNER,
    signal = new AbortController().signal,
  ) => ({ threadId, projectId: PROJECT, signal });

  async function allocate(
    disposition:
      | "disposable-when-owner-ends"
      | "keep-until-released" = "keep-until-released",
    threadId = OWNER,
    requestKey = "fixture",
  ) {
    const state = await service.owner(
      {
        request: {
          action: "allocate",
          disposition,
          requestKey,
          storage: {
            role: "verification",
            budgetBytes: 1024 ** 2,
            minimumFreeBytes: 1024 ** 2,
            restoreInputs: [],
          },
          purpose: "Focused managed service fixture",
        },
      },
      context(threadId),
    );

    const item = state.allocations[0];

    if (!item) throw new Error("Fixture allocation missing.");

    return item;
  }

  async function inspect(item: ManagedAllocation, threadId = OWNER) {
    const state = await service.owner(
      { request: { action: "inspect", id: item.id } },
      context(threadId),
    );

    const observed = state.allocations[0];

    if (!observed) throw new Error("Fixture inspect missing.");

    return observed;
  }

  async function release(item: ManagedAllocation) {
    const observed = await inspect(item);

    return (
      await service.owner(
        {
          request: {
            action: "release",
            closeout: { outcome: "success", retainedOutputs: [] },
            ...exact(observed),
            reason: "The fixture is no longer needed.",
          },
        },
        context(),
      )
    ).allocations[0]!;
  }

  async function configure(policy: ManagedPolicyDraft) {
    const preview = await service.request({ action: "policy-preview", policy });

    if (!preview.preview) throw new Error("Fixture preview missing.");

    return service.request({
      action: "configure",
      policy,
      expectedRevision: preview.policy.revision,
      previewDigest: preview.preview.digest,
    });
  }

  return {
    host,
    native,
    threads,
    calls,
    unavailable,
    context,
    allocate,
    inspect,
    release,
    configure,
    get service() {
      return service;
    },
    restart() {
      service = createManagedService(host.api, () => clock);
    },
    setClock(value: number) {
      clock = value;
    },
    fail(id: string | null) {
      failTransition = id;
    },
    failOwnerEnd(stage: "before" | "after" | null) {
      failedOwnerEnd = stage;
    },
    failNativeRelease() {
      failedNativeRelease = true;
    },
    offline() {
      connected = false;
    },
    online() {
      connected = true;
    },
    factReads,
    overrideList(items: ManagedAllocation[]) {
      listed = items;
    },
    pauseReview() {
      return new Promise<void>((resolve) => {
        reviewStarted = resolve;
      });
    },
    resumeReview() {
      resumeReview?.();
    },
    pauseTransition() {
      return new Promise<void>((resolve) => {
        transitionStarted = resolve;
      });
    },
    emitChange(threadId: string) {
      for (const subscription of subscriptions)
        if (subscription.event === "thread:changed")
          subscription.callback({
            type: "changed",
            entity: "thread",
            id: threadId,
            changes: ["work-changed"],
          });
    },
    subscriptions,
  };
}

it("derives native identity and host, separates identical request keys, and rejects client owner grants", async () => {
  const f = await fixture();
  await f.service.lifecycle("thread.archived", f.threads.get(OWNER)!);
  await f.service.lifecycle("thread.unarchived", f.threads.get(OWNER)!);
  await f.service.lifecycle("thread.deleted", f.threads.get(OWNER)!);
  expect(
    await f.host.api.storage.kv.get("managed-cleanup.authoritative-ends.v1"),
  ).toBeUndefined();
  expect((await f.service.state()).allocations).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(f.host.harness.sdk.callsTo("hosts.list")).toEqual([]);
  const first = await f.allocate();
  const retry = await f.allocate();
  const other = await f.allocate("keep-until-released", OTHER);
  expect(retry.id).toBe(first.id);
  expect(other.id).not.toBe(first.id);
  expect([first.ownerThreadId, other.ownerThreadId]).toEqual([OWNER, OTHER]);
  expect(first.hostId).toBe(HOST);
  const inspected = await f.inspect(first);
  await expect(
    f.service.owner(
      {
        request: {
          action: "consumer-register",
          ...exact(inspected),
          consumerThreadId: "thr_missing",
        },
      },
      f.context(),
    ),
  ).rejects.toThrow("not found");
  expect(
    (await f.native.managedList()).find((item) => item.id === first.id)
      ?.consumers,
  ).toEqual([]);
  await expect(
    f.service.owner(
      {
        request: {
          action: "release",
          closeout: { outcome: "success", retainedOutputs: [] },
          ...exact(first),
          reason: "wrong owner",
        },
      },
      f.context(OTHER),
    ),
  ).rejects.toThrow("does not own or consume");
  await expect(
    f.service.owner(
      {
        request: {
          action: "allocate",
          disposition: "keep-until-released",
          requestKey: "spoof",
          storage: {
            role: "verification",
            budgetBytes: 1024 ** 2,
            minimumFreeBytes: 1024 ** 2,
            restoreInputs: [],
          },
          purpose: "fixture",
          hostId: "host_other",
        },
      },
      f.context(),
    ),
  ).rejects.toThrow();
  await expect(
    f.service.request({ action: "allocate", ownerThreadId: OWNER }),
  ).rejects.toThrow();
  await expect(
    f.service.request({
      action: "release",
      closeout: { outcome: "success", retainedOutputs: [] },
      ...adminExact(await f.inspect(first)),
      ownerThreadId: OWNER,
    }),
  ).rejects.toThrow();
  await expect(
    f.service.request({
      action: "review",
      ...adminExact(await f.inspect(first)),
    }),
  ).rejects.toThrow();
  expect(f.calls.filter((call) => call === "managedTransition")).toHaveLength(
    0,
  );
});

it("holds queued, running, waiting, pending input, recovery and unknown work without relying on optional model assessments", async () => {
  const f = await fixture();
  let item = await f.release(await f.allocate());
  const original = f.threads.get(OWNER)!;

  const cases = [
    { ...original, status: "active" as const },
    { ...original, queuedMessageCount: 1 },
    { ...original, activeBackgroundAgentCount: 1 },
    { ...original, pinnedAt: 1 },
    { ...original, shelvedAt: 1 },
    {
      ...original,
      work: settledWork({
        waits: [
          {
            id: "wait",
            reason: "A producer is pending.",
            actor: { kind: "external", id: null, label: "Producer" },
          },
        ],
      }),
    },
    {
      ...original,
      work: settledWork({
        requiredInput: [
          { id: "input", kind: "question", label: "Pending decision" },
        ],
      }),
    },
    {
      ...original,
      work: settledWork({
        optionalInput: [
          {
            id: "optional",
            kind: "question",
            label: "Pending optional decision",
          },
        ],
      }),
    },
    {
      ...original,
      work: settledWork({
        activity: [
          {
            id: "producer",
            kind: "plugin",
            label: "Active producer",
            phase: "running",
            actor: { kind: "external", id: null, label: "Producer" },
          },
        ],
      }),
    },
    {
      ...original,
      work: settledWork({
        failures: [
          { code: "failed", text: "Recovery is needed.", sourceId: null },
        ],
      }),
    },
    { ...original, work: null },
  ];

  for (const thread of cases) {
    f.threads.set(OWNER, thread);

    const result = await f.service.request({
      action: "review",
      ...adminExact(item),
    });

    expect(result.allocations[0]?.hold).not.toBeNull();
    expect(result.allocations[0]?.phase).toBe("proposed");
  }

  f.threads.set(OWNER, original);
  item = (await f.service.request({ action: "review", ...adminExact(item) }))
    .allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(item.hold).toBeNull();
});

it("persists authoritative deleted owner settlement but treats an ordinary 404 as unknown", async () => {
  const f = await fixture();
  const item = await f.allocate("disposable-when-owner-ends");
  f.unavailable.add(OWNER);
  expect((await f.service.reconcile()).allocations[0]?.grant).toBeNull();
  const ended = { ...f.threads.get(OWNER)!, deletedAt: 1000 };
  const result = await f.service.lifecycle("thread.deleted", ended);
  expect(result.allocations[0]?.grant?.kind).toBe("owner-ended");
  f.restart();
  const restored = (await f.service.reconcile()).allocations[0]!;
  expect(restored.id).toBe(item.id);
  expect(restored.grant?.kind).toBe("owner-ended");
  expect(restored.phase).toBe("proposed");
});

it("revokes quarantined advance grants on unarchive and allows a new native release in the same clock tick", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: true,
    quarantineBudgetBytes: 100000,
  });
  const initial = await f.allocate("disposable-when-owner-ends");
  await fs.writeFile(path.join(initial.path, "proof.txt"), "restore me");
  const archived = { ...f.threads.get(OWNER)!, archivedAt: 1000 };
  f.threads.set(OWNER, archived);

  let item = (await f.service.lifecycle("thread.archived", archived))
    .allocations[0]!;

  expect(item.phase).toBe("quarantined");
  const unarchived = { ...archived, archivedAt: null };
  f.threads.set(OWNER, unarchived);
  item = (await f.service.lifecycle("thread.unarchived", unarchived))
    .allocations[0]!;
  expect(item.grant).toBeNull();
  f.setClock(1000 + MANAGED_HOLDING_MS * 2);
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(await fs.readFile(path.join(item.path, "proof.txt"), "utf8")).toBe(
    "restore me",
  );
  item = (await f.service.request({ action: "restore", ...adminExact(item) }))
    .allocations[0]!;
  expect(item.phase).toBe("kept");
  expect(await fs.readFile(path.join(item.path, "proof.txt"), "utf8")).toBe(
    "restore me",
  );
  f.setClock(1000);
  item = await f.release(item);
  expect((await f.service.reconcile()).allocations[0]?.grant).not.toBeNull();
});

it("resets expiry enable time on every off-to-on transition and requires an unchanged policy preview", async () => {
  const f = await fixture();

  const draft = {
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  } satisfies ManagedPolicyDraft;

  await f.configure(draft);
  await f.release(await f.allocate());
  let item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  f.setClock(1000 + MANAGED_HOLDING_MS * 3);
  const enabled = await f.configure({ ...draft, automaticExpiry: true });
  expect(enabled.policy.expiryEnabledAt).toBe(1000 + MANAGED_HOLDING_MS * 3);
  expect((await f.service.reconcile()).allocations[0]?.phase).toBe(
    "quarantined",
  );
  f.setClock(1000 + MANAGED_HOLDING_MS * 4 - 1);
  await f.configure(draft);
  const again = await f.configure({ ...draft, automaticExpiry: true });
  expect(again.policy.expiryEnabledAt).toBe(1000 + MANAGED_HOLDING_MS * 4 - 1);
  expect((await f.service.reconcile()).allocations[0]?.phase).toBe(
    "quarantined",
  );

  const preview = await f.service.request({
    action: "policy-preview",
    policy: draft,
  });

  await f.allocate("keep-until-released", OTHER);
  await expect(
    f.service.request({
      action: "configure",
      policy: draft,
      expectedRevision: preview.policy.revision,
      previewDigest: preview.preview!.digest,
    }),
  ).rejects.toThrow("changed");
  item = (await f.service.state()).allocations.find(
    (entry) => entry.id === item.id,
  )!;
  expect(item.phase).toBe("quarantined");
});

it("preserves consumer holds, rechecks settled consumers for each transition and cannot erase another consumer's hold", async () => {
  const f = await fixture();
  let item = await f.inspect(await f.allocate());
  item = (
    await f.service.owner(
      {
        request: {
          action: "consumer-register",
          ...exact(item),
          consumerThreadId: CONSUMER,
        },
      },
      f.context(),
    )
  ).allocations[0]!;
  item = await f.release(item);
  const original = f.threads.get(CONSUMER)!;
  f.threads.set(CONSUMER, { ...original, queuedMessageCount: 1 });
  expect(
    (await f.service.request({ action: "review", ...adminExact(item) }))
      .allocations[0]?.hold,
  ).not.toBeNull();
  await expect(
    f.service.owner(
      { request: { action: "consumer-release", ...exact(item) } },
      f.context(),
    ),
  ).rejects.toThrow("declared consumer");
  f.threads.set(CONSUMER, original);
  expect(
    (await f.service.request({ action: "review", ...adminExact(item) }))
      .allocations[0]?.hold?.message,
  ).toContain("declared use remains open");
  f.threads.set(CONSUMER, { ...original, archivedAt: 1000 });
  item = (await f.service.request({ action: "review", ...adminExact(item) }))
    .allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(item.consumers[0]?.releasedAt).toBeNull();
  f.setClock(1000 + MANAGED_HOLDING_MS);
  f.threads.set(CONSUMER, { ...original, queuedMessageCount: 1 });
  expect(
    (await f.service.request({ action: "purge", ...adminExact(item) }))
      .allocations[0]?.phase,
  ).toBe("quarantined");
  item = (
    await f.service.owner(
      { request: { action: "consumer-release", ...exact(item) } },
      f.context(CONSUMER),
    )
  ).allocations[0]!;
  expect(item.consumers[0]?.releasedAt).not.toBeNull();
  expect(
    (await f.service.request({ action: "purge", ...adminExact(item) }))
      .allocations[0]?.phase,
  ).toBe("removed");
});

it("permits exact explicit purge with automatic expiry off, reports partial batch failures and serializes duplicate reconciliation", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  await f.release(await f.allocate("keep-until-released", OWNER, "one"));
  await f.release(await f.allocate("keep-until-released", OWNER, "two"));
  await Promise.all([f.service.reconcile(), f.service.reconcile()]);
  expect(f.calls.filter((call) => call === "managedTransition")).toHaveLength(
    2,
  );
  const quarantined = (await f.service.state()).allocations;

  const early = await f.service.request({
    action: "purge",
    ...adminExact(quarantined[0]!),
  });

  expect(early.allocations[0]?.phase).toBe("quarantined");
  expect(early.allocations[0]?.hold).not.toBeNull();
  f.setClock(1000 + MANAGED_HOLDING_MS);
  const items = quarantined.map(adminExact);
  const preview = await f.service.request({ action: "purge-preview", items });
  f.fail(items[1]!.id);

  const result = await f.service.request({
    action: "purge-batch",
    items,
    previewDigest: preview.preview!.digest,
  });

  expect(result.allocations.map((item) => item.phase).sort()).toEqual([
    "quarantined",
    "removed",
  ]);
  expect(result.failures).toHaveLength(1);
  expect(result.policy.automaticExpiry).toBe(false);
});

it("rejects stale snapshots and cancellation before mutation, and exposes offline holds", async () => {
  const f = await fixture();
  const item = await f.release(await f.allocate());
  await fs.writeFile(path.join(item.path, "late.txt"), "preserve");
  await expect(
    f.service.request({ action: "review", ...adminExact(item) }),
  ).rejects.toThrow("changed");
  expect(await fs.readFile(path.join(item.path, "late.txt"), "utf8")).toBe(
    "preserve",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.service.owner(
      {
        request: {
          action: "allocate",
          disposition: "keep-until-released",
          requestKey: "cancelled",
          storage: {
            role: "verification",
            budgetBytes: 1024 ** 2,
            minimumFreeBytes: 1024 ** 2,
            restoreInputs: [],
          },
          purpose: "fixture",
        },
      },
      f.context(OWNER, controller.signal),
    ),
  ).rejects.toThrow();
  f.offline();
  const state = await f.service.state();
  expect(state.failures[0]?.message).toContain("offline");
  expect(state.allocations).toEqual([]);
});

it("skips terminal tickets and rotates fairly past a full batch of held owners", async () => {
  const f = await fixture();
  const template = await f.allocate();
  const items: ManagedAllocation[] = [];

  for (let index = 0; index < 212; index++) {
    const ownerThreadId = `thr_fixture_${index}`;
    f.threads.set(
      ownerThreadId,
      makeThreadResponse({
        id: ownerThreadId,
        projectId: PROJECT,
        work: settledWork(),
        queuedMessageCount: index === 211 ? 0 : 1,
      }),
    );
    items.push({
      ...template,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ownerThreadId,
      phase: index < 110 ? "removed" : "kept",
    });
  }

  f.overrideList(items);
  const first = await f.service.reconcile();
  expect(first.allocations.filter((item) => item.hold !== null)).toHaveLength(
    100,
  );
  expect(f.factReads).not.toContain("thr_fixture_211");
  await f.service.reconcile();
  expect(f.factReads).toContain("thr_fixture_211");
  expect(f.factReads).not.toContain("thr_fixture_0");
});

it("revokes an unarchived owner's quarantined grant beyond a full unrelated held batch", async () => {
  const f = await fixture();
  let item = await f.release(await f.allocate());
  item = (await f.service.request({ action: "review", ...adminExact(item) }))
    .allocations[0]!;

  const heldItems = Array.from(
    { length: 105 },
    (_, index): ManagedAllocation => ({
      ...item,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      phase: "kept",
      grant: null,
      ownerThreadId: OTHER,
    }),
  );

  f.threads.set(OTHER, { ...f.threads.get(OTHER)!, queuedMessageCount: 1 });
  f.overrideList([...heldItems, item]);
  const original = f.threads.get(OWNER)!;
  await f.service.lifecycle("thread.unarchived", original);
  expect(
    (await f.native.managedList()).find((entry) => entry.id === item.id)?.grant,
  ).toBeNull();
});

it("cancels an administrative request in flight before the next physical effect", async () => {
  const f = await fixture();
  const item = await f.release(await f.allocate());
  const started = f.pauseReview();
  const controller = new AbortController();

  const request = f.service.request(
    { action: "review", ...adminExact(item) },
    controller.signal,
  );

  const rejected = expect(request).rejects.toThrow("cancelled");
  await started;
  controller.abort();
  await rejected;
  expect(f.calls.filter((call) => call === "managedTransition")).toHaveLength(
    0,
  );
  expect((await f.native.managedList())[0]?.phase).toBe("proposed");
});

it("keeps ended owners with recovery failures or missing work, while settled authoritative deletion need not retain a runtime error status", async () => {
  const f = await fixture();
  await f.allocate("disposable-when-owner-ends");
  const original = f.threads.get(OWNER)!;
  f.unavailable.add(OWNER);
  expect(
    (
      await f.service.lifecycle("thread.deleted", {
        ...original,
        status: "error",
        deletedAt: 1000,
        work: settledWork({
          failures: [
            {
              code: "recovery",
              text: "Unique recovery inputs remain.",
              sourceId: null,
            },
          ],
        }),
      })
    ).allocations[0]?.grant,
  ).toBeNull();
  expect(
    (
      await f.service.lifecycle("thread.deleted", {
        ...original,
        status: "error",
        deletedAt: 1000,
        work: null,
      })
    ).allocations[0]?.grant,
  ).toBeNull();
  expect(
    (
      await f.service.lifecycle("thread.deleted", {
        ...original,
        status: "error",
        deletedAt: 1000,
      })
    ).allocations[0]?.grant?.kind,
  ).toBe("owner-ended");
});

it("retains coordinator holds and background failures across state reads and restart, then clears them after success", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  const item = await f.release(await f.allocate());
  const owner = f.threads.get(OWNER)!;
  f.threads.set(OWNER, { ...owner, queuedMessageCount: 1 });
  await f.service.reconcile();
  f.restart();
  expect((await f.service.state()).allocations[0]?.hold?.message).toContain(
    "queued",
  );
  f.threads.set(OWNER, owner);
  await f.release(item);
  f.fail(item.id);
  await f.service.reconcile();
  f.restart();
  const failed = await f.service.state();
  expect(failed.failures[0]?.message).toContain("transport failed");
  expect(failed.allocations[0]?.hold?.message).toContain("failed");
  await f.release(failed.allocations[0]!);
  f.fail(null);
  await f.service.reconcile();
  const completed = await f.service.state();
  expect(completed.failures).toEqual([]);
  expect(completed.allocations[0]?.hold).toBeNull();
  expect(completed.allocations[0]?.phase).toBe("quarantined");
});

it("synchronously cancels an in-flight transition when the owner unarchives before the queued lifecycle handler runs", async () => {
  const f = await fixture();
  const item = await f.release(await f.allocate());
  const started = f.pauseTransition();
  const request = f.service.request({ action: "review", ...adminExact(item) });
  const rejected = expect(request).rejects.toThrow("cancelled");
  await started;

  const lifecycle = f.service.lifecycle(
    "thread.unarchived",
    f.threads.get(OWNER)!,
  );

  await rejected;
  await lifecycle;
  expect((await f.native.managedList())[0]?.grant).toBeNull();
  expect((await f.native.managedList())[0]?.phase).toBe("kept");
  expect(f.calls.filter((call) => call === "managedTransition")).toHaveLength(
    1,
  );
  expect(f.subscriptions.size).toBe(0);
});

it("cancels only matching participant transitions on live work events and removes its short-lived subscription", async () => {
  const f = await fixture();
  let item = await f.inspect(await f.allocate());
  item = (
    await f.service.owner(
      {
        request: {
          action: "consumer-register",
          ...exact(item),
          consumerThreadId: CONSUMER,
        },
      },
      f.context(),
    )
  ).allocations[0]!;
  item = await f.release(item);
  f.threads.set(CONSUMER, { ...f.threads.get(CONSUMER)!, archivedAt: 1000 });
  const started = f.pauseTransition();
  const request = f.service.request({ action: "review", ...adminExact(item) });
  const rejected = expect(request).rejects.toThrow("cancelled");
  await started;
  f.emitChange(OTHER);
  expect(f.subscriptions.size).toBe(1);
  f.emitChange(CONSUMER);
  await rejected;
  expect((await f.native.managedList())[0]?.phase).toBe("approved");
  expect(f.subscriptions.size).toBe(0);
});

it("holds physical effects when unarchive arrives before the transition subscription is constructed", async () => {
  const f = await fixture();
  const item = await f.release(await f.allocate());
  const started = f.pauseReview();
  const request = f.service.request({ action: "review", ...adminExact(item) });
  await started;

  const lifecycle = f.service.lifecycle(
    "thread.unarchived",
    f.threads.get(OWNER)!,
  );

  f.resumeReview();
  expect((await request).allocations[0]?.hold?.message).toContain("resumed");
  await lifecycle;
  expect(f.calls.filter((call) => call === "managedTransition")).toHaveLength(
    0,
  );
  expect((await f.native.managedList())[0]?.grant).toBeNull();
});

it("consumes an archived owner's advance disposition once and preserves restore until a fresh native decision or owner end", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  await f.allocate("disposable-when-owner-ends");
  const archived = { ...f.threads.get(OWNER)!, archivedAt: 1000 };
  f.threads.set(OWNER, archived);

  let item = (await f.service.lifecycle("thread.archived", archived))
    .allocations[0]!;

  expect(item.phase).toBe("quarantined");
  item = (await f.service.request({ action: "restore", ...adminExact(item) }))
    .allocations[0]!;
  f.restart();
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("kept");
  expect(item.grant).toBeNull();
  item = await f.release(item);
  expect(item.grant?.kind).toBe("native-release");
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  item = (await f.service.request({ action: "restore", ...adminExact(item) }))
    .allocations[0]!;
  const unarchived = { ...archived, archivedAt: null };
  f.threads.set(OWNER, unarchived);
  await f.service.lifecycle("thread.unarchived", unarchived);
  const nextEnd = { ...archived, archivedAt: 1000 };
  f.threads.set(OWNER, nextEnd);
  item = (await f.service.lifecycle("thread.archived", nextEnd))
    .allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(item.grant).toEqual({ kind: "owner-ended", at: 1000 });
});

it("keeps a changed quarantine revoked for the consumed owner end and accepts only a new native release", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: true,
    quarantineBudgetBytes: 100000,
  });
  const allocated = await f.allocate("disposable-when-owner-ends");
  await fs.writeFile(path.join(allocated.path, "proof.txt"), "original");
  const archived = { ...f.threads.get(OWNER)!, archivedAt: 1000 };
  f.threads.set(OWNER, archived);

  let item = (await f.service.lifecycle("thread.archived", archived))
    .allocations[0]!;

  await fs.writeFile(path.join(item.path, "proof.txt"), "changed unique bytes");
  item = await f.inspect(item);
  expect(item.grant).toBeNull();
  f.setClock(1000 + MANAGED_HOLDING_MS * 2);
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(item.grant).toBeNull();
  expect(await fs.readFile(path.join(item.path, "proof.txt"), "utf8")).toBe(
    "changed unique bytes",
  );
  item = await f.release(item);
  expect(item.grant?.kind).toBe("native-release");
});

it("uses the same deletion token for current metadata and the later authoritative 404 proof", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  await f.allocate("disposable-when-owner-ends");
  const deleted = { ...f.threads.get(OWNER)!, deletedAt: 1000 };
  f.threads.set(OWNER, deleted);
  let item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  item = (await f.service.request({ action: "restore", ...adminExact(item) }))
    .allocations[0]!;
  f.setClock(2000);
  f.unavailable.add(OWNER);
  item = (await f.service.lifecycle("thread.deleted", deleted)).allocations[0]!;
  f.restart();
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("kept");
  expect(item.grant).toBeNull();
  item = (
    await f.service.lifecycle("thread.deleted", { ...deleted, deletedAt: 500 })
  ).allocations[0]!;
  expect(item.phase).toBe("kept");
  expect(item.grant).toBeNull();
});

it("carries offline unarchive revocation across rearchive before renewing the genuinely new end", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  await f.allocate("disposable-when-owner-ends");
  const archived = { ...f.threads.get(OWNER)!, archivedAt: 1000 };
  f.threads.set(OWNER, archived);

  const first = (await f.service.lifecycle("thread.archived", archived))
    .allocations[0]!;

  const decisions = f.calls.filter(
    (method) => method === "managedOwnerDecision",
  ).length;

  f.offline();
  const unarchived = { ...archived, archivedAt: null };
  f.threads.set(OWNER, unarchived);
  await f.service.lifecycle("thread.unarchived", unarchived);
  f.setClock(2000);
  const rearchived = { ...archived, archivedAt: 2000 };
  f.threads.set(OWNER, rearchived);
  await f.service.lifecycle("thread.archived", rearchived);
  f.online();
  f.restart();
  const current = (await f.service.reconcile()).allocations[0]!;
  expect(current.phase).toBe("quarantined");
  expect(current.grant).toEqual({ kind: "owner-ended", at: 2000 });
  expect(current.revision).toBeGreaterThan(first.revision);
  expect(
    f.calls.filter((method) => method === "managedOwnerDecision").length -
      decisions,
  ).toBe(2);
});

it("does not manufacture an automatic generation from legacy deleted proof or restored legacy allocation state", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  const allocation = await f.allocate("disposable-when-owner-ends");
  await f.host.api.storage.kv.set("managed-cleanup.authoritative-ends.v1", {
    [OWNER]: { kind: "deleted", at: 1000, settled: true, sequence: 1 },
  });
  f.unavailable.add(OWNER);
  let item = (await f.service.reconcile()).allocations[0]!;
  expect(item.grant).toBeNull();
  expect(item.hold?.message).toContain("generation timestamp");
  f.unavailable.delete(OWNER);
  const deleted = { ...f.threads.get(OWNER)!, deletedAt: 1000 };
  f.threads.set(OWNER, deleted);
  item = (await f.service.lifecycle("thread.deleted", deleted)).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  item = (await f.service.request({ action: "restore", ...adminExact(item) }))
    .allocations[0]!;
  await f.host.api.storage.kv.set(
    "managed-cleanup.consumed-owner-end.v1:" + allocation.id,
    null,
  );
  f.restart();
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("kept");
  expect(item.grant).toBeNull();
  expect(item.hold?.message).toContain("prior cleanup authority");
});

it("consumes uncertain owner-end attempts before the host call and never silently replays a lost grant", async () => {
  for (const stage of ["before", "after"] as const) {
    const f = await fixture();
    await f.configure({
      mode: "owner-approved",
      automaticExpiry: false,
      quarantineBudgetBytes: 100000,
    });
    await f.allocate("disposable-when-owner-ends");
    const original = f.threads.get(OWNER)!;
    await f.service.lifecycle("thread.unarchived", original);
    f.failOwnerEnd(stage);
    const archived = { ...original, archivedAt: 1000 };
    f.threads.set(OWNER, archived);
    const first = await f.service.lifecycle("thread.archived", archived);
    expect(
      first.failures.some((failure) =>
        failure.message.includes("outcome is unknown"),
      ),
    ).toBe(true);
    f.failOwnerEnd(null);
    f.restart();
    const item = (await f.service.reconcile()).allocations[0]!;
    expect(item.grant).toBeNull();
    expect(item.phase === "allocated" || item.phase === "kept").toBe(true);
    expect(item.hold?.message).toContain("already consumed");
    expect(
      f.calls.filter((method) => method === "managedTransition"),
    ).toHaveLength(0);
  }
});

it("admits a recorded consumer deletion only with authoritative settled proof and preserves an ordinary missing consumer hold", async () => {
  const f = await fixture();
  let item = await f.inspect(await f.allocate());
  item = (
    await f.service.owner(
      {
        request: {
          action: "consumer-register",
          ...exact(item),
          consumerThreadId: CONSUMER,
        },
      },
      f.context(),
    )
  ).allocations[0]!;
  item = await f.release(item);
  const consumer = f.threads.get(CONSUMER)!;
  f.unavailable.add(CONSUMER);
  expect(
    (await f.service.request({ action: "review", ...adminExact(item) }))
      .allocations[0]?.hold?.message,
  ).toContain("unknown");
  await f.service.lifecycle("thread.deleted", { ...consumer, deletedAt: 1000 });
  item = (await f.service.request({ action: "review", ...adminExact(item) }))
    .allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(item.consumers[0]?.releasedAt).toBeNull();
});

it("recovers a missed unarchive from a metadata-only owner end and keeps the quarantined allocation restorable", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  const allocated = await f.allocate("disposable-when-owner-ends");
  await fs.writeFile(
    path.join(allocated.path, "proof.txt"),
    "preserve after reopen",
  );
  const open = f.threads.get(OWNER)!;
  f.threads.set(OWNER, { ...open, archivedAt: 1000 });
  let item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  f.threads.set(OWNER, open);
  f.restart();
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(item.grant).toBeNull();
  expect(await fs.readFile(path.join(item.path, "proof.txt"), "utf8")).toBe(
    "preserve after reopen",
  );
  item = await f.release(item);
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.grant?.kind).toBe("native-release");
  expect(item.phase).toBe("quarantined");
});

it("revokes native grants when current metadata proves a known ended owner reopened without a lifecycle event", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  await f.release(await f.allocate());
  const open = f.threads.get(OWNER)!;
  const archived = { ...open, archivedAt: 1000 };
  f.threads.set(OWNER, archived);

  let item = (await f.service.lifecycle("thread.archived", archived))
    .allocations[0]!;

  expect(item.grant?.kind).toBe("native-release");
  f.threads.set(OWNER, open);
  f.restart();
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(item.grant).toBeNull();
});

it("records an inferred unarchive before acknowledging a fresh native decision and preserves ordinary live native grants", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  await f.allocate("disposable-when-owner-ends");
  const open = f.threads.get(OWNER)!;
  const archived = { ...open, archivedAt: 1000 };
  f.threads.set(OWNER, archived);

  let item = (await f.service.lifecycle("thread.archived", archived))
    .allocations[0]!;

  f.threads.set(OWNER, open);
  f.restart();
  item = await f.release(item);
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.grant?.kind).toBe("native-release");

  const ends = await f.host.api.storage.kv.get(
    "managed-cleanup.authoritative-ends.v1",
  );

  expect(ends).toMatchObject({ [OWNER]: { kind: "unarchived" } });
  const live = await fixture();
  await live.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  const ordinary = await live.release(await live.allocate());
  const current = await live.service.reconcile();
  expect(
    current.allocations.find((entry) => entry.id === ordinary.id)?.grant?.kind,
  ).toBe("native-release");
  expect(
    await live.host.api.storage.kv.get("managed-cleanup.authoritative-ends.v1"),
  ).toBeUndefined();
});

it("revokes legacy grants without an epoch acknowledgment even when the current epoch is zero", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  await f.release(await f.allocate());
  expect((await f.service.reconcile()).allocations[0]?.phase).toBe(
    "quarantined",
  );
  await f.host.api.storage.kv.set("managed-cleanup.unarchive-acks.v1", {});
  f.restart();
  const item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(item.grant).toBeNull();
});

it("holds reloaded live grants when an entirely missed owner cycle cannot be proven from current metadata", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  await f.release(await f.allocate());
  let item = (await f.service.reconcile()).allocations[0]!;
  expect(item.grant?.kind).toBe("native-release");
  const open = f.threads.get(OWNER)!;
  f.threads.set(OWNER, { ...open, archivedAt: 1000 });
  f.threads.set(OWNER, open);
  f.restart();
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(item.grant).toBeNull();
  expect(item.hold?.message).toContain("history is unavailable");
  item = await f.release(item);
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.grant?.kind).toBe("native-release");
});

it("preserves reloaded grants bound to the exact current consumed owner-end token", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  await f.allocate("disposable-when-owner-ends");
  f.threads.set(OWNER, { ...f.threads.get(OWNER)!, archivedAt: 1000 });
  let item = (await f.service.reconcile()).allocations[0]!;
  expect(item.grant?.kind).toBe("owner-ended");
  f.restart();
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.phase).toBe("quarantined");
  expect(item.grant?.kind).toBe("owner-ended");
  item = await f.release(item);
  f.restart();
  item = (await f.service.reconcile()).allocations[0]!;
  expect(item.grant?.kind).toBe("native-release");
});

it("does not reuse a same-timestamp fresh acceptance when a later native release loses its response", async () => {
  const f = await fixture();
  await f.configure({
    mode: "owner-approved",
    automaticExpiry: false,
    quarantineBudgetBytes: 100000,
  });
  await f.release(await f.allocate());
  const item = (await f.service.reconcile()).allocations[0]!;
  f.failNativeRelease();
  await expect(f.release(item)).rejects.toThrow("outcome is unknown");
  const current = (await f.service.reconcile()).allocations[0]!;
  expect(current.grant).toBeNull();
  expect(current.hold?.message).toContain("history is unavailable");
});

it("resolves an interrupted rename before checking active owner admission and permits explicit restore with bytes preserved", async () => {
  let interrupt = true;

  const f = await fixture({
    fault: (stage) => {
      if (interrupt && stage === "after-rename") {
        interrupt = false;
        throw new Error("Fixture interruption after quarantine rename.");
      }
    },
  });

  const allocation = await f.allocate();
  await fs.writeFile(
    path.join(allocation.path, "proof.txt"),
    "recoverable bytes",
  );
  const released = await f.release(allocation);

  const interrupted = (
    await f.service.request({ action: "review", ...adminExact(released) })
  ).allocations[0]!;

  expect(interrupted.phase).toBe("quarantine-intent");
  await expect(fs.stat(allocation.path)).rejects.toMatchObject({
    code: "ENOENT",
  });
  const active = { ...f.threads.get(OWNER)!, status: "active" as const };
  f.threads.set(OWNER, active);

  const recovered = (await f.service.lifecycle("thread.unarchived", active))
    .allocations[0]!;

  expect(recovered.phase).toBe("quarantined");
  expect(recovered.path).not.toBe(allocation.path);
  expect(recovered.hold?.message).toContain("not idle");
  expect(
    await fs.readFile(path.join(recovered.path, "proof.txt"), "utf8"),
  ).toBe("recoverable bytes");
  expect(
    f.calls.filter((method) => method === "managedTransition"),
  ).toHaveLength(1);

  const restored = (
    await f.service.request({ action: "restore", ...adminExact(recovered) })
  ).allocations[0]!;

  expect(restored.phase).toBe("kept");
  expect(restored.path).toBe(allocation.path);
  expect(restored.grant).toBeNull();
  expect(await fs.readFile(path.join(restored.path, "proof.txt"), "utf8")).toBe(
    "recoverable bytes",
  );
  await expect(fs.stat(recovered.path)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
