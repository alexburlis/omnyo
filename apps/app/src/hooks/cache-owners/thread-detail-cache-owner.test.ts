import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment, Host } from "@omnyo/domain";
import { makeEnvironment, makeHost } from "@omnyo/test-helpers/domain-fixtures";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { sdk } from "@/lib/sdk";
import { environmentQueryOptions } from "../queries/environment-queries";
import { hostsQueryOptions } from "../queries/host-queries";
import {
  environmentQueryKey,
  hostQueryKey,
  hostsQueryKey,
} from "../queries/query-keys";
import { ingestThreadDetailBootstrap } from "./thread-detail-cache-owner";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    environments: { get: vi.fn() },
    hosts: { list: vi.fn() },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

const provisioning = makeEnvironment({
  id: "env_1",
  status: "provisioning",
  updatedAt: 1,
});

const ready = makeEnvironment({ id: "env_1", status: "ready", updatedAt: 2 });

const reconnecting = makeHost({
  id: "host_1",
  status: "disconnected",
  updatedAt: 1,
});

const connected = makeHost({ id: "host_1", status: "connected", updatedAt: 2 });

function ingest(
  queryClient: QueryClient,
  includes: { environment?: Environment; host?: Host },
) {
  ingestThreadDetailBootstrap({
    queryClient,
    thread: { ...makeThreadResponse({ id: "thr_1" }), ...includes },
  });
}

afterEach(() => {
  vi.mocked(sdk.environments.get).mockReset();
  vi.mocked(sdk.hosts.list).mockReset();
});

describe("thread detail bootstrap ingestion", () => {
  it("keeps the bootstrap environment when an older environment fetch lands later", async () => {
    const queryClient = makeQueryClient();
    const staleFetch = deferred<Environment>();
    vi.mocked(sdk.environments.get).mockReturnValueOnce(staleFetch.promise);

    const observer = new QueryObserver(
      queryClient,
      environmentQueryOptions("env_1"),
    );

    const unsubscribe = observer.subscribe(() => {});

    try {
      ingest(queryClient, { environment: ready });
      staleFetch.resolve(provisioning);
      await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(queryClient.getQueryData(environmentQueryKey("env_1"))).toEqual(
        ready,
      );
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it("does not replace a newer cached environment with an older bootstrap", () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(environmentQueryKey("env_1"), ready);
    ingest(queryClient, { environment: provisioning });
    expect(queryClient.getQueryData(environmentQueryKey("env_1"))).toEqual(
      ready,
    );
  });

  it.each([false, true])(
    "cancels equal-timestamp host reads including creating=%s",
    async (includeCreating) => {
      const queryClient = makeQueryClient();
      const staleFetch = deferred<Host[]>();
      const stale = { ...connected, status: "disconnected" as const };
      queryClient.setQueryData(hostsQueryKey(includeCreating), [reconnecting]);
      vi.mocked(sdk.hosts.list)
        .mockReturnValueOnce(staleFetch.promise)
        .mockResolvedValueOnce([connected]);

      const observer = new QueryObserver(queryClient, {
        ...hostsQueryOptions(includeCreating),
        staleTime: 0,
      });

      const unsubscribe = observer.subscribe(() => {});

      try {
        ingest(queryClient, { host: connected });
        staleFetch.resolve([stale]);
        await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
        expect(sdk.hosts.list).toHaveBeenCalledTimes(2);
        expect(
          queryClient.getQueryData(hostsQueryKey(includeCreating)),
        ).toEqual([connected]);
      } finally {
        unsubscribe();
        queryClient.clear();
      }
    },
  );

  it("does not seed an incomplete cold host list", () => {
    const queryClient = makeQueryClient();
    ingest(queryClient, { host: connected });
    expect(queryClient.getQueryData(hostsQueryKey())).toBeUndefined();
    expect(queryClient.getQueryData(hostsQueryKey(true))).toBeUndefined();
    expect(queryClient.getQueryData(hostQueryKey(connected.id))).toEqual(
      connected,
    );
    queryClient.clear();
  });

  it("preserves the complete cold list after canceling its initial read", async () => {
    const queryClient = makeQueryClient();
    const other = makeHost({ id: "host_2" });
    const staleFetch = deferred<Host[]>();
    vi.mocked(sdk.hosts.list)
      .mockReturnValueOnce(staleFetch.promise)
      .mockResolvedValueOnce([connected, other]);
    const observer = new QueryObserver(queryClient, hostsQueryOptions());
    const unsubscribe = observer.subscribe(() => {});

    try {
      ingest(queryClient, { host: connected });
      expect(queryClient.getQueryData(hostsQueryKey())).toBeUndefined();
      staleFetch.resolve([reconnecting, other]);
      await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(queryClient.getQueryData(hostsQueryKey())).toEqual([
        connected,
        other,
      ]);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it("keeps newer environment data between resolution and final cache commit", async () => {
    const queryClient = makeQueryClient();
    const staleFetch = deferred<Environment>();
    vi.mocked(sdk.environments.get).mockReturnValueOnce(staleFetch.promise);
    const fetch = queryClient.fetchQuery(environmentQueryOptions("env_1"));
    staleFetch.resolve(provisioning);
    await Promise.resolve();
    ingest(queryClient, { environment: ready });
    await fetch;
    expect(queryClient.getQueryData(environmentQueryKey("env_1"))).toEqual(
      ready,
    );
    queryClient.clear();
  });

  it("keeps cached host status when the bootstrap carries the same revision", () => {
    const queryClient = makeQueryClient();
    const disconnected = { ...connected, status: "disconnected" as const };
    queryClient.setQueryData(hostQueryKey("host_1"), disconnected);
    queryClient.setQueryData(hostsQueryKey(), [disconnected]);
    ingest(queryClient, { host: connected });
    expect(queryClient.getQueryData(hostQueryKey("host_1"))).toEqual(
      disconnected,
    );
    expect(queryClient.getQueryData(hostsQueryKey())).toEqual([disconnected]);
  });

  it("replaces cached host and environment data with a newer bootstrap", () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(environmentQueryKey("env_1"), provisioning);
    queryClient.setQueryData(hostQueryKey("host_1"), reconnecting);
    queryClient.setQueryData(hostsQueryKey(), [reconnecting]);
    ingest(queryClient, { environment: ready, host: connected });
    expect(queryClient.getQueryData(environmentQueryKey("env_1"))).toEqual(
      ready,
    );
    expect(queryClient.getQueryData(hostQueryKey("host_1"))).toEqual(connected);
    expect(queryClient.getQueryData(hostsQueryKey())).toEqual([connected]);
  });
});
