import { useCallback, useContext, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ThreadChatMessageAction,
  ThreadChatProps,
} from "@omnyo/plugin-sdk";
import { EmptyStatePanel } from "@omnyo/shared-ui/empty-state";
import { cn } from "@omnyo/shared-ui/lib/utils";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { EmbeddedThreadChat } from "@/components/thread/embedded-chat";
import {
  ThreadTimelinePanelContent,
  type ThreadTimelineConsumerMessageAction,
} from "@/components/thread/timeline";
import { useThreadTimelineNavigation } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { PluginContext } from "@/components/plugin/plugin-context";
import { ThreadProviderContext } from "@/components/thread/thread-provider-context";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useSystemProviderInfo } from "@/hooks/queries/system-queries";
import { useThread } from "@/hooks/queries/thread-queries";
import { OmnyoHttpError } from "@/lib/sdk";
import { ThreadChatLoadingBody } from "@/components/thread/timeline/ThreadChatLoading";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
} from "@/lib/route-paths";

export function PluginThreadChat({
  threadId,
  variant = "full",
  layout = "contained",
  focusRequest,
  permissionPolicy = "inherit",
  className,
  leadingContent,
  messageActions,
  experimental_conversation,
  experimental_placeholder,
}: ThreadChatProps) {
  const containerClassName = cn(
    layout === "contained" ? "flex h-full min-h-0 flex-col" : "flex flex-col",
    className,
  );

  return (
    <div className={containerClassName}>
      <PluginThreadChatBody
        threadId={threadId}
        variant={variant}
        layout={layout}
        focusRequest={focusRequest}
        permissionPolicy={permissionPolicy}
        leadingContent={leadingContent}
        messageActions={messageActions}
        conversation={experimental_conversation}
        placeholder={experimental_placeholder}
      />
    </div>
  );
}

interface PluginThreadChatBodyProps {
  threadId: string;
  variant: "full" | "compact" | "timeline";
  layout: "contained" | "document";
  focusRequest: number | undefined;
  permissionPolicy: "inherit" | "editable";
  leadingContent: ReactNode;
  messageActions: readonly ThreadChatMessageAction[] | undefined;
  conversation: ThreadChatProps["experimental_conversation"];
  placeholder: string | undefined;
}

