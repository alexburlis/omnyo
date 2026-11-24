import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import {
  SETTINGS_COMPACT_DROPDOWN_TRIGGER_CLASS,
  SETTINGS_DROPDOWN_CONTENT_CLASS,
} from "./settings-dropdown";
import { useMemo, useState } from "react";
import type {
  WorkspaceOpenTarget,
  WorkspaceOpenTargetId,
} from "@omnyo/host-daemon-contract";
import { WorkspaceOpenTargetIcon } from "@/components/workspace-open-target/WorkspaceOpenTargetIcon";
import { getWorkspaceOpenTargetFallbackLabel } from "@/components/workspace-open-target/workspace-open-target-display";
import { useHostDaemon, useLocalHostDaemonAccess } from "@/hooks/useHostDaemon";
import { useWorkspaceOpenTargets } from "@/hooks/useWorkspaceOpenTargets";
import {
  resolvePreferredWorkspaceOpenTarget,
  supportsWorkspaceOpenTargetCapability,
  useFileOpenTargetPreference,
  useWorkspaceOpenTargetPreference,
  type StoredWorkspaceOpenTargetPreference,
  type WorkspaceOpenTargetCapability,
} from "@/lib/workspace-open-target-preference";
import type { LocalHostDaemonAccessState } from "@/lib/local-host-daemon-access";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { FileOpenersSettingsSection } from "./FileOpenersSettingsSection";
import { SETTINGS_ROW_STACK_CLASS } from "./settings-row-stack";

interface LocalOpenTargetPreferenceDefinition {
  capability: WorkspaceOpenTargetCapability;
  emptyDescription: string;
  label: string;
}

interface LocalOpenTargetPreferenceControlProps {
  definition: LocalOpenTargetPreferenceDefinition;
  onTargetChange: (targetId: WorkspaceOpenTargetId) => void;
  preferredTargetId: StoredWorkspaceOpenTargetPreference;
  targets: WorkspaceOpenTarget[];
}

export interface LocalOpenTargetSettingsSectionProps {
  accessState: LocalHostDaemonAccessState;
  directoryTargetId: StoredWorkspaceOpenTargetPreference;
  fileTargetId: StoredWorkspaceOpenTargetPreference;
  hasDaemon: boolean;
  onDirectoryTargetChange: (targetId: WorkspaceOpenTargetId) => void;
  onFileTargetChange: (targetId: WorkspaceOpenTargetId) => void;
  onRequestAccess: () => Promise<boolean>;
  targets: WorkspaceOpenTarget[];
}

const DIRECTORY_TARGET_PREFERENCE: LocalOpenTargetPreferenceDefinition = {
  capability: "openDirectory",
  emptyDescription: "No local app can open directories.",
  label: "Directory default",
};

const FILE_TARGET_PREFERENCE: LocalOpenTargetPreferenceDefinition = {
  capability: "openFile",
  emptyDescription: "No local app can open files.",
  label: "File default",
};

