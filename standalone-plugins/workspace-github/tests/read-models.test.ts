import { expect, it } from "vitest";
import { ReadModels } from "../read-models";

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {};

  const promise = new Promise<Value>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

it("reuses models across visits while sharing concurrent reads and exposing refresh failure", async () => {
  const models = new ReadModels<string>();
  const first = deferred<string>();
  let calls = 0;

  const load = () => {
    calls++;

    return first.promise;
  };

  const one = models.refresh("acme/one#1", load);
  const two = models.refresh("acme/one#1", load);
  await Promise.resolve();
  expect(calls).toBe(1);
  first.resolve("old details");
  await Promise.all([one, two]);
  expect(models.getSnapshot("acme/one#1").value).toBe("old details");

  const refresh = models.refresh("acme/one#1", async () => {
    throw new Error("Offline");
  });

  expect(models.getSnapshot("acme/one#1")).toMatchObject({
    value: "old details",
    refreshing: true,
  });
  await refresh;
  expect(models.getSnapshot("acme/one#1")).toEqual({
    value: "old details",
    error: "Offline",
    refreshing: false,
  });
  expect(models.getSnapshot("acme/two#1").value).toBeNull();
});

it("discards an in-flight pre-mutation model and coalesces invalidation into one fresh read", async () => {
  const models = new ReadModels<string>();
  const release = models.subscribe("pull", () => {});
  const first = deferred<string>();
  const second = deferred<string>();
  let calls = 0;
  const load = () => (++calls === 1 ? first.promise : second.promise);
  const pending = models.refresh("pull", load);
  await Promise.resolve();
  models.invalidate("pull");
  models.invalidate("pull");
  first.resolve("obsolete");
  await pending;
  await Promise.resolve();
  expect(models.getSnapshot("pull").value).toBeNull();
  expect(calls).toBe(2);
  second.resolve("after mutation");
  await models.refresh("pull", load);
  expect(models.getSnapshot("pull").value).toBe("after mutation");
  release();
});

it("evicts inactive payloads under count and byte budgets while retaining mounted models", async () => {
  const models = new ReadModels<string>(2, 20);
  const release = models.subscribe("shown", () => {});
  await models.refresh("shown", async () => "active content");
  await models.refresh("old", async () => "old details");
  await models.refresh("next", async () => "new details");
  expect(models.getSnapshot("shown").value).toBe("active content");
  expect(models.getSnapshot("old").value).toBeNull();
  release();
  expect(models.getSnapshot("shown").value).toBeNull();
  const failures = new ReadModels<string>(8, 20);
  await failures.refresh("offline", async () => {
    throw new Error("A long provider error exceeds the retained payload budget");
  });
  expect(failures.getSnapshot("offline").error).toBeNull();
});
