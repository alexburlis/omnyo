import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  useRpc,
  experimental_ProviderIcon as ProviderIcon,
} from "@omnyo/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  formatUsageReset,
  formatUsdCents,
  usageBarColorClass,
} from "./usage-format.js";
import type { providerUsageRpcContract } from "./server.js";
import {
  emptyUsageMessage,
  hasReportedUsage,
  offlineUsageMessage,
  UsageFeedback,
  usageFeedbackMessages,
} from "./usage-feedback.js";
import {
  selectUsageMachine,
  type UsageMachine,
  type UsageProvider,
  type ProviderUsage,
  type UsageWindow,
} from "./usage-schema.js";

function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full bg-state-hover px-2 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

interface ProviderConfig {
  name: string;
  providerId: string;
  signInHint: string;
  expiredHint: string;
  provider: UsageProvider;
}

function usageWindowValue(window: UsageWindow): string {
  if (!window.cost) {
    return `${window.usedPercent}% used`;
  }

  return `${formatUsdCents(window.cost.usedUsdCents, true)} / ${formatUsdCents(window.cost.limitUsdCents, false)}`;
}

function usageValueToneClass(usedPercent: number): string {
  if (usedPercent >= 95) return "text-destructive-text";

  if (usedPercent >= 80) return "text-warning-text";

  return "text-muted-foreground";
}

function UsageWindowRow({ window }: { window: UsageWindow }) {
  const reset = formatUsageReset(window.resetsAt);
  const value = usageWindowValue(window);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          {window.label}
        </span>
        <span
          className={cn(
            "shrink-0 text-xs font-medium tabular-nums",
            usageValueToneClass(window.usedPercent),
          )}
        >
          {value}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${window.label}: ${value}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(
          Math.min(100, Math.max(0, window.usedPercent)),
        )}
        className="h-1.5 w-full overflow-hidden rounded-full bg-state-active"
      >
        <div
          className={cn(
            "h-full rounded-full",
            usageBarColorClass(window.usedPercent),
          )}
          style={{
            width: `${Math.min(100, Math.max(window.usedPercent, 2))}%`,
          }}
        />
      </div>
      <p className="flex items-center gap-1 text-xs text-subtle-foreground">
        <Icon name="Clock" aria-hidden="true" className="size-3 shrink-0" />
        {reset ?? "Reset time not reported"}
      </p>
    </div>
  );
}

interface UsageLocation {
  id: string;
  name: string;
  kind: "host" | "source";
  disabled: boolean;
}

