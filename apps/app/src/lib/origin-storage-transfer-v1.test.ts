// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { emptyPromptDraftState } from "@omnyo/client-core";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import {
  admitOriginStorageV1,
  admitOriginAdoptionV1,
  assertOriginStorageSourceUnchangedV1,
  fenceOriginStorageSourceV1,
  importOriginStorageV1,
  snapshotOriginStorageV1,
  type OriginStorageTicketV1,
} from "./origin-storage-transfer-v1";

class Store implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const ticket: OriginStorageTicketV1 = {
  version: 1,
  adoptionId: "adoption-fixture",
  id: "a".repeat(64),
  selectedIds: ["a".repeat(64)],
  nonce: "b".repeat(64),
  fromOrigin: "https://bb.alexburlis.com",
  toOrigin: "https://app.omnyohq.com",
};

function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  const local = new Store();
  const session = new Store();
  local.setItem("bb.theme", "dark");
  local.setItem(
    "bb.composer-submissions.v1.stable-tab",
    JSON.stringify([
      {
        id: "stable-request",
        draft: "opaque draft bytes",
        scope: { kind: "new-thread" },
      },
    ]),
  );
  local.setItem("unknown-plugin-data", "opaque BB user work");
  session.setItem("bb.composer-submission-tab.v1", "stable-tab");
  session.setItem(
    "bb.pending-chats.v1",
    JSON.stringify([
      {
        id: "pending_stable",
        projectId: "project-stable",
        realThreadId: "thread-stable",
      },
    ]),
  );
  fenceOriginStorageSourceV1(ticket, ticket.fromOrigin, local);

  const payload = snapshotOriginStorageV1(
    ticket,
    ticket.fromOrigin,
    local,
    session,
  );

  const targetLocal = new Store();
  const targetSession = new Store();

  const args = {
    ticket,
    currentOrigin: ticket.toOrigin,
    eventOrigin: ticket.fromOrigin,
    eventSource: window,
    expectedSource: window,
    payload,
    local: targetLocal,
    session: targetSession,
  };

  return { local, session, payload, targetLocal, targetSession, args };
}

test("copies original tab, pending identities and unknown bytes through quota interruption before admission, then preserves later work", async () => {
  const f = fixture();
  const original = [...f.local.values];
  const set = f.targetLocal.setItem.bind(f.targetLocal);
  f.targetLocal.setItem = (key, value) => {
    if (key === "unknown-plugin-data")
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    set(key, value);
  };

  await expect(importOriginStorageV1(f.args)).rejects.toThrow("Quota exceeded");
  expect([...f.local.values]).toEqual(original);
  expect(() =>
    admitOriginStorageV1(ticket, "c".repeat(64), f.targetSession),
  ).toThrow();
  f.targetLocal.setItem = set;
  const result = await importOriginStorageV1(f.args);
  expect(result.phase).toBe("verified");
  expect(f.targetSession.getItem("bb.composer-submission-tab.v1")).toBe(
    "stable-tab",
  );
  expect(f.targetSession.getItem("bb.pending-chats.v1")).toBe(
    f.session.getItem("bb.pending-chats.v1"),
  );
  expect(f.targetLocal.getItem("bb.composer-submissions.v1.stable-tab")).toBe(
    f.local.getItem("bb.composer-submissions.v1.stable-tab"),
  );
  expect(f.targetLocal.getItem("unknown-plugin-data")).toBe(
    "opaque BB user work",
  );
  assertOriginStorageSourceUnchangedV1(f.payload, f.local, f.session);
  admitOriginStorageV1(ticket, result.digest, f.targetSession);
  admitOriginAdoptionV1(ticket, f.targetLocal, f.targetSession, {
    phase: "admitted",
    adoptionAccepted: true,
  });
  f.targetLocal.setItem("bb.theme", "later-user-choice");
  expect(await importOriginStorageV1(f.args)).toMatchObject({
    phase: "accepted",
  });
  expect(f.targetLocal.getItem("bb.theme")).toBe("later-user-choice");
});

test("refuses a wrong origin, sender, nonce, target collision and changed source without dispatching any stored work", async () => {
  const f = fixture();
  await expect(
    importOriginStorageV1({
      ...f.args,
      eventOrigin: "https://foreign.example",
    }),
  ).rejects.toThrow("not authorized");
  await expect(
    importOriginStorageV1({ ...f.args, eventSource: null }),
  ).rejects.toThrow("not authorized");
  await expect(
    importOriginStorageV1({
      ...f.args,
      payload: { ...f.payload, ticket: { ...ticket, nonce: "d".repeat(64) } },
    }),
  ).rejects.toThrow("not authorized");
  expect(f.targetLocal.length).toBe(0);
  expect(f.targetSession.length).toBe(0);
  f.targetLocal.setItem("unknown-plugin-data", "new unrelated work");
  await expect(importOriginStorageV1(f.args)).rejects.toThrow("collides");
  expect(f.targetSession.length).toBe(0);
  expect(f.targetLocal.getItem("unknown-plugin-data")).toBe(
    "new unrelated work",
  );
  f.local.setItem("new-late-user-work", "preserved");
  expect(() =>
    assertOriginStorageSourceUnchangedV1(f.payload, f.local, f.session),
  ).toThrow("changed");
});

