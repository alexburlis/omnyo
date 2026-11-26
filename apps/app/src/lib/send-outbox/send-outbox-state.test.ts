import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import type { OutboxEntry } from "./send-outbox-entry";
import type { DeliveredOutboxEntry } from "./send-outbox-drain";
import type { SendOutboxStore } from "./send-outbox-store";

const state = vi.hoisted(() => {
  const entries: OutboxEntry[] = [];
  const listeners = new Set<() => void>();

  const announce = () => {
    for (const listener of listeners) listener();
  };

  const store: SendOutboxStore = {
    async stage(entry) {
      const staged: OutboxEntry = {
        ...entry,
        schema: 1,
        sequence: entries.length + 1,
        state: { kind: "waiting" },
      };

      entries.push(staged);
      announce();

      return staged;
    },
    async list() {
      return [...entries];
    },
    async count() {
      return entries.length;
    },
    async recordUpload() {},
    async setState(id, next) {
      const entry = entries.find((item) => item.submissionId === id);

      if (entry) entry.state = next;
      announce();
    },
    async reset(id) {
      await store.setState(id, { kind: "waiting" });
    },
    async discard(id) {
      const index = entries.findIndex((entry) => entry.submissionId === id);

      if (index >= 0) entries.splice(index, 1);
      announce();
    },
    async settle({ submissionId }) {
      await store.discard(submissionId);
    },
    async readAlias() {
      return null;
    },
    async readKnownStoreId() {
      return "store";
    },
    async rememberStoreId() {},
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };

  let onDelivered: ((delivery: DeliveredOutboxEntry) => void) | null = null;

  return {
    entries,
    listeners,
    store,
    connection: "connected",
    get onDelivered() {
      return onDelivered;
    },
    set onDelivered(callback) {
      onDelivered = callback;
    },
  };
});

vi.mock("../ws", () => ({
  wsManager: {
    getConnectionState: () => state.connection,
    onConnected: () => () => undefined,
    onResumed: () => () => undefined,
  },
}));

vi.mock("./send-outbox-store", () => ({
  createIndexedDbSendOutboxStore: () => state.store,
}));

vi.mock("./send-outbox-failure", () => ({
  classifyOutboxFailure: () => ({ kind: "retry" }),
  sdkSendOutboxTransport: { readStoreId: async () => "store" },
}));

vi.mock("./send-outbox-drain", () => ({
  createSendOutboxDrainer: (deps: {
    onDelivered: (delivery: DeliveredOutboxEntry) => void;
  }) => {
    state.onDelivered = deps.onDelivered;

    return { wake() {}, dispose() {} };
  },
}));

const clients: QueryClient[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", {});
  state.entries.splice(0);
  state.listeners.clear();
  state.connection = "connected";
  state.onDelivered = null;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

function fixture() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });

  clients.push(queryClient);

  const idle = makeThreadListEntry({
    id: "thr_saved",
    projectId: "proj_saved",
    status: "idle",
    runtime: { displayStatus: "idle" },
  });

  queryClient.setQueryData(
    sidebarNavigationQueryKey(),
    makeSidebarBootstrapResponse({
      projects: [
        makeProjectWithThreadsResponse({ id: idle.projectId, threads: [idle] }),
      ],
    }),
  );

  const sidebar = () =>
    queryClient.getQueryData<SidebarBootstrapResponse>(
      sidebarNavigationQueryKey(),
    )?.projects[0]?.threads[0];

  const args = {
    queryClient,
    threadId: idle.id,
    projectId: idle.projectId,
    execution: null,
    sourceOf: () => null,
    showsInChat: true,
    submission: {
      input: [{ type: "text" as const, text: "Send", mentions: [] }],
      prepareInput: undefined,
      getDraft: () => ({ text: "Send", mentions: [], attachments: [] }),
    },
  };

  return { queryClient, sidebar, args };
}

it("keeps staged input pending until a real delivery receipt", async () => {
  const outbox = await import("./send-outbox");
  const { stageTimelineFollowUp } = await import("./stage-timeline-follow-up");
  const { queryClient, sidebar, args } = fixture();
  await outbox.startSendOutbox(queryClient);
  expect(await stageTimelineFollowUp(args)).toBe(true);
  expect(sidebar()).toMatchObject({
    status: "idle",
    queuedWork: "waiting",
    work: {
      primary: { label: "waiting", reason: { text: "Sending message" } },
    },
  });
  expect(state.entries).toHaveLength(1);
  const entry = state.entries[0]!;
  const delivered = state.onDelivered;

  if (delivered === null) throw new Error("No delivery callback");
  delivered({
    entry,
    receipt: {
      version: 1,
      submissionId: entry.submissionId,
      storeId: "store",
      action: "thread-message",
      threadId: "thr_saved",
      queuedMessageId: "qtm_accepted",
      acceptedAt: 100,
      replayed: false,
    },
  });
  expect(
    queryClient.getQueryState(sidebarNavigationQueryKey())?.isInvalidated,
  ).toBe(true);
  await state.store.discard(entry.submissionId);
});

it("restores offline outbox state and clears a discard from another tab without a server event", async () => {
  state.connection = "reconnecting";
  await state.store.stage({
    submissionId: "sub_00000000000000000000000000000001",
    storeId: "store",
    createdAt: 1,
    attachments: [],
    action: {
      kind: "thread-message",
      projectId: "proj_saved",
      target: { threadId: "thr_saved" },
      message: {
        input: [{ type: "text", text: "Saved offline", mentions: [] }],
      },
    },
  });
  const outbox = await import("./send-outbox");
  const { queryClient, sidebar } = fixture();
  await outbox.startSendOutbox(queryClient);
  expect(sidebar()).toMatchObject({
    status: "idle",
    queuedWork: "waiting",
    work: {
      primary: {
        label: "waiting",
        reason: { text: "Waiting for a connection to send your message." },
      },
    },
  });
  await state.store.discard(state.entries[0]!.submissionId);
  await vi.waitFor(() => expect(sidebar()?.queuedWork).toBe("none"));
  expect(sidebar()?.work?.waits ?? []).toEqual([]);
});

it("clears a failed durable entry while preserving another pending send", async () => {
  const outbox = await import("./send-outbox");
  const { stageTimelineFollowUp } = await import("./stage-timeline-follow-up");
  const { queryClient, sidebar, args } = fixture();
  await outbox.startSendOutbox(queryClient);
  expect(await stageTimelineFollowUp(args)).toBe(true);
  expect(await stageTimelineFollowUp(args)).toBe(true);

  const first = state.entries[0]!,
    second = state.entries[1]!;

  await state.store.setState(first.submissionId, {
    kind: "paused",
    code: "denied",
    message: "Denied",
  });
  await vi.waitFor(() =>
    expect(sidebar()?.work?.waits.map((wait) => wait.id)).toEqual([
      `outbox:${second.submissionId}`,
    ]),
  );
  await outbox.discardOutboxEntry(second.submissionId);
  expect(sidebar()?.queuedWork).toBe("none");
  expect(sidebar()?.work?.waits ?? []).toEqual([]);
});
