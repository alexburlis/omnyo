import type { QueryClient } from "@tanstack/react-query";
import type { Environment, Host } from "@omnyo/domain";
import type {
  ThreadResponse,
  ThreadWithIncludesResponse,
} from "@omnyo/server-contract";
import {
  environmentQueryKey,
  hostQueryKey,
  hostsQueryKey,
  threadQueryKey,
} from "../queries/query-keys";

import { setQueryDataOverInFlightFetch } from "./cache-effect-utils";

function cachedUnlessBootstrapIsNewer<T extends { updatedAt: number }>(
  cached: T | undefined,
  incoming: T,
): T {
  return cached !== undefined && cached.updatedAt >= incoming.updatedAt
    ? cached
    : incoming;
}

type HostList = Host[];

type HostListQueryData = HostList | undefined;

interface UpsertHostListArgs {
  host: Host;
  hosts: HostListQueryData;
}

interface ThreadDetailBootstrapIngestionArgs {
  queryClient: QueryClient;
  thread: ThreadWithIncludesResponse;
}

function stripThreadIncludes(
  thread: ThreadWithIncludesResponse,
): ThreadResponse {
  const { environment, host, ...threadResponse } = thread;

  return threadResponse;
}

function upsertHostList({
  host,
  hosts,
}: UpsertHostListArgs): HostListQueryData {
  if (!hosts) {
    return undefined;
  }

  let found = false;

  const nextHosts = hosts.map((candidate) => {
    if (candidate.id !== host.id) {
      return candidate;
    }

    found = true;

    return cachedUnlessBootstrapIsNewer(candidate, host);
  });

  return found ? nextHosts : [...hosts, host];
}

export function ingestThreadDetailBootstrap({
  queryClient,
  thread,
}: ThreadDetailBootstrapIngestionArgs): void {
  queryClient.setQueryData(
    threadQueryKey(thread.id),
    stripThreadIncludes(thread),
  );

  if (thread.environment) {
    const environment = thread.environment;
    queryClient.setQueryData<Environment>(
      environmentQueryKey(environment.id),
      (cached) => cachedUnlessBootstrapIsNewer(cached, environment),
    );
  }

  if (thread.host) {
    const host = thread.host;
    queryClient.setQueryData<Host>(hostQueryKey(host.id), (cached) =>
      cachedUnlessBootstrapIsNewer(cached, host),
    );

    for (const includeCreating of [false, true]) {
      setQueryDataOverInFlightFetch<HostList>(
        queryClient,
        hostsQueryKey(includeCreating),
        (hosts) => upsertHostList({ host, hosts }),
      );
    }
  }
}
