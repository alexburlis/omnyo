import { createHash } from "node:crypto";
import type { PluginAgentToolContext, PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  defaultManagedPolicy,
  MANAGED_HOLDING_MS,
  managedAdminRequestSchema,
  managedHostContract,
  managedOwnerRequestSchema,
  managedPolicySchema,
  managedHoldSchema,
  type ManagedAllocation,
  type ManagedPolicy,
  type ManagedPolicyDraft,
  type ManagedState,
} from "./managed-contract.js";

const POLICY_KEY = "managed-cleanup.policy.v1";

const ENDS_KEY = "managed-cleanup.authoritative-ends.v1";

const HOSTS_KEY = "managed-cleanup.hosts.v1";

const UNARCHIVE_ACKS_KEY = "managed-cleanup.unarchive-acks.v1";

const CURSOR_KEY = "managed-cleanup.reconcile-cursor.v1";

const OBSERVATIONS_KEY = "managed-cleanup.observations.v1";

const PARTICIPANTS_KEY = "managed-cleanup.participants.v1";

const CONSUMED_END_KEY = "managed-cleanup.consumed-owner-end.v1:";

const LIMIT = 100;

const endsSchema = z.record(
  z.string(),
  z
    .object({
      kind: z.enum(["archived", "deleted", "unarchived"]),
      at: z.number(),
      settled: z.boolean(),
      sequence: z.number().int().nonnegative(),
      endAt: z.number().nonnegative().nullable().optional(),
      lastUnarchiveSequence: z.number().int().nonnegative().optional(),
    })
    .strict(),
);

const endTokenSchema = z
  .object({
    kind: z.enum(["archived", "deleted"]),
    at: z.number().nonnegative(),
    unarchiveSequence: z.number().int().nonnegative(),
  })
  .strict();

type EndProof = z.infer<typeof endsSchema>[string];

type EndToken = z.infer<typeof endTokenSchema>;

const observationsSchema = z
  .object({
    holds: z
      .array(
        z
          .object({
            hostId: z.string(),
            id: z.string(),
            revision: z.number(),
            snapshotDigest: z.string().nullable(),
            hold: managedHoldSchema,
          })
          .strict(),
      )
      .max(1000),
    failures: z
      .array(z.object({ hostId: z.string(), message: z.string() }).strict())
      .max(100),
  })
  .strict();

type Thread = Awaited<ReturnType<PluginApi["sdk"]["threads"]["get"]>>;

type Work = Awaited<
  ReturnType<PluginApi["sdk"]["threads"]["experimental_work"]>
>;

type Exact = Pick<ManagedAllocation, "id" | "revision"> & {
  snapshotDigest: string | null;
};

