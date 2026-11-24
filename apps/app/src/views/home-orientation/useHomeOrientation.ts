import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  INBOX_SIDEBAR_SCOPE,
  useSetSidebarScope,
} from "@/components/sidebar/sidebarScope";
import { useSidebar } from "@/components/ui/sidebar";
import { useInboxSnapshot } from "@/hooks/queries/use-inbox-snapshot";
import { sdk } from "@/lib/sdk";
import {
  EMPTY_HOME_INBOX_SUMMARY,
  homeInboxSummary,
  ownerFirstName,
  type HomeInboxSummary,
} from "./home-orientation";

const HOME_OWNER_QUERY_KEY = ["home-orientation", "owner"] as const;

const HOME_OWNER_STALE_MS = 60_000;

const HOUR_CHECK_INTERVAL_MS = 60_000;

const ACCOUNT_PLUGIN_ID = "omnyo-account";

const ACCOUNT_STATUS_METHOD = "omnyo-account.v1.status";

const accountStatusSchema = z.object({
  account: z
    .object({
      name: z.string(),
      githubLogin: z.string().nullable(),
      handle: z.string().nullable(),
    })
    .nullable(),
});

export interface HomeOrientationCounts extends HomeInboxSummary {
  running: number;
  isLoaded: boolean;
}

export function useHomeOrientationCounts(): HomeOrientationCounts {
  const { snapshot } = useInboxSnapshot();

  const summary = useMemo(
    () =>
      snapshot === null ? EMPTY_HOME_INBOX_SUMMARY : homeInboxSummary(snapshot),
    [snapshot],
  );

  const running =
    snapshot === null
      ? 0
      : [...snapshot.inbox, ...snapshot.running, ...snapshot.waiting].filter(
          (entry) => entry.state === "working",
        ).length;

  return { ...summary, running, isLoaded: snapshot !== null };
}

export function useHomeOwnerFirstName(): {
  firstName: string | null;
  isSettled: boolean;
} {
  const query = useQuery({
    queryKey: HOME_OWNER_QUERY_KEY,
    queryFn: ({ signal }) =>
      sdk.plugins.callRpc({
        pluginId: ACCOUNT_PLUGIN_ID,
        method: ACCOUNT_STATUS_METHOD,
        input: null,
        outputSchema: accountStatusSchema,
        signal,
      }),
    staleTime: HOME_OWNER_STALE_MS,
    retry: false,
  });

  const account = query.data?.account;

  return {
    firstName:
      account === undefined || account === null
        ? null
        : ownerFirstName(account),
    isSettled: !query.isPending,
  };
}

export function useCurrentHour(): number {
  const [hour, setHour] = useState(() => new Date().getHours());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setHour(new Date().getHours());
    }, HOUR_CHECK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, []);

  return hour;
}

export function useOpenInboxSidebar(): () => void {
  const setSidebarScope = useSetSidebarScope();
  const { setOpen } = useSidebar();

  return () => {
    setSidebarScope(INBOX_SIDEBAR_SCOPE);
    setOpen(true);
  };
}
