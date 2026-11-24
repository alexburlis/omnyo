import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentType,
} from "react";
import { Button } from "@omnyo/shared-ui/button";
import {
  useOutboxCreatedChatId,
  useWaitingToSendEntries,
  WaitingToSendCard,
} from "@/components/promptbox/banner/WaitingToSendCard";
import { movePendingChatDraft } from "@/lib/pending-chat-draft-transfer";
import { useImmediateRouteNavigate } from "@/components/ui/app-route-anchor";
import {
  getProjectComposeRoutePath,
  type ThreadRoutePathArgs,
} from "@/lib/route-paths";
import {
  getPendingChatRenderer,
  usePendingChat,
  retirePendingChatSurface,
  type PendingChatSnapshot,
} from "@/lib/pending-chat-creations";
import { usePaneContext, type PaneContextValue } from "./PaneContext";

type PendingChatRenderer = ComponentType<{ pendingId: string }>;

type PendingChatRouteView =
  | { kind: "starting"; Renderer: PendingChatRenderer }
  | { kind: "failed"; Renderer: PendingChatRenderer }
  | {
      kind: "handoff";
      Renderer: PendingChatRenderer;
      destination: ThreadRoutePathArgs;
    }
  | { kind: "redirect"; destination: ThreadRoutePathArgs }
  | { kind: "recovery" };

function resolvePendingChatRouteView(
  pending: PendingChatSnapshot | null,
  Renderer: PendingChatRenderer | null,
): PendingChatRouteView {
  if (
    pending?.realThreadId &&
    (pending.status === "ready" || pending.status === "open-failed")
  ) {
    const destination = {
      projectId: pending.projectId,
      threadId: pending.realThreadId,
    };

    return Renderer === null
      ? { kind: "redirect", destination }
      : { kind: "handoff", Renderer, destination };
  }

  if (Renderer === null) return { kind: "recovery" };

  return pending?.status === "failed"
    ? { kind: "failed", Renderer }
    : { kind: "starting", Renderer };
}

function measureComposerHeight(surface: HTMLElement | null): number | null {
  const height =
    surface?.querySelector("form[data-promptbox]")?.getBoundingClientRect()
      .height ?? 0;

  return height > 0 ? height : null;
}

export function PendingChatRoute({
  projectId,
  threadId,
}: {
  projectId: string;
  threadId: string;
}) {
  const pending = usePendingChat(threadId);
  const Renderer = getPendingChatRenderer(threadId);
  const { navigateInPane } = usePaneContext();
  const navigate = useImmediateRouteNavigate();

  const handedOffThrough = useRef<PaneContextValue["navigateInPane"] | null>(
    null,
  );

  const surfaceRef = useRef<HTMLDivElement>(null);

  const view = useMemo(
    () => resolvePendingChatRouteView(pending, Renderer),
    [pending, Renderer],
  );

  const openRealChat = useCallback(
    (destination: ThreadRoutePathArgs) => {
      if (handedOffThrough.current === navigateInPane) return;
      handedOffThrough.current = navigateInPane;
      movePendingChatDraft(projectId, threadId, {
        kind: "thread",
        ...destination,
      });
      retirePendingChatSurface(threadId, {
        composerHeight: measureComposerHeight(surfaceRef.current),
      });
      navigateInPane(destination, { replace: true });
    },
    [navigateInPane, projectId, threadId],
  );

  useLayoutEffect(() => {
    if (view.kind === "handoff") openRealChat(view.destination);
  }, [openRealChat, view]);

  const waitingEntries = useWaitingToSendEntries(threadId);
  const createdThreadId = useOutboxCreatedChatId(threadId);

  useEffect(() => {
    if (view.kind === "recovery" && createdThreadId !== null)
      navigateInPane(
        { projectId, threadId: createdThreadId },
        { replace: true },
      );
  }, [createdThreadId, navigateInPane, projectId, view.kind]);

  useEffect(() => {
    if (view.kind === "redirect") openRealChat(view.destination);

    if (view.kind === "failed")
      movePendingChatDraft(projectId, threadId, { kind: "new-thread" });
  }, [openRealChat, projectId, threadId, view]);

  switch (view.kind) {
    case "starting":
    case "failed":
    case "handoff":
      return (
        <div ref={surfaceRef} className="contents">
          <view.Renderer pendingId={threadId} />
        </div>
      );
    case "redirect":
      return null;
    case "recovery":
      if (waitingEntries.length > 0 || createdThreadId !== null)
        return (
          <div className="mx-auto flex max-w-lg flex-col gap-3 py-12">
            <p>This chat starts once its first message is sent.</p>
            <WaitingToSendCard entries={waitingEntries} />
          </div>
        );

      return (
        <div className="mx-auto flex max-w-lg flex-col gap-3 py-12">
          <p>
            Unfinished messages were recovered to New chat. Check whether the
            chat was created before sending again.
          </p>
          <Button
            onClick={() => navigate(getProjectComposeRoutePath(projectId))}
          >
            Open New chat
          </Button>
        </div>
      );
  }
}
