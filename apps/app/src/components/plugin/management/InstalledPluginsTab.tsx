import { usePluginEnabledMutation } from "@/components/plugin/usePluginEnabledMutation";
import { useState } from "react";
import { EmptyStateBlock } from "@omnyo/shared-ui/empty-state";
import { Switch } from "@omnyo/shared-ui/switch";
import { ResourceIconFrame } from "@omnyo/shared-ui/resource-list";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import { pluginNeedsAttention } from "@/hooks/usePluginAttention";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  pluginRowSignal,
  pluginRuntimeStatusPresentation,
} from "./plugin-status";
import { PluginRowSignalView, PluginSignalLogo } from "./PluginRowSignal";
import {
  OmnyoAuthorByline,
  PluginCard,
  PluginCardGrid,
  PluginCardAuthor,
  PluginAuthorByline,
} from "./PluginCard";
import { PluginOfficialBadge } from "./PluginOfficialBadge";
import { pluginIsOfficial } from "./installed-plugin-catalog";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";
import { UpdatePluginDialog } from "./UpdatePluginDialog";
import { PluginLogo } from "./plugin-ui";

export function InstalledPluginsTab({
  entries,
  onOpenPlugin,
}: {
  entries: readonly {
    plugin: PluginListItem;
    catalogEntry?: PluginCatalogSearchEntry;
  }[];
  onOpenPlugin: (pluginId: string, trigger: HTMLButtonElement) => void;
}) {
  const [updateTargetId, setUpdateTargetId] = useState<string | null>(null);

  const visibleEntries = entries.filter(
    ({ plugin }) => plugin.consolidatedInto === undefined,
  );

  const updateTarget =
    updateTargetId === null
      ? null
      : (visibleEntries.find(({ plugin }) => plugin.id === updateTargetId)
          ?.plugin ?? null);

  if (visibleEntries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border">
        <EmptyStateBlock
          icon="Puzzle"
          title="No plugins installed yet"
          description={
            <>
              Browse the catalog or create a plugin. From a terminal, run{" "}
              <code className="rounded bg-state-hover px-1 py-px font-mono text-xs text-foreground">
                omnyo plugin install &lt;source&gt;
              </code>
              .
            </>
          }
        />
      </div>
    );
  }

  return (
    <>
      <PluginCardGrid>
        {visibleEntries.map(({ plugin, catalogEntry }) => (
          <InstalledPluginRow
            key={plugin.id}
            plugin={plugin}
            catalogEntry={catalogEntry}
            onUpdateClick={() => setUpdateTargetId(plugin.id)}
            onOpenPlugin={onOpenPlugin}
          />
        ))}
      </PluginCardGrid>
      {updateTarget !== null ? (
        <UpdatePluginDialog
          plugin={updateTarget}
          open
          onOpenChange={(open) => {
            if (!open) setUpdateTargetId(null);
          }}
        />
      ) : null}
    </>
  );
}

export function InstalledPluginRow({
  plugin,
  onUpdateClick,
  catalogEntry,
  onOpenPlugin,
}: {
  plugin: PluginListItem;
  catalogEntry?: PluginCatalogSearchEntry;
  onUpdateClick: () => void;
  onOpenPlugin: (pluginId: string, trigger: HTMLButtonElement) => void;
}) {
  const { toggle, enabled } = usePluginEnabledMutation(plugin);
  const isLocal = plugin.source.startsWith("path:");
  const official = pluginIsOfficial(plugin, catalogEntry);
  const signal = pluginRowSignal(plugin);
  const statusSignal = signal?.kind === "status" ? signal : null;
  const updateSignal = signal?.kind === "update" ? signal : null;
  const runtimeStatus = pluginRuntimeStatusPresentation(plugin);

  const notRunning = pluginNeedsAttention({
    enabled: enabled === true,
    status: plugin.status,
  });

  const runtimeStatusToneClass =
    runtimeStatus?.tone === "error"
      ? "text-destructive-text"
      : runtimeStatus?.tone === "warning"
        ? "text-warning-text"
        : "text-muted-foreground";

  const openDetail = (trigger: HTMLButtonElement) =>
    onOpenPlugin(plugin.id, trigger);

  return (
    <div data-testid={`plugin-row-${plugin.id}`}>
      <PluginCard
        leading={
          <PluginSignalLogo signal={statusSignal} onStatusClick={openDetail}>
            <ResourceIconFrame className="size-6 rounded border border-border bg-muted/40 text-muted-foreground">
              {() => <PluginLogo plugin={plugin} className="size-4" />}
            </ResourceIconFrame>
          </PluginSignalLogo>
        }
        title={plugin.name ?? plugin.id}
        byline={
          catalogEntry !== undefined ? (
            <PluginCardAuthor
              entry={{
                ...catalogEntry,
                author: plugin.author ?? catalogEntry.author,
                official,
              }}
            />
          ) : plugin.author != null ? (
            <PluginAuthorByline
              name={plugin.author.name}
              github={plugin.author.github}
              official={official}
            >
              {plugin.author.name}
            </PluginAuthorByline>
          ) : isLocal ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate">Local</span>
              {official ? <PluginOfficialBadge /> : null}
            </span>
          ) : plugin.provenance === "builtin" ? (
            <OmnyoAuthorByline official={official} />
          ) : plugin.publisherLabel !== null ? (
            <PluginAuthorByline
              name={plugin.publisherLabel}
              github={null}
              official={official}
            >
              {plugin.publisherLabel}
            </PluginAuthorByline>
          ) : null
        }
        description={
          runtimeStatus === null ? (
            plugin.description
          ) : (
            <span>
              <span
                data-testid={`plugin-runtime-status-${plugin.id}`}
                className={cn("font-medium", runtimeStatusToneClass)}
              >
                {runtimeStatus.label}
              </span>
              {" · "}
              <span>{plugin.statusDetail ?? runtimeStatus.condition}</span>
            </span>
          )
        }
        openLabel={`${plugin.name ?? plugin.id} plugin details`}
        onOpen={openDetail}
        footerAction={
          <span className="flex items-center gap-2">
            {updateSignal !== null ? (
              <span data-testid={`plugin-update-signal-${plugin.id}`}>
                <PluginRowSignalView
                  signal={updateSignal}
                  onUpdateClick={onUpdateClick}
                  onStatusClick={openDetail}
                />
              </span>
            ) : undefined}
            {notRunning ? (
              <span
                data-testid={`plugin-not-running-${plugin.id}`}
                className={cn("sr-only", runtimeStatusToneClass)}
              >
                not running
              </span>
            ) : null}
            {enabled === false ? (
              <span
                aria-hidden="true"
                className="text-xs text-muted-foreground"
              >
                Off
              </span>
            ) : null}
            <Switch
              checked={enabled}
              disabled={toggle.isPending}
              onCheckedChange={(next) => toggle.mutate(next)}
              aria-label={`${enabled ? "Disable" : "Enable"} ${plugin.id}${
                notRunning ? ` (${plugin.status}, not running)` : ""
              }`}
            />
          </span>
        }
      />
    </div>
  );
}