function PluginThreadChatBody({
  threadId,
  variant,
  layout,
  focusRequest,
  permissionPolicy,
  leadingContent,
  messageActions,
  conversation,
  placeholder,
}: PluginThreadChatBodyProps) {
  const threadQuery = useThread(threadId, { enabled: threadId.length > 0 });
  const thread = threadQuery.data;

  const threadProviderInfo = useSystemProviderInfo(
    thread?.environmentId
      ? {
          enabled: true,
          environmentId: thread.environmentId,
          providerId: thread.providerId,
        }
      : {
          enabled: thread !== undefined,
          providerId: thread?.providerId,
        },
  );

  const threadProviderPluginId = threadProviderInfo?.pluginId ?? null;

  const threadProviderContextValue = useMemo(
    () => ({
      providerId: thread?.providerId ?? null,
      pluginId: threadProviderPluginId,
    }),
    [thread?.providerId, threadProviderPluginId],
  );

  const navigate = useNavigate();
  const environmentQuery = useEnvironment(thread?.environmentId ?? null);
  const environment = environmentQuery.data ?? null;
  const timelineNavigation = useThreadTimelineNavigation();

  const canUseHostFileNavigation =
    thread !== undefined &&
    thread.environmentId === timelineNavigation?.environmentId;

  const onOpenLink = timelineNavigation?.onOpenLink;

  const onOpenLocalFileLink = canUseHostFileNavigation
    ? timelineNavigation.onOpenLocalFileLink
    : undefined;

  const resolveHostMentionLink = canUseHostFileNavigation
    ? timelineNavigation.resolveMentionLink
    : undefined;

  const workspaceRootPath =
    environment?.path ??
    (canUseHostFileNavigation
      ? timelineNavigation.workspaceRootPath
      : undefined);

  const pluginId = useContext(PluginContext);

  const consumerMessageActions = useMemo<
    readonly ThreadTimelineConsumerMessageAction[] | undefined
  >(
    () =>
      messageActions === undefined || messageActions.length === 0
        ? undefined
        : messageActions.map((action) => ({
            id: action.id,
            pluginId: action.icon !== undefined ? null : pluginId,
            icon: action.icon ?? null,
            label: action.title,
            ...(action.roles !== undefined ? { roles: action.roles } : {}),
            run: action.run,
          })),
    [messageActions, pluginId],
  );

  const resolveMentionLink = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        const targetProjectId = resource.projectId ?? thread?.projectId;

        if (targetProjectId === undefined) return null;

        return () =>
          navigate(
            getThreadRoutePath({
              projectId: targetProjectId,
              threadId: resource.threadId,
            }),
          );
      }

      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }

      if (
        resource.kind === "path" &&
        resource.entryKind === "file" &&
        resource.source === "workspace"
      ) {
        return resolveHostMentionLink?.(resource) ?? null;
      }

      return null;
    },
    [navigate, resolveHostMentionLink, thread?.projectId],
  );

  const isThreadMissing =
    threadQuery.error instanceof OmnyoHttpError &&
    threadQuery.error.status === 404;

  if (isThreadMissing) {
    return (
      <EmptyStatePanel className="m-2 rounded-lg">
        This thread is no longer available.
      </EmptyStatePanel>
    );
  }

  if (thread === undefined) {
    return (
      <ThreadChatLoadingBody
        leadingContent={leadingContent}
        variant={variant}
      />
    );
  }

  if (variant === "timeline") {
    const transcript = (
      <ThreadTimelinePanelContent
        leadingContent={leadingContent}
        consumerMessageActions={consumerMessageActions}
        includePluginMessageActions={false}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={thread.projectId}
        resolveMentionLink={resolveMentionLink}
        conversation={
          conversation && pluginId
            ? {
                pluginId,
                itemId: `${conversation.mention.provider}:${conversation.mention.id}`,
              }
            : undefined
        }
        surfaceKey={`plugin-thread-chat:${threadId}`}
        threadId={threadId}
        workspaceRootPath={workspaceRootPath}
      />
    );

    return (
      <ThreadProviderContext.Provider value={threadProviderContextValue}>
        {layout === "contained" ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-background px-2 pb-3 pt-3">
            {transcript}
          </div>
        ) : (
          <div className="bg-background px-2 pb-3 pt-3">{transcript}</div>
        )}
      </ThreadProviderContext.Provider>
    );
  }

  return (
    <ThreadProviderContext.Provider value={threadProviderContextValue}>
      <EmbeddedThreadChat
        variant="compact"
        layout={layout}
        measure={variant === "full" ? "page" : "panel"}
        surfaceTone={variant === "compact" ? "sidebar" : "background"}
        threadId={threadId}
        projectId={thread.projectId}
        providerId={thread.providerId}
        promptContextEnvironmentId={thread.environmentId}
        resolveMentionLink={resolveMentionLink}
        leadingContent={leadingContent}
        consumerMessageActions={consumerMessageActions}
        includePluginMessageActions={false}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        workspaceRootPath={workspaceRootPath}
        conversation={
          conversation && pluginId
            ? {
                kind: "plugin",
                pluginId,
                itemId: `${conversation.mention.provider}:${conversation.mention.id}`,
                label: conversation.mention.label,
              }
            : undefined
        }
        composer={{
          draftScope: {
            kind: "thread",
            projectId: thread.projectId,
            threadId,
            ...(conversation && pluginId
              ? { conversationKey: `${pluginId}:${conversation.id}` }
              : {}),
          },
          executionDefaultsThreadId: threadId,
          executionResetKey: threadId,
          executionEnvironmentId: thread.environmentId ?? undefined,
          executionEnvironmentHostId: environment?.hostId,
          permissionPolicy:
            permissionPolicy === "editable" ? "editable" : "snapshot",
          pluginComposerBottomScope: { kind: "thread", threadId },
          composerIdentity: `plugin-thread-chat:${threadId}:${pluginId ?? ""}:${conversation?.id ?? ""}`,
          focusRequestKey: focusRequest,
          ...(placeholder !== undefined ? { placeholder } : {}),
        }}
      />
    </ThreadProviderContext.Provider>
  );
}