function exact(item: ManagedAllocation): Exact {
  return {
    id: item.id,
    revision: item.revision,
    snapshotDigest: item.snapshot?.digest ?? null,
  };
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unarchiveSequence(proof: EndProof | undefined) {
  return proof?.lastUnarchiveSequence ?? proof?.sequence ?? 0;
}

function newerEnd(next: EndToken, previous: EndToken) {
  if (next.unarchiveSequence !== previous.unarchiveSequence)
    return next.unarchiveSequence > previous.unarchiveSequence;

  if (next.at !== previous.at) return next.at > previous.at;

  return next.kind === "deleted" && previous.kind === "archived";
}

function currentEnd(
  thread: Thread,
  proof: EndProof | undefined,
): EndToken | null {
  if (thread.deletedAt !== null)
    return {
      kind: "deleted",
      at: thread.deletedAt,
      unarchiveSequence: unarchiveSequence(proof),
    };

  if (thread.archivedAt !== null)
    return {
      kind: "archived",
      at: thread.archivedAt,
      unarchiveSequence: unarchiveSequence(proof),
    };

  return null;
}

function workHold(thread: Thread, work: Work | null) {
  if (thread.pinnedAt !== null) return "The chat is pinned.";

  if (thread.shelvedAt !== null) return "The chat is on the owner's Shelf.";

  if (
    thread.status !== "idle" &&
    thread.archivedAt === null &&
    thread.deletedAt === null
  )
    return "The chat is not idle or authoritatively ended.";

  if (thread.queuedMessageCount !== 0) return "The chat has queued messages.";

  if (thread.activeBackgroundAgentCount !== 0)
    return "The chat has background agents.";

  if (work === null) return "The chat's current work is unknown.";

  if (work.activity.length > 0) return "The chat has active work or producers.";

  if (work.requiredInput.length > 0 || work.optionalInput.length > 0)
    return "The chat has pending input.";

  if (work.waits.length > 0 || work.postponement !== null)
    return "The chat has a wait or dependency.";

  if (work.failures.length > 0) return "The chat's work needs recovery.";

  return null;
}

function held(item: ManagedAllocation, message: string): ManagedAllocation {
  return {
    ...item,
    hold: { code: "coordinator-hold", message, at: Date.now() },
  };
}

export function createManagedService(
  api: PluginApi,
  now: () => number = Date.now,
) {
  const worker = api.hosts.experimental_client({
    contract: managedHostContract,
  });

  const disposal = new AbortController();
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let pendingState: Promise<ManagedState> | null = null;
  const pendingUnarchives = new Map<string, number>();
  const pendingOwnerDecisions = new Map<string, number>();

  const freshNativeGrants = new Map<
    string,
    { ownerThreadId: string; kind: "native-release"; at: number }
  >();

  const transitions = new Set<{
    id: string;
    ownerThreadId: string;
    threadIds: Set<string>;
    controller: AbortController;
  }>();

  api.onDispose(() => {
    disposed = true;
    disposal.abort();
  });

  function operationSignal(signal?: AbortSignal) {
    return signal === undefined
      ? disposal.signal
      : AbortSignal.any([signal, disposal.signal]);
  }

  function invalidate(threadId: string, allocationId?: string) {
    for (const transition of transitions)
      if (
        allocationId === undefined
          ? transition.threadIds.has(threadId)
          : transition.id === allocationId &&
            transition.ownerThreadId === threadId
      )
        transition.controller.abort(
          new Error(
            "Managed cleanup was cancelled because a participating chat changed.",
          ),
        );
  }

  function forgetFreshNative(ownerThreadId: string, id?: string) {
    for (const [allocationId, grant] of freshNativeGrants)
      if (
        grant.ownerThreadId === ownerThreadId &&
        (id === undefined || allocationId === id)
      )
        freshNativeGrants.delete(allocationId);
  }

  function freshlyAccepted(item: ManagedAllocation) {
    const fresh = freshNativeGrants.get(item.id);

    return (
      fresh !== undefined &&
      fresh.ownerThreadId === item.ownerThreadId &&
      item.grant?.kind === fresh.kind &&
      item.grant.at === fresh.at
    );
  }

  function pending(map: Map<string, number>, key: string) {
    map.set(key, (map.get(key) ?? 0) + 1);

    return () => {
      const count = map.get(key) ?? 0;

      if (count <= 1) map.delete(key);
      else map.set(key, count - 1);
    };
  }

  function active(signal?: AbortSignal) {
    signal?.throwIfAborted();

    if (disposed) throw new Error("Storage & retention plugin is disabled.");
  }

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => undefined);

    return result;
  }

  async function policy() {
    const stored = await api.storage.kv.get(POLICY_KEY);

    return stored == null
      ? { ...defaultManagedPolicy }
      : managedPolicySchema.parse(stored);
  }

  async function ends() {
    return endsSchema.parse((await api.storage.kv.get(ENDS_KEY)) ?? {});
  }

  async function observeOwner(thread: Thread, settled: boolean) {
    const stored = await ends();
    const previous = stored[thread.id];
    const end = currentEnd(thread, previous);

    if (
      end === null &&
      (previous === undefined || previous.kind === "unarchived")
    )
      return previous;

    if (
      end !== null &&
      previous?.kind === end.kind &&
      previous.endAt === end.at &&
      previous.settled === settled &&
      previous.lastUnarchiveSequence !== undefined
    )
      return previous;
    const sequence = (previous?.sequence ?? 0) + 1;

    if (end === null) forgetFreshNative(thread.id);

    const observed: EndProof = {
      kind: end?.kind ?? "unarchived",
      at: now(),
      settled,
      sequence,
      endAt: end?.at ?? null,
      lastUnarchiveSequence:
        end === null ? sequence : unarchiveSequence(previous),
    };

    stored[thread.id] = observed;
    await api.storage.kv.set(ENDS_KEY, stored);

    return observed;
  }

  async function observations() {
    return observationsSchema.parse(
      (await api.storage.kv.get(OBSERVATIONS_KEY)) ?? {
        holds: [],
        failures: [],
      },
    );
  }

  async function rememberOutcome(
    state: ManagedState,
    replaceFailures = false,
  ): Promise<ManagedState> {
    const previous = await observations();

    const holds = new Map(
      previous.holds.map((item) => [`${item.hostId}/${item.id}`, item]),
    );

    for (const item of state.allocations) {
      const key = `${item.hostId}/${item.id}`;
      holds.delete(key);

      if (item.hold?.code === "coordinator-hold" && item.phase !== "removed")
        holds.set(key, {
          hostId: item.hostId,
          ...exact(item),
          hold: item.hold,
        });
    }

    await api.storage.kv.set(OBSERVATIONS_KEY, {
      holds: [...holds.values()].slice(-1000),
      failures: (replaceFailures ? state.failures : previous.failures)
        .slice(-100)
        .map((failure) => ({
          hostId: failure.hostId,
          message: failure.message.slice(0, 1000),
        })),
    });

    return state;
  }

  async function rememberHost(hostId: string) {
    const previous = z
      .array(z.string())
      .parse((await api.storage.kv.get(HOSTS_KEY)) ?? []);

    if (!previous.includes(hostId))
      await api.storage.kv.set(HOSTS_KEY, [...previous, hostId]);
  }

  async function rememberParticipant(threadId: string) {
    const previous = z
      .array(z.string())
      .parse((await api.storage.kv.get(PARTICIPANTS_KEY)) ?? []);

    if (!previous.includes(threadId))
      await api.storage.kv.set(PARTICIPANTS_KEY, [...previous, threadId]);
  }

  async function threadFacts(threadId: string, signal?: AbortSignal) {
    const [thread, work] = await Promise.all([
      api.sdk.threads.get({ threadId, include: "host,environment", signal }),
      api.sdk.threads.experimental_work({ threadId, signal }),
    ]);

    return { thread, work };
  }

  async function settlement(threadId: string, signal?: AbortSignal) {
    const proof = (await ends())[threadId];

    try {
      const { thread, work } = await threadFacts(threadId, signal);
      const message = workHold(thread, work);

      return {
        message,
        ended: thread.archivedAt !== null || thread.deletedAt !== null,
        end: currentEnd(thread, proof),
        thread,
      };
    } catch (error) {
      active(signal);

      if (proof?.kind === "deleted" && proof.settled)
        return {
          message: null,
          ended: true,
          thread: null,
          end:
            proof.endAt == null
              ? null
              : ({
                  kind: "deleted",
                  at: proof.endAt,
                  unarchiveSequence: unarchiveSequence(proof),
                } satisfies EndToken | null),
        };

      return {
        message: `The chat's current state is unknown: ${error instanceof Error ? error.message : String(error)}`,
        ended: false,
        end: null,
        thread: null,
      };
    }
  }

  async function admission(item: ManagedAllocation, signal?: AbortSignal) {
    const ids = [
      item.ownerThreadId,
      ...item.consumers
        .filter((consumer) => consumer.releasedAt === null)
        .map((consumer) => consumer.threadId),
    ];

    const facts = await Promise.all(
      [...new Set(ids)].map(async (id) => ({
        id,
        ...(await settlement(id, signal)),
      })),
    );

    for (const fact of facts) {
      if (fact.message !== null) return `${fact.id}: ${fact.message}`;

      if (fact.id !== item.ownerThreadId && !fact.ended)
        return `${fact.id}: This consumer's declared use remains open. It must end authoritatively or release its hold through the native tool.`;
    }

    return null;
  }

  async function collect(
    signal: AbortSignal = disposal.signal,
    includePreviousFailures = true,
  ): Promise<ManagedState> {
    active(signal);

    const [current, saved, previous] = await Promise.all([
      policy(),
      api.storage.kv.get(HOSTS_KEY),
      observations(),
    ]);

    const hostIds = [...new Set(z.array(z.string()).parse(saved ?? []))].sort();

    const hosts =
      hostIds.length === 0 ? [] : await api.sdk.hosts.list({ signal });

    const online = new Set(
      hosts
        .filter((host) => host.status === "connected")
        .map((host) => host.id),
    );

    const allocations: ManagedAllocation[] = [];
    const failures: ManagedState["failures"] = [];

    for (let offset = 0; offset < hostIds.length; offset += 4) {
      const batch = await Promise.all(
        hostIds.slice(offset, offset + 4).map(async (hostId) => {
          try {
            if (!online.has(hostId))
              throw new Error(
                "The managed allocation host is offline. Its files remain held.",
              );

            const items = await worker.call("managedList", null, {
              hostId,
              signal,
            });

            return { hostId, items, error: null };
          } catch (error) {
            return {
              hostId,
              items: [],
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );

      for (const result of batch) {
        if (result.error !== null)
          failures.push({ hostId: result.hostId, message: result.error });
        allocations.push(...result.items);
      }
    }

    active(signal);

    const overlay = new Map(
      previous.holds.map((item) => [`${item.hostId}/${item.id}`, item]),
    );

    const mergedFailures = [
      ...failures,
      ...(includePreviousFailures ? previous.failures : []),
    ];

    return {
      policy: current,
      allocations: allocations.map((item) => {
        const saved = overlay.get(`${item.hostId}/${item.id}`);

        return item.hold === null &&
          saved?.revision === item.revision &&
          saved.snapshotDigest === (item.snapshot?.digest ?? null)
          ? { ...item, hold: saved.hold }
          : item;
      }),
      failures: [
        ...new Map(
          mergedFailures.map((failure) => [
            `${failure.hostId}/${failure.message}`,
            failure,
          ]),
        ).values(),
      ].slice(-100),
      preview: null,
    };
  }

  async function read(hostId: string, id: string, signal?: AbortSignal) {
    active(signal);

    return worker.call("managedInspect", { id }, { hostId, signal });
  }

  function requireExact(item: ManagedAllocation, input: Exact) {
    if (
      item.id !== input.id ||
      item.revision !== input.revision ||
      item.snapshot?.digest !== input.snapshotDigest
    )
      throw new Error(
        "The allocation changed. Inspect it again before confirming.",
      );
  }

  async function acknowledgeUnarchive(
    item: ManagedAllocation,
    sequence: number,
  ) {
    const acknowledged = z
      .record(z.string(), z.number())
      .parse((await api.storage.kv.get(UNARCHIVE_ACKS_KEY)) ?? {});

    acknowledged[item.id] = sequence;
    await api.storage.kv.set(UNARCHIVE_ACKS_KEY, acknowledged);
  }

  async function advance(item: ManagedAllocation, signal?: AbortSignal) {
    if (item.phase === "removed") return item;
    const owner = await settlement(item.ownerThreadId, signal);

    const proof =
      owner.thread === null
        ? (await ends())[item.ownerThreadId]
        : await observeOwner(owner.thread, owner.message === null);

    const sequence = unarchiveSequence(proof);

    const token =
      owner.thread === null ? owner.end : currentEnd(owner.thread, proof);

    const stored = await api.storage.kv.get(CONSUMED_END_KEY + item.id);
    const consumed = stored == null ? null : endTokenSchema.parse(stored);

    if (item.grant !== null) {
      const acknowledged = z
        .record(z.string(), z.number())
        .parse((await api.storage.kv.get(UNARCHIVE_ACKS_KEY)) ?? {});

      if (acknowledged[item.id] !== sequence) {
        freshNativeGrants.delete(item.id);
        item = await worker.call(
          "managedOwnerDecision",
          {
            ...exact(item),
            actorThreadId: item.ownerThreadId,
            decision: { action: "owner-unarchived" },
          },
          { hostId: item.hostId, signal },
        );
      }
    }

    if (
      item.grant !== null &&
      !freshlyAccepted(item) &&
      !(
        token !== null &&
        consumed !== null &&
        token.kind === consumed.kind &&
        token.at === consumed.at &&
        token.unarchiveSequence === consumed.unarchiveSequence
      )
    ) {
      freshNativeGrants.delete(item.id);

      const revoked = await worker.call(
        "managedOwnerDecision",
        {
          ...exact(item),
          actorThreadId: item.ownerThreadId,
          decision: { action: "owner-unarchived" },
        },
        { hostId: item.hostId, signal },
      );

      return held(
        revoked,
        "The owner's lifecycle history is unavailable after reload. A fresh native release is required before cleanup.",
      );
    }

    if (token === null) {
      if (
        owner.ended &&
        owner.message === null &&
        item.grant === null &&
        item.disposition === "disposable-when-owner-ends"
      )
        return held(
          item,
          "The authoritative owner end has no known generation timestamp. A fresh native release is required.",
        );

      return item;
    }

    if (item.grant !== null) {
      if (consumed === null || newerEnd(token, consumed))
        await api.storage.kv.set(CONSUMED_END_KEY + item.id, token);

      return item;
    }

    if (
      owner.ended &&
      owner.message === null &&
      item.grant === null &&
      item.disposition === "disposable-when-owner-ends"
    ) {
      if (consumed !== null && !newerEnd(token, consumed))
        return held(
          item,
          "This owner end has already consumed its advance cleanup permission. A fresh native release or a new authoritative owner end is required.",
        );

      if (consumed === null && item.phase !== "allocated") {
        await api.storage.kv.set(CONSUMED_END_KEY + item.id, token);

        return held(
          item,
          "This allocation's prior cleanup authority is no longer present. A fresh native release or a new authoritative owner end is required.",
        );
      }

      const message = await admission(item, signal);

      if (message !== null) return held(item, message);
      const observed = await read(item.hostId, item.id, signal);

      if (observed.hold !== null) return observed;

      active(signal);
      await api.storage.kv.set(CONSUMED_END_KEY + item.id, token);
      active(signal);

      const granted = await worker.call(
        "managedOwnerDecision",
        {
          ...exact(observed),
          actorThreadId: item.ownerThreadId,
          decision: { action: "owner-ended" },
        },
        { hostId: item.hostId, signal },
      );

      await acknowledgeUnarchive(granted, sequence);

      return granted;
    }

    return item;
  }

  async function perform(
    item: ManagedAllocation,
    action: "quarantine" | "restore" | "purge",
    current: ManagedPolicy,
    signal?: AbortSignal,
  ) {
    const controller = new AbortController();

    const transition = {
      id: item.id,
      ownerThreadId: item.ownerThreadId,
      threadIds: new Set([
        item.ownerThreadId,
        ...item.consumers
          .filter((consumer) => consumer.releasedAt === null)
          .map((consumer) => consumer.threadId),
      ]),
      controller,
    };

    transitions.add(transition);

    const unsubscribe = api.sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.id !== undefined && transition.threadIds.has(event.id))
          controller.abort(
            new Error(
              "Managed cleanup was cancelled because a participating chat changed.",
            ),
          );
      },
    });

    signal = AbortSignal.any([operationSignal(signal), controller.signal]);

    try {
      active(signal);

      if (
        [...transition.threadIds].some((id) => pendingUnarchives.has(id)) ||
        pendingOwnerDecisions.has(`${item.ownerThreadId}/${item.id}`)
      )
        return held(
          item,
          "A participating chat resumed or the native owner is revising its cleanup decision. Nothing was removed.",
        );
      item = await advance(item, signal);

      if (action !== "restore") {
        const message = await admission(item, signal);

        if (message !== null) return held(item, message);

        if (item.grant === null)
          return held(
            item,
            "A native owner release is required. Nothing was removed.",
          );
      }

      if (action === "quarantine") {
        const state = await collect(signal, false);

        if (state.failures.length > 0)
          return held(
            item,
            "The quarantine budget cannot be confirmed while a host is unavailable.",
          );

        const used = state.allocations
          .filter((entry) =>
            ["quarantined", "purge-intent", "restore-intent"].includes(
              entry.phase,
            ),
          )
          .reduce(
            (total, entry) => total + (entry.snapshot?.logicalBytes ?? 0),
            0,
          );

        if (
          used + (item.snapshot?.logicalBytes ?? 0) >
          current.quarantineBudgetBytes
        )
          return held(
            item,
            "The managed quarantine budget is full. Existing allocations were preserved.",
          );
      }

      active(signal);

      const result = await worker.call(
        "managedTransition",
        {
          ...exact(item),
          action,
          expiryEnabledAt: action === "purge" ? null : current.expiryEnabledAt,
          settledConsumerThreadIds: item.consumers
            .filter((consumer) => consumer.releasedAt === null)
            .map((consumer) => consumer.threadId),
        },
        { hostId: item.hostId, signal },
      );

      if (result.grant === null) freshNativeGrants.delete(item.id);

      return result;
    } finally {
      transitions.delete(transition);
      unsubscribe();
    }
  }

  function preview(state: ManagedState, proposed: ManagedPolicyDraft) {
    const items = [...state.allocations].sort(
      (a, b) => a.hostId.localeCompare(b.hostId) || a.id.localeCompare(b.id),
    );

    return {
      digest: digest({
        revision: state.policy.revision,
        proposed,
        items: items.map((item) => ({
          hostId: item.hostId,
          ...exact(item),
          phase: item.phase,
        })),
        failures: state.failures,
      }),
      affectedCount: items.filter((item) => item.phase !== "removed").length,
      eligibleCount: items.filter(
        (item) => item.grant !== null && item.phase === "proposed",
      ).length,
      quarantinedCount: items.filter((item) => item.phase === "quarantined")
        .length,
    };
  }

  async function request(
    input: unknown,
    callerSignal?: AbortSignal,
  ): Promise<ManagedState> {
    const parsed = managedAdminRequestSchema.parse(input);
    const signal = operationSignal(callerSignal);

    return serial(async () => {
      active(signal);

      if (parsed.action === "list") return collect(signal);

      if (
        parsed.action === "namespace-preview" ||
        parsed.action === "namespace-reanchor"
      ) {
        const current = await worker.call("managedList", null, {
          hostId: parsed.hostId,
          signal,
        });

        for (const item of current) {
          const message = await admission(item, signal);

          if (message !== null) throw new Error(message);
        }

        const result = await worker.call(
          "managedReanchor",
          {
            previewDigest:
              parsed.action === "namespace-preview"
                ? null
                : parsed.previewDigest,
          },
          { hostId: parsed.hostId, signal },
        );

        const state = await collect(signal);

        return {
          ...state,
          preview: {
            digest: result.digest,
            affectedCount: result.allocationCount,
            eligibleCount: 0,
            quarantinedCount: 0,
          },
        };
      }

      if (parsed.action === "policy-preview" || parsed.action === "configure") {
        const state = await collect(signal);
        const selected = preview(state, parsed.policy);

        if (parsed.action === "policy-preview")
          return { ...state, preview: selected };

        if (
          state.policy.revision !== parsed.expectedRevision ||
          selected.digest !== parsed.previewDigest
        )
          throw new Error(
            "The policy or allocations changed. Preview the policy again.",
          );

        const next: ManagedPolicy = {
          ...parsed.policy,
          revision: state.policy.revision + 1,
          expiryEnabledAt: parsed.policy.automaticExpiry
            ? state.policy.automaticExpiry
              ? state.policy.expiryEnabledAt
              : now()
            : null,
        };

        active(signal);
        await api.storage.kv.set(POLICY_KEY, next);
        api.realtime.publish("managed-changed", null);

        return { ...state, policy: next, preview: selected };
      }

      if (
        parsed.action === "purge-preview" ||
        parsed.action === "purge-batch"
      ) {
        const state = await collect(signal);
        const items: ManagedAllocation[] = [];

        for (const input of parsed.items) {
          const item = await read(input.hostId, input.id, signal);
          requireExact(item, input);
          items.push(item);
        }

        const selected = {
          digest: digest({
            revision: state.policy.revision,
            items: items.map((item) => ({
              hostId: item.hostId,
              ...exact(item),
            })),
          }),
          affectedCount: items.length,
          eligibleCount: items.filter(
            (item) =>
              item.phase === "quarantined" &&
              item.grant !== null &&
              item.quarantinedAt !== null &&
              item.quarantinedAt + MANAGED_HOLDING_MS <= now(),
          ).length,
          quarantinedCount: items.filter((item) => item.phase === "quarantined")
            .length,
        };

        if (parsed.action === "purge-preview")
          return { ...state, allocations: items, preview: selected };

        if (selected.digest !== parsed.previewDigest)
          throw new Error("The purge preview changed. Preview again.");
        const results: ManagedAllocation[] = [];
        const failures = [...state.failures];

        for (const item of items) {
          try {
            results.push(await perform(item, "purge", state.policy, signal));
          } catch (error) {
            active(signal);
            results.push(item);
            failures.push({
              hostId: item.hostId,
              message: `${item.id}: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        api.realtime.publish("managed-changed", null);

        return rememberOutcome({
          ...state,
          allocations: results,
          failures,
          preview: selected,
        });
      }

      let item = await read(parsed.hostId, parsed.id, signal);

      if (parsed.action === "inspect") {
        const message = await admission(item, signal);

        return rememberOutcome({
          policy: await policy(),
          allocations: [message === null ? item : held(item, message)],
          failures: [],
          preview: null,
        });
      }

      requireExact(item, parsed);
      const current = await policy();

      if (parsed.action === "review") {
        const message = await admission(item, signal);

        if (message !== null) item = held(item, message);
        else {
          active(signal);
          item = await worker.call("managedReview", exact(item), {
            hostId: item.hostId,
            signal,
          });

          if (item.phase === "approved")
            item = await perform(item, "quarantine", current, signal);
        }
      } else item = await perform(item, parsed.action, current, signal);
      api.realtime.publish("managed-changed", null);

      return rememberOutcome({
        policy: current,
        allocations: [item],
        failures: [],
        preview: null,
      });
    });
  }

  async function owner(
    input: unknown,
    ctx: PluginAgentToolContext,
  ): Promise<ManagedState> {
    const parsed = managedOwnerRequestSchema.parse(input).request;
    const signal = operationSignal(ctx.signal);
    let clearPending: (() => void) | null = null;

    if (parsed.action === "release") forgetFreshNative(ctx.threadId, parsed.id);

    if (
      parsed.action === "keep" ||
      parsed.action === "reuse" ||
      parsed.action === "budget-extend" ||
      parsed.action === "consumer-register"
    ) {
      forgetFreshNative(ctx.threadId, parsed.id);
      clearPending = pending(
        pendingOwnerDecisions,
        `${ctx.threadId}/${parsed.id}`,
      );
      invalidate(ctx.threadId, parsed.id);
    }

    return serial(async () => {
      active(signal);

      const thread = await api.sdk.threads.get({
        threadId: ctx.threadId,
        include: "host,environment",
        signal,
      });

      if (thread.id !== ctx.threadId || thread.projectId !== ctx.projectId)
        throw new Error("The native owner context does not match the chat.");
      await observeOwner(thread, workHold(thread, thread.work) === null);
      const state = await collect(signal);

      if (parsed.action === "list")
        return {
          ...state,
          allocations: state.allocations.filter(
            (item) =>
              item.ownerThreadId === ctx.threadId ||
              item.consumers.some(
                (consumer) => consumer.threadId === ctx.threadId,
              ),
          ),
        };

      if (parsed.action === "allocate") {
        if (!("host" in thread) || thread.host == null)
          throw new Error(
            "The owner's resolved host is unavailable. No allocation was created.",
          );
        const hostId = thread.host.id;
        active(signal);
        await rememberHost(hostId);

        const item = await worker.call(
          "managedAllocate",
          {
            hostId,
            ownerThreadId: ctx.threadId,
            projectId: ctx.projectId,
            requestKey: parsed.requestKey,
            purpose: parsed.purpose,
            disposition: parsed.disposition,
            storage: parsed.storage,
          },
          { hostId, signal },
        );

        await rememberParticipant(ctx.threadId);
        api.realtime.publish("managed-changed", null);

        return { ...state, allocations: [item] };
      }

      const found = state.allocations.find(
        (item) =>
          item.id === parsed.id &&
          (item.ownerThreadId === ctx.threadId ||
            item.consumers.some(
              (consumer) => consumer.threadId === ctx.threadId,
            )),
      );

      if (found === undefined)
        throw new Error("This chat does not own or consume the allocation.");
      const item = await read(found.hostId, found.id, signal);

      if (parsed.action === "inspect") return { ...state, allocations: [item] };

      if (
        item.ownerThreadId !== ctx.threadId &&
        parsed.action !== "consumer-release" &&
        parsed.action !== "consumer-register"
      )
        throw new Error(
          "Only the native owner can make this usefulness decision.",
        );

      if (
        item.revision !== parsed.revision ||
        (item.snapshot?.digest ?? null) !== parsed.snapshotDigest
      )
        throw new Error(
          "The allocation changed. Inspect it before recording a decision.",
        );

      if (parsed.action === "consumer-register") {
        const consumer = await api.sdk.threads.get({
          threadId: parsed.consumerThreadId,
          signal,
        });

        if (
          consumer.id !== parsed.consumerThreadId ||
          consumer.deletedAt !== null
        )
          throw new Error(
            "The named consumer does not exist as a live chat. No hold was registered.",
          );
      }

      const decision =
        parsed.action === "consumer-register"
          ? { action: parsed.action, consumerThreadId: parsed.consumerThreadId }
          : parsed.action === "consumer-release"
            ? { action: parsed.action }
            : parsed.action === "release"
              ? {
                  action: parsed.action,
                  reason: parsed.reason,
                  closeout: parsed.closeout,
                }
              : parsed.action === "budget-extend"
                ? {
                    action: parsed.action,
                    reason: parsed.reason,
                    budgetBytes: parsed.budgetBytes,
                  }
                : { action: parsed.action, reason: parsed.reason };

      active(signal);

      const updated = await worker.call(
        "managedOwnerDecision",
        { ...exact(item), actorThreadId: ctx.threadId, decision },
        { hostId: item.hostId, signal },
      );

      const proof = (await ends())[ctx.threadId];

      if (parsed.action === "consumer-register")
        await rememberParticipant(parsed.consumerThreadId);

      if (parsed.action === "release") {
        await acknowledgeUnarchive(updated, unarchiveSequence(proof));
        const token = currentEnd(thread, proof);

        if (token !== null) {
          const stored = await api.storage.kv.get(
            CONSUMED_END_KEY + updated.id,
          );

          const consumed = stored == null ? null : endTokenSchema.parse(stored);

          if (consumed === null || newerEnd(token, consumed))
            await api.storage.kv.set(CONSUMED_END_KEY + updated.id, token);
        }

        freshNativeGrants.delete(updated.id);

        if (updated.grant?.kind === "native-release")
          freshNativeGrants.set(updated.id, {
            ownerThreadId: updated.ownerThreadId,
            kind: "native-release",
            at: updated.grant.at,
          });
      }

      api.realtime.publish("managed-changed", null);

      return { ...state, allocations: [updated] };
    }).finally(() => {
      clearPending?.();
    });
  }

  async function reconcileUnlocked(
    signal?: AbortSignal,
  ): Promise<ManagedState> {
    const callerSignal = operationSignal(signal);
    const deadline = AbortSignal.timeout(20_000);
    const boundedSignal = AbortSignal.any([callerSignal, deadline]);
    const state = await collect(boundedSignal, false);

    const candidates = state.allocations
      .filter((item) => item.phase !== "removed")
      .sort((a, b) =>
        `${a.hostId}/${a.id}`.localeCompare(`${b.hostId}/${b.id}`),
      );

    const storedCursor = z
      .string()
      .nullable()
      .parse((await api.storage.kv.get(CURSOR_KEY)) ?? null);

    const next =
      storedCursor === null
        ? 0
        : candidates.findIndex(
            (item) => `${item.hostId}/${item.id}` > storedCursor,
          );

    const start = next < 0 ? 0 : next;

    const selected = [
      ...candidates.slice(start),
      ...candidates.slice(0, start),
    ].slice(0, LIMIT);

    const results = new Map<string, ManagedAllocation>();
    let lastKey: string | null = null;

    for (const initial of selected) {
      active(callerSignal);

      if (deadline.aborted) {
        state.failures.push({
          hostId: initial.hostId,
          message:
            "Managed reconciliation reached its 20-second bound. Remaining allocations stay held for a later pass.",
        });
        break;
      }

      lastKey = `${initial.hostId}/${initial.id}`;

      let item =
        initial.hold?.code === "coordinator-hold"
          ? { ...initial, hold: null }
          : initial;

      try {
        item = await advance(item, boundedSignal);

        if (
          ["quarantine-intent", "restore-intent", "purge-intent"].includes(
            item.phase,
          )
        ) {
          const recovered = await worker.call(
            "managedReconcile",
            { id: item.id },
            { hostId: item.hostId, signal: boundedSignal },
          );

          item = recovered.find((entry) => entry.id === item.id) ?? item;
        }

        const message =
          item.phase === "removed"
            ? null
            : await admission(item, boundedSignal);

        if (message !== null) {
          results.set(item.id, held(item, message));
          continue;
        }

        if (
          (item.phase === "proposed" ||
            (item.phase === "quarantined" && item.reviewedAt === null)) &&
          item.grant !== null &&
          state.policy.mode === "owner-approved"
        )
          item = await worker.call("managedReview", exact(item), {
            hostId: item.hostId,
            signal: boundedSignal,
          });

        if (item.phase === "approved")
          item = await perform(item, "quarantine", state.policy, boundedSignal);

        if (
          item.phase === "quarantined" &&
          item.grant !== null &&
          state.policy.automaticExpiry &&
          state.policy.expiryEnabledAt !== null &&
          item.quarantinedAt !== null &&
          Math.max(item.quarantinedAt, state.policy.expiryEnabledAt) +
            MANAGED_HOLDING_MS <=
            now()
        )
          item = await perform(item, "purge", state.policy, boundedSignal);
        results.set(item.id, item);
      } catch (error) {
        active(callerSignal);
        state.failures.push({
          hostId: initial.hostId,
          message: `${initial.id}: ${error instanceof Error ? error.message : String(error)}`,
        });
        results.set(
          initial.id,
          held(
            item,
            deadline.aborted
              ? "Managed reconciliation reached its 20-second bound. The allocation remains held."
              : "Reconciliation failed. The allocation remains held.",
          ),
        );

        if (deadline.aborted) break;
      }
    }

    if (lastKey !== null) await api.storage.kv.set(CURSOR_KEY, lastKey);

    return {
      ...state,
      allocations: state.allocations.map(
        (item) => results.get(item.id) ?? item,
      ),
    };
  }

  async function lifecycle(
    event: "thread.archived" | "thread.deleted" | "thread.unarchived",
    thread: Thread,
  ) {
    if (event === "thread.unarchived") forgetFreshNative(thread.id);

    const clearPending =
      event === "thread.unarchived"
        ? pending(pendingUnarchives, thread.id)
        : null;

    invalidate(thread.id);

    return serial(async () => {
      active();

      const participants = z
        .array(z.string())
        .parse((await api.storage.kv.get(PARTICIPANTS_KEY)) ?? []);

      if (!participants.includes(thread.id))
        return {
          policy: await policy(),
          allocations: [],
          failures: [],
          preview: null,
        };
      const stored = await ends();
      const previous = stored[thread.id];
      const sequence = (previous?.sequence ?? 0) + 1;
      stored[thread.id] = {
        kind:
          event === "thread.deleted"
            ? "deleted"
            : event === "thread.archived"
              ? "archived"
              : "unarchived",
        at: now(),
        settled: workHold(thread, thread.work) === null,
        sequence,
        endAt:
          event === "thread.deleted"
            ? thread.deletedAt
            : event === "thread.archived"
              ? thread.archivedAt
              : null,
        lastUnarchiveSequence:
          event === "thread.unarchived"
            ? sequence
            : unarchiveSequence(previous),
      };
      await api.storage.kv.set(ENDS_KEY, stored);
      const failures: ManagedState["failures"] = [];

      if (event === "thread.unarchived") {
        const state = await collect(disposal.signal);

        for (const item of state.allocations.filter(
          (item) =>
            item.ownerThreadId === thread.id &&
            item.phase !== "removed" &&
            item.grant !== null,
        )) {
          try {
            active(disposal.signal);
            await worker.call(
              "managedOwnerDecision",
              {
                ...exact(item),
                actorThreadId: thread.id,
                decision: { action: "owner-unarchived" },
              },
              { hostId: item.hostId, signal: disposal.signal },
            );
          } catch (error) {
            failures.push({
              hostId: item.hostId,
              message: `${item.id}: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }

      const state = await reconcileUnlocked(disposal.signal);

      const result = await rememberOutcome(
        { ...state, failures: [...state.failures, ...failures] },
        true,
      );

      api.realtime.publish("managed-changed", null);

      return result;
    }).finally(() => {
      clearPending?.();
    });
  }

  return {
    state: () => {
      pendingState ??= serial(() => collect()).finally(() => {
        pendingState = null;
      });

      return pendingState;
    },
    request,
    owner,
    lifecycle,
    reconcile: (signal?: AbortSignal) =>
      serial(async () => {
        const state = await reconcileUnlocked(operationSignal(signal));
        await rememberOutcome(state, true);
        api.realtime.publish("managed-changed", null);

        return state;
      }),
  };
}

export type ManagedService = ReturnType<typeof createManagedService>;
