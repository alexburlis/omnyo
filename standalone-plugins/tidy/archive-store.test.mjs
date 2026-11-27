import assert from "node:assert/strict";
import { test } from "node:test";
import { createArchiveStore } from "./archive-store.ts";

function deferred() {
  let resolve = () => {};

  let reject = () => {};

  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

const hidden = (store) => [...store.getSnapshot().hidden].sort();

test("hides archived chats before the server answers and keeps them hidden until readiness drops them", async () => {
  const store = createArchiveStore();
  const server = deferred();
  const done = store.archive(["a", "b"], () => server.promise);

  assert.deepEqual(hidden(store), ["a", "b"]);
  server.resolve({ archived: 2, failures: [] });
  await done;
  assert.deepEqual(hidden(store), ["a", "b"]);
  assert.equal(store.getSnapshot().failure, null);

  store.release(["a", "b"]);
  assert.deepEqual(hidden(store), ["a", "b"]);
  store.release(["b"]);
  assert.deepEqual(hidden(store), ["b"]);
});

test("brings back only the chats the server refused, with its reason", async () => {
  const store = createArchiveStore();

  await store.archive(["a", "b"], async () => ({
    archived: 1,
    failures: [{ threadId: "b", message: "The chat is not offered for archiving." }],
  }));

  assert.deepEqual(hidden(store), ["a"]);
  assert.equal(
    store.getSnapshot().failure,
    "Could not archive that chat: The chat is not offered for archiving.",
  );
});

test("brings every chat back when the request fails", async () => {
  const store = createArchiveStore();

  await store.archive(["a", "b"], () => Promise.reject(new Error("offline")));

  assert.deepEqual(hidden(store), []);
  assert.equal(store.getSnapshot().failure, "Could not archive: offline");
});

test("does not retain a hidden chat when readiness drops it before the response", async () => {
  const store = createArchiveStore();
  const server = deferred();
  store.release(["a"]);
  const done = store.archive(["a"], () => server.promise);
  store.release([]);
  server.resolve({ failures: [] });
  await done;
  assert.deepEqual(hidden(store), []);
  store.release(["a"]);
  assert.deepEqual(hidden(store), []);
});
