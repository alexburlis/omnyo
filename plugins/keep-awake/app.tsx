import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type StandardSchemaV1InferOutput,
} from "@omnyo/plugin-sdk/app";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-row";
import { SuccessCheck } from "@/components/ui/success-check";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { keepAwakeRpcContract } from "./server.js";

export type ConfigurationView = StandardSchemaV1InferOutput<
  (typeof keepAwakeRpcContract)["getConfiguration"]["output"]
>;

type PersistedConfiguration = Pick<ConfigurationView, "enabled" | "selection">;

export type SaveState = "idle" | "saving" | "saved" | "error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function persistedConfiguration(
  view: ConfigurationView,
): PersistedConfiguration {
  return { enabled: view.enabled, selection: view.selection };
}

function KeepAwakeSettings() {
  const rpc = useRpc<typeof keepAwakeRpcContract>();
  const [view, setView] = useState<ConfigurationView | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [ownerSaveCount, setOwnerSaveCount] = useState(0);
  const activeRef = useRef(true);
  const viewRef = useRef<ConfigurationView | null>(null);
  const confirmedRef = useRef<ConfigurationView | null>(null);
  const latestRevisionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let loading = true;
    activeRef.current = true;
    void rpc
      .call("getConfiguration")
      .then((configuration) => {
        if (!loading || !activeRef.current) return;
        viewRef.current = configuration;
        confirmedRef.current = configuration;
        setView(configuration);
        setSaveState("saved");
      })
      .catch((loadError: unknown) => {
        if (!loading || !activeRef.current) return;
        setError(errorMessage(loadError));
        setSaveState("error");
      });

    return () => {
      loading = false;
      activeRef.current = false;
    };
  }, [rpc]);

  function updateConfiguration(
    update: (current: ConfigurationView) => ConfigurationView,
  ): void {
    const current = viewRef.current;

    if (current === null) return;
    const next = update(current);
    const revision = latestRevisionRef.current + 1;
    latestRevisionRef.current = revision;
    viewRef.current = next;
    setView(next);
    setError(null);
    setSaveState("saving");

    const operation = saveQueueRef.current.then(async () => {
      const saved = await rpc.call(
        "setConfiguration",
        persistedConfiguration(next),
      );

      confirmedRef.current = saved;

      if (!activeRef.current || latestRevisionRef.current !== revision) return;
      viewRef.current = saved;
      setView(saved);
      setSaveState("saved");
      setOwnerSaveCount((count) => count + 1);
    });

    saveQueueRef.current = operation.catch((saveError: unknown) => {
      if (!activeRef.current || latestRevisionRef.current !== revision) return;
      const confirmed = confirmedRef.current;

      if (confirmed !== null) {
        viewRef.current = confirmed;
        setView(confirmed);
      }

      setError(errorMessage(saveError));
      setSaveState("error");
    });
  }

  function selectMode(mode: "all" | "selected"): void {
    updateConfiguration((current) => {
      if (mode === "all") {
        return { ...current, selection: { mode: "all" } };
      }

      const hostIds =
        current.selection.mode === "selected"
          ? current.selection.hostIds
          : current.hosts.map((host) => host.id).slice(0, 256);

      if (hostIds.length === 0) return current;

      return { ...current, selection: { mode: "selected", hostIds } };
    });
  }

  function setHostSelected(hostId: string, selected: boolean): void {
    updateConfiguration((current) => {
      if (current.selection.mode !== "selected") return current;
      const currentHostIds = current.selection.hostIds;

      const hostIds = selected
        ? [...new Set([...currentHostIds, hostId])]
        : currentHostIds.filter((candidate) => candidate !== hostId);

      if (hostIds.length === 0) return current;

      return { ...current, selection: { mode: "selected", hostIds } };
    });
  }

  return (
    <KeepAwakeSettingsView
      view={view}
      saveState={saveState}
      error={error}
      ownerSaveCount={ownerSaveCount}
      onEnabledChange={(enabled) => {
        updateConfiguration((current) => ({ ...current, enabled }));
      }}
      onSelectMode={selectMode}
      onHostSelectedChange={setHostSelected}
    />
  );
}

export interface KeepAwakeSettingsViewProps {
  view: ConfigurationView | null;
  saveState: SaveState;
  error: string | null;
  ownerSaveCount: number;
  onEnabledChange: (enabled: boolean) => void;
  onSelectMode: (mode: "all" | "selected") => void;
  onHostSelectedChange: (hostId: string, selected: boolean) => void;
}

