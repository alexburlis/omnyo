import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  pluginCommandId,
  type AppKeybindingOverrides,
  type AppShortcut,
  type KeyboardCommandId,
} from "@omnyo/domain";
import { APP_COMMAND_GROUPS } from "@/lib/app-command-metadata";
import {
  getShortcutConflicts,
  resetCommandShortcutOverride,
  setCommandShortcutOverride,
} from "@/lib/keyboard-shortcut-settings";
import { browserPlatform } from "@/lib/app-keybindings";
import { useUpdateKeyboardSettings } from "@/hooks/mutations/settings-mutations";
import { usePluginCommandBindings } from "@/hooks/usePluginCommandBindings";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { getOmnyoDesktopInfo } from "@/lib/omnyo-desktop";

const EMPTY_OVERRIDES: AppKeybindingOverrides = [];

export interface AppShortcutCommandMetadata {
  command: KeyboardCommandId;
  description: string;
  label: string;
}

export interface AppShortcutCommandGroup {
  commands: readonly AppShortcutCommandMetadata[];
  label: string;
}

export interface PendingShortcutAssignment {
  command: KeyboardCommandId;
  conflicts: KeyboardCommandId[];
  shortcut: AppShortcut;
}

export function useAppShortcutEditor() {
  const systemConfig = useSystemConfig();

  const {
    isPending: isKeyboardSettingsPending,
    mutate: mutateKeyboardSettings,
  } = useUpdateKeyboardSettings();

  const isDesktop = getOmnyoDesktopInfo() !== null;
  const platform = browserPlatform();

  const {
    defaults,
    commands,
    conflicts: defaultConflicts,
  } = usePluginCommandBindings();

  const commandGroups = useMemo<readonly AppShortcutCommandGroup[]>(
    () => [
      ...APP_COMMAND_GROUPS,
      {
        label: "Plugin commands",
        commands: commands.map((command) => ({
          command: pluginCommandId(command.pluginId, command.id),
          label: command.title,
          description: `Plugin: ${command.pluginId}`,
        })),
      },
    ],
    [commands],
  );

  const labels = useMemo(
    () =>
      new Map<KeyboardCommandId, string>(
        commandGroups.flatMap((group) =>
          group.commands.map(
            (command) => [command.command, command.label] as const,
          ),
        ),
      ),
    [commandGroups],
  );

  const [pendingAssignment, setPendingAssignment] =
    useState<PendingShortcutAssignment | null>(null);

  const serverOverrides =
    systemConfig.data?.keybindingOverrides ?? EMPTY_OVERRIDES;

  const serverOverridesKey = JSON.stringify(serverOverrides);

  const [draft, setDraft] = useState<{
    sourceKey: string;
    value: AppKeybindingOverrides;
  }>(() => ({ sourceKey: serverOverridesKey, value: serverOverrides }));

  const overrides =
    draft.sourceKey === serverOverridesKey ? draft.value : serverOverrides;

  const pendingCommandRef = useRef<KeyboardCommandId | null>(null);

  const latestSettingsRef = useRef({
    defaults,
    isDesktop,
    overrides,
    platform,
    serverOverridesKey,
  });

  useLayoutEffect(() => {
    latestSettingsRef.current = {
      defaults,
      isDesktop,
      overrides,
      platform,
      serverOverridesKey,
    };
  }, [defaults, isDesktop, overrides, platform, serverOverridesKey]);

  const applyOverrides = useCallback(
    (
      next: AppKeybindingOverrides,
      pending: KeyboardCommandId | null,
      previous: AppKeybindingOverrides,
      sourceKey: string,
    ) => {
      pendingCommandRef.current = pending;
      setDraft({ sourceKey, value: next });
      mutateKeyboardSettings(next, {
        onError: () => setDraft({ sourceKey, value: previous }),
      });
    },
    [mutateKeyboardSettings],
  );

  const assignCommand = useCallback(
    (
      command: KeyboardCommandId,
      shortcut: AppShortcut | null,
      replace: boolean,
    ): "applied" | "conflict" => {
      const current = latestSettingsRef.current;

      let next = setCommandShortcutOverride(
        current.overrides,
        command,
        shortcut,
        current.platform,
      );

      const conflicts = getShortcutConflicts(
        current.defaults,
        next,
        command,
        current.isDesktop,
        current.platform,
      );

      if (shortcut !== null && conflicts.length > 0 && !replace) {
        setPendingAssignment({ command, shortcut, conflicts });

        return "conflict";
      }

      if (replace) {
        for (const conflict of conflicts) {
          next = setCommandShortcutOverride(
            next,
            conflict,
            null,
            current.platform,
          );
        }
      }

      setPendingAssignment(null);
      applyOverrides(
        next,
        command,
        current.overrides,
        current.serverOverridesKey,
      );

      return "applied";
    },
    [applyOverrides],
  );

  const resetCommands = useCallback(
    (commandsToReset: readonly KeyboardCommandId[]) => {
      const current = latestSettingsRef.current;

      const next = commandsToReset.reduce(
        (result, command) =>
          resetCommandShortcutOverride(result, command, current.platform),
        current.overrides,
      );

      setPendingAssignment(null);
      applyOverrides(
        next,
        commandsToReset.length === 1 ? (commandsToReset[0] ?? null) : null,
        current.overrides,
        current.serverOverridesKey,
      );
    },
    [applyOverrides],
  );

  const pendingCommand = isKeyboardSettingsPending
    ? pendingCommandRef.current
    : null;

  return {
    assignCommand,
    commandGroups,
    defaultConflicts,
    defaults,
    disabled: systemConfig.data === undefined || isKeyboardSettingsPending,
    isDesktop,
    isPending: isKeyboardSettingsPending,
    labels,
    loaded: systemConfig.data !== undefined,
    overrides,
    pendingAssignment,
    pendingCommand,
    platform,
    resetCommands,
    setPendingAssignment,
  };
}
