import { hashKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { z } from "zod";
import type { ThreadAttentionSnapshot } from "@omnyo/domain";

const submissionKeySchema = z
  .tuple([
    z.literal("native-question-command"),
    z.string(),
    z.array(z.tuple([z.string(), z.number().int().positive()])),
  ])
  .transform(([, threadId, questions]) =>
    questions.map(([id, revision]) => ({ threadId, id, revision })),
  );

type NativeQuestionSubmission = {
  threadId: string;
  id: string;
  revision: number;
  submittedAt: number;
};

export function nativeQuestionSubmissionKey(
  threadId: string,
  questions: readonly { id: string; revision: number }[],
) {
  return [
    "native-question-command",
    threadId,
    questions.map((question) => [question.id, question.revision]),
  ];
}

export function useNativeQuestionSubmissions() {
  const cache = useQueryClient().getMutationCache();
  const snapshot = useRef<NativeQuestionSubmission[]>([]);

  const getSnapshot = useCallback(() => {
    const submissions = cache
      .findAll({
        mutationKey: ["native-question-command"],
        predicate: (mutation) =>
          mutation.state.status === "pending" ||
          mutation.state.status === "success",
      })
      .flatMap((mutation) => {
        const parsed = submissionKeySchema.safeParse(
          mutation.options.mutationKey,
        );

        return parsed.success
          ? parsed.data.map((question) => ({
              ...question,
              submittedAt: mutation.state.submittedAt,
            }))
          : [];
      });

    if (
      submissions.length !== snapshot.current.length ||
      submissions.some((submission, index) => {
        const current = snapshot.current[index];

        return (
          current === undefined ||
          submission.threadId !== current.threadId ||
          submission.id !== current.id ||
          submission.revision !== current.revision ||
          submission.submittedAt !== current.submittedAt
        );
      })
    )
      snapshot.current = submissions;

    return snapshot.current;
  }, [cache]);

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      cache.subscribe((event) => {
        if (
          event.mutation?.options.mutationKey?.[0] !== "native-question-command"
        )
          return;
        const previous = snapshot.current;

        if (getSnapshot() !== previous) onStoreChange();
      }),
    [cache, getSnapshot],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useNativeQuestionSubmission(mutationKey: readonly unknown[]) {
  const cache = useQueryClient().getMutationCache();
  const mutationKeyHash = hashKey(mutationKey);

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      cache.subscribe((event) => {
        const eventKey = event.mutation?.options.mutationKey;

        if (eventKey !== undefined && hashKey(eventKey) === mutationKeyHash)
          onStoreChange();
      }),
    [cache, mutationKeyHash],
  );

  const getSnapshot = () =>
    cache.findAll({ mutationKey, exact: true }).at(-1)?.state;

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function projectSubmittedNativeQuestions(
  snapshot: ThreadAttentionSnapshot | undefined,
  submissions: readonly NativeQuestionSubmission[],
): ThreadAttentionSnapshot | undefined {
  if (snapshot === undefined || submissions.length === 0) return snapshot;

  const questions = snapshot.questions.filter(
    (question) =>
      !submissions.some(
        (submission) =>
          submission.threadId === question.threadId &&
          submission.id === question.id &&
          submission.revision === question.revision,
      ),
  );

  return questions.length === snapshot.questions.length
    ? snapshot
    : { ...snapshot, questions };
}
