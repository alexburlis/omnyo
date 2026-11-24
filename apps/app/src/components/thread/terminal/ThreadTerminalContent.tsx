import { EmptyStateBlock } from "@omnyo/shared-ui/empty-state";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import {
  ThreadTerminalView,
  type TerminalInputInterceptor,
} from "./ThreadTerminalView";
import type { ThreadTerminalController } from "./useThreadTerminalController";

interface ThreadTerminalContentProps {
  autoFocus?: boolean;
  controller: ThreadTerminalController;
  onAutoFocusHandled?: () => void;
  onOpenLink?: MarkdownPreviewLinkHandler;
  onSelectionAddToChat?: (text: string) => void;
  interceptInput?: TerminalInputInterceptor;
}

export function ThreadTerminalContent({
  autoFocus = false,
  controller,
  onAutoFocusHandled,
  onOpenLink,
  onSelectionAddToChat,
  interceptInput,
}: ThreadTerminalContentProps) {
  if (!controller.shouldMountTerminalView) {
    return null;
  }

  if (controller.hasTerminalQueryError) {
    return (
      <div role="alert" className="flex h-full items-center justify-center">
        <EmptyStateBlock
          icon="AlertCircle"
          tone="error"
          title="Couldn’t load terminals"
          description="Omnyo couldn’t read this chat’s terminal sessions."
        />
      </div>
    );
  }

  if (!controller.activeSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyStateBlock
          icon="Terminal"
          title={controller.terminalBodyMessage}
        />
      </div>
    );
  }

  const session = controller.activeSession;
  const status = session.status;

  if (status !== "running" && status !== "disconnected") {
    const exited = status === "exited";

    return (
      <div
        role="status"
        className="flex h-full items-center justify-center bg-sidebar"
      >
        <EmptyStateBlock
          icon="Terminal"
          title={exited ? "This terminal has ended" : "Starting terminal…"}
          description={
            exited
              ? session.exitCode === null || session.exitCode === 0
                ? "The shell finished and no longer accepts input."
                : `The shell exited with code ${session.exitCode} and no longer accepts input.`
              : "Connecting to the shell on this chat’s machine."
          }
        />
      </div>
    );
  }

  return (
    <ThreadTerminalView
      autoFocus={autoFocus}
      isPanelOpen={controller.isPanelOpen}
      onAutoFocusHandled={onAutoFocusHandled}
      onOpenLink={onOpenLink}
      onSelectionAddToChat={onSelectionAddToChat}
      interceptInput={interceptInput}
      onSessionChange={controller.handleActiveTerminalSessionChange}
      onTitleChange={controller.handleActiveTerminalTitleChange}
      session={controller.activeSession}
    />
  );
}
