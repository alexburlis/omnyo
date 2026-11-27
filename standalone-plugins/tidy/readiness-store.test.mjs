import assert from "node:assert/strict";
import { test } from "node:test";
import {
  broadcastReadiness,
  createReadinessStore,
  canShowReadiness,
  READINESS_ENDED_EVENT,
  READINESS_EVENT,
  READINESS_REQUEST_EVENT,
} from "./readiness-store.ts";

test("other plugins hear every readiness change and can request the current snapshot", async () => {
  const store = createReadinessStore();
  const target = new EventTarget();
  const heard = [];
  let ended = 0;
  target.addEventListener(READINESS_EVENT, (event) => heard.push(event.detail));
  target.addEventListener(READINESS_ENDED_EVENT, () => (ended += 1));
  const stop = broadcastReadiness(store, target);

  target.dispatchEvent(new Event(READINESS_REQUEST_EVENT));
  assert.deepEqual(heard, []);
  await store.refresh(async () => ({ threadIds: ["thread-a"], waiting: [], revision: 4 }));
  store.accept({ threadIds: [], waiting: [], revision: 5 });
  target.dispatchEvent(new Event(READINESS_REQUEST_EVENT));
  assert.deepEqual(heard, [
    { revision: 4, stale: false, threadIds: ["thread-a"], waiting: [] },
    { revision: 5, stale: false, threadIds: [], waiting: [] },
    { revision: 5, stale: false, threadIds: [], waiting: [] },
  ]);
  assert.equal(ended, 0);
  stop();
  assert.equal(ended, 1);
  store.accept({ threadIds: ["thread-b"], waiting: [], revision: 6 });
  target.dispatchEvent(new Event(READINESS_REQUEST_EVENT));
  assert.equal(heard.length, 3);
});

test("the broadcast carries what unfinished chats are waiting on", async () => {
  const store = createReadinessStore();
  const target = new EventTarget();
  const heard = [];
  target.addEventListener(READINESS_EVENT, (event) => heard.push(event.detail));
  const stop = broadcastReadiness(store, target);

  await store.refresh(async () => ({
    threadIds: ["done"],
    waiting: [{ threadId: "review", on: "App Store review" }],
    revision: 1,
  }));
  store.accept({ threadIds: ["done"], waiting: [], revision: 2 });
  assert.deepEqual(heard, [
    {
      revision: 1,
      stale: false,
      threadIds: ["done"],
      waiting: [{ threadId: "review", on: "App Store review" }],
    },
    { revision: 2, stale: false, threadIds: ["done"], waiting: [] },
  ]);
  stop();
});

test("late readiness responses cannot restore a claim after a newer withdrawal", async () => {
  const store = createReadinessStore();
  let old;

  const first = store.refresh(
    () =>
      new Promise((resolve) => {
        old = resolve;
      }),
  );

  await store.refresh(async () => ({ threadIds: [], waiting: [], revision: 2 }), 2);
  old({ threadIds: ["thread-test"], waiting: [], revision: 1 });
  await first;
  assert.deepEqual(store.getSnapshot(), {
    threadIds: [],
    waiting: [],
    revision: 2,
    refreshFailed: false,
  });
  await store.refresh(async () => ({ threadIds: ["thread-test"], waiting: [], revision: 1 }));
  assert.deepEqual(store.getSnapshot().threadIds, []);
  await store.refresh(async () => ({ threadIds: ["thread-test"], waiting: [], revision: 3 }));
  assert.deepEqual(store.getSnapshot().threadIds, ["thread-test"]);
});

test("the row guard consumes the shared recommendation instead of classifying runtime fields", () => {
  const thread = {
    status: "active",
    runtimeStatus: "active",
    queuedWork: "waiting",
    hasPendingInteraction: true,
    activity: { workflows: 1 },
    experimental_work: { archive: { recommended: true } },
  };

  assert.equal(canShowReadiness(thread), true);
  assert.equal(
    canShowReadiness({ ...thread, experimental_work: { archive: { recommended: false } } }),
    false,
  );
  assert.equal(canShowReadiness({ ...thread, experimental_work: null }), false);
  assert.equal(canShowReadiness(undefined), true);
});

test("a withdrawal signal immediately updates every subscriber and supersedes an in-flight read", async () => {
  const store = createReadinessStore();
  store.accept({ threadIds: ["thread-test"], waiting: [], revision: 1 });
  let release;

  const reading = store.refresh(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );

  let updates = 0;

  const stop = store.subscribe(() => {
    ++updates;
  });

  store.accept({ threadIds: [], waiting: [], revision: 2 });
  assert.deepEqual(store.getSnapshot().threadIds, []);
  assert.equal(updates, 1);
  release({ threadIds: ["thread-test"], waiting: [], revision: 1 });
  await reading;
  assert.deepEqual(store.getSnapshot().threadIds, []);
  stop();
});

test("a stale server snapshot keeps its list and reports the failed refresh", async () => {
  const store = createReadinessStore();
  await store.refresh(async () => ({ threadIds: ["thread-a"], waiting: [], revision: 1 }));
  assert.equal(store.getSnapshot().refreshFailed, false);
  store.accept({ threadIds: ["thread-a"], waiting: [], revision: 2, stale: true });
  assert.deepEqual(store.getSnapshot().threadIds, ["thread-a"]);
  assert.equal(store.getSnapshot().refreshFailed, true);
  await store.refresh(async () => ({
    threadIds: ["thread-a"],
    waiting: [],
    revision: 3,
    stale: false,
  }));
  assert.equal(store.getSnapshot().refreshFailed, false);
});

test("a failed refresh broadcasts stale readiness instead of endorsing the retained IDs", async () => {
  const store = createReadinessStore();
  const target = new EventTarget();
  const heard = [];
  target.addEventListener(READINESS_EVENT, (event) => heard.push(event.detail));
  const stop = broadcastReadiness(store, target);

  store.accept({ threadIds: ["done"], waiting: [], revision: 4 });
  await store.refresh(async () => {
    throw new Error("work summary unavailable");
  });
  assert.equal(heard.at(-1).stale, true);
  assert.deepEqual(heard.at(-1).threadIds, ["done"]);
  stop();
});
