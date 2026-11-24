import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import type { TerminalCreateTarget } from "@omnyo/server-contract";
import { ThreadTerminalContent } from "./ThreadTerminalContent";
import type { TerminalInputInterceptor } from "./ThreadTerminalView";
import { useThreadTerminalController } from "./useThreadTerminalController";

interface ThreadTerminalPanelProps {
  autoFocus?: boolean;
  isPanelOpen: boolean;
  isPanelPersistedOpen: boolean;
  onAutoFocusHandled?: () => void;
  onOpenLink?: MarkdownPreviewLinkHandler;
  onSelectionAddToChat?: (text: string) => void;
  interceptInput?: TerminalInputInterceptor;
  terminalId: string;
  target: TerminalCreateTarget;
}

export function ThreadTerminalPanel({
  autoFocus = false,
  isPanelOpen,
  isPanelPersistedOpen,
  onAutoFocusHandled,
  onOpenLink,
  onSelectionAddToChat,
  interceptInput,
  terminalId,
  target,
}: ThreadTerminalPanelProps) {
  const terminalController = useThreadTerminalController({
    isPanelOpen,
    isPanelPersistedOpen,
    terminalId,
    target,
  });

  return (
    <section
      aria-label="Terminal"
      data-app-terminal=""
      className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar"
    >
      <div className="min-h-0 flex-1 overflow-hidden bg-sidebar">
        <ThreadTerminalContent
          autoFocus={autoFocus}
          controller={terminalController}
          onAutoFocusHandled={onAutoFocusHandled}
          onOpenLink={onOpenLink}
          onSelectionAddToChat={onSelectionAddToChat}
          interceptInput={interceptInput}
        />
      </div>
    </section>
  );
}
