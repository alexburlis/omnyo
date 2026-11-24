import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@omnyo/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  defaultHousekeepingBudget,
  type HousekeepingRun,
  type HousekeepingStatus,
  type housekeepingRpc,
} from "./src/housekeeping-contract.js";

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);

  return `${Number((value / 1024 ** index).toFixed(1))} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}`;
}

function stageName(name: string) {
  if (name === "process-private-temp") return "Worker temporary files";

  if (name === "plugin-cache") return "Unused plugin versions";

  const words = name.replaceAll(/[-_]/g, " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
}

function runState(state: HousekeepingRun["state"]) {
  switch (state) {
    case "planned":
      return "Waiting";
    case "running":
      return "Running";
    case "completed":
      return "Finished";
    case "held":
      return "Held";
    case "failed":
      return "Failed";
  }
}

export function HousekeepingPanel({
  hostId,
  machineName,
}: {
  hostId: string | null;
  machineName: (id: string) => string;
}) {
  const rpc = useRpc<typeof housekeepingRpc>();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<HousekeepingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const sequence = useRef(0);
  const epoch = useRef(0);

  const refresh = useCallback(async () => {
    if (!open) return;
    const current = ++sequence.current;
    setLoading(true);

    try {
      const next = await rpc.call("housekeepingStatus", null);

      if (sequence.current !== current) return;
      setState(next);
      setError(null);
    } catch (failure) {
      if (sequence.current === current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (sequence.current === current) setLoading(false);
    }
  }, [open, rpc]);

  useEffect(() => {
    epoch.current += 1;
    sequence.current += 1;
    setState(null);
    setError(null);
    void refresh();

    return () => {
      epoch.current += 1;
      sequence.current += 1;
    };
  }, [hostId, refresh]);

  useRealtime("housekeeping-changed", refresh);

  async function start(target: string, mode: "preview" | "apply") {
    if (busyRef.current.has(target)) return;
    const current = epoch.current;
    busyRef.current.add(target);
    setBusy(new Set(busyRef.current));

    try {
      await rpc.call(
        mode === "preview" ? "housekeepingPreview" : "housekeepingRun",
        { hostId: target, budget: defaultHousekeepingBudget },
      );

      if (epoch.current === current) await refresh();
    } catch (failure) {
      if (epoch.current === current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busyRef.current.delete(target);
      setBusy(new Set(busyRef.current));
    }
  }

  const hosts = state?.hosts.filter(
    (host) => hostId === null || host.hostId === hostId,
  );

  const failures = state?.failures.filter(
    (failure) => hostId === null || failure.hostId === hostId,
  );

  return (
    <section className="space-y-3" aria-label="Housekeeping">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Housekeeping</h2>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">
            Run approved cleanup and see what is kept or held.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Close housekeeping" : "Open housekeeping"}
        </Button>
      </div>
      {open && (
        <div className="space-y-3">
          {error !== null && (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
              >
                Try again
              </Button>
            </div>
          )}
          {loading && state === null && (
            <p role="status" className="text-xs text-subtle-foreground">
              Loading housekeeping
            </p>
          )}
          {failures?.map((failure) => (
            <p
              key={failure.hostId}
              role="alert"
              className="break-words text-xs text-destructive"
            >
              {machineName(failure.hostId)}: {failure.message}
            </p>
          ))}
          {state !== null && hosts?.length === 0 && failures?.length === 0 && (
            <p className="text-xs text-subtle-foreground">
              No maintenance machine is available.
            </p>
          )}
          {hosts?.map((host) => {
            const run = host.currentRun ?? host.lastRun;

            const working =
              busy.has(host.hostId) ||
              host.currentRun?.state === "planned" ||
              host.currentRun?.state === "running";

            const reportedBytes =
              run?.stages.reduce(
                (total, stage) => total + (stage.bytes ?? 0),
                0,
              ) ?? 0;

            const unknownSizes =
              run?.stages.some((stage) => stage.bytes === null) ?? false;

            const sizeLabel = unknownSizes
              ? `${bytes(reportedBytes)} known; other sizes not measured`
              : `${bytes(reportedBytes)} ${run?.mode === "preview" ? "eligible" : "reported removed"}`;

            return (
              <article
                key={host.hostId}
                aria-label={`Housekeeping for ${machineName(host.hostId)}`}
                className="space-y-3 rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium">
                      {machineName(host.hostId)}
                    </h3>
                    <p className="text-xs text-subtle-foreground">
                      {host.registration === null
                        ? "Built-in maintenance"
                        : "Built-in maintenance and registered local policy"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={working}
                      aria-label={`Preview housekeeping on ${machineName(host.hostId)}`}
                      onClick={() => void start(host.hostId, "preview")}
                    >
                      Preview
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={working}
                      aria-label={`Run housekeeping on ${machineName(host.hostId)}`}
                      onClick={() => void start(host.hostId, "apply")}
                    >
                      Run housekeeping
                    </Button>
                  </div>
                </div>
                {run === null ? (
                  <p className="text-xs text-subtle-foreground">
                    No maintenance run has been recorded.
                  </p>
                ) : (
                  <div className="space-y-2" role="status">
                    <p className="text-xs">
                      {run.mode === "preview" ? "Preview" : "Cleanup"}
                      {" · "}
                      {runState(run.state)}
                      {" · "}
                      {sizeLabel}
                    </p>
                    {run.reason !== null && (
                      <p className="break-words text-xs text-subtle-foreground">
                        {run.reason}
                      </p>
                    )}
                    <ul className="space-y-1 text-xs">
                      {run.stages.map((stage) => (
                        <li key={stage.name} className="break-words">
                          {stageName(stage.name)}: {stage.state}
                          {stage.reason !== null && ` · ${stage.reason}`}
                        </li>
                      ))}
                    </ul>
                    {run.reviewProposals !== undefined &&
                      run.reviewProposals.length > 0 && (
                        <div
                          className="space-y-2 text-xs"
                          aria-label="Protected storage review proposals"
                        >
                          <p className="font-medium">Owner review required</p>
                          {run.reviewProposals.map((proposal) => (
                            <article key={proposal.id} className="space-y-1">
                              <p>
                                {proposal.owner} · {proposal.reason}
                              </p>
                              {proposal.paths.map((path) => (
                                <p key={path} className="break-all font-mono">
                                  {path}
                                </p>
                              ))}
                              <p>
                                {proposal.allocatedBytes === null
                                  ? "Allocation not measured"
                                  : `${bytes(proposal.allocatedBytes)} allocated`}
                                {proposal.logicalBytes === null
                                  ? ""
                                  : ` · ${bytes(proposal.logicalBytes)} logical`}
                              </p>
                              <p>{proposal.action}</p>
                              <p>{proposal.preservation}</p>
                            </article>
                          ))}
                        </div>
                      )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
