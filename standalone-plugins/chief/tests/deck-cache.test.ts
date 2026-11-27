import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoadCache } from "../components/deck-cache.ts";

interface Pending {
  resolve: (value: number) => void;
  reject: (error: Error) => void;
}

function controlled() {
  const pending: Pending[] = [];

  const load = () =>
    new Promise<number>((resolve, reject) => {
      pending.push({ resolve, reject });
    });

  return { pending, load };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("refreshes that arrive mid-load never throw away the finished result", async () => {
  let clock = 1_000;
  const cache = createLoadCache<number>(() => clock);
  const { pending, load } = controlled();

  cache.refresh(load);
  cache.refresh(load);
  cache.refresh(load);
  assert.equal(pending.length, 1, "one request at a time");

  clock = 2_000;
  pending[0]?.resolve(1);
  await settle();
  assert.deepEqual(cache.get(), { value: 1, error: null, loadedAt: 2_000, loading: true });
  assert.equal(pending.length, 2, "the refreshes collapse into one rerun");

  clock = 3_000;
  pending[1]?.resolve(2);
  await settle();
  assert.deepEqual(cache.get(), { value: 2, error: null, loadedAt: 3_000, loading: false });
  assert.equal(pending.length, 2);
});

test("a failed refresh keeps the last value and reports the error", async () => {
  const cache = createLoadCache<number>(() => 5);
  const { pending, load } = controlled();

  cache.refresh(load);
  pending[0]?.resolve(7);
  await settle();
  cache.refresh(load);
  pending[1]?.reject(new Error("offline"));
  await settle();
  assert.deepEqual(cache.get(), { value: 7, error: "offline", loadedAt: 5, loading: false });
});

test("changes refresh at most once per background window while nobody watches", async () => {
  let clock = 0;
  const cache = createLoadCache<number>(() => clock, 40);
  const { pending, load } = controlled();

  cache.changed(load);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pending.length, 1, "the first change loads right away");
  pending[0]?.resolve(1);
  await settle();

  cache.changed(load);
  cache.changed(load);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pending.length, 1, "later changes wait for the window");
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(pending.length, 2, "then load once");
  pending[1]?.resolve(2);
  await settle();
  assert.equal(cache.get().value, 2);
});

test("a watched cache leaves change handling to the page that watches it", async () => {
  const cache = createLoadCache<number>(() => 0, 0);
  const { pending, load } = controlled();
  const unwatch = cache.watch();

  cache.changed(load);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pending.length, 0);

  unwatch();
  cache.changed(load);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pending.length, 1);
});
