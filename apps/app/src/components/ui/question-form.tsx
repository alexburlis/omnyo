import "./compact-question-form.css";
import { useRef, useState } from "react";
import { MarkdownPreview } from "./markdown-preview";
import { buildMarkdownMessageLinkRouting } from "./markdown-message-link-routing";
import { flushSync } from "react-dom";
import {
  QuestionForm as SharedQuestionForm,
  type QuestionFormProps,
} from "@omnyo/shared-ui/question-form";
import { Icon } from "@omnyo/shared-ui/icon";
import { shellHaptic } from "@/lib/native-shell/native-shell";
import { useBottomAnchoredScroll } from "./bottom-anchored-scroll-body.js";

function pulseSelection(): void {
  shellHaptic("selection");
}

export function QuestionForm({
  threadId,
  submissionPending = false,
  onSubmit,
  onCancel,
  ...props
}: Omit<QuestionFormProps, "onSelectionChange"> & {
  threadId?: string;
  submissionPending?: boolean;
}) {
  const [pendingAction, setPendingAction] = useState<
    "submit" | "cancel" | null
  >(null);

  const bottomAnchor = useBottomAnchoredScroll();
  const inFlight = useRef<Promise<void> | null>(null);
  const pending = submissionPending || pendingAction !== null;

  const run = (
    action: "submit" | "cancel",
    command: () => void | Promise<void>,
  ) => {
    if (inFlight.current) return inFlight.current;
    flushSync(() => setPendingAction(action));
    bottomAnchor?.scrollToBottom();

    const task = (async () => {
      await command();
    })();

    inFlight.current = task;

    return task.finally(() => {
      if (inFlight.current === task) {
        inFlight.current = null;
        setPendingAction(null);
      }
    });
  };

  return (
    <>
      {pending ? (
        <div
          role="status"
          className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
        >
          <Icon name="Spinner" className="size-3 animate-spin" />
          {pendingAction === "cancel" ? "Cancelling…" : "Sending answer…"}
        </div>
      ) : null}
      <div hidden={pending} data-compact-questions="">
        <SharedQuestionForm
          {...props}
          renderRichPreview={(preview) =>
            /!\[[^\]]*\]\(|^\s*<[a-z][\w-]*(?:\s|\/?>)/iu.test(preview) ? (
              <MarkdownPreview
                allowHtml
                content={preview}
                linkRouting={buildMarkdownMessageLinkRouting({ threadId })}
              />
            ) : null
          }
          onSelectionChange={pulseSelection}
          disabled={props.disabled || pending}
          cancelDisabled={props.cancelDisabled || pending}
          onSubmit={(answers) => run("submit", () => onSubmit(answers))}
          onCancel={() => run("cancel", onCancel)}
        />
      </div>
    </>
  );
}
