import type { ThreadTimelineActivePromptMode } from "@omnyo/domain";
import { CollapsibleActiveStackCard } from "@/components/promptbox/banner/CollapsibleActiveStackCard";

interface ThreadPromptModeCardProps {
  activePromptMode: ThreadTimelineActivePromptMode | null;
  isExitPending?: boolean;
  isExpanded: boolean;
  onExitPlanMode?: () => void;
  onToggle: () => void;
}

const BODY_ID = "thread-prompt-mode-card-body";

const TOGGLE_ID = "thread-prompt-mode-card-toggle";

export function ThreadPromptModeCard({
  activePromptMode,
  isExitPending = false,
  isExpanded,
  onExitPlanMode,
  onToggle,
}: ThreadPromptModeCardProps) {
  if (activePromptMode?.mode !== "plan") {
    return null;
  }

  const promptText = activePromptMode.prompt.trim();
  const hasPrompt = promptText.length > 0;

  return (
    <CollapsibleActiveStackCard
      cardAriaLabel="Prompt mode"
      controlsAriaLabel="Plan mode controls"
      toggleId={TOGGLE_ID}
      bodyId={BODY_ID}
      toggleAriaLabel="Plan mode: the agent proposes a plan before changing files"
      iconName="ListTodo"
      title="Plan mode"
      description="Proposes a plan before changing files"
      isExpanded={isExpanded}
      onToggle={onToggle}
      dismiss={
        onExitPlanMode
          ? {
              ariaLabel: "Exit plan mode",
              label: "Exit plan mode",
              pendingLabel: "Exiting…",
              isPending: isExitPending,
              onDismiss: onExitPlanMode,
            }
          : null
      }
    >
      <div className="px-3 pb-2.5 pt-2">
        <p className="text-2xs font-medium text-subtle-foreground">
          Planning for
        </p>
        <p
          className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-foreground"
          title={promptText}
        >
          {hasPrompt ? promptText : "No request text."}
        </p>
      </div>
    </CollapsibleActiveStackCard>
  );
}
