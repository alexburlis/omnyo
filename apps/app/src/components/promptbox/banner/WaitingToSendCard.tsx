import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { appToast } from "@/components/ui/app-toast";
import {
  discardOutboxEntry,
  outboxEntriesForConversation,
  readOutboxChatAlias,
  readSendOutboxSnapshot,
  retryOutboxEntry,
  subscribeSendOutbox,
} from "@/lib/send-outbox/send-outbox";
import type { OutboxEntry } from "@/lib/send-outbox/send-outbox-entry";

function entryPreview(entry: OutboxEntry): string {
  const input =
    entry.action.kind === "new-thread"
      ? entry.action.thread.input
      : entry.action.message.input;

  const text = input
    .flatMap((item) => (item.type === "text" ? [item.text.trim()] : []))
    .filter((value) => value.length > 0)
    .join(" ");

  return text.length > 0 ? text : "Attached files";
}

function attachmentLabel(entry: OutboxEntry): string | null {
  const input =
    entry.action.kind === "new-thread"
      ? entry.action.thread.input
      : entry.action.message.input;

  const count = input.filter(
    (item) => item.type === "localFile" || item.type === "localImage",
  ).length;

  return count === 0 ? null : count === 1 ? "1 file" : `${count} files`;
}

function reportOutboxActionFailure(error: unknown): void {
  appToast.error("Could not update the waiting message.", {
    description: error instanceof Error ? error.message : undefined,
  });
}

export function useWaitingToSendEntries(
  conversationKey: string,
): OutboxEntry[] {
  const snapshot = useSyncExternalStore(
    subscribeSendOutbox,
    readSendOutboxSnapshot,
    readSendOutboxSnapshot,
  );

  return useMemo(
    () => outboxEntriesForConversation(snapshot, conversationKey),
    [conversationKey, snapshot],
  );
}

export function useOutboxCreatedChatId(pendingChatId: string): string | null {
  const snapshot = useSyncExternalStore(
    subscribeSendOutbox,
    readSendOutboxSnapshot,
    readSendOutboxSnapshot,
  );

  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void readOutboxChatAlias(pendingChatId)
      .then((created) => {
        if (active) setThreadId(created);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [pendingChatId, snapshot]);

  return threadId;
}

export function WaitingToSendCard({ entries }: { entries: OutboxEntry[] }) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <PromptStackCard ariaLabel="Messages waiting to send" attachedToComposer>
      <div className="divide-y divide-border-hairline">
        {entries.map((entry) => {
          const paused = entry.state.kind === "paused";
          const files = attachmentLabel(entry);

          return (
            <div
              key={entry.submissionId}
              data-waiting-to-send={entry.state.kind}
              className="flex min-h-10 min-w-0 items-center gap-2.5 px-3 py-2"
            >
              <span className="flex size-4 shrink-0 items-center justify-center self-start">
                <Icon
                  name={paused ? "AlertCircle" : "Spinner"}
                  className={cn(
                    "size-3.5 shrink-0",
                    paused
                      ? "text-destructive-text"
                      : "animate-spin text-subtle-foreground",
                  )}
                  aria-hidden
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-foreground">
                  {entryPreview(entry)}
                </div>
                {entry.state.kind === "paused" ? (
                  <p className="mt-0.5 line-clamp-2 text-2xs leading-4">
                    <span className="font-medium text-destructive-text">
                      Not sent
                    </span>
                    <span aria-hidden="true" className="text-subtle-foreground">
                      {" · "}
                    </span>
                    <span className="text-muted-foreground">
                      {entry.state.message}
                    </span>
                    {files === null ? null : (
                      <span className="text-subtle-foreground">{` · ${files}`}</span>
                    )}
                  </p>
                ) : (
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs">
                    <span className="shrink-0 font-medium text-muted-foreground">
                      Waiting to send
                    </span>
                    <span className="min-w-0 truncate text-subtle-foreground">
                      Retrying automatically
                    </span>
                    {files === null ? null : (
                      <span className="inline-flex shrink-0 items-center gap-1 text-subtle-foreground">
                        <Icon
                          name="Paperclip"
                          className="size-3"
                          aria-hidden="true"
                        />
                        {files}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {paused ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant="soft"
                    onClick={() => {
                      void retryOutboxEntry(entry.submissionId).catch(
                        reportOutboxActionFailure,
                      );
                    }}
                  >
                    <Icon name="RotateCcw" aria-hidden="true" />
                    Try again
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => {
                      void discardOutboxEntry(entry.submissionId).catch(
                        reportOutboxActionFailure,
                      );
                    }}
                  >
                    Discard
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </PromptStackCard>
  );
}
