import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useRpc,
  type StandardSchemaV1InferOutput,
} from "@omnyo/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-row";
import type { acpRegistryRpcContract } from "./src/registry-service.js";

type RegistryView = StandardSchemaV1InferOutput<
  (typeof acpRegistryRpcContract)["listRegistry"]["output"]
>;

type RegistryAgent = RegistryView["agents"][number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STATUS_BADGES: Partial<
  Record<RegistryAgent["status"], { label: string; tone: StatusTone }>
> = {
  added: { label: "Added", tone: "success" },
  "update-available": { label: "Update available", tone: "warning" },
  "built-in": { label: "Built in", tone: "neutral" },
  "manual-install": { label: "Manual install", tone: "pending" },
};

function matchesQuery(agent: RegistryAgent, query: string): boolean {
  const needle = query.trim().toLowerCase();

  return (
    needle === "" ||
    [agent.id, agent.name, agent.description, ...agent.authors].some((text) =>
      text.toLowerCase().includes(needle),
    )
  );
}

function agentNote(agent: RegistryAgent): string | null {
  if (agent.status === "built-in") {
    return "Omnyo already ships this agent as a provider.";
  }

  if (agent.status === "manual-install") {
    return "Ships only as a downloadable binary. Install it yourself, then add it under Custom agents with its command.";
  }

  return agent.command === null ? null : `Runs ${agent.command}`;
}

function RegistryNotice({
  tone,
  children,
}: {
  tone: "error" | "warning";
  children: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "flex items-start gap-2 rounded-lg border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs leading-5 text-destructive-text"
          : "flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-5 text-foreground"
      }
    >
      <Icon
        name={tone === "error" ? "AlertCircle" : "CloudOff"}
        aria-hidden="true"
        className={
          tone === "error"
            ? "mt-0.5 size-3.5 shrink-0"
            : "mt-0.5 size-3.5 shrink-0 text-warning-text"
        }
      />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function RegistrySkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the registry"
      className="divide-y divide-border-seam"
    >
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-start gap-3 px-3 py-3">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2 pt-1">
            <Skeleton className={row === 1 ? "h-3 w-24" : "h-3 w-32"} />
            <Skeleton className={row === 2 ? "h-2.5 w-2/3" : "h-2.5 w-4/5"} />
          </div>
          <Skeleton className="mt-1 h-6 w-12 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function AcpRegistrySettings() {
  const rpc = useRpc<typeof acpRegistryRpcContract>();
  const [view, setView] = useState<RegistryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>("load");
  const [query, setQuery] = useState("");
  const activeRef = useRef(true);

  const settle = useCallback((request: Promise<RegistryView>): void => {
    void request
      .then((next) => {
        if (activeRef.current) setView(next);
      })
      .catch((requestError: unknown) => {
        if (activeRef.current) setError(errorMessage(requestError));
      })
      .finally(() => {
        if (activeRef.current) setBusy(null);
      });
  }, []);

  const run = useCallback(
    (key: string, request: () => Promise<RegistryView>): void => {
      setBusy(key);
      setError(null);
      settle(request());
    },
    [settle],
  );

  useEffect(() => {
    activeRef.current = true;
    settle(rpc.call("listRegistry", { refresh: false }));

    return () => {
      activeRef.current = false;
    };
  }, [rpc, settle]);

  const agents = useMemo(
    () => (view?.agents ?? []).filter((agent) => matchesQuery(agent, query)),
    [query, view],
  );

  const refreshing = busy === "refresh";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            Agent registry
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Agents from the official ACP registry. Adding one makes it a
            provider in the thread composer; it runs through npx or uvx on the
            machine that hosts the thread.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={busy !== null}
          onClick={() =>
            run("refresh", () => rpc.call("listRegistry", { refresh: true }))
          }
        >
          <Icon
            name="RotateCcw"
            aria-hidden="true"
            className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
          />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {error !== null ? (
        <RegistryNotice tone="error">{error}</RegistryNotice>
      ) : view?.error != null ? (
        <RegistryNotice tone="warning">
          {view.agents.length === 0
            ? `The registry could not be reached: ${view.error}`
            : `Showing a saved copy. The registry could not be reached: ${view.error}`}
        </RegistryNotice>
      ) : null}

      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-subtle-foreground"
        >
          <Icon name="Search" className="size-3.5" />
        </span>
        <Input
          type="search"
          value={query}
          placeholder="Search agents"
          aria-label="Search agents"
          className="pl-8"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
        {view === null ? (
          error === null ? (
            <RegistrySkeleton />
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No agents to show.
            </p>
          )
        ) : agents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <Icon
              name={view.agents.length === 0 ? "Toolbox" : "Search"}
              aria-hidden="true"
              className="size-5 text-subtle-foreground"
            />
            <p className="text-sm text-muted-foreground">
              {view.agents.length === 0
                ? "No agents to show."
                : "No agent matches that search."}
            </p>
          </div>
        ) : (
          <ul className="m-0 list-none divide-y divide-border-seam p-0">
            {agents.map((agent) => {
              const badge = STATUS_BADGES[agent.status];
              const note = agentNote(agent);

              const canAdd =
                agent.status === "available" ||
                agent.status === "update-available";

              const canRemove =
                agent.status === "added" || agent.status === "update-available";

              const working = busy === agent.id;

              return (
                <li key={agent.id} className="flex items-start gap-3 px-3 py-3">
                  <span
                    aria-hidden="true"
                    className="grid size-8 shrink-0 place-items-center rounded-lg bg-state-hover text-muted-foreground"
                  >
                    <Icon name={agent.icon ?? "Toolbox"} className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-medium text-foreground">
                        {agent.name}
                      </span>
                      <span className="font-mono text-xs text-subtle-foreground">
                        {agent.version}
                      </span>
                      {badge === undefined ? null : (
                        <StatusBadge tone={badge.tone}>
                          {badge.label}
                        </StatusBadge>
                      )}
                    </div>
                    {agent.description === "" ? null : (
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {agent.description}
                      </p>
                    )}
                    {note === null ? null : (
                      <p className="mt-1 break-words text-xs leading-relaxed text-subtle-foreground">
                        {note}
                      </p>
                    )}
                  </div>
                  <div className="flex min-h-6 shrink-0 items-center gap-1.5 pt-1">
                    {canRemove ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={busy !== null}
                        aria-label={`Remove ${agent.name}`}
                        onClick={() =>
                          run(agent.id, () =>
                            rpc.call("removeAgent", { id: agent.id }),
                          )
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                    {canAdd ? (
                      <Button
                        type="button"
                        variant="soft"
                        size="xs"
                        disabled={busy !== null}
                        aria-label={`${agent.status === "available" ? "Add" : "Update"} ${agent.name}`}
                        onClick={() =>
                          run(agent.id, () =>
                            rpc.call("addRegistryAgent", { id: agent.id }),
                          )
                        }
                      >
                        {working ? (
                          <Icon
                            name="Spinner"
                            aria-hidden="true"
                            className="animate-spin"
                          />
                        ) : (
                          <Icon
                            name={
                              agent.status === "available" ? "Plus" : "ArrowUp"
                            }
                            aria-hidden="true"
                          />
                        )}
                        {agent.status === "available" ? "Add" : "Update"}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "registry",
    component: AcpRegistrySettings,
  });
});
