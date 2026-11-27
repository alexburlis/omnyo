import type { CuaResourceView } from "../cua-contract";
import { formatBytes, formatDuration } from "../lib/format";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { StatusList, StatusRow, type StatusTone } from "./ui/status-row";

const reasons: Record<CuaResourceView["retentionReason"], { text: string; tone: StatusTone }> = {
  "observed-only": { text: "Observed only", tone: "neutral" },
  "consumer-active": { text: "Retained by a job", tone: "active" },
  kept: { text: "Kept running", tone: "neutral" },
  "idle-grace": { text: "Waiting to stop", tone: "pending" },
  ready: { text: "Ready for cleanup", tone: "pending" },
  blocked: { text: "Cleanup held", tone: "warning" },
  stopping: { text: "Stopping", tone: "warning" },
  stopped: { text: "Stopped", tone: "neutral" },
  uncertain: { text: "Shutdown needs reconciliation", tone: "error" },
};

export function CuaResources({
  resources,
  busyKey,
  onOpenThread,
  onKeep,
}: {
  resources: readonly CuaResourceView[];
  busyKey: string | null;
  onOpenThread: (threadId: string) => void;
  onKeep: (resource: CuaResourceView) => void;
}) {
  if (resources.length === 0) return null;

  return (
    <section aria-label="Cua runtimes" className="space-y-2.5">
      <div className="flex min-h-7 items-center gap-2">
        <Icon name="Browser" aria-hidden="true" className="size-4 text-subtle-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Cua runtimes</h2>
      </div>
      <StatusList label="Cua runtimes">
        {resources.map((resource) => {
          const reason = reasons[resource.retentionReason];

          return (
            <StatusRow
              key={resource.id}
              tone={reason.tone}
              title={resource.sandbox.name}
              status={reason.text}
              meta={[
                resource.lastObserved?.memory.kind === "footprint"
                  ? `Last measured ${formatBytes(resource.lastObserved.memory.bytes)}, ${formatDuration(Date.now() - resource.lastObserved.at)} ago`
                  : "Memory not measured",
                ...(resource.nextStopAt === null
                  ? []
                  : [`Cleanup after ${new Date(resource.nextStopAt).toLocaleTimeString()}`]),
              ]}
              detail={
                resource.lastHoldReason === null ? undefined : (
                  <span role="status">{resource.lastHoldReason}</span>
                )
              }
              actions={
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onOpenThread(resource.ownerThreadId)}
                  >
                    Open owning chat
                  </Button>
                  {resource.ownership === "managed" && resource.transition.kind === "stable" && (
                    <Button
                      size="xs"
                      variant="soft"
                      disabled={busyKey !== null}
                      onClick={() => onKeep(resource)}
                    >
                      {resource.keepRequested ? "Allow cleanup" : "Keep running"}
                    </Button>
                  )}
                </>
              }
            />
          );
        })}
      </StatusList>
    </section>
  );
}
