import type { Preset } from "../../shared/contract.js";
import {
  PERMISSION_LABELS,
  describePresetEnvironment,
} from "./preset-dialog.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-row";
import { EmptyStateBlock } from "@/components/ui/empty-state";
import { Hint } from "../../components/hint.js";

interface MachineOption {
  id: string;
  name: string;
}

export function PresetList({
  presets,
  machines,
  onEdit,
  onDelete,
}: {
  presets: readonly Preset[];
  machines: readonly MachineOption[];
  onEdit: (preset: Preset) => void;
  onDelete: (preset: Preset) => void;
}) {
  if (presets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border">
        <EmptyStateBlock
          icon="Bot"
          title="No agent presets yet"
          description="Create one to start agents on tasks with a single click."
        />
      </div>
    );
  }

  return (
    <ul
      aria-label="Agent presets"
      className="divide-y divide-border-hairline overflow-hidden rounded-lg border border-border bg-card"
    >
      {presets.map((preset) => (
        <li key={preset.id} className="flex items-start gap-3 px-3.5 py-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-state-hover text-muted-foreground">
            <Icon name="Bot" aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-sm font-medium text-foreground">
                {preset.name}
              </span>
              <StatusBadge
                tone={preset.permissionMode === "full" ? "warning" : "neutral"}
              >
                {PERMISSION_LABELS[preset.permissionMode]}
              </StatusBadge>
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span>{preset.providerId}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{preset.modelId}</span>
              <span aria-hidden="true">·</span>
              <span>{preset.reasoningLevel} reasoning</span>
              {preset.serviceTier === null ? null : (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{preset.serviceTier} tier</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="inline-flex min-w-0 items-center gap-1">
                <Icon
                  name={
                    preset.environmentKind === "new-worktree"
                      ? "GitBranch"
                      : "Folder"
                  }
                  aria-hidden="true"
                  className="size-3 shrink-0"
                />
                {describePresetEnvironment(preset, machines)}
              </span>
            </div>
            {preset.instructions === "" ? null : (
              <p
                title={preset.instructions}
                className="mt-1 line-clamp-2 text-xs text-subtle-foreground"
              >
                {preset.instructions}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="xs"
              variant="soft"
              aria-label={`Edit preset ${preset.name}`}
              onClick={() => onEdit(preset)}
            >
              <Icon name="Edit" />
              Edit
            </Button>
            <Hint label="Delete preset">
              <Button
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive-text"
                aria-label={`Delete preset ${preset.name}`}
                onClick={() => onDelete(preset)}
              >
                <Icon name="Trash2" />
              </Button>
            </Hint>
          </div>
        </li>
      ))}
    </ul>
  );
}
