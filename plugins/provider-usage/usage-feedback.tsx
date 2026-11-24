import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { UsageMachine, UsageProvider } from "./usage-schema.js";

export const usageFeedbackMessages = {
  loading: "Loading usage…",
  noSources: "No usage sources available.",
  loadFailed: "Couldn’t load usage.",
  refreshFailed: "Couldn’t refresh. Showing last update.",
  unavailable: "Usage unavailable.",
} as const;

export function hasReportedUsage(providers: readonly UsageProvider[]): boolean {
  return providers.some((provider) => provider.usage !== null);
}

export function emptyUsageMessage(machine: UsageMachine): string {
  return machine.id.startsWith("source:")
    ? "No accounts report usage yet. Configure accounts in the source plugin’s settings."
    : "No providers report usage limits on this machine.";
}

export function offlineUsageMessage(
  machine: UsageMachine,
  hasUsage: boolean,
): string {
  return hasUsage
    ? `${machine.displayName} is offline. Showing last update.`
    : `${machine.displayName} is offline. Usage will refresh when it reconnects.`;
}

export function UsageFeedback({
  message,
  loading = false,
  className,
}: {
  message: string;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-w-0 items-start gap-2 text-xs leading-5 text-muted-foreground",
        !loading && "rounded-lg bg-state-hover px-3 py-2",
        className,
      )}
    >
      <Icon
        name={loading ? "Spinner" : "Info"}
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          loading && "animate-spin text-subtle-foreground",
        )}
      />
      <span className="min-w-0 flex-1">{message}</span>
    </div>
  );
}
