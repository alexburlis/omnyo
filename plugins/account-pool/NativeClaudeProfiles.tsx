import { useCallback, useEffect, useMemo, useState } from "react";
import { useSdk } from "@omnyo/plugin-sdk/app";
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

type ProfilesClient = ReturnType<typeof useSdk>["providers"]["claudeProfiles"];

type ProfileList = Awaited<ReturnType<ProfilesClient["list"]>>;

type Profile = ProfileList["profiles"][number];

type Machine = Awaited<
  ReturnType<ReturnType<typeof useSdk>["hosts"]["list"]>
>[number];

const STATUS_LABELS: Record<Profile["status"], string> = {
  ready: "Ready",
  "sign-in-required": "Sign in required",
  "wrong-account": "Different account signed in",
  unavailable: "Unavailable",
};

export type ClaudeSetup = "sign-in" | "adopt";

export function NativeClaudeProfiles({
  setup,
  onCloseSetup,
  showEmpty,
}: {
  setup: ClaudeSetup | null;
  onCloseSetup: () => void;
  showEmpty: boolean;
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
      {data?.profiles.map((profile) => (
        <div
          key={profile.id}
          className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {profile.label}
            </p>
            <p className="text-xs text-muted-foreground">
              {machineName} · {STATUS_LABELS[profile.status]}
              {data.defaultSelection.kind === "profile" &&
              data.defaultSelection.profileId === profile.id
                ? " · Default for new chats"
                : ""}
            </p>
          </div>
          <div className="flex gap-2">
            {profile.status === "ready" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={
                  pending ||
                  (data.defaultSelection.kind === "profile" &&
                    data.defaultSelection.profileId === profile.id)
                }
                onClick={() =>
                  void run(async () => {
                    await profiles.defaultsSet({
                      hostId,
                      selection: { kind: "profile", profileId: profile.id },
                    });
                  })
                }
              >
                Make default
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={
                  pending || !supported || profile.status === "unavailable"
                }
                onClick={() => void run(() => signIn(profile.id))}
              >
                Sign in again
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || !supported}
              onClick={() =>
                void run(async () => {
                  await profiles.status({ hostId, profileId: profile.id });
                })
              }
            >
              Check status
            </Button>
          </div>
        </div>
      ))}
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
      {data?.defaultSelection.kind !== "profile" ? null : (
        <div className="border-b border-border py-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                await profiles.defaultsSet({
                  hostId,
                  selection: { kind: "unprofiled" },
                });
              })
            }
          >
            Use ordinary Claude sign-in by default
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
