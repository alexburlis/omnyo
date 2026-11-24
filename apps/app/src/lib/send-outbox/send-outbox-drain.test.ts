import type { SubmissionReceipt, SubmitRequest } from "@omnyo/server-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createSendOutboxDrainer,
  drainSendOutbox,
  type OutboxDeliveryFailure,
  type SendOutboxTransport,
} from "./send-outbox-drain";
import {
  createOutboxAttachment,
  createSubmissionId,
  type NewOutboxEntry,
  type OutboxEntry,
} from "./send-outbox-entry";
import type { SendOutboxStore } from "./send-outbox-store";

const STORE_ID = "store-test";

class RetryableFailure extends Error {}

class TerminalFailure extends Error {}

function classify(error: unknown): OutboxDeliveryFailure {
  return error instanceof TerminalFailure
    ? { kind: "terminal", code: "refused", message: error.message }
    : { kind: "retry" };
}

function createMemoryStore(): SendOutboxStore & { entries: OutboxEntry[] } {
  const entries: OutboxEntry[] = [];
  const aliases = new Map<string, string>();
  let knownStoreId: string | null = null;
  const listeners = new Set<() => void>();
  let sequence = 0;

  const update = (
    submissionId: string,
    change: (entry: OutboxEntry) => OutboxEntry,
  ): void => {
    const index = entries.findIndex(
      (entry) => entry.submissionId === submissionId,
    );

    const current = entries[index];

    if (current !== undefined) {
      entries[index] = change(current);
    }

    for (const listener of listeners) listener();
  };

  return {
    entries,
    async stage(entry) {
      sequence += 1;

      const staged: OutboxEntry = {
        ...entry,
        schema: 1,
        sequence,
        state: { kind: "waiting" },
      };

      entries.push(staged);

      return staged;
    },
    async list() {
      return [...entries];
    },
    async count() {
      return entries.length;
    },
    async recordUpload(args) {
      update(args.submissionId, (entry) => ({
        ...entry,
        attachments: entry.attachments.map((attachment) =>
          attachment.token === args.token
            ? { ...attachment, uploadedPath: args.path }
            : attachment,
        ),
      }));
    },
    async setState(submissionId, state) {
      update(submissionId, (entry) => ({ ...entry, state }));
    },
    async reset(submissionId) {
      update(submissionId, (entry) => ({
        ...entry,
        attachments: entry.attachments.map((attachment) => ({
          ...attachment,
          uploadedPath: null,
        })),
        state: { kind: "waiting" },
      }));
    },
    async discard(submissionId) {
      entries.splice(
        entries.findIndex((entry) => entry.submissionId === submissionId),
        1,
      );
    },
    async settle(args) {
      entries.splice(
        entries.findIndex((entry) => entry.submissionId === args.submissionId),
        1,
      );

      if (args.alias !== null) {
        aliases.set(args.alias.pendingChatId, args.alias.threadId);
      }
    },
    async readAlias(pendingChatId) {
      return aliases.get(pendingChatId) ?? null;
    },
    async readKnownStoreId() {
      return knownStoreId;
    },
    async rememberStoreId(storeId) {
      knownStoreId = storeId;
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface FakeServer extends SendOutboxTransport {
  accepted: Map<string, SubmissionReceipt>;
  failNextSubmit: Error | null;
  loseNextReply: boolean;
  requests: SubmitRequest[];
  storeId: string | null;
  uploads: string[];
}

function createFakeServer(): FakeServer {
  const server: FakeServer = {
    accepted: new Map(),
    failNextSubmit: null,
    loseNextReply: false,
    requests: [],
    storeId: STORE_ID,
    uploads: [],
    async readStoreId() {
      return server.storeId;
    },
    async submit(request) {
      if (server.failNextSubmit !== null) {
        const failure = server.failNextSubmit;
        server.failNextSubmit = null;
        throw failure;
      }

      server.requests.push(request);

      const receipt = server.accepted.get(request.submissionId) ?? {
        version: 1,
        submissionId: request.submissionId,
        storeId: request.storeId,
        action: request.action.kind,
        threadId:
          request.action.kind === "thread-message"
            ? request.action.threadId
            : `thr_created_${server.accepted.size + 1}`,
        queuedMessageId: `qtm_${server.accepted.size + 1}`,
        acceptedAt: server.accepted.size + 1,
        replayed: false,
      };

      server.accepted.set(request.submissionId, receipt);

      if (server.loseNextReply) {
        server.loseNextReply = false;
        throw new RetryableFailure("reply lost");
      }

      return receipt;
    },
    async upload(args) {
      server.uploads.push(args.name);

      return `uploaded/${args.name}-${server.uploads.length}`;
    },
  };

  return server;
}

function message(threadId: string, text: string): NewOutboxEntry {
  return {
    submissionId: createSubmissionId(),
    storeId: STORE_ID,
    createdAt: 1,
    action: {
      kind: "thread-message",
      projectId: "proj-1",
      target: { threadId },
      message: { input: [{ type: "text", text, mentions: [] }] },
    },
    attachments: [],
  };
}

function sentTexts(server: FakeServer): string[] {
  return server.requests.map((request) => {
    const input =
      request.action.kind === "thread-message"
        ? request.action.message.input
        : request.action.thread.input;

    const first = input[0];

    return first?.type === "text" ? first.text : "";
  });
}

describe("send outbox drain", () => {
  it("delivers each chat's messages in the order they were staged and settles them", async () => {
    const store = createMemoryStore();
    const transport = createFakeServer();
    await store.stage(message("thr-a", "a1"));
    await store.stage(message("thr-b", "b1"));
    await store.stage(message("thr-a", "a2"));

    const result = await drainSendOutbox({ classify, store, transport });

    expect({
      outcome: result.outcome,
      remaining: store.entries.length,
      sent: sentTexts(transport),
    }).toEqual({ outcome: "idle", remaining: 0, sent: ["a1", "b1", "a2"] });
  });

  it("keeps a message after a lost reply and resolves the retry to the same acceptance", async () => {
    const store = createMemoryStore();
    const transport = createFakeServer();
    const staged = await store.stage(message("thr-a", "only once"));
    transport.loseNextReply = true;

    const first = await drainSendOutbox({ classify, store, transport });
    const keptAfterLostReply = store.entries.length;
    const second = await drainSendOutbox({ classify, store, transport });

    expect({
      acceptedOnServer: transport.accepted.size,
      attempts: transport.requests.map((request) => request.submissionId),
      first: first.outcome,
      keptAfterLostReply,
      remaining: store.entries.length,
      second: {
        delivered: second.delivered.map((item) => item.receipt.submissionId),
        outcome: second.outcome,
      },
    }).toEqual({
      acceptedOnServer: 1,
      attempts: [staged.submissionId, staged.submissionId],
      first: "retry",
      keptAfterLostReply: 1,
      remaining: 0,
      second: { delivered: [staged.submissionId], outcome: "idle" },
    });
  });

  it("uploads a staged file once, declares its content and reuses the upload on retry", async () => {
    const store = createMemoryStore();
    const transport = createFakeServer();

    const attachment = await createOutboxAttachment({
      blob: new Blob(["file bytes"], { type: "text/plain" }),
      mimeType: "text/plain",
      name: "notes.txt",
      uploadedPath: null,
    });

    await store.stage({
      ...message("thr-a", "with a file"),
      action: {
        kind: "thread-message",
        projectId: "proj-1",
        target: { threadId: "thr-a" },
        message: {
          input: [
            { type: "text", text: "with a file", mentions: [] },
            {
              type: "localFile",
              path: attachment.token,
              name: "notes.txt",
              sizeBytes: attachment.sizeBytes,
            },
          ],
        },
      },
      attachments: [attachment],
    });

    transport.failNextSubmit = new RetryableFailure("offline");
    await drainSendOutbox({ classify, store, transport });
    const keptBytes = store.entries[0]?.attachments[0]?.blob.size;
    await drainSendOutbox({ classify, store, transport });

    const request = transport.requests[0];

    expect({
      declared: request?.attachments,
      keptBytes,
      remaining: store.entries.length,
      sentPath:
        request?.action.kind === "thread-message"
          ? request.action.message.input[1]
          : null,
      uploads: transport.uploads,
    }).toEqual({
      declared: [
        {
          path: "uploaded/notes.txt-1",
          sha256: attachment.sha256,
          sizeBytes: 10,
        },
      ],
      keptBytes: 10,
      remaining: 0,
      sentPath: {
        type: "localFile",
        path: "uploaded/notes.txt-1",
        name: "notes.txt",
        sizeBytes: 10,
      },
      uploads: ["notes.txt"],
    });
  });

  it("sends a follow-up for a new chat only after the chat is accepted, and to the created chat", async () => {
    const store = createMemoryStore();
    const transport = createFakeServer();

    await store.stage({
      submissionId: createSubmissionId(),
      storeId: STORE_ID,
      createdAt: 1,
      action: {
        kind: "new-thread",
        pendingChatId: "pending_1",
        thread: {
          origin: "app",
          projectId: "proj-1",
          input: [{ type: "text", text: "first prompt", mentions: [] }],
          environment: {
            type: "host",
            hostId: "host-1",
            workspace: { type: "unmanaged", path: null },
          },
          startedOnBehalfOf: null,
          originKind: null,
        },
      },
      attachments: [],
    });

    await store.stage({
      ...message("unused", "follow-up"),
      action: {
        kind: "thread-message",
        projectId: "proj-1",
        target: { pendingChatId: "pending_1" },
        message: {
          input: [{ type: "text", text: "follow-up", mentions: [] }],
        },
      },
    });

    transport.failNextSubmit = new RetryableFailure("offline");
    await drainSendOutbox({ classify, store, transport });
    const sentWhileOffline = transport.requests.length;
    await drainSendOutbox({ classify, store, transport });

    const followUp = transport.requests[1];

    expect({
      followUpThread:
        followUp?.action.kind === "thread-message"
          ? followUp.action.threadId
          : null,
      order: sentTexts(transport),
      remaining: store.entries.length,
      sentWhileOffline,
    }).toEqual({
      followUpThread: "thr_created_1",
      order: ["first prompt", "follow-up"],
      remaining: 0,
      sentWhileOffline: 0,
    });
  });

  it("pauses a refused message, holds later ones in that chat and still delivers other chats", async () => {
    const store = createMemoryStore();
    const transport = createFakeServer();
    const refused = await store.stage(message("thr-a", "refused"));
    await store.stage(message("thr-a", "held behind it"));
    await store.stage(message("thr-b", "other chat"));
    transport.failNextSubmit = new TerminalFailure("Thread not found");

    const result = await drainSendOutbox({ classify, store, transport });

    expect({
      outcome: result.outcome,
      remaining: store.entries.map((entry) => ({
        state: entry.state,
        submissionId: entry.submissionId === refused.submissionId,
      })),
      sent: sentTexts(transport),
    }).toEqual({
      outcome: "idle",
      remaining: [
        {
          state: {
            kind: "paused",
            code: "refused",
            message: "Thread not found",
          },
          submissionId: true,
        },
        { state: { kind: "waiting" }, submissionId: false },
      ],
      sent: ["other chat"],
    });
  });

  it("leaves messages for another store and for a server without the route untouched", async () => {
    const store = createMemoryStore();
    const transport = createFakeServer();
    await store.stage({ ...message("thr-a", "other"), storeId: "store-other" });
    await store.stage(message("thr-a", "mine"));

    const delivered = await drainSendOutbox({ classify, store, transport });
    const afterOtherStore = store.entries.map((entry) => entry.storeId);
    await store.stage(message("thr-a", "later"));
    transport.storeId = null;
    const unsupported = await drainSendOutbox({ classify, store, transport });

    expect({
      afterOtherStore,
      delivered: delivered.outcome,
      knownStoreId: await store.readKnownStoreId(),
      remaining: store.entries.length,
      sent: sentTexts(transport),
      unsupported: unsupported.outcome,
    }).toEqual({
      afterOtherStore: ["store-other"],
      delivered: "idle",
      knownStoreId: STORE_ID,
      remaining: 2,
      sent: ["mine"],
      unsupported: "unsupported",
    });
  });

  it("retries on a bounded backoff, drains again on wake and skips a pass another tab holds", async () => {
    vi.useFakeTimers();

    try {
      const store = createMemoryStore();
      const transport = createFakeServer();
      const delivered: string[] = [];
      let lockAvailable = true;
      await store.stage(message("thr-a", "eventually"));

      const drainer = createSendOutboxDrainer({
        classify,
        onDelivered: (item) => delivered.push(item.receipt.submissionId),
        store,
        transport,
        withDrainLock: async (work) => (lockAvailable ? await work() : null),
      });

      transport.failNextSubmit = new RetryableFailure("offline");
      drainer.wake();
      await vi.advanceTimersByTimeAsync(0);
      const afterFirstPass = store.entries.length;
      await vi.advanceTimersByTimeAsync(1_000);
      const afterRetry = store.entries.length;

      await store.stage(message("thr-a", "held by other tab"));
      lockAvailable = false;
      drainer.wake();
      await vi.advanceTimersByTimeAsync(60_000);
      const whileOtherTabHolds = store.entries.length;

      lockAvailable = true;
      drainer.wake();
      await vi.advanceTimersByTimeAsync(0);
      drainer.dispose();

      expect({
        afterFirstPass,
        afterRetry,
        delivered: delivered.length,
        remaining: store.entries.length,
        whileOtherTabHolds,
      }).toEqual({
        afterFirstPass: 1,
        afterRetry: 0,
        delivered: 2,
        remaining: 0,
        whileOtherTabHolds: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
