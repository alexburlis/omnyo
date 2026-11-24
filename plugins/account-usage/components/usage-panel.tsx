import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_useProviders,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import type { Snapshot, rpcContract } from "../contract.ts";
import { PANEL_POLL_MS, USAGE_CHANGED_CHANNEL } from "../contract.ts";
import { formatAgo } from "../lib/format.ts";
import { FooterUsage } from "./usage-footer.tsx";
import { ProviderGauges } from "./usage-rail.tsx";
import { invalidateResetCredits } from "./reset-credits-cache.ts";
import { useAccountSignIn } from "./account-repair.tsx";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);

    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

export type UsagePanelLayout = "rail" | "footer";

type UsageReadFailure = { message: string; retryAttempt: number };

type UsageRequest = { id: number; promise: Promise<void> };

const READ_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export function UsagePanel({
  layout,
}: {
  layout: UsagePanelLayout;
}): React.ReactElement | null {
  const rpc = useRpc<typeof rpcContract>();
  const { providers } = experimental_useProviders();
  const now = useNow(30_000);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failure, setFailure] = useState<UsageReadFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resetCreditsRevision, setResetCreditsRevision] = useState(0);
  const mounted = useRef(true);
  const requestId = useRef(0);

  const inFlight = useRef<{
    snapshot: UsageRequest | null;
    refresh: UsageRequest | null;
  }>({ snapshot: null, refresh: null });

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      requestId.current += 1;
      inFlight.current = { snapshot: null, refresh: null };
    };
  }, []);

  const updateSnapshot = useCallback((next: Snapshot): string | null => {
    if (next.error === null) {
      setSnapshot(next);

      return null;
    }

    setSnapshot((current) =>
      next.groups.length > 0 &&
      (current === null || next.fetchedAt >= current.fetchedAt)
        ? next
        : current,
    );

    return `Could not read the account pool: ${next.error}`;
  }, []);

  const request = useCallback(
    (method: "snapshot" | "refresh", retryAttempt = 0): Promise<void> => {
      const running =
        inFlight.current.refresh ??
        (method === "snapshot" &&
        inFlight.current.snapshot?.id === requestId.current
          ? inFlight.current.snapshot
          : null);

      if (running !== null) return running.promise;

      const id = ++requestId.current;

      if (method === "refresh") {
        setRefreshing(true);
        invalidateResetCredits();
        setResetCreditsRevision((revision) => revision + 1);
      }

      const promise = Promise.resolve().then(async () => {
        try {
          if (!mounted.current || requestId.current !== id) return;
          const next = await rpc.call(method);

          if (!mounted.current || requestId.current !== id) return;
          const message = updateSnapshot(next);
          setFailure(message === null ? null : { message, retryAttempt });
        } catch (error) {
          if (!mounted.current || requestId.current !== id) return;
          setFailure({
            message: error instanceof Error ? error.message : String(error),
            retryAttempt,
          });
        } finally {
          if (inFlight.current[method]?.id === id)
            inFlight.current[method] = null;

          if (method === "refresh" && mounted.current) setRefreshing(false);
        }
      });

      inFlight.current[method] = { id, promise };

      return promise;
    },
    [rpc, updateSnapshot],
  );

  const load = useCallback(
    (retryAttempt = 0) => request("snapshot", retryAttempt),
    [request],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => void load(), PANEL_POLL_MS);

    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (failure === null) return;
    const delay = READ_RETRY_DELAYS_MS[failure.retryAttempt];

    if (delay === undefined) return;

    const timer = setTimeout(() => {
      void load(failure.retryAttempt + 1);
    }, delay);

    return () => clearTimeout(timer);
  }, [failure, load]);

  useRealtime(USAGE_CHANGED_CHANNEL, () => {
    void load();
  });
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection === "connected" && !wasConnected.current) void load();
    wasConnected.current = connection === "connected";
  }, [connection, load]);

  const refresh = useCallback(() => request("refresh"), [request]);
  const signIn = useAccountSignIn(load);

  const providerFor = useCallback(
    (providerId: string) =>
      providers.find((provider) => provider.id === providerId) ?? {
        id: providerId,
      },
    [providers],
  );

  if (
    snapshot !== null &&
    (snapshot.poolUnavailable || snapshot.groups.length === 0)
  )
    return null;

  const stripAccounts =
    snapshot?.groups.reduce((sum, group) => sum + group.weeklyBars.length, 0) ??
    0;

  const status =
    connection !== "connected"
      ? "Offline"
      : failure !== null || snapshot?.error != null
        ? stripAccounts > 0
          ? "Stale"
          : "Unavailable"
        : snapshot === null
          ? "Loading"
          : stripAccounts === 0
            ? "Disabled"
            : null;

  if (layout === "footer") {
    return (
      <FooterUsage
        snapshot={snapshot}
        status={status}
        failure={failure?.message ?? null}
        now={now}
        providerFor={providerFor}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        onUsageChanged={load}
        resetCreditsRevision={resetCreditsRevision}
        signIn={signIn}
      />
    );
  }

  return (
    <section
      aria-label="Account usage"
      className="flex w-full min-w-0 flex-col gap-2.5 pt-1"
    >
      {status !== null ? (
        <span
          role="status"
          aria-label={status}
          title={
            failure?.message ??
            (snapshot === null
              ? undefined
              : `Last reading ${formatAgo(snapshot.fetchedAt, now) ?? "just now"}`)
          }
          className="text-center text-2xs leading-tight whitespace-nowrap text-subtle-foreground"
        >
          {status === "Unavailable" ? "No data" : status}
        </span>
      ) : null}
      {snapshot?.groups.map((group) => (
        <ProviderGauges
          key={group.providerId}
          group={group}
          now={now}
          provider={providerFor(group.providerId)}
        />
      ))}
    </section>
  );
}