function UsageLocationPicker({
  locations,
  selectedLocationId,
  onSelectLocation,
}: {
  locations: readonly UsageLocation[];
  selectedLocationId: string | null;
  onSelectLocation: (locationId: string) => void;
}) {
  const selectedLocation =
    locations.find((location) => location.id === selectedLocationId) ??
    locations[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="max-w-48 gap-1.5"
          aria-label="Usage source"
        >
          <Icon
            name={selectedLocation?.kind === "source" ? "Layers" : "Laptop"}
            className="size-3.5 shrink-0"
          />
          <span className="min-w-0 truncate">
            {selectedLocation?.name ?? "Source"}
          </span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" mobileTitle="Usage source">
        {locations.map((location) => {
          const connected = !location.disabled;

          return (
            <DropdownMenuItem
              key={location.id}
              disabled={!connected}
              onSelect={() => onSelectLocation(location.id)}
              className="flex items-center gap-2"
            >
              <Icon
                name={location.kind === "source" ? "Layers" : "Laptop"}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">{location.name}</span>
              {connected ? null : (
                <span className="shrink-0 text-xs text-subtle-foreground">
                  Offline
                </span>
              )}
              {location.id === selectedLocation?.id ? (
                <Icon name="Check" className="size-3.5 shrink-0" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type UsageStateTone = "neutral" | "warning" | "error";

const USAGE_STATE_CLASS: Record<UsageStateTone, string> = {
  neutral: "text-muted-foreground",
  warning: "text-warning-text",
  error: "text-destructive-text",
};

const USAGE_STATE_ICON = {
  neutral: "Info",
  warning: "Lock",
  error: "AlertCircle",
} as const;

function UsageStateMessage({
  tone,
  children,
}: {
  tone: UsageStateTone;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex min-w-0 items-start gap-1.5 text-xs leading-5",
        USAGE_STATE_CLASS[tone],
      )}
    >
      <Icon
        name={USAGE_STATE_ICON[tone]}
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0"
      />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

function UsageWindowsSkeleton() {
  return (
    <div
      role="status"
      aria-label={usageFeedbackMessages.loading}
      className="space-y-1.5"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="h-2.5 w-12" />
      </div>
      <Skeleton className="h-1.5 w-full rounded-full" />
      <Skeleton className="h-2.5 w-28" />
    </div>
  );
}

interface AccountUsageBodyProps {
  config: ProviderConfig;
  usage: ProviderUsage | undefined;
  isLoading: boolean;
  isError: boolean;
}

function AccountUsageBody({
  config,
  usage,
  isLoading,
  isError,
}: AccountUsageBodyProps) {
  if (isError) {
    return (
      <UsageStateMessage tone="error">
        {usageFeedbackMessages.unavailable}
      </UsageStateMessage>
    );
  }

  if (!usage) {
    return isLoading ? (
      <UsageWindowsSkeleton />
    ) : (
      <UsageStateMessage tone="neutral">Usage not provided.</UsageStateMessage>
    );
  }

  switch (usage.status) {
    case "ok":
      if (usage.windows.length === 0) {
        return (
          <UsageStateMessage tone="neutral">
            No usage limits reported for this plan.
          </UsageStateMessage>
        );
      }

      return (
        <div className="space-y-3.5">
          {usage.windows.map((window) => (
            <UsageWindowRow key={window.label} window={window} />
          ))}
        </div>
      );
    case "not_installed":
      return (
        <UsageStateMessage tone="neutral">
          Not installed on this machine.
        </UsageStateMessage>
      );
    case "unauthenticated":
      return (
        <UsageStateMessage tone="warning">
          {config.signInHint}
        </UsageStateMessage>
      );
    case "expired":
      return (
        <UsageStateMessage tone="warning">
          {config.expiredHint}
        </UsageStateMessage>
      );
    case "error":
      return (
        <UsageStateMessage tone="error">{usage.message}</UsageStateMessage>
      );
    default:
      return null;
  }
}

function UsageResourceGroup({
  config,
  resources,
  isLoading,
  isError,
}: {
  config: ProviderConfig;
  resources: UsageProvider[];
  isLoading: boolean;
  isError: boolean;
}) {
  const headingId = useId();

  const accounts = resources.map((resource) => {
    const usage = resource.usage ?? undefined;

    return {
      id: resource.id,
      usage,
      email:
        usage?.status === "ok"
          ? (usage.accountEmail ?? resource.accountLabel)
          : resource.accountLabel,
      plan: usage?.status === "ok" ? usage.planLabel : null,
    };
  });

  const single = accounts.length === 1 ? accounts[0] : undefined;

  return (
    <section aria-labelledby={headingId} className="py-4 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-md bg-state-hover"
        >
          <ProviderIcon
            providerKind="agent"
            provider={{ ...config.provider, id: config.providerId }}
            className="size-4"
          />
        </span>
        <div className="min-w-0 flex-1">
          <h3
            id={headingId}
            className="truncate text-sm font-semibold text-foreground"
          >
            {config.name}
          </h3>
          {single?.email && single.email !== config.name ? (
            <p className="truncate text-xs text-muted-foreground">
              {single.email}
            </p>
          ) : null}
        </div>
        {single === undefined ? (
          <SettingsBadge>{accounts.length} accounts</SettingsBadge>
        ) : single.plan ? (
          <SettingsBadge>{single.plan}</SettingsBadge>
        ) : null}
      </div>
      <div className="mt-3 pl-9.5">
        {single !== undefined ? (
          <AccountUsageBody
            config={config}
            usage={single.usage}
            isLoading={isLoading}
            isError={isError && single.usage === undefined}
          />
        ) : (
          <ul className="m-0 list-none divide-y divide-border-seam p-0">
            {accounts.map((account) => (
              <li
                key={account.id}
                aria-label={account.email ?? config.name}
                className="space-y-2.5 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-xs font-medium text-foreground">
                    {account.email ?? config.name}
                  </p>
                  {account.plan ? (
                    <SettingsBadge>{account.plan}</SettingsBadge>
                  ) : null}
                </div>
                <AccountUsageBody
                  config={config}
                  usage={account.usage}
                  isLoading={isLoading}
                  isError={isError && account.usage === undefined}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function UsageSettingsContent({
  machines,
  selectedId,
  loading,
  error,
  onSelect,
  onRefresh,
}: {
  machines: UsageMachine[];
  selectedId: string | null;
  loading: boolean;
  error: boolean;
  onSelect: (machineId: string) => void;
  onRefresh: () => void;
}) {
  const selected = selectUsageMachine(machines, selectedId, null);
  const groups = new Map<string, UsageProvider[]>();

  for (const provider of selected?.providers ?? []) {
    if (provider.usage?.status === "not_installed") continue;
    const group = groups.get(provider.providerId);

    if (group) group.push(provider);
    else groups.set(provider.providerId, [provider]);
  }

  const notice =
    selected?.status === "disconnected"
      ? offlineUsageMessage(selected, hasReportedUsage(selected.providers))
      : error || selected?.error
        ? hasReportedUsage(selected?.providers ?? [])
          ? usageFeedbackMessages.refreshFailed
          : usageFeedbackMessages.loadFailed
        : selected === null
          ? loading
            ? usageFeedbackMessages.loading
            : usageFeedbackMessages.noSources
          : groups.size === 0
            ? emptyUsageMessage(selected)
            : null;

  return (
    <section className="@container/usage-settings space-y-3">
      <div
        className={cn(
          machines.length > 1
            ? "flex flex-col gap-3 @min-[36rem]/usage-settings:flex-row @min-[36rem]/usage-settings:justify-between @min-[36rem]/usage-settings:gap-4 @min-[36rem]/usage-settings:items-start"
            : "flex flex-row items-start justify-between gap-4",
        )}
      >
        <div className="min-w-0">
          <h2 className="min-w-0 text-sm font-semibold text-foreground">
            Usage limits
          </h2>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            How much of each subscription’s limits you’ve used. Bars turn amber
            at 80% and red at 95%.
          </p>
        </div>
        <div className="shrink-0 self-start">
          <div className="flex items-center gap-1">
            {machines.length > 1 ? (
              <UsageLocationPicker
                locations={machines.map((machine) => ({
                  id: machine.id,
                  name: machine.displayName,
                  kind: machine.id.startsWith("source:") ? "source" : "host",
                  disabled: machine.status !== "connected",
                }))}
                selectedLocationId={selected?.id ?? null}
                onSelectLocation={onSelect}
              />
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              disabled={loading}
              onClick={onRefresh}
              aria-label={
                loading ? "Reloading usage data" : "Reload usage data"
              }
            >
              <Icon
                name="RotateCcw"
                className={cn("size-3.5", loading && "animate-spin")}
              />
            </Button>
          </div>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card px-4 py-4 shadow-card">
        {notice ? (
          <UsageFeedback
            message={notice}
            loading={notice === usageFeedbackMessages.loading}
            className={groups.size > 0 ? "mb-3" : undefined}
          />
        ) : null}
        <div className="divide-y divide-border-seam">
          {[...groups].map(([id, resources]) => {
            const provider = resources[0]!;

            return (
              <UsageResourceGroup
                key={id}
                config={{
                  name: provider.displayName,
                  providerId: id,
                  signInHint: provider.signInHint,
                  expiredHint: provider.expiredHint,
                  provider,
                }}
                resources={resources}
                isLoading={loading}
                isError={error || Boolean(selected?.error)}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function UsageSettings() {
  const rpc = useRpc<typeof providerUsageRpcContract>();
  const [machines, setMachines] = useState<UsageMachine[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const forceGeneration = useRef(0);
  useEffect(() => {
    let disposed = false;
    let running = false;
    const force = refresh > forceGeneration.current;
    forceGeneration.current = refresh;

    async function load(force: boolean) {
      if (running) return;
      running = true;
      setLoading(true);
      setError(false);

      try {
        const inventory = await rpc.call("getUsage", {
          force: false,
          machineIds: null,
          providerIds: [],
          maxAgeMs: 60_000,
        });

        if (disposed) return;
        setMachines(inventory.machines);

        const selected = selectUsageMachine(
          inventory.machines,
          selectedId,
          null,
        );

        const providerIds = [
          ...new Set(
            selected?.providers.map((provider) => provider.providerId),
          ),
        ];

        if (
          selected &&
          selected.status === "connected" &&
          providerIds.length > 0
        ) {
          const result = await rpc.call("getUsage", {
            force,
            machineIds: [selected.id],
            providerIds,
            maxAgeMs: 60_000,
          });

          if (disposed) return;
          setMachines(result.machines);
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        running = false;

        if (!disposed) setLoading(false);
      }
    }

    void load(force);

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(false);
    }, 60_000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [rpc, selectedId, refresh]);

  return (
    <UsageSettingsContent
      machines={machines}
      selectedId={selectedId}
      loading={loading}
      error={error}
      onSelect={setSelectedId}
      onRefresh={() => setRefresh((value) => value + 1)}
    />
  );
}
