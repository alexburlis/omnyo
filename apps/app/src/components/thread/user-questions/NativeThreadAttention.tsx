import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { QuestionForm } from "@/components/ui/question-form";
import type {
  ThreadCallback,
  ThreadQuestion,
  ThreadQuestionAnswer,
} from "@omnyo/domain";
import { sdk } from "@/lib/sdk";
import { shellHaptic } from "@/lib/native-shell/native-shell";
import { formatRelativeTime } from "@/lib/relative-time";
import { useMinuteNow } from "@omnyo/shared-ui/hooks/use-minute-now";
import { useThreadAttention } from "@/hooks/queries/thread-attention";
import {
  nativeQuestionSubmissionKey,
  useNativeQuestionSubmission,
} from "@/hooks/queries/native-question-submissions";
import { applyThreadQuestionCommandResult } from "@/hooks/cache-owners/thread-attention-cache-owner";
import {
  isCachedThreadRunning,
  beginResolvedThreadQuestionTransaction,
} from "@/hooks/cache-owners/thread-answer-cache-owner";
import { answerInboxQuestions } from "@/lib/inbox-predictions";
import { predictInboxSnapshot } from "@/hooks/cache-owners/inbox-snapshot-cache-owner";
import { invalidateThreadListQueries } from "@/hooks/cache-owners/mutation-cache-effects";
import { PendingInteractionShell } from "../pending-interactions/PendingInteractionShell";
import {
  RouteAnchor,
  useActivatedRouteNavigate,
} from "@/components/ui/app-route-anchor";
import { getThreadRoutePath } from "@/lib/route-paths";
import { useSidebarNavigationThreadSelection } from "@/hooks/queries/sidebar-navigation-query";
import { getThreadDisplayTitle } from "@/lib/thread-title";

interface NativeQuestionResolution {
  id: string;
  revision: number;
  answer: ThreadQuestionAnswer | null;
}

export function NativeThreadAttention({ threadId }: { threadId: string }) {
  const snapshot = useThreadAttention();

  if (snapshot.error)
    return (
      <div role="alert" className="text-xs text-destructive-text">
        Questions and callback status could not be loaded.
      </div>
    );

  const questions =
    snapshot.data?.questions.filter(
      (question) => question.threadId === threadId,
    ) ?? [];

  const callback = snapshot.data?.callbacks.find(
    (wait) => wait.threadId === threadId,
  );

  const incoming =
    snapshot.data?.callbacks.filter(
      (wait) => wait.sourceThreadId === threadId,
    ) ?? [];

  return (
    <div className="space-y-2">
      <NativeQuestionFlow
        key={threadId}
        threadId={threadId}
        questions={questions}
      />
      {callback ? <NativeCallback callback={callback} /> : null}
      {incoming.length > 0 ? <WaitingChats callbacks={incoming} /> : null}
    </div>
  );
}

function NativeQuestionFlow({
  threadId,
  questions,
}: {
  threadId: string;
  questions: ThreadQuestion[];
}) {
  const client = useQueryClient();

  const [progressTarget, setProgressTarget] = useState<HTMLDivElement | null>(
    null,
  );

  const mutationKey = nativeQuestionSubmissionKey(threadId, questions);

  const formQuestions = useMemo(
    () =>
      questions.map((question) => ({
        id: `${question.id}:${question.revision}`,
        prompt: question.question.prompt,
        shortLabel:
          question.question.shortLabel === "Question"
            ? question.question.prompt
            : question.question.shortLabel,
        multiSelect: question.question.multiSelect,
        allowFreeText: question.question.allowFreeText,
        additiveNotes: question.question.additiveNotes,
        optional: question.question.mode === "optional",
        ...(question.question.context === null
          ? {}
          : { context: question.question.context }),
        options: question.question.options.map((option) => ({
          value: option.value,
          label: option.label,
          recommended: option.recommended,
          ...(option.description === null
            ? {}
            : { description: option.description }),
          ...(option.preview === null ? {} : { preview: option.preview }),
        })),
      })),
    [questions],
  );

  const mutation = useMutation({
    mutationKey,
    meta: { showErrorToast: false },
    mutationFn: (answers: NativeQuestionResolution[]) =>
      sdk.experimental_attention.command({
        threadId,
        command: { action: "answers", answers },
      }),
    onMutate: async (answers) => {
      const questionIds = answers.map((entry) => entry.id);
      const answered = answers.some((entry) => entry.answer !== null);

      const inbox = predictInboxSnapshot(client, (snapshot) =>
        answerInboxQuestions(
          snapshot,
          threadId,
          questionIds,
          answered || isCachedThreadRunning(client, threadId),
        ),
      );

      const lists = await beginResolvedThreadQuestionTransaction(client, {
        threadId,
        questionIds,
        resolution: answered ? "answered" : "skipped",
      });

      return { inbox, lists };
    },
    onError: (_error, _answers, context) => {
      context?.inbox.discard();
      context?.lists.rollback();
      invalidateThreadListQueries({ queryClient: client });
    },
    onSuccess: (result, _answers, context) => {
      context?.inbox.settle();

      return applyThreadQuestionCommandResult(client, result);
    },
    onSettled: (_result, _error, _answers, context) => context?.lists.release(),
  });

  const submission = useNativeQuestionSubmission(mutationKey);
  const busy = submission?.status === "pending";
  const cause = busy ? null : submission?.error;

  const error = cause
    ? cause instanceof Error
      ? cause.message
      : "Answer could not be sent"
    : null;

  if (questions.length === 0) return null;
  const setKey = formQuestions.map((question) => question.id).join(",");

  const optionalCount = formQuestions.filter(
    (question) => question.optional,
  ).length;

  const count = questions.length;

  const badge =
    optionalCount === count
      ? `${count} optional`
      : optionalCount === 0
        ? `${count} required`
        : `${count} · ${optionalCount} optional`;

  const resolve = (
    answers: Record<string, { selected: string[]; freeText?: string }>,
    confirmation: "success" | "impact-light",
  ) =>
    mutation
      .mutateAsync(
        questions.map((question) => {
          const answer = answers[`${question.id}:${question.revision}`];

          return {
            id: question.id,
            revision: question.revision,
            answer:
              answer &&
              (answer.selected.length > 0 || answer.freeText !== undefined)
                ? answer
                : null,
          };
        }),
      )
      .then(
        () => shellHaptic(confirmation),
        (cause: unknown) => {
          shellHaptic("error");
          throw cause;
        },
      );

  return (
    <PendingInteractionShell
      label="Needs your answer"
      headerBadge={
        <span className="shrink-0 whitespace-nowrap rounded-full border border-border px-1.5 text-xs font-normal text-muted-foreground">
          {badge}
        </span>
      }
      headerProgressRef={setProgressTarget}
      expandedByDefault
      errorMessage={error}
      testId="native-question-banner"
      interactionKey={setKey}
    >
      {() => (
        <QuestionForm
          key={setKey}
          threadId={threadId}
          draftKey={`${threadId}:native-questions`}
          progressTarget={progressTarget}
          questions={formQuestions}
          disabled={busy}
          submissionPending={busy}
          cancelDisabled={busy}
          cancelLabel={questions.length > 1 ? "Skip all" : "Skip"}
          onSubmit={(answers) => resolve(answers, "success")}
          onCancel={() => resolve({}, "impact-light")}
        />
      )}
    </PendingInteractionShell>
  );
}

