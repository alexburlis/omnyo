import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, type ReactNode } from "react";
import type {
  InboxActRequest,
  InboxWaitKind,
  InboxWaitView,
} from "@omnyo/domain";
import { inboxServerRevision } from "@/hooks/cache-owners/inbox-snapshot-cache-owner";
import { useInboxSnapshot } from "@/hooks/queries/use-inbox-snapshot";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { SectionHeader } from "@omnyo/shared-ui/section-header";
import {
  StatusList,
  StatusRow,
  type StatusTone,
} from "@omnyo/shared-ui/status-row";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { getThreadRoutePath } from "@/lib/route-paths";
import { formatScheduledTime } from "@/lib/relative-time";
import { sdk } from "@/lib/sdk";
import { useRawThreadMentionResources } from "./ThreadTitleMentions";
import { PromptMentionPill } from "./timeline/ConversationMessageMentions";

const CHAT_CONDITION_PREFIX = "chat:";

const NO_WAITERS: readonly string[] = [];

const WAIT_KIND_LABEL: Record<InboxWaitKind, string> = {
  chat: "Another chat",
  check: "Scheduled check",
  event: "Event",
  report: "On you",
  date: "Timer",
  "send-later": "Send later",
  join: "Several conditions",
};

function pendingChatWaits(waits: readonly InboxWaitView[]) {
  return waits.flatMap((wait) => {
    if (wait.status !== "live" && wait.status !== "evaluating") return [];

    const sources = wait.conditions.flatMap(({ key, kind, label, met }) => {
      if (met || kind !== "chat" || !key.startsWith(CHAT_CONDITION_PREFIX))
        return [];

      const threadId = key.slice(CHAT_CONDITION_PREFIX.length);

      return threadId ? [{ threadId, label }] : [];
    });

    return sources.length > 0 ? [{ id: wait.id, sources }] : [];
  });
}

function unmetWatchedLabels(wait: InboxWaitView): string[] {
  return wait.conditions.flatMap(({ kind, label, met }) =>
    !met && kind === "event" && label !== wait.forText ? [label] : [],
  );
}

function WaitTime({ at, now }: { at: number; now: number }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
    >
      {formatScheduledTime({ timestamp: at, now }).replace(
        /^Tomorrow/u,
        "tomorrow",
      )}
    </time>
  );
}

function WaitSources({
  sources,
  resources,
}: {
  sources: ReturnType<typeof pendingChatWaits>[number]["sources"];
  resources: ReturnType<typeof useRawThreadMentionResources>;
}) {
  return sources.map(({ threadId, label }, index) => {
    const resource = resources.get(threadId);

    return (
      <Fragment key={threadId}>
        {index > 0 ? ", " : null}
        {resource?.kind === "thread" && resource.projectId !== undefined ? (
          <RouteAnchor
            className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
            href={getThreadRoutePath({
              projectId: resource.projectId,
              threadId,
            })}
          >
            {label}
          </RouteAnchor>
        ) : (
          <span className="font-medium text-foreground">{label}</span>
        )}
      </Fragment>
    );
  });
}

function waitTone(wait: InboxWaitView): StatusTone {
  if (wait.status === "evaluating") return "active";

  return wait.kind === "report" ? "warning" : "pending";
}

function waitStatusLabel(wait: InboxWaitView): string {
  return wait.status === "evaluating"
    ? "Checking now"
    : WAIT_KIND_LABEL[wait.kind];
}

function deadlineLabel(kind: InboxWaitKind): string {
  if (kind === "date") return "Ends";

  if (kind === "send-later") return "Sends";

  return "Deadline";
}

function checkTiming(checkAt: number, now: number): ReactNode {
  return (
    <>
      {checkAt <= now ? "Check was due" : "Checks again"}{" "}
      <WaitTime at={checkAt} now={now} />
    </>
  );
}

function returnTiming(returnAt: number, now: number): ReactNode {
  return (
    <>
      Back in your inbox by <WaitTime at={returnAt} now={now} />
    </>
  );
}

