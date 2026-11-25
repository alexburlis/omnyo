import { useCallback, useEffect, useMemo, useState } from "react";
import { useSdk } from "@omnyo/plugin-sdk/app";
import type { ProviderUsage } from "@omnyo/plugin-sdk/provider-bridge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { AccountListRow, SettingsBadge } from "./AccountListRow.js";

type ProfilesClient = ReturnType<
  typeof useSdk
>["providers"]["claudeProfiles"] & {
  usage?: (target: {
    hostId: string;
    profileId: string;
  }) => Promise<{ usage: ProviderUsage }>;
};

type ProfileList = Awaited<ReturnType<ProfilesClient["list"]>>;

type Profile = ProfileList["profiles"][number];

type Machine = Awaited<
  ReturnType<ReturnType<typeof useSdk>["hosts"]["list"]>
>[number];

const STATUS_LABELS: Record<Profile["status"], { label: string; dot: string }> =
  {
    ready: { label: "Ready", dot: "bg-success" },
    "sign-in-required": { label: "Sign in required", dot: "bg-warning" },
    "wrong-account": {
      label: "Different account signed in",
      dot: "bg-destructive",
    },
    unavailable: { label: "Unavailable", dot: "bg-muted-foreground" },
  };

function NativeClaudeAccountRow({
  profile,
  profiles,
  hostId,
  machineName,
  isDefault,
  pending,
  threshold,
  signIn,
  run,
}: {
  profile: Profile;
  profiles: ProfilesClient;
  hostId: string;
  machineName: string;
  isDefault: boolean;
  pending: boolean;
  threshold: number;
  signIn: () => Promise<void>;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const [usage, setUsage] = useState<ProviderUsage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const ready = profile.status === "ready";
  const usageAvailable = typeof profiles.usage === "function";
  const profileId = profile.id;

  const readUsage = useCallback(
    async () => (await profiles.usage?.({ hostId, profileId }))?.usage ?? null,
    [hostId, profileId, profiles],
  );

  useEffect(() => {
    setUsage(null);

    if (!ready || !usageAvailable) return;
    let current = true;
    void readUsage().then(
      (next) => {
        if (current) setUsage(next);
      },
      () => {
        if (current) setUsage(null);
      },
    );

    return () => {
      current = false;
    };
  }, [readUsage, ready, usageAvailable]);

  const account =
    ready && (usage?.status === "ok" || usage?.status === "error")
      ? usage
      : null;

  const email = account?.accountEmail ?? null;

  const slots =
    ready && usage?.status === "ok"
      ? usage.windows.map((window) => ({
          key: window.label,
          label: window.label,
          utilization: window.usedPercent / 100,
          status: null,
        }))
      : [];

  const atLimit = slots.some((slot) => slot.utilization >= 1);

  return (
    <AccountListRow
      name={email ?? profile.label}
      secondaryName={
        email !== null &&
        profile.label !== email &&
        profile.label !== "Existing Claude sign-in"
          ? profile.label
          : null
      }
      badges={
        <SettingsBadge>{account?.planLabel ?? "Subscription"}</SettingsBadge>
      }
      status={
        atLimit
          ? { label: "At subscription limit", dot: "bg-destructive" }
          : STATUS_LABELS[profile.status]
      }
      statusDetail={
        <>
          <span>{machineName}</span>
          {isDefault ? <span>Default for new chats</span> : null}
        </>
      }
      slots={slots}
      threshold={threshold}
      refreshing={refreshing}
      missingUsage={
        ready ? (
          <a
            href="https://claude.ai/settings/usage"
            target="_blank"
            rel="noreferrer"
            className="relative text-xs text-subtle-foreground hover:text-foreground hover:underline"
          >
            View usage in Claude
          </a>
        ) : null
      }
      actions={
        <>
          {ready ? (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() =>
                void run(async () => {
                  await profiles.defaultsSet({
                    hostId,
                    selection: isDefault
                      ? { kind: "unprofiled" }
                      : { kind: "profile", profileId },
                  });
                })
              }
            >
              <Icon name="CircleCheck" />
              {isDefault ? "Use ordinary sign-in by default" : "Make default"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={pending || profile.status === "unavailable"}
            onSelect={() => void run(signIn)}
          >
            <Icon name="UserRound" />
            Sign in again…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              void run(async () => {
                await profiles.status({ hostId, profileId });
              })
            }
          >
            <Icon name="RotateCcw" />
            Check sign-in status
          </DropdownMenuItem>
          {ready && usageAvailable ? (
            <DropdownMenuItem
              disabled={refreshing || pending}
              onSelect={() => {
                setRefreshing(true);
                void readUsage()
                  .then(setUsage, () => setUsage(null))
                  .finally(() => setRefreshing(false));
              }}
            >
              <Icon name="RotateCcw" />
              Refresh usage
            </DropdownMenuItem>
          ) : null}
        </>
      }
    />
  );
}

export type ClaudeSetup = "sign-in" | "adopt";

export function NativeClaudeProfiles({
  setup,
  onCloseSetup,
  showEmpty,
  threshold,
}: {
  setup: ClaudeSetup | null;
  onCloseSetup: () => void;
  showEmpty: boolean;
  threshold: number;
}) {
  const sdk = useSdk();
  const profiles = useMemo(() => sdk.providers.claudeProfiles, [sdk]);
  const [machine, setMachine] = useState<Machine | null>();
  const hostId = machine?.status === "connected" ? machine.id : "";
  const machineName = machine?.name ?? "the server machine";
  const [data, setData] = useState<ProfileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loginProfileId, setLoginProfileId] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (profiles === undefined) return;
    let current = true;
    void Promise.resolve()
      .then(() =>
        Promise.all([
          sdk.system.config(),
          sdk.hosts.list({ type: "persistent" }),
        ]),
      )
      .then(
        ([config, machines]) => {
          if (current)
            setMachine(
              machines.find((host) => host.id === config.primaryHostId) ?? null,
            );
        },
        () => {
          if (current)
            setError("Claude accounts are unavailable on this server.");
        },
      );

    return () => {
      current = false;
    };
  }, [profiles, sdk]);

  const refresh = useCallback(async () => {
    if (!hostId || profiles === undefined) return;
    const next = await profiles.list({ hostId });
    setData(next);
  }, [hostId, profiles]);

  useEffect(() => {
    setData(null);
    setLoginProfileId(null);
    setError(null);

    if (!hostId || profiles === undefined) return;
    let current = true;
    void Promise.resolve()
      .then(() => profiles.list({ hostId }))
      .then(
        (next) => {
          if (current) setData(next);
        },
        () => {
          if (current)
            setError("Claude accounts are unavailable on this machine.");
        },
      );

    return () => {
      current = false;
    };
  }, [hostId, profiles]);

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);

    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The Claude account could not be updated.",
      );
    } finally {
      await refresh().catch(() => {
        setError(
          (current) => current ?? "The Claude accounts could not be refreshed.",
        );
      });
      setPending(false);
    }
  };

  const signIn = async (profileId: string) => {
    const result = await profiles.loginStart({ hostId, profileId });
    setLoginProfileId(result.loginState === "running" ? profileId : null);

    if (result.loginState === "failed")
      throw new Error("Claude sign-in did not finish. Try signing in again.");
  };

  const supported = data?.supported === true;
  const hasProfiles = (data?.profiles.length ?? 0) > 0;
  const unavailable = data?.supported === false || profiles === undefined;

  function closeSetup() {
    setLabel("");
    setError(null);
    onCloseSetup();
  }

  return (
    <>
      {setup === null && error !== null ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : null}
      {showEmpty && !hasProfiles ? (
        <p className="py-2.5 text-sm text-subtle-foreground">
          No accounts yet.
        </p>
      ) : null}
      <div className="divide-y divide-border">
        {data?.profiles.map((profile) => (
          <NativeClaudeAccountRow
            key={profile.id}
            profile={profile}
            profiles={profiles}
            hostId={hostId}
            machineName={machineName}
            isDefault={
              data.defaultSelection.kind === "profile" &&
              data.defaultSelection.profileId === profile.id
            }
            pending={pending}
            threshold={threshold}
            signIn={() => signIn(profile.id)}
            run={run}
          />
        ))}
      </div>
      {loginProfileId === null ? null : (
        <div
          className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
          role="status"
        >
          <span>Finish sign-in in the browser on {machineName}.</span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                const result = await profiles.loginGet({
                  hostId,
                  profileId: loginProfileId,
                });

                if (result.loginState !== "running") setLoginProfileId(null);

                if (result.loginState === "failed")
                  throw new Error(
                    "Claude sign-in did not finish. Try signing in again.",
                  );
              })
            }
          >
            Check sign-in
          </Button>
        </div>
      )}
      <Dialog
        open={setup !== null}
        onOpenChange={(open) => {
          if (!open && !pending) closeSetup();
        }}
      >
        {setup === null ? null : (
          <DialogContent hideCloseButton>
            <DialogHeader>
              <DialogTitle>
                {setup === "adopt"
                  ? "Use existing Claude sign-in"
                  : "Sign in to Claude"}
              </DialogTitle>
              <DialogDescription>
                {setup === "adopt"
                  ? `Use the Claude Code account already signed in on ${machineName}.`
                  : `Sign-in opens in the browser on ${machineName}.`}
              </DialogDescription>
            </DialogHeader>
            {setup === "sign-in" ? (
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                aria-label="Claude account name"
                placeholder="Account name (optional)"
                maxLength={80}
                disabled={pending || !supported}
              />
            ) : null}
            {unavailable ? (
              <p className="text-sm text-muted-foreground">
                Claude account setup is unavailable on this machine.
              </p>
            ) : hostId === "" && machine !== undefined && error === null ? (
              <p className="text-sm text-muted-foreground">
                Connect {machineName} to set up a Claude account.
              </p>
            ) : null}
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive-text">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={pending} onClick={closeSetup}>
                Cancel
              </Button>
              <Button
                disabled={pending || !supported}
                onClick={() =>
                  void run(async () => {
                    if (setup === "adopt") {
                      await profiles.add({
                        hostId,
                        label: "Existing Claude sign-in",
                        adoptExisting: true,
                      });
                      closeSetup();
                    } else {
                      const { profile } = await profiles.add({
                        hostId,
                        label:
                          label.trim() ||
                          `Claude account ${(data?.profiles.length ?? 0) + 1}`,
                      });

                      closeSetup();
                      await signIn(profile.id);
                    }
                  })
                }
              >
                {setup === "adopt" ? "Use existing sign-in" : "Sign in"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