function LocalOpenTargetPreferenceControl({
  definition,
  onTargetChange,
  preferredTargetId,
  targets,
}: LocalOpenTargetPreferenceControlProps) {
  const compatibleTargets = useMemo(
    () =>
      targets.filter((target) =>
        supportsWorkspaceOpenTargetCapability({
          capability: definition.capability,
          target,
        }),
      ),
    [definition.capability, targets],
  );

  const resolvedTarget = useMemo(
    () =>
      resolvePreferredWorkspaceOpenTarget({
        capability: definition.capability,
        preferredTargetId,
        targets,
      }),
    [definition.capability, preferredTargetId, targets],
  );

  const unavailableMessage =
    compatibleTargets.length === 0 ? definition.emptyDescription : null;

  const selectedTargetId = resolvedTarget?.id ?? preferredTargetId;

  const buttonLabel =
    resolvedTarget?.label ??
    (preferredTargetId
      ? getWorkspaceOpenTargetFallbackLabel(preferredTargetId)
      : "Unavailable");

  return (
    <SettingsWithControl label={definition.label}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_COMPACT_DROPDOWN_TRIGGER_CLASS}
            aria-label={definition.label}
          >
            <span className="flex min-w-0 items-center gap-2">
              {selectedTargetId ? (
                <WorkspaceOpenTargetIcon
                  {...(resolvedTarget
                    ? { target: resolvedTarget }
                    : { targetId: selectedTargetId })}
                  className="size-5"
                />
              ) : null}
              <span className="min-w-0 truncate">{buttonLabel}</span>
            </span>
            <Icon
              name="ChevronDown"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        >
          {unavailableMessage ? (
            <div
              role="note"
              className="px-2 py-[0.3125rem] text-xs leading-snug text-foreground"
            >
              {unavailableMessage}
            </div>
          ) : (
            compatibleTargets.map((target) => (
              <DropdownMenuItem
                key={target.id}
                onSelect={() => onTargetChange(target.id)}
              >
                <WorkspaceOpenTargetIcon target={target} className="size-5" />
                <span className="min-w-0 truncate">{target.label}</span>
                <Icon
                  name="Check"
                  className={cn(
                    "ml-auto",
                    resolvedTarget?.id !== target.id && "opacity-0",
                    COARSE_POINTER_ICON_SIZE_CLASS,
                  )}
                />
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}

export function LocalOpenTargetSettingsSection({
  accessState,
  directoryTargetId,
  fileTargetId,
  hasDaemon,
  onDirectoryTargetChange,
  onFileTargetChange,
  onRequestAccess,
  targets,
}: LocalOpenTargetSettingsSectionProps) {
  const [accessRequestPending, setAccessRequestPending] = useState(false);

  if (accessState === "unavailable") {
    return null;
  }

  const handleRequestAccess = async () => {
    setAccessRequestPending(true);

    try {
      await onRequestAccess();
    } finally {
      setAccessRequestPending(false);
    }
  };

  if (!hasDaemon) {
    const accessDenied = accessState === "denied";
    const accessAvailable = accessState === "available";

    const descriptionText = accessDenied
      ? "Your browser blocked access to Omnyo on this device. Allow local network access for this site in browser settings, then reload Omnyo."
      : accessAvailable
        ? "Omnyo couldn’t connect to its local editor helper. Make sure the Omnyo desktop app or CLI is running on this device, then retry. If it is already running, a remote browser origin may need to be configured."
        : "Connect this browser to Omnyo on this device so it can discover installed editors. Omnyo only contacts the local helper after you choose Enable; your browser may ask for local network access.";

    const buttonLabel = accessRequestPending
      ? accessAvailable
        ? "Retrying…"
        : "Enabling…"
      : accessDenied
        ? "Blocked"
        : accessAvailable
          ? "Retry"
          : "Enable";

    return (
      <SettingsSection title="File preferences">
        <SettingsWithControl
          label="Local editor integration"
          description={descriptionText}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={accessRequestPending || accessDenied}
            onClick={handleRequestAccess}
          >
            {buttonLabel}
          </Button>
        </SettingsWithControl>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="File preferences">
      <div className={SETTINGS_ROW_STACK_CLASS}>
        <LocalOpenTargetPreferenceControl
          definition={DIRECTORY_TARGET_PREFERENCE}
          onTargetChange={onDirectoryTargetChange}
          preferredTargetId={directoryTargetId}
          targets={targets}
        />
        <LocalOpenTargetPreferenceControl
          definition={FILE_TARGET_PREFERENCE}
          onTargetChange={onFileTargetChange}
          preferredTargetId={fileTargetId}
          targets={targets}
        />
      </div>
    </SettingsSection>
  );
}

export function FilesSettingsPage() {
  const { hasDaemon } = useHostDaemon();
  const { accessState, requestAccess } = useLocalHostDaemonAccess();

  const { workspaceOpenTargets } = useWorkspaceOpenTargets({
    enabled: hasDaemon,
  });

  const [directoryTargetId, setDirectoryTargetId] =
    useWorkspaceOpenTargetPreference(workspaceOpenTargets);

  const [fileTargetId, setFileTargetId] =
    useFileOpenTargetPreference(workspaceOpenTargets);

  return (
    <>
      <LocalOpenTargetSettingsSection
        accessState={accessState}
        directoryTargetId={directoryTargetId}
        fileTargetId={fileTargetId}
        hasDaemon={hasDaemon}
        onDirectoryTargetChange={setDirectoryTargetId}
        onFileTargetChange={setFileTargetId}
        onRequestAccess={requestAccess}
        targets={workspaceOpenTargets}
      />
      <FileOpenersSettingsSection />
    </>
  );
}
