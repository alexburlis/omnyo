import { useNavigation, useRouter } from "expo-router";
import { useState, type ReactNode } from "react";
import {
  Alert,
  Linking,
  Pressable,
  type AccessibilityActionEvent,
} from "react-native";
import { useProfiles } from "@/app-shell";
import { connectDashboardUrl } from "@/data/connect";
import { describeError } from "@/lib/describe-error";
import { haptic, iosHaptic } from "@/lib/haptics";
import { PROFILE_LABEL_MAX_LENGTH, type ServerProfile } from "@/lib/profiles";
import { useTheme } from "@/theme";
import {
  ActionSheet,
  confirmDestructive,
  Icon,
  toast,
  useSheet,
  type ActionSheetAction,
  type GroupedRowProps,
} from "@/ui";
import { dismissToShell } from "../shell/dismiss-to-shell";
import { connectEnrollHref, webViewShellHref } from "../shell/hrefs";

const IS_IOS = process.env.EXPO_OS === "ios";

type ServerRowActions = Required<
  Pick<
    GroupedRowProps,
    "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
  >
>;

export interface ServerActions {
  switchTo(profile: ServerProfile): void;
  openOptions(profile: ServerProfile): void;
  rowActions(profile: ServerProfile): ServerRowActions;
  sheet: ReactNode;
}

function removalMessage(profile: ServerProfile): string {
  return profile.mode === "connect"
    ? `This phone forgets ${profile.label}. Other servers on the same Omnyo connect account stay signed in. To revoke this phone, open omnyo.link → Machines.`
    : `This phone forgets ${profile.label}. Nothing on the server changes.`;
}

function openDashboard(profile: ServerProfile): void {
  Linking.openURL(connectDashboardUrl(profile.serverUrl)).catch(
    (error: unknown) => {
      toast.error("Could not open the dashboard", {
        description: describeError(error),
      });
    },
  );
}

