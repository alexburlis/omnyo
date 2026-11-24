import { useMemo } from "react";
import type { PendingInteractionUserQuestionQuestion } from "@omnyo/domain";
import { Icon } from "@omnyo/shared-ui/icon";
import { QuestionForm } from "@/components/ui/question-form";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { shellHaptic } from "@/lib/native-shell/native-shell";

interface UserQuestionAnswerFormProps {
  interactionId: string;
  isResolving: boolean;
  questions: readonly PendingInteractionUserQuestionQuestion[];
  threadId: string;
}

export function UserQuestionAnswerForm({
  interactionId,
  isResolving,
  questions,
  threadId,
}: UserQuestionAnswerFormProps) {
  const normalizedQuestions = useMemo(
    () =>
      questions.map((question, index) => ({
        ...question,
        shortLabel: question.shortLabel ?? `Question ${index + 1}`,
        options: question.options ?? [],
      })),
    [questions],
  );

  const resolvePendingInteraction = useResolveThreadPendingInteraction(
    threadId,
    interactionId,
  );

  const stopThread = useStopThread();
  const disabled = resolvePendingInteraction.isPending || isResolving;

  const error = resolvePendingInteraction.error
    ? getMutationErrorMessage({
        error: resolvePendingInteraction.error,
        fallbackMessage: "Submit it again to retry.",
        lifecycleOperation: "resolve_interaction",
      })
    : null;

  return (
    <div>
      <QuestionForm
        key={interactionId}
        threadId={threadId}
        draftKey={`${threadId}:${interactionId}`}
        questions={normalizedQuestions}
        disabled={disabled}
        submissionPending={disabled}
        cancelDisabled={disabled || stopThread.isPending}
        onSubmit={(answers) => {
          return resolvePendingInteraction
            .mutateAsync({
              threadId,
              interactionId,
              resolution: { kind: "user_answer", answers },
            })
            .then(
              () => shellHaptic("success"),
              (error: unknown) => {
                shellHaptic("error");
                throw error;
              },
            );
        }}
        onCancel={() => stopThread.mutateAsync(threadId).then(() => {})}
      />
      {error ? (
        <div
          role="alert"
          className="mt-2 flex shrink-0 items-start gap-2 rounded-md border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text"
        >
          <Icon
            name="AlertCircle"
            className="mt-px size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0">
            <span className="font-medium">Your answer wasn’t sent.</span>{" "}
            {error}
          </span>
        </div>
      ) : null}
    </div>
  );
}
