import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { createSnapshotInvalidator } from "./snapshot-invalidation";

const key = ["snapshot-test"];

afterEach(() => vi.useRealTimers());

it("lets urgent membership replace an already waiting background refresh", async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  client.setQueryData(key, "primed");
  const invalidator = createSnapshotInvalidator(key);
  let complete!: (value: string) => void;

  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue("new membership");

  const stop = new QueryObserver(client, {
    queryKey: key,
    queryFn: read,
    staleTime: Infinity,
  }).subscribe(() => {});

  void client.refetchQueries({ queryKey: key });

  try {
    invalidator.invalidate(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    invalidator.invalidate(client, { supersedeActive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(key)).toBe("new membership");
    complete("stale");
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(key)).toBe("new membership");
  } finally {
    invalidator.dispose(client);
    stop();
    client.clear();
    complete("stale");
  }
});

it.each(["before timer", "during cancellation"] as const)(
  "disposes an urgent refresh %s without starting another read",
  async (when) => {
    vi.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(key, "primed");
    const invalidator = createSnapshotInvalidator(key);
    const read = vi.fn(() => new Promise<string>(() => {}));

    const stop = new QueryObserver(client, {
      queryKey: key,
      queryFn: read,
      staleTime: Infinity,
    }).subscribe(() => {});

    void client.refetchQueries({ queryKey: key });
    invalidator.invalidate(client, { supersedeActive: true });

    if (when === "during cancellation") vi.advanceTimersByTime(0);
    invalidator.dispose(client);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    client.clear();
  },
);

it("does not fetch inactive snapshots for urgent membership invalidations", async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  const read = vi.fn(async () => "unrequested");
  client.setQueryDefaults(key, { queryFn: read });
  client.setQueryData(key, "cached");
  const invalidator = createSnapshotInvalidator(key);
  invalidator.invalidate(client, { supersedeActive: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(read).not.toHaveBeenCalled();
  expect(client.getQueryData(key)).toBe("cached");
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  invalidator.dispose(client);
  client.clear();
});
