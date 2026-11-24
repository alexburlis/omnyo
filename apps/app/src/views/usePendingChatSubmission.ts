import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isPromptDraftEmpty } from "@omnyo/client-core";
import type { NewThreadComposerSubmission } from "@/components/promptbox/NewThreadComposer";
import { takeNewChatStagedCallback } from "@/lib/send-outbox/new-chat-staging";
import {
  useCreateThread,
  useSendThreadMessage,
} from "@/hooks/mutations/thread-runtime-mutations";
import { usePromptDraftController } from "@/hooks/usePromptDraftStorage";
import { DEFAULT_THREAD_CREATION_PLACEMENT } from "@/lib/thread-creation-placement";
import { useRootComposePlacement } from "@/lib/root-compose-selection";
import { useNavigateToThreadAfterCreatePreference } from "@/lib/root-compose-create-preference";
import type { ThreadRoutePathArgs } from "@/lib/route-paths";
import { createPendingChat } from "@/lib/pending-chat-creations";
import { PendingThreadChat } from "./thread-detail/PendingThreadChat";
import { prefetchThreadOpen } from "@/hooks/queries/thread-queries";
import {
  threadDetailBootstrapQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import { LazyThreadDetailView } from "./thread-detail/LazyThreadDetailView";
import { movePendingChatDraft } from "@/lib/pending-chat-draft-transfer";
import { startTypeAheadCapture } from "@/lib/typed-ahead";

export interface PendingChatSubmissionOptions {
  projectId: string;
  isActiveSurface: boolean;
  open: (thread: ThreadRoutePathArgs) => void;
  onUnopenedFailure: ((error: unknown) => void) | null;
}

export function usePendingChatSubmission({
  projectId,
  isActiveSurface,
  open,
  onUnopenedFailure,
}: PendingChatSubmissionOptions) {
  const createThread = useCreateThread();
  const sendMessage = useSendThreadMessage();
  const queryClient = useQueryClient();
  const [placement, setPlacement] = useRootComposePlacement();
  const [navigateAfterCreate] = useNavigateToThreadAfterCreatePreference();
  const draft = usePromptDraftController({ kind: "new-thread" });

  const latest = useRef({
    isActiveSurface,
    projectId,
    open,
    onUnopenedFailure,
  });

  latest.current = { isActiveSurface, projectId, open, onUnopenedFailure };

  const mounted = useRef(false);
  const latestPlacement = useRef(placement);
  latestPlacement.current = placement;

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const handleSubmit = useCallback(
    async (request: NewThreadComposerSubmission) => {
      const onDurablyStaged = takeNewChatStagedCallback(request);

      const { sendAt, ...requestFields } = request;

      const createRequest = {
        ...requestFields,
        ...placement,
        ...(sendAt === undefined ? {} : { sendAt }),
      };

      const pending = createPendingChat({
        request: createRequest,
        ...(onDurablyStaged === undefined ? {} : { onDurablyStaged }),
        queueOwner: queryClient,
        create: (preparedRequest, outbox) =>
          createThread.mutateAsync({ ...preparedRequest, outbox }),
        send: sendMessage.mutateAsync,
        renderer: PendingThreadChat,
        prepare: async (threadId) => {
          await Promise.all([
            prefetchThreadOpen(queryClient, threadId, true),
            LazyThreadDetailView.preload(),
          ]);

          if (
            queryClient.getQueryState(threadDetailBootstrapQueryKey(threadId))
              ?.status !== "success" ||
            queryClient.getQueryState(threadTimelineQueryKey(threadId))
              ?.status !== "success"
          ) {
            throw new Error("The new chat could not load yet.");
          }
        },
      });

      if (
        latest.current.projectId === request.projectId &&
        latestPlacement.current.sectionId === placement.sectionId &&
        latestPlacement.current.pinned === placement.pinned
      ) {
        setPlacement(DEFAULT_THREAD_CREATION_PLACEMENT);
      }

      const opens =
        mounted.current &&
        navigateAfterCreate &&
        latest.current.projectId === request.projectId &&
        latest.current.isActiveSurface &&
        isPromptDraftEmpty(draft.getCurrent());

      const { onUnopenedFailure: reportUnopenedFailure } = latest.current;

      if (opens) {
        startTypeAheadCapture();
        latest.current.open({
          projectId: request.projectId,
          threadId: pending.id,
        });
      }

      await pending.completion.catch((error: unknown) => {
        movePendingChatDraft(request.projectId, pending.id, {
          kind: "new-thread",
        });

        if (!opens) reportUnopenedFailure?.(error);

        throw error;
      });
    },
    [
      createThread,
      draft,
      navigateAfterCreate,
      placement,
      setPlacement,
      sendMessage.mutateAsync,
      queryClient,
    ],
  );

  return { handleSubmit };
}
