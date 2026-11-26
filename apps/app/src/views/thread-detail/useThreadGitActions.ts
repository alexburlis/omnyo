import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Environment, Thread, WorkspaceStatus } from "@omnyo/domain";
import { useDialogState } from "@omnyo/shared-ui/use-dialog-state";
import type { ThreadGitActionDialogTarget } from "@/components/dialogs/ThreadGitActionDialog";
import { appToast } from "@/components/ui/app-toast";
import { runThreadMessageSend } from "@/hooks/mutations/thread-runtime-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { sdk } from "@/lib/sdk";

interface UseThreadGitActionsParams {
  environment?: Environment;
  thread?: Thread;
  workspaceStatus?: WorkspaceStatus;
}

export function useThreadGitActions({
  environment,
  thread,
  workspaceStatus,
}: UseThreadGitActionsParams) {
  const queryClient = useQueryClient();
  const threadGitActionDialog = useDialogState<ThreadGitActionDialogTarget>();
  const pendingThreadIds = useRef(new Set<string>());

  const threadId =
    thread?.archivedAt === null && thread.deletedAt === null
      ? thread.id
      : undefined;

  const canCommit =
    threadId !== undefined &&
    environment !== undefined &&
    workspaceStatus?.workingTree?.hasUncommittedChanges === true;

  const handleCommitThread = useCallback(async () => {
    const pending = pendingThreadIds.current;

    if (!canCommit || threadId === undefined || pending.has(threadId)) return;
    pending.add(threadId);

    try {
      const result = await runThreadMessageSend({
        queryClient,
        transport: sdk.threads.send,
        request: {
          id: threadId,
          mode: "queue-if-active",
          messageSource: { kind: "script", label: "Omnyo · Commit changes" },
          input: [
            {
              type: "text",
              text: "Review the workspace changes and create a local Git commit for the changes that belong to this chat. Leave unrelated changes alone and keep the commit local.",
              mentions: [],
            },
          ],
        },
      });

      appToast.success(
        result.delivery === "sent"
          ? "Commit request sent"
          : "Commit request queued",
      );
    } catch (error) {
      appToast.error(
        getMutationErrorMessage({
          error,
          fallbackMessage: "Could not send the commit request.",
        }),
      );
    } finally {
      pending.delete(threadId);
    }
  }, [canCommit, queryClient, threadId]);

  return { canCommit, handleCommitThread, threadGitActionDialog };
}