export function KeepAwakeSettingsView({
  view,
  saveState,
  error,
  ownerSaveCount,
  onEnabledChange,
  onSelectMode,
  onHostSelectedChange,
}: KeepAwakeSettingsViewProps) {
  if (view === null) {
    if (error !== null) {
      return (
        <Alert variant="destructive">
          <Icon name="AlertCircle" />
          <AlertDescription>Couldn’t load Keep Awake: {error}</AlertDescription>
        </Alert>
      );
    }

    return (
      <div role="status" aria-label="Loading machines" className="space-y-3">
        <Skeleton aria-hidden className="h-4 w-40" />
        <Skeleton aria-hidden className="h-3 w-3/4" />
      </div>
    );
  }

  const selectedHostIds =
    view.selection.mode === "selected" ? view.selection.hostIds : [];

  const hasHosts = view.hosts.length > 0;

  return (
    <div className="w-full space-y-5">
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className={cn(
              "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg",
              view.enabled
                ? "bg-warning/15 text-warning-text"
                : "bg-state-hover text-muted-foreground",
            )}
          >
            <Icon name="Coffee" className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">
              Prevent idle sleep
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Keeps the chosen Mac and Windows machines awake while Omnyo runs
              on them, so long chats don’t pause. Closing the lid or choosing
              Sleep still puts a machine to sleep.
            </p>
          </div>
        </div>
        <Switch
          checked={view.enabled}
          size="default"
          aria-label="Keep Awake"
          onCheckedChange={onEnabledChange}
        />
      </div>

      {view.enabled ? (
        <div className="space-y-3 border-t border-border pt-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">Machines</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Choose which machines to keep awake.
            </p>
          </div>
          <RadioGroup
            className="grid gap-2 sm:grid-cols-2"
            value={view.selection.mode}
            onValueChange={(mode) => {
              if (mode === "all" || mode === "selected") onSelectMode(mode);
            }}
          >
            <label
              htmlFor="keep-awake-all-hosts"
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:bg-state-hover",
                view.selection.mode === "all"
                  ? "border-ring/60 bg-state-hover"
                  : "border-border",
              )}
            >
              <RadioGroupItem
                id="keep-awake-all-hosts"
                value="all"
                aria-label="All machines"
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">All machines</span>
                <span className="block text-xs text-muted-foreground">
                  Includes machines you add later. Linux machines are skipped.
                </span>
              </span>
            </label>
            <label
              htmlFor="keep-awake-selected-hosts"
              className={cn(
                "flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                view.selection.mode === "selected"
                  ? "border-ring/60 bg-state-hover"
                  : "border-border",
                hasHosts
                  ? "cursor-pointer hover:bg-state-hover"
                  : "cursor-not-allowed opacity-50",
              )}
            >
              <RadioGroupItem
                id="keep-awake-selected-hosts"
                value="selected"
                aria-label="Specific machines"
                disabled={!hasHosts}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  Specific machines
                </span>
                <span className="block text-xs text-muted-foreground">
                  Pick them one by one below.
                </span>
              </span>
            </label>
          </RadioGroup>

          {view.selection.mode === "selected" ? (
            <div className="overflow-hidden rounded-lg border border-border">
              {hasHosts ? (
                <div className="divide-y divide-border">
                  {view.hosts.map((host) => {
                    const selected = selectedHostIds.includes(host.id);

                    const isOnlySelectedHost =
                      selected && selectedHostIds.length === 1;

                    const checkboxId = `keep-awake-host-${host.id}`;
                    const connected = host.status === "connected";

                    return (
                      <label
                        key={host.id}
                        htmlFor={checkboxId}
                        title={
                          isOnlySelectedHost
                            ? "Keep at least one machine selected, or choose All machines."
                            : undefined
                        }
                        className={cn(
                          "flex min-h-11 items-center gap-3 px-3 py-2 transition-colors",
                          isOnlySelectedHost
                            ? "cursor-default"
                            : "cursor-pointer hover:bg-state-hover",
                        )}
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={selected}
                          disabled={isOnlySelectedHost}
                          aria-label={host.name}
                          onCheckedChange={(checked) => {
                            onHostSelectedChange(host.id, checked === true);
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {host.name}
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <StatusDot tone={connected ? "success" : "pending"} />
                          {connected ? "Connected" : "Offline"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="px-3 py-4 text-sm text-muted-foreground">
                  No machines are connected yet.
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-5 justify-end" aria-live="polite">
        {error !== null ? (
          <span
            className="inline-flex items-center gap-1.5 text-xs text-destructive-text"
            role="alert"
          >
            <Icon name="AlertCircle" className="size-3.5" />
            {error}
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            role="status"
          >
            {saveState === "saving" ? null : (
              <SuccessCheck
                key={ownerSaveCount}
                size="sm"
                animate={ownerSaveCount > 0}
              />
            )}
            {saveState === "saving" ? "Saving…" : "Saved"}
          </span>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "configuration",
    component: KeepAwakeSettings,
  });
});