function NativeCallback({ callback }: { callback: ThreadCallback }) {
  const sourceDetail = {
    working: null,
    waiting: null,
    "needs-input": "The source chat is waiting for your answer.",
    idle: "The source chat has stopped working.",
    error: "The source chat has failed.",
    archived: "The source chat is archived.",
    unavailable: "The source chat is unavailable.",
    unverified: "The source chat's progress could not be verified.",
  }[callback.sourceState];

  return (
    <div
      role="status"
      data-native-callback={callback.threadId}
      className="text-xs text-muted-foreground"
    >
      <span>Waiting for another chat</span>
      {" · "}
      {callback.sourceThreadId === null ? (
        <span>{callback.sourceTitle}</span>
      ) : (
        <AttentionThreadLink
          threadId={callback.sourceThreadId}
          title={callback.sourceTitle}
        />
      )}
      <div>{callback.reason}</div>
      <CallbackAge createdAt={callback.createdAt} />
      {sourceDetail ? <div>{sourceDetail}</div> : null}
    </div>
  );
}

function CallbackAge({ createdAt }: { createdAt: number }) {
  const now = useMinuteNow();

  return (
    <time
      dateTime={new Date(createdAt).toISOString()}
      title={new Date(createdAt).toLocaleString()}
    >
      Started {formatRelativeTime({ timestamp: createdAt, now })}
    </time>
  );
}

function WaitingChats({ callbacks }: { callbacks: ThreadCallback[] }) {
  const { data: threads } = useSidebarNavigationThreadSelection(
    (entries) => entries,
  );

  return (
    <section
      aria-label="Waiting on this chat"
      className="space-y-1 text-xs text-muted-foreground"
    >
      <div>Waiting on this chat</div>
      <ul className="space-y-2">
        {callbacks.map((callback) => {
          const thread = threads?.find(
            (entry) => entry.id === callback.threadId,
          );

          return (
            <li key={callback.id}>
              {thread ? (
                <RouteAnchor
                  className="text-foreground underline decoration-dotted"
                  href={getThreadRoutePath({
                    projectId: thread.projectId,
                    threadId: thread.id,
                  })}
                >
                  {getThreadDisplayTitle(thread)}
                </RouteAnchor>
              ) : (
                <AttentionThreadLink
                  threadId={callback.threadId}
                  title="Open waiting chat"
                />
              )}
              <div>{callback.reason}</div>
              <CallbackAge createdAt={callback.createdAt} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AttentionThreadLink({
  threadId,
  title,
}: {
  threadId: string;
  title: string;
}) {
  const activate = useActivatedRouteNavigate();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        className="text-foreground underline decoration-dotted"
        onClick={() => {
          setError(null);
          void sdk.threads
            .get({ threadId })
            .then((thread) =>
              activate(
                getThreadRoutePath({
                  projectId: thread.projectId,
                  threadId: thread.id,
                }),
              ),
            )
            .catch(() => setError("The chat could not be opened."));
        }}
      >
        {title}
      </button>
      {error ? <div role="alert">{error}</div> : null}
    </>
  );
}