export function useServerActions(): ServerActions {
  const router = useRouter();
  const navigation = useNavigation();

  const { activeProfile, setActiveProfile, updateProfile, removeProfile } =
    useProfiles();

  const menu = useSheet();
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [target, setTarget] = useState<ServerProfile | null>(null);

  const switchTo = (profile: ServerProfile) => {
    if (profile.id === activeProfile?.id) return;
    setActiveProfile(profile.id).then(
      () => {
        iosHaptic("selection");
        dismissToShell(router, navigation, webViewShellHref());
        toast.success(`Switched to ${profile.label}`);
      },
      (error: unknown) => {
        iosHaptic("error");
        toast.error("Could not switch server", {
          description: describeError(error),
        });
      },
    );
  };

  const remove = (profile: ServerProfile) => {
    removeProfile(profile.id).then(
      (removal) => {
        if (removal.sessionCleared) {
          iosHaptic("success");
          toast.success(`Removed ${profile.label}`);

          return;
        }

        iosHaptic("error");
        toast.error("Could not clear the saved sign-in", {
          description: `${profile.label} was removed from this phone. ${describeError(removal.error)}`,
        });
      },
      (error: unknown) => {
        iosHaptic("error");
        toast.error("Could not remove server", {
          description: describeError(error),
        });
      },
    );
  };

  const confirmRemove = (profile: ServerProfile) =>
    confirmDestructive({
      title: `Remove ${profile.label}?`,
      message: removalMessage(profile),
      actionLabel: "Remove",
      secondaryAction:
        profile.mode === "connect"
          ? { label: "Open dashboard", onPress: () => openDashboard(profile) }
          : undefined,
      onConfirm: () => remove(profile),
    });

  const requestRemoval = (profile: ServerProfile) => {
    if (IS_IOS) {
      confirmRemove(profile);

      return;
    }

    setTarget(profile);
    setConfirmingRemoval(true);
    menu.present();
  };

  const saveLabel = (profile: ServerProfile, value: string) => {
    const label = value.trim().slice(0, PROFILE_LABEL_MAX_LENGTH);

    if (label.length === 0) {
      iosHaptic("error");
      toast.error("Could not rename server", {
        description: "Enter a name for the server.",
      });

      return;
    }

    if (label === profile.label) return;
    updateProfile(profile.id, { label }).then(
      () => {
        iosHaptic("success");
        toast.success(`Renamed to ${label}`);
      },
      (error: unknown) => {
        iosHaptic("error");
        toast.error("Could not rename server", {
          description: describeError(error),
        });
      },
    );
  };

  const rename = (profile: ServerProfile) => {
    if (process.env.EXPO_OS !== "ios") return;
    Alert.prompt(
      "Rename server",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          onPress: (value?: string) => saveLabel(profile, value ?? ""),
        },
      ],
      "plain-text",
      profile.label,
    );
  };

  const actionsFor = (profile: ServerProfile): ActionSheetAction[] => [
    ...(IS_IOS || profile.id !== activeProfile?.id
      ? [
          {
            key: "activate",
            label: "Use this server",
            icon: "Check" as const,
            disabled: profile.id === activeProfile?.id,
            onPress: () => switchTo(profile),
          },
        ]
      : []),
    ...(IS_IOS
      ? [
          {
            key: "rename",
            label: "Rename",
            icon: "Pencil" as const,
            onPress: () => rename(profile),
          },
        ]
      : []),
    ...(profile.mode === "connect"
      ? [
          {
            key: "reauth",
            label: "Sign in again",
            icon: "Lock" as const,
            onPress: () => {
              router.push(connectEnrollHref({ profileId: profile.id }));
            },
          },
        ]
      : []),
    {
      key: "remove",
      label: "Remove",
      icon: "Trash2",
      destructive: true,
      dismissOnPress: IS_IOS,
      onPress: () => {
        if (IS_IOS) confirmRemove(profile);
        else setConfirmingRemoval(true);
      },
    },
  ];

  const removalActions = (profile: ServerProfile): ActionSheetAction[] => [
    {
      key: "confirm-remove",
      label: "Remove server",
      icon: "Trash2",
      destructive: true,
      onPress: () => remove(profile),
    },
    ...(profile.mode === "connect"
      ? [
          {
            key: "open-dashboard",
            label: "Open dashboard",
            onPress: () => openDashboard(profile),
          },
        ]
      : []),
  ];

  const openOptions = (profile: ServerProfile) => {
    setTarget(profile);
    menu.present();
  };

  const rowActions = (profile: ServerProfile): ServerRowActions => {
    const actions = actionsFor(profile).filter(
      (action) => action.key !== "activate" && !action.disabled,
    );

    return {
      onLongPress: () => {
        haptic("impact-heavy");
        openOptions(profile);
      },
      accessibilityActions: actions.map((action) => ({
        name: action.key,
        label: action.label,
      })),
      onAccessibilityAction: (event: AccessibilityActionEvent) => {
        const name = event.nativeEvent.actionName;

        if (name === "remove") {
          requestRemoval(profile);

          return;
        }

        actions.find((action) => action.key === name)?.onPress();
      },
    };
  };

  const sheet = (
    <ActionSheet
      controller={menu}
      cancelLabel={IS_IOS || confirmingRemoval ? "Cancel" : null}
      status={
        !IS_IOS && !confirmingRemoval && target?.id === activeProfile?.id
          ? "Current"
          : undefined
      }
      presentation={confirmingRemoval ? "prompt" : "menu"}
      title={confirmingRemoval ? `Remove ${target?.label}?` : target?.label}
      message={
        target === null
          ? undefined
          : confirmingRemoval
            ? removalMessage(target)
            : target.serverUrl
      }
      actions={
        target === null
          ? []
          : confirmingRemoval
            ? removalActions(target)
            : actionsFor(target)
      }
      onDismiss={() => setConfirmingRemoval(false)}
    />
  );

  return { switchTo, openOptions, rowActions, sheet };
}

export function ServerOptionsButton({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const { tokens } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Options for ${label}`}
      onPress={onPress}
      testID={testID}
      className="-my-3 -mr-2 h-11 w-11 items-center justify-center rounded-full active:bg-state-active"
    >
      <Icon
        name="Info"
        size={22}
        color={IS_IOS ? tokens.primary : tokens.mutedForeground}
      />
    </Pressable>
  );
}
