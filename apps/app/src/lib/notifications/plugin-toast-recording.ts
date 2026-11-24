import type { Action, ExternalToast } from "sonner";
import type { ReactNode } from "react";
import { recordNotification } from "./notification-store";
import type { AppToastTone } from "@/components/ui/app-toast";

type ToastMessage = ReactNode | ((id: number | string) => ReactNode);

interface RecordedToastMethod {
  (message: ToastMessage, data?: ExternalToast): string | number;
}

const RECORDED_METHOD_TONES: Readonly<Record<string, AppToastTone>> = {
  success: "success",
  error: "error",
  warning: "warning",
  info: "message",
  message: "message",
};

function isToastAction(action: ExternalToast["action"]): action is Action {
  return (
    typeof action === "object" &&
    action !== null &&
    "label" in action &&
    "onClick" in action &&
    typeof action.onClick === "function"
  );
}

function recordPluginToast(
  tone: AppToastTone,
  message: ToastMessage,
  data: ExternalToast | undefined,
): void {
  if (typeof message === "function") {
    return;
  }

  const description = data?.description;
  const action = data?.action;
  recordNotification({
    toastId: data?.id ?? null,
    tone,
    title: message,
    description:
      description === undefined || typeof description === "function"
        ? null
        : description,
    actions: isToastAction(action)
      ? [
          {
            kind: "open",
            label: action.label,
            run: (event) => action.onClick(event),
          },
        ]
      : [],
    badge: tone !== "success",
    createdAt: Date.now(),
  });
}

export function createRecordingToast<T extends object>(baseToast: T): T {
  const callable = baseToast as RecordedToastMethod;

  const wrapped: RecordedToastMethod = (message, data) => {
    recordPluginToast("message", message, data);

    return callable(message, data);
  };

  Object.assign(wrapped, baseToast);

  for (const [method, tone] of Object.entries(RECORDED_METHOD_TONES)) {
    const original = (baseToast as Record<string, unknown>)[method];

    if (typeof original !== "function") {
      continue;
    }

    const originalMethod = original as RecordedToastMethod;
    Object.assign(wrapped, {
      [method]: (message: ToastMessage, data?: ExternalToast) => {
        recordPluginToast(tone, message, data);

        return originalMethod.call(baseToast, message, data);
      },
    });
  }

  return wrapped as T;
}