function waitTiming({
  wait,
  nextCheckAt,
  returnAt,
  now,
}: {
  wait: InboxWaitView;
  nextCheckAt: number | null;
  returnAt: number | null;
  now: number;
}): ReactNode[] {
  const timing: ReactNode[] = [];

  if (nextCheckAt !== null && wait.status !== "evaluating")
    timing.push(checkTiming(nextCheckAt, now));

  if (wait.deadline !== null) {
    timing.push(
      <span
        title={
          wait.kind === "date" || wait.kind === "send-later"
            ? undefined
            : "If it hasn’t happened by then, this chat stops waiting and comes back to your inbox."
        }
      >
        {deadlineLabel(wait.kind)} <WaitTime at={wait.deadline} now={now} />
      </span>,
    );
  } else if (returnAt !== null) {
    timing.push(returnTiming(returnAt, now));
  }

  if (wait.checkCount > 0) {
    timing.push(
      `Checked ${wait.checkCount} ${wait.checkCount === 1 ? "time" : "times"}`,
    );
  }

  return timing;
}

function TimingLine({ items }: { items: readonly ReactNode[] }) {
  return items.map((item, index) => (
    <Fragment key={index}>
      {index === 0 ? null : <span aria-hidden="true"> · </span>}
      {item}
    </Fragment>
  ));
}

function DeliverReason({
  text,
  waiterIds,
}: {
  text: string;
  waiterIds: readonly string[];
}) {
  const resources = useRawThreadMentionResources(waiterIds);

  const waiters = waiterIds.flatMap((id) => {
    const resource = resources.get(id);

    return resource?.kind === "thread" ? [resource] : [];
  });

  if (waiters.length === 0 || waiters.length !== waiterIds.length)
    return <p className="text-sm leading-6 text-muted-foreground">{text}</p>;

  return (
    <p className="text-sm leading-6 text-muted-foreground">
      {waiters.map((resource, index) => (
        <Fragment key={resource.threadId}>
          {index > 0 ? " " : null}
          <PromptMentionPill
            resource={resource}
            serializedText={`@thread:${resource.threadId}`}
          />
        </Fragment>
      ))}{" "}
      {waiters.length === 1 ? "is" : "are"} waiting on this chat
    </p>
  );
}

function ReasonHeadline({
  attention,
  label,
  text,
}: {
  attention: boolean;
  label: string;
  text: string;
}) {
  return (
    <p className="flex min-w-0 items-start gap-2 text-sm leading-5 text-foreground">
      <Icon
        name={attention ? "AlertCircle" : "Clock"}
        aria-hidden="true"
        className={
          attention
            ? "mt-0.5 size-4 shrink-0 text-warning-text"
            : "mt-0.5 size-4 shrink-0 text-muted-foreground"
        }
      />
      <span className="min-w-0 break-words">
        <span
          className={
            attention ? "font-medium text-warning-text" : "font-medium"
          }
        >
          {label}:
        </span>{" "}
        {text}
      </span>
    </p>
  );
}

function isActionableWait(wait: InboxWaitView) {
  return wait.status === "live" || wait.status === "evaluating";
}

type WaitAction = Extract<
  InboxActRequest,
  { action: "happened" | "cancel-wait" }
>;

