import { Alert, type AlertButton } from "react-native";
import { haptic } from "@/lib/haptics";

export interface ConfirmDestructiveOptions {
  title: string;
  message?: string;
  actionLabel: string;
  cancelLabel?: string;
  secondaryAction?: { label: string; onPress: () => void };
  onConfirm: () => void;
  onCancel?: () => void;
}

export function confirmDestructive({
  title,
  message,
  actionLabel,
  cancelLabel = "Cancel",
  secondaryAction,
  onConfirm,
  onCancel,
}: ConfirmDestructiveOptions): void {
  haptic("warning");

  const buttons: AlertButton[] = [
    { text: cancelLabel, style: "cancel", onPress: onCancel },
    ...(secondaryAction
      ? [{ text: secondaryAction.label, onPress: secondaryAction.onPress }]
      : []),
    { text: actionLabel, style: "destructive", onPress: onConfirm },
  ];

  Alert.alert(title, message, buttons, {
    cancelable: true,
    onDismiss: onCancel,
  });
}
