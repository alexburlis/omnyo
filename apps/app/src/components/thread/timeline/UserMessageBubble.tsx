import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react";
import { MessageTouchActions, type MessageAction } from "./message-actions.js";

export const MESSAGE_ACTION_SLOT_HEIGHT_CLASS = "h-5";

const USER_MESSAGE_BUBBLE_CLASS =
  "max-w-full rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5 text-sm leading-relaxed text-foreground [&_[data-image-anchor-active=true][data-prompt-mention]]:ring-2 [&_[data-image-anchor-active=true][data-prompt-mention]]:ring-ring";

interface UserMessageBubbleTouchActions {
  actions: readonly MessageAction[];
  timestamp: number;
  canSelectText: boolean;
}

interface UserMessageBubbleProps {
  label: ReactElement | null;
  bubbleProps?: Omit<ComponentPropsWithRef<"div">, "className" | "children">;
  children: ReactNode;
  actions: ReactElement | null;
  touchActions?: UserMessageBubbleTouchActions;
}

export function UserMessageBubble({
  label,
  bubbleProps,
  children,
  actions,
  touchActions,
}: UserMessageBubbleProps) {
  const bubble = (
    <div {...bubbleProps} className={USER_MESSAGE_BUBBLE_CLASS}>
      {children}
    </div>
  );

  return (
    <div className="w-full" data-message-column="">
      <div className="group/message ml-auto flex w-fit max-w-[70%] flex-col items-end">
        {label === null ? null : (
          <div className="mb-1 flex items-center justify-end gap-2">
            {label}
          </div>
        )}
        <div className="flex w-fit max-w-full flex-col items-end">
          {touchActions === undefined ? (
            bubble
          ) : (
            <MessageTouchActions {...touchActions}>
              {bubble}
            </MessageTouchActions>
          )}
          {actions ?? (
            <div aria-hidden className={MESSAGE_ACTION_SLOT_HEIGHT_CLASS} />
          )}
        </div>
      </div>
    </div>
  );
}