export function ThreadInboxReason({
  threadId,
  parentThreadId,
}: {
  threadId: string;
  parentThreadId: string | null;
}) {
  const { snapshot, refresh } = useInboxSnapshot();
  const queryClient = useQueryClient();

  const waitAction = useMutation({
    mutationFn: (request: WaitAction) =>
      sdk.experimental_inbox.act({ request }),
    onSettled: () => {
      refresh();

      return Promise.all(
        [...new Set([threadId, primaryWaitThreadId])].map((sourceId) =>
          queryClient.invalidateQueries({
            queryKey: ["inbox", "chat-waits", sourceId],
          }),
        ),
      );
    },
  });

  const ancestors = useQuery({
    queryKey: [
      "inbox",
      "ancestors",
      threadId,
      parentThreadId,
      snapshot === null ? null : inboxServerRevision(snapshot.revision),
    ],
    queryFn: ({ signal }) =>
      sdk.threads.experimental_listAncestors({
        threadIds:
          parentThreadId === null ? [threadId] : [threadId, parentThreadId],
        signal,
      }),
    enabled: parentThreadId !== null,
  });

  const { data: waitList } = useQuery({
    queryKey: ["inbox", "chat-waits", threadId, snapshot?.generatedAt],
    queryFn: ({ signal }) => sdk.experimental_inbox.waits({ threadId, signal }),
    enabled: snapshot !== null,
    gcTime: 0,
    placeholderData: (previous, query) =>
      query?.queryKey[2] === threadId ? previous : undefined,
  });

  const familyIds = new Set([
    threadId,
    ...(parentThreadId === null ? [] : [parentThreadId]),
    ...(ancestors.data?.threads.flatMap(({ ancestorIds }) => ancestorIds) ??
      []),
  ]);

  const entry =
    snapshot === null
      ? undefined
      : [
          ...snapshot.inbox,
          ...snapshot.running,
          ...snapshot.waiting,
          ...snapshot.shelf,
        ].find(
          (candidate) =>
            familyIds.has(candidate.threadId) ||
            candidate.runs?.some((member) => familyIds.has(member.threadId)) ||
            candidate.incident?.members.some((member) =>
              familyIds.has(member.threadId),
            ),
        );

  const primaryWaitThreadId =
    entry?.threadId === threadId
      ? (entry.waiting?.waitThreadId ?? threadId)
      : threadId;

  const { data: primaryWaitList } = useQuery({
    queryKey: [
      "inbox",
      "chat-waits",
      primaryWaitThreadId,
      snapshot?.generatedAt,
    ],
    queryFn: ({ signal }) =>
      sdk.experimental_inbox.waits({ threadId: primaryWaitThreadId, signal }),
    enabled: primaryWaitThreadId !== threadId,
    gcTime: 0,
  });

  const directWaits = waitList?.waits;

  const waitRecords = useMemo(
    () => [
      ...new Map(
        [
          ...(directWaits ?? []),
          ...(primaryWaitThreadId === threadId
            ? []
            : (primaryWaitList?.waits ?? []).filter(
                (wait) => wait.id === entry?.waiting?.waitId,
              )),
        ].map((wait) => [wait.id, wait]),
      ).values(),
    ],
    [
      directWaits,
      primaryWaitList,
      primaryWaitThreadId,
      threadId,
      entry?.waiting?.waitId,
    ],
  );

  const chatWaits = useMemo(
    () =>
      new Map(
        pendingChatWaits(waitRecords).map(({ id, sources }) => [id, sources]),
      ),
    [waitRecords],
  );

  const sourceIds = useMemo(
    () => [
      ...new Set(
        [...chatWaits.values()].flatMap((sources) =>
          sources.map((source) => source.threadId),
        ),
      ),
    ],
    [chatWaits],
  );

  const resources = useRawThreadMentionResources(sourceIds);

  const showReason =
    entry !== undefined &&
    (entry.state === "needs-you" || entry.state === "waiting") &&
    !(
      entry.reason.kind === "decision" &&
      entry.card?.primary.kind === "accept-proposal" &&
      entry.card.primary.proposalKind === "archive"
    ) &&
    !(entry.threadId === threadId && entry.waiting?.retry != null) &&
    !(entry.reason.kind === "question" && entry.reason.threadId === threadId) &&
    !(
      entry.reason.kind === "recap" && entry.reason.threadId !== entry.threadId
    );

  const waitOwnerId =
    entry && familyIds.has(entry.threadId) ? entry.threadId : threadId;

  const actionableWaits = waitRecords.filter(isActionableWait);

  if (!showReason && actionableWaits.length === 0) return null;

  const hasLinkedPrimary = actionableWaits.some(
    (wait) => wait.id === entry?.waiting?.waitId,
  );

  const hasLinkedReason =
    entry?.state === "waiting" &&
    ((entry.reason.kind === "wait" && hasLinkedPrimary) ||
      actionableWaits.some((wait) => wait.forText === entry.reason.text));

  const now = Date.now();

  const primaryWaiting =
    showReason && entry.state === "waiting" && !hasLinkedPrimary
      ? (entry.waiting ?? null)
      : null;

  const primaryTiming: ReactNode[] = [];

  if (primaryWaiting?.checkAt != null)
    primaryTiming.push(checkTiming(primaryWaiting.checkAt, now));

  if (primaryWaiting?.returnAt != null)
    primaryTiming.push(returnTiming(primaryWaiting.returnAt, now));

  return (
    <div className="space-y-2 px-3 py-2" role="status">
      {showReason && !hasLinkedReason ? (
        entry.reason.kind === "deliver" ? (
          <DeliverReason
            text={entry.reason.text}
            waiterIds={
              entry.reason.threadId === threadId
                ? (waitList?.waitingChatIds ?? NO_WAITERS)
                : NO_WAITERS
            }
          />
        ) : (
          <ReasonHeadline
            attention={entry.state === "needs-you"}
            label={entry.state === "needs-you" ? "Needs you" : "Waiting"}
            text={entry.reason.text}
          />
        )
      ) : null}
      {primaryWaiting?.behind || primaryTiming.length > 0 ? (
        <div
          className={cn(
            "space-y-0.5 text-xs leading-5 text-muted-foreground",
            showReason &&
              !hasLinkedReason &&
              entry.reason.kind !== "deliver" &&
              "pl-6",
          )}
        >
          {primaryWaiting?.behind ? (
            <p>Waiting for {primaryWaiting.behind}</p>
          ) : null}
          {primaryTiming.length > 0 ? (
            <p className="text-subtle-foreground">
              <TimingLine items={primaryTiming} />
            </p>
          ) : null}
        </div>
      ) : null}
      {actionableWaits.length > 0 ? (
        <div className="space-y-1">
          <SectionHeader
            title="Waiting on"
            count={actionableWaits.length}
            countLabel={
              actionableWaits.length === 1
                ? "1 open wait"
                : `${actionableWaits.length} open waits`
            }
            className="min-h-6 px-0.5"
          />
          <StatusList label="What this chat is waiting on">
            {actionableWaits.map((wait) => {
              const linkedPrimary = wait.id === entry?.waiting?.waitId;
              const sources = chatWaits.get(wait.id) ?? [];

              const nextCheckAt =
                wait.nextCheckAt ??
                (linkedPrimary ? (entry?.waiting?.checkAt ?? null) : null);

              const returnAt = linkedPrimary
                ? (entry?.waiting?.returnAt ?? null)
                : null;

              const singleSourceTitle =
                sources.length === 1 && sources[0]?.label === wait.forText;

              const reportable =
                wait.kind === "report" && wait.status === "live";

              const actionPending =
                waitAction.isPending &&
                waitAction.variables?.waitId === wait.id;

              const failed =
                waitAction.isError && waitAction.variables?.waitId === wait.id;

              const watching = unmetWatchedLabels(wait);

              const timing = waitTiming({ wait, nextCheckAt, returnAt, now });

              const detailParts: ReactNode[] = [];

              if (sources.length > 0 && !singleSourceTitle) {
                detailParts.push(
                  <span key="sources">
                    Waiting on{" "}
                    <WaitSources sources={sources} resources={resources} />
                  </span>,
                );
              }

              if (watching.length > 0) {
                detailParts.push(
                  <span key="watching">
                    Watching for {watching.join(", ")}
                  </span>,
                );
              }

              if (timing.length > 0) {
                detailParts.push(
                  <span key="timing" className="text-subtle-foreground">
                    <TimingLine items={timing} />
                  </span>,
                );
              }

              return (
                <StatusRow
                  key={wait.id}
                  tone={waitTone(wait)}
                  title={
                    singleSourceTitle ? (
                      <span className="block whitespace-normal break-words">
                        <WaitSources sources={sources} resources={resources} />
                      </span>
                    ) : (
                      <span
                        className="line-clamp-2 block whitespace-normal break-words"
                        title={wait.forText}
                      >
                        {wait.forText}
                      </span>
                    )
                  }
                  status={waitStatusLabel(wait)}
                  detail={
                    detailParts.length === 0 ? undefined : (
                      <span className="flex flex-col">{detailParts}</span>
                    )
                  }
                  error={
                    failed ? (
                      <span role="alert">
                        Couldn’t update this wait. Try again.
                      </span>
                    ) : undefined
                  }
                  actions={
                    <>
                      {reportable ? (
                        <Button
                          type="button"
                          variant="soft"
                          size="xs"
                          aria-label={`It happened: ${wait.forText}`}
                          disabled={waitAction.isPending}
                          onClick={() =>
                            waitAction.mutate({
                              action: "happened",
                              threadId: waitOwnerId,
                              waitId: wait.id,
                              note: null,
                            })
                          }
                        >
                          {actionPending &&
                          waitAction.variables?.action === "happened"
                            ? "Saving…"
                            : "It happened"}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant={reportable ? "ghost" : "soft"}
                        size="xs"
                        aria-label={`Cancel wait: ${wait.forText}`}
                        disabled={waitAction.isPending}
                        onClick={() =>
                          waitAction.mutate({
                            action: "cancel-wait",
                            threadId: waitOwnerId,
                            waitId: wait.id,
                          })
                        }
                      >
                        {actionPending &&
                        waitAction.variables?.action === "cancel-wait"
                          ? "Cancelling…"
                          : "Cancel"}
                      </Button>
                    </>
                  }
                />
              );
            })}
          </StatusList>
        </div>
      ) : null}
      {showReason && entry.recap && entry.recap !== entry.reason.text ? (
        <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
          {entry.recap}
        </p>
      ) : null}
    </div>
  );
}
