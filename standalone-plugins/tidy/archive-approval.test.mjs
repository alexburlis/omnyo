import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalReceiptTitle, approvalTitle, legacyProposalText } from "./archive-approval.ts";
import { PROPOSAL_LIFETIME_MS, createArchiveProposals, proposalKey } from "./archive-proposals.ts";

const DAY = 24 * 60 * 60 * 1000;

function memoryKv() {
  const rows = new Map();

  return {
    rows,
    get: async (key) => rows.get(key),
    set: async (key, value) => {
      rows.set(key, structuredClone(value));
    },
    delete: async (key) => {
      rows.delete(key);
    },
    list: async (prefix = "") => [...rows.keys()].filter((key) => key.startsWith(prefix)),
  };
}

function scriptedUi() {
  const requests = [];

  return {
    requests,
    requestInput: (request, options) =>
      new Promise((resolve, reject) => {
        const entry = { request, resolve, reject };
        requests.push(entry);
        options?.signal?.addEventListener("abort", () =>
          resolve({ outcome: "cancelled", reason: "request-aborted" }),
        );
      }),
  };
}

const log = { warn: () => {} };

async function settle() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const chats = [
  { threadId: "first", title: "First" },
  { threadId: "second", title: "Second" },
];

test("labels credit only what this approval archived", () => {
  assert.equal(approvalTitle(1), "Archive 1 ready chat");
  assert.equal(approvalTitle(2), "Archive 2 ready chats");
  assert.equal(approvalReceiptTitle({ archived: 2, failures: [] }), "Archived 2 chats");
  assert.equal(approvalReceiptTitle({ archived: 1, failures: [] }), "Archived 1 chat");
  assert.equal(
    approvalReceiptTitle({ archived: 1, failures: [{ threadId: "x", message: "changed" }] }),
    "Archived 1 of 2 chats",
  );
  assert.equal(approvalReceiptTitle({ archived: 0, failures: [] }), "Already archived");
  assert.equal(
    approvalReceiptTitle({ archived: 0, failures: [{ threadId: "x", message: "changed" }] }),
    "No chats archived",
  );
  assert.equal(legacyProposalText(2), "Archive proposal for 2 chats");
});

test("a thread stop re-pins the approval with the time it has left", async () => {
  const ui = scriptedUi();
  const kv = memoryKv();
  let clock = 1_000;
  const proposals = createArchiveProposals(ui, kv, log, () => clock);

  assert.equal(await proposals.propose("source", chats), "pinned");
  assert.equal(ui.requests[0].request.timeoutMs, PROPOSAL_LIFETIME_MS);
  clock += DAY;
  ui.requests[0].resolve({ outcome: "cancelled", reason: "thread-stopped" });
  await settle();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.requests[1].request.timeoutMs, PROPOSAL_LIFETIME_MS - DAY);
  assert.equal(kv.rows.size, 1);
});

test("an interrupted approval older than seven days is dropped, not re-pinned", async () => {
  const kv = memoryKv();
  let clock = 1_000;
  const before = createArchiveProposals(scriptedUi(), kv, log, () => clock);
  await before.propose("source", chats);
  before.dispose();

  clock += PROPOSAL_LIFETIME_MS;
  const ui = scriptedUi();
  const after = createArchiveProposals(ui, kv, log, () => clock);
  await after.reconcile(new Set(["first", "second"]));
  await settle();
  assert.equal(ui.requests.length, 0);
  assert.equal(kv.rows.size, 0);
});

test("a new proposal from the same chat replaces the open one", async () => {
  const ui = scriptedUi();
  const kv = memoryKv();
  const proposals = createArchiveProposals(ui, kv, log);

  await proposals.propose("source", chats);
  await proposals.propose("source", chats.slice(0, 1));
  await settle();
  assert.equal(ui.requests.length, 2);
  assert.deepEqual(await ui.requests[0].request.payload, { threadIds: ["first", "second"] });
  assert.deepEqual(
    [...kv.rows.values()].map(({ chats: listed }) => listed.length),
    [1],
  );
});

test("a failed pin waits for the next restart instead of retrying on every change", async () => {
  const ui = scriptedUi();
  const kv = memoryKv();
  const proposals = createArchiveProposals(ui, kv, log);

  await proposals.propose("source", chats);
  ui.requests[0].reject(new Error("coordinator unavailable"));
  await settle();
  await proposals.reconcile(new Set(["first"]));
  await settle();
  assert.equal(ui.requests.length, 1);
  assert.equal(kv.rows.size, 1);
});

test("a refresh running beside a proposal pins its approval once", async () => {
  const ui = scriptedUi();
  const kv = memoryKv();
  const gates = { delete: null, set: null };

  const gated = {
    ...kv,
    delete: async (key) => {
      if (gates.delete) await gates.delete.promise;
      await kv.delete(key);
    },
    set: async (key, value) => {
      if (gates.set) await gates.set.promise;
      await kv.set(key, value);
    },
  };

  await kv.set(proposalKey("earlier", ["first"]), {
    sourceThreadId: "earlier",
    chats: [{ threadId: "first", title: "First" }],
    createdAt: 1_000,
  });

  const proposals = createArchiveProposals(ui, gated, log, () => 2_000);
  gates.delete = Promise.withResolvers();
  gates.set = Promise.withResolvers();

  const refresh = proposals.reconcile(new Set(["second"]));
  await settle();
  const proposal = proposals.propose("source", [{ threadId: "second", title: "Second" }]);
  await settle();
  gates.delete.resolve();
  await settle();
  gates.set.resolve();
  assert.equal(await proposal, "pinned");
  await refresh;
  await settle();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].request.threadId, "source");
});
