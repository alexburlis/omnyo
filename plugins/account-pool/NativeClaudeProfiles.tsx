import { useCallback, useEffect, useMemo, useState } from "react";
import { useSdk } from "@omnyo/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ProfilesClient = ReturnType<typeof useSdk>["providers"]["claudeProfiles"];

type ProfileList = Awaited<ReturnType<ProfilesClient["list"]>>;

type Profile = ProfileList["profiles"][number];

type Machines = Awaited<ReturnType<ReturnType<typeof useSdk>["hosts"]["list"]>>;

const STATUS_LABELS: Record<Profile["status"], string> = {
  ready: "Ready",
  "sign-in-required": "Sign in required",
  "wrong-account": "Different account signed in",
  unavailable: "Unavailable",
};

export function NativeClaudeProfiles() {
  const sdk = useSdk();
  const profiles = useMemo(() => sdk.providers.claudeProfiles, [sdk]);
  const [machines, setMachines] = useState<Machines>([]);
  const [hostId, setHostId] = useState("");
  const [data, setData] = useState<ProfileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loginProfileId, setLoginProfileId] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (profiles === undefined) return;
    let current = true;
    void Promise.resolve()
      .then(() => sdk.hosts.list({ type: "persistent" }))
      .then(
        (next) => {
          if (!current) return;
          setMachines(next);
          setHostId(
            next.find((machine) => machine.status === "connected")?.id ?? "",
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
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The Claude account could not be updated.",
      );
    } finally {
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

  return (
    <section className="space-y-3" aria-label="Native Claude accounts">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Claude accounts
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Sign in to Claude Code and choose the account for new chats.
          </p>
        </div>
        <Select value={hostId} onValueChange={setHostId} disabled={pending}>
          <SelectTrigger className="w-44" aria-label="Claude account machine">
            <SelectValue placeholder="Choose a machine" />
          </SelectTrigger>
          <SelectContent>
            {machines.map((machine) => (
              <SelectItem
                key={machine.id}
                value={machine.id}
                disabled={machine.status !== "connected"}
              >
                {machine.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      )}
      {data?.supported === false || profiles === undefined ? (
        <p className="text-xs text-muted-foreground">
          Native Claude accounts are not enabled on this machine.
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
              {STATUS_LABELS[profile.status]}
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
          <span>Finish sign-in in the browser on this machine.</span>
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
      <div className="flex flex-wrap gap-2">
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          aria-label="Claude account name"
          placeholder="Account name (optional)"
          maxLength={80}
          className="w-48"
          disabled={pending || !supported}
        />
        <Button
          size="sm"
          disabled={pending || !supported}
          onClick={() =>
            void run(async () => {
              const { profile } = await profiles.add({
                hostId,
                label:
                  label.trim() ||
                  `Claude account ${(data?.profiles.length ?? 0) + 1}`,
              });

              setLabel("");
              await signIn(profile.id);
            })
          }
        >
          Add Claude account
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !supported}
          onClick={() =>
            void run(async () => {
              await profiles.add({
                hostId,
                label: "Existing Claude sign-in",
                adoptExisting: true,
              });
            })
          }
        >
          Use existing Claude sign-in
        </Button>
        {data?.defaultSelection.kind !== "profile" ? null : (
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
        )}
      </div>
    </section>
  );
}