test("fences a whole adoption while preserving independent window receipts and refusing another adoption", () => {
  const local = new Store();
  const selected = { ...ticket, selectedIds: [ticket.id, "e".repeat(64)] };
  fenceOriginStorageSourceV1(selected, selected.fromOrigin, local);
  const before = [...local.values];
  fenceOriginStorageSourceV1(
    { ...selected, id: "e".repeat(64), nonce: "f".repeat(64) },
    ticket.fromOrigin,
    local,
  );
  expect([...local.values]).toEqual(before);
  expect(() =>
    fenceOriginStorageSourceV1(
      { ...selected, adoptionId: "another-adoption" },
      ticket.fromOrigin,
      local,
    ),
  ).toThrow("different transfer");
  expect([...local.values]).toEqual(before);
});

test("restores actual journal drafts and pending destinations across the address change without replaying creation or sends", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const sourceLocal = new Store();
  const sourceSession = new Store();
  sourceSession.setItem("omnyo.composer-submission-tab.v1", "stable-real-tab");

  const local = vi
    .spyOn(window, "localStorage", "get")
    .mockReturnValue(sourceLocal);

  const session = vi
    .spyOn(window, "sessionStorage", "get")
    .mockReturnValue(sourceSession);

  const network = vi.fn(() => {
    throw new Error("No request is authorized by storage migration");
  });

  vi.stubGlobal("fetch", network);
  const journal = await import("./composer-submission-journal");
  const pending = await import("./pending-chat-creations");

  const draft = {
    ...emptyPromptDraftState(),
    text: "Keep BB in this user draft",
    attachments: [
      {
        type: "localFile" as const,
        path: "/fixture/owned.txt",
        name: "owned.txt",
      },
    ],
  };

  journal.beginComposerSubmission({ scope: { kind: "new-thread" }, draft });

  const request = {
    projectId: "project-pending",
    providerId: "codex",
    model: "original-model",
    reasoningLevel: "high",
    permissionMode: "full",
    environment: { type: "reuse", environmentId: "environment-original" },
    executionInputSources: { providerId: "explicit", model: "explicit" },
    input: [{ type: "text", text: "original pending intent", mentions: [] }],
  } satisfies Parameters<typeof pending.createPendingChat>[0]["request"];

  const create = vi.fn(() => new Promise<never>(() => {}));

  const acceptedCreate = vi.fn(async () =>
    makeThreadResponse({
      id: "thr_already_created",
      projectId: request.projectId,
    }),
  );

  const send = vi.fn(async () => {});

  const options = {
    queueOwner: {},
    request,
    send,
    renderer: () => null,
    prepare: async () => {},
  };

  const inFlight = pending.createPendingChat({ ...options, create });

  const accepted = pending.createPendingChat({
    ...options,
    create: acceptedCreate,
  });

  await accepted.completion;
  const journalKey = "omnyo.composer-submissions.v1.stable-real-tab";
  const originalJournal = sourceLocal.getItem(journalKey);
  const originalPending = sourceSession.getItem("omnyo.pending-chats.v1");
  expect(originalJournal).not.toBeNull();
  expect(originalPending).not.toBeNull();
  fenceOriginStorageSourceV1(ticket, ticket.fromOrigin, sourceLocal);

  const payload = snapshotOriginStorageV1(
    ticket,
    ticket.fromOrigin,
    sourceLocal,
    sourceSession,
  );

  const targetLocal = new Store();
  const targetSession = new Store();

  const result = await importOriginStorageV1({
    ticket,
    currentOrigin: ticket.toOrigin,
    eventOrigin: ticket.fromOrigin,
    eventSource: window,
    expectedSource: window,
    payload,
    local: targetLocal,
    session: targetSession,
  });

  expect(targetLocal.getItem(journalKey)).toBe(originalJournal);
  expect(targetSession.getItem("omnyo.pending-chats.v1")).toBe(originalPending);
  expect(targetSession.getItem("omnyo.composer-submission-tab.v1")).toBe(
    "stable-real-tab",
  );
  admitOriginStorageV1(ticket, result.digest, targetSession);
  admitOriginAdoptionV1(ticket, targetLocal, targetSession, {
    phase: "admitted",
    adoptionAccepted: true,
  });
  local.mockReturnValue(targetLocal);
  session.mockReturnValue(targetSession);
  vi.resetModules();
  const recipientJournal = await import("./composer-submission-journal");
  const restore = vi.fn();
  expect(
    recipientJournal.recoverInterruptedComposerSubmissions(restore),
  ).toEqual({ recovered: 1, failed: 0 });
  expect(restore).toHaveBeenCalledExactlyOnceWith(
    { kind: "new-thread" },
    draft,
  );
  const recipientPending = await import("./pending-chat-creations");
  expect(recipientPending.getPendingChatSnapshot(inFlight.id)).toMatchObject({
    id: inFlight.id,
    projectId: request.projectId,
    realThreadId: null,
    status: "interrupted",
  });
  expect(recipientPending.getPendingChatSnapshot(accepted.id)).toMatchObject({
    id: accepted.id,
    projectId: request.projectId,
    realThreadId: "thr_already_created",
    status: "ready",
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(acceptedCreate).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});
