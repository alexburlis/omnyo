import { type ReactNode, useEffect, useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { DiffPresentation } from "@/components/code/code-rendering";
import type { WorkspaceDiffTarget } from "@omnyo/domain";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { DiffLoadingSkeleton } from "@/components/code/code-loading-skeletons";
import { OmnyoDiffSplit } from "@/components/code/OmnyoDiffSplit";
import { useRequestPierreWorkerPool } from "@/lib/pierre-worker-pool-gate";
import { Alert, AlertDescription, AlertTitle } from "@omnyo/shared-ui/alert";
import { Button } from "@omnyo/shared-ui/button";
import { EmptyStateBlock } from "@omnyo/shared-ui/empty-state";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import {
  useEnvironmentDiffFiles,
  useEnvironment,
  useEnvironmentFilePreview,
} from "@/hooks/queries/environment-queries";
import {
  useProjectAttachmentPreview,
  useProjectFilePreview,
} from "@/hooks/queries/project-queries";
import {
  useThreadHostFilePreview,
  useThreadStorageFilePreview,
} from "@/hooks/queries/thread-queries";
import { useHostFilePreview } from "@/hooks/queries/host-file-preview-query";
import {
  buildEnvironmentFileContentUrl,
  buildProjectFileContentUrl,
  buildThreadHostFileContentUrl,
  buildThreadStorageRawContentUrl,
} from "@/lib/file-content-urls";
import type {
  EnvironmentFilePreviewSource,
  FilePreview,
  FilePreviewLineRange,
  WorkspaceFilePreviewStatusLabel,
} from "@omnyo/client-core";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PANEL_SCROLL_SLOT_CLASS } from "./panelChromeClasses";
import { DiffFilesPanel } from "./git-diff/DiffFilesPanel";
import { clearDiffFileCardStates } from "./git-diff/diffFilesStore";
import { buildGitDiffIdentity } from "./git-diff/gitDiffPanelHelpers";
import { useDiffFileContentsRequester } from "./git-diff/useDiffFileContentsRequester";
import { SecondaryPanelFilePreview } from "./ThreadStorageFilePreview";
import {
  buildMarkdownFileImageRouting,
  buildMarkdownHostFileImageRouting,
} from "@/components/ui/markdown-file-image-routing";
import { getAbsoluteDirname } from "@/lib/absolute-file-path";

const GIT_DIFF_SKELETON_FILE_COUNT = 3;

interface GitDiffTabContentProps {
  environmentId?: string;
  target: WorkspaceDiffTarget | undefined;
  isPanelOpen: boolean;
  gitDiffPresentation: DiffPresentation;
  fileFilter: string;
  onClearPendingGitDiffIntent?: () => void;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onSelectionAddToChat?: (text: string) => void;
  pendingGitDiffScrollPath?: string | null;
  workspaceRootPath?: string | null;
}

interface WorkspaceFilePreviewTabContentProps {
  activePath: string;
  isPanelOpen: boolean;
  copyPath?: string | null;
  environmentId?: string | null;
  lineRange: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  source: EnvironmentFilePreviewSource | null;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
  threadId?: string | null;
}

interface ProjectFilePreviewTabContentProps {
  activePath: string;
  isPanelOpen: boolean;
  copyPath?: string | null;
  environmentId: string | null;
  hostId: string | null;
  lineRange: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  projectId: string;
  rootPath?: string | null;
  threadId?: string | null;
}

interface HostFilePreviewTabContentProps {
  activePath: string;
  isPanelOpen: boolean;
  copyPath: string;
  environmentId?: string | null;
  lineRange: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  threadId: string;
}

interface HostScopedFilePreviewTabContentProps {
  activePath: string;
  hostId: string;
  isPanelOpen: boolean;
  lineRange: FilePreviewLineRange | null;
  onOpenInEditor?: (path: string) => void;
}

interface AttachmentFilePreviewTabContentProps {
  isPanelOpen: boolean;
  name: string;
  onSelectionAddToChat?: (text: string) => void;
  path: string;
  projectId: string;
}

interface ThreadStorageFilePreviewTabContentProps {
  activePath: string;
  isPanelOpen: boolean;
  copyPath?: string | null;
  lineRange: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  threadId: string;
}

function filePreviewQueryProps(query: UseQueryResult<FilePreview>) {
  return {
    error: query.error,
    filePreview: query.data,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching,
    onRefresh: () => void query.refetch(),
  };
}

function GitDiffMessageSlot({ children }: { children: ReactNode }) {
  return (
    <div className={cn(PANEL_SCROLL_SLOT_CLASS, "px-4 pb-3")}>{children}</div>
  );
}

function GitDiffStateMessage({
  icon,
  title,
  description,
  tone = "neutral",
  role,
  actions,
}: {
  icon: IconName;
  title: string;
  description: ReactNode;
  tone?: "neutral" | "error";
  role?: "alert" | "status";
  actions?: ReactNode;
}) {
  return (
    <GitDiffMessageSlot>
      <div role={role} className="flex min-h-full flex-col justify-center">
        <EmptyStateBlock
          icon={icon}
          tone={tone}
          title={title}
          description={description}
          actions={actions}
          className="py-14"
        />
      </div>
    </GitDiffMessageSlot>
  );
}

function gitDiffNoChangesCopy(target: WorkspaceDiffTarget | undefined): {
  title: string;
  description: string;
} {
  switch (target?.type) {
    case "branch_committed":
      return {
        title: "No committed changes on this branch",
        description: `Changes committed on this branch that ${target.mergeBaseBranch} doesn’t have yet show up here.`,
      };
    case "all":
      return {
        title: `No changes compared with ${target.mergeBaseBranch}`,
        description: `Committed and uncommitted changes against ${target.mergeBaseBranch} show up here.`,
      };
    case "commit":
      return {
        title: "This commit changes no files",
        description: "Pick another commit to see its changes.",
      };
    case undefined:
      return {
        title: "No changes to show",
        description: "Changes in this chat’s workspace show up here.",
      };
    case "uncommitted":
      return {
        title: "No uncommitted changes",
        description:
          "Edits in this workspace that aren’t committed yet show up here.",
      };
  }
}

function GitDiffNoChangesMessage({
  target,
}: {
  target: WorkspaceDiffTarget | undefined;
}) {
  const copy = gitDiffNoChangesCopy(target);

  return (
    <GitDiffStateMessage
      icon="CircleCheck"
      title={copy.title}
      description={copy.description}
    />
  );
}

export function GitDiffLoadingSkeleton() {
  return (
    <GitDiffMessageSlot>
      <div className="space-y-2 pt-2" role="status" aria-label="Loading diff">
        {Array.from({ length: GIT_DIFF_SKELETON_FILE_COUNT }).map(
          (_, index) => (
            <div
              key={`git-diff-skeleton-${index}`}
              className="overflow-clip rounded-lg border border-border bg-background"
            >
              <div className="flex h-8 items-center justify-between gap-2 py-1.5 pl-2 pr-3">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <Skeleton className="size-4 shrink-0 rounded-sm" />
                  <Skeleton className="h-3 w-48 max-w-full rounded-sm" />
                </div>
                <Skeleton className="h-3 w-14 shrink-0 rounded-sm" />
              </div>
              <DiffLoadingSkeleton />
            </div>
          ),
        )}
      </div>
    </GitDiffMessageSlot>
  );
}

export function GitDiffTabContent({
  environmentId,
  target,
  isPanelOpen,
  gitDiffPresentation,
  fileFilter,
  onClearPendingGitDiffIntent,
  onOpenFileInEditor,
  onOpenFilePreview,
  onSelectionAddToChat,
  pendingGitDiffScrollPath,
  workspaceRootPath,
}: GitDiffTabContentProps) {
  const isQueryEnabled =
    isPanelOpen && Boolean(environmentId) && target !== undefined;

  const {
    data: diffFilesResponse,
    dataUpdatedAt: diffFilesUpdatedAt,
    isLoading: isDiffFilesLoading,
    isPlaceholderData: isDiffFilesPlaceholder,
    error: diffFilesError,
    isFetching: isDiffFilesFetching,
    refetch: refetchDiffFiles,
  } = useEnvironmentDiffFiles(environmentId ?? "", {
    enabled: isQueryEnabled,
    target,
  });

  const mergeBaseRef =
    diffFilesResponse?.outcome === "available"
      ? diffFilesResponse.mergeBaseRef
      : null;

  const diffIdentity = buildGitDiffIdentity({
    environmentId,
    mergeBaseRef,
    target,
  });

  const onRequestFileContents = useDiffFileContentsRequester({
    environmentId,
    target,
    mergeBaseRef,
  });

  useEffect(() => {
    clearDiffFileCardStates(diffIdentity);
  }, [diffIdentity]);
  const requestDiffWorkers = useRequestPierreWorkerPool();
  useEffect(() => {
    if (!isPanelOpen) return;
    void OmnyoDiffSplit.preload();
    requestDiffWorkers();
  }, [isPanelOpen, requestDiffWorkers]);

  const isPreparing =
    isQueryEnabled &&
    (isDiffFilesLoading ||
      (diffFilesResponse === undefined && diffFilesError === null));

  if (isPreparing) {
    return <GitDiffLoadingSkeleton />;
  }

  if (diffFilesError && diffFilesResponse === undefined) {
    return (
      <GitDiffStateMessage
        icon="AlertTriangle"
        tone="error"
        role="alert"
        title="Couldn’t load the changes"
        description={
          diffFilesError instanceof Error && diffFilesError.message.trim()
            ? diffFilesError.message
            : "Something went wrong while reading this workspace’s Git changes."
        }
        actions={
          isQueryEnabled ? (
            <Button
              type="button"
              size="sm"
              disabled={isDiffFilesFetching}
              onClick={() => {
                void refetchDiffFiles();
              }}
            >
              <Icon name="RotateCcw" aria-hidden />
              {isDiffFilesFetching ? "Trying again…" : "Try again"}
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (diffFilesResponse === undefined) {
    return <GitDiffNoChangesMessage target={target} />;
  }

  if (diffFilesResponse.outcome === "unavailable") {
    return (
      <GitDiffStateMessage
        icon="FolderUnknown"
        title="Workspace unavailable"
        description={diffFilesResponse.failure.message}
      />
    );
  }

  if (diffFilesResponse.outcome === "not_applicable") {
    return (
      <GitDiffStateMessage
        icon="GitBranch"
        title="No Git changes to show"
        description={diffFilesResponse.message}
      />
    );
  }

  if (
    diffFilesResponse.files.length === 0 ||
    !environmentId ||
    target === undefined
  ) {
    return <GitDiffNoChangesMessage target={target} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {diffFilesResponse.truncated ? (
        <Alert className="mx-4 mb-2 w-auto" role="status">
          <Icon name="Info" aria-hidden />
          <AlertTitle className="text-xs">
            Showing the first {diffFilesResponse.files.length} changed files
          </AlertTitle>
          <AlertDescription className="text-xs">
            There are more changes than this panel can list.
          </AlertDescription>
        </Alert>
      ) : null}
      <DiffFilesPanel
        environmentId={environmentId}
        target={target}
        diffIdentity={diffIdentity}
        files={diffFilesResponse.files}
        fileFilter={fileFilter}
        initialPatches={diffFilesResponse.initialPatches}
        filesUpdatedAt={diffFilesUpdatedAt}
        presentation={gitDiffPresentation}
        filePathRoot={workspaceRootPath}
        isPanelOpen={isPanelOpen}
        isPlaceholderData={isDiffFilesPlaceholder}
        scrollToPath={pendingGitDiffScrollPath}
        onScrolledToPath={onClearPendingGitDiffIntent}
        onOpenFileInEditor={onOpenFileInEditor}
        onOpenFilePreview={onOpenFilePreview}
        onRequestFileContents={onRequestFileContents}
        onSelectionAddToChat={onSelectionAddToChat}
      />
    </div>
  );
}

export function WorkspaceFilePreviewTabContent({
  activePath,
  copyPath = null,
  environmentId,
  isPanelOpen,
  lineRange,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  source,
  statusLabel,
  threadId,
}: WorkspaceFilePreviewTabContentProps) {
  const environmentQuery = useEnvironment(environmentId ?? null, {
    enabled:
      environmentId !== null &&
      environmentId !== undefined &&
      markdownLinkRouting?.localImage === undefined,
    staleTime: 5_000,
  });

  const workspaceFilePreviewQuery = useEnvironmentFilePreview(
    environmentId,
    activePath,
    source,
    { enabled: isPanelOpen },
  );

  const environmentRootPath = environmentQuery.data?.path ?? null;

  const resolvedMarkdownLinkRouting = useMemo(() => {
    if (source === null || !environmentId) {
      return markdownLinkRouting;
    }

    return buildMarkdownFileImageRouting({
      path: activePath,
      rootPath: environmentRootPath,
      threadId: threadId ?? null,
      linkRouting: markdownLinkRouting,
      resolveRelativeSrc: (path) =>
        buildEnvironmentFileContentUrl(environmentId, source, path),
    });
  }, [
    activePath,
    environmentId,
    environmentRootPath,
    markdownLinkRouting,
    source,
    threadId,
  ]);

  return (
    <SecondaryPanelFilePreview
      {...filePreviewQueryProps(workspaceFilePreviewQuery)}
      activePath={activePath}
      copyPath={copyPath}
      htmlPreviewUrl={
        environmentId && source?.kind === "working-tree"
          ? buildEnvironmentFileContentUrl(environmentId, source, activePath)
          : null
      }
      lineRange={lineRange}
      markdownLinkRouting={resolvedMarkdownLinkRouting}
      onSelectionAddToChat={onSelectionAddToChat}
      onOpenInEditor={onOpenInEditor}
      statusLabel={statusLabel}
    />
  );
}

export function ProjectFilePreviewTabContent({
  activePath,
  copyPath = null,
  environmentId,
  hostId,
  isPanelOpen,
  lineRange,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  projectId,
  rootPath = null,
  threadId = null,
}: ProjectFilePreviewTabContentProps) {
  const projectFilePreviewQuery = useProjectFilePreview(
    projectId,
    activePath,
    { environmentId, hostId },
    { enabled: isPanelOpen },
  );

  const resolvedMarkdownLinkRouting = useMemo(() => {
    return buildMarkdownFileImageRouting({
      path: activePath,
      rootPath,
      threadId,
      linkRouting: markdownLinkRouting,
      resolveRelativeSrc: (path) =>
        buildProjectFileContentUrl(projectId, path, { environmentId, hostId }),
    });
  }, [
    activePath,
    environmentId,
    hostId,
    markdownLinkRouting,
    projectId,
    rootPath,
    threadId,
  ]);

  return (
    <SecondaryPanelFilePreview
      {...filePreviewQueryProps(projectFilePreviewQuery)}
      activePath={activePath}
      copyPath={copyPath}
      htmlPreviewUrl={buildProjectFileContentUrl(projectId, activePath, {
        environmentId,
        hostId,
      })}
      lineRange={lineRange}
      markdownLinkRouting={resolvedMarkdownLinkRouting}
      onSelectionAddToChat={onSelectionAddToChat}
      onOpenInEditor={onOpenInEditor}
      statusLabel={null}
    />
  );
}

export function HostFilePreviewTabContent({
  activePath,
  copyPath,
  environmentId,
  isPanelOpen,
  lineRange,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  threadId,
}: HostFilePreviewTabContentProps) {
  const hostFilePreviewQuery = useThreadHostFilePreview(
    threadId,
    environmentId,
    activePath,
    { enabled: isPanelOpen },
  );

  const resolvedMarkdownLinkRouting = useMemo(() => {
    return buildMarkdownFileImageRouting({
      path: activePath,
      rootPath:
        markdownLinkRouting?.localFile?.relativeLinks?.rootPath ??
        getAbsoluteDirname({ path: activePath }),
      threadId,
      linkRouting: markdownLinkRouting,
      resolveRelativeSrc: (_relativePath, path) =>
        buildThreadHostFileContentUrl(threadId, path),
    });
  }, [activePath, markdownLinkRouting, threadId]);

  return (
    <SecondaryPanelFilePreview
      {...filePreviewQueryProps(hostFilePreviewQuery)}
      activePath={activePath}
      copyPath={copyPath}
      htmlPreviewUrl={buildThreadHostFileContentUrl(threadId, activePath)}
      lineRange={lineRange}
      markdownLinkRouting={resolvedMarkdownLinkRouting}
      onSelectionAddToChat={onSelectionAddToChat}
      onOpenInEditor={onOpenInEditor}
      statusLabel={null}
    />
  );
}

export function HostScopedFilePreviewTabContent({
  activePath,
  hostId,
  isPanelOpen,
  lineRange,
  onOpenInEditor,
}: HostScopedFilePreviewTabContentProps) {
  const hostFilePreviewQuery = useHostFilePreview(hostId, activePath, {
    enabled: isPanelOpen,
  });

  const markdownLinkRouting = useMemo(() => {
    return buildMarkdownHostFileImageRouting({
      path: activePath,
      rootPath: getAbsoluteDirname({ path: activePath }),
      hostId,
    });
  }, [activePath, hostId]);

  return (
    <SecondaryPanelFilePreview
      {...filePreviewQueryProps(hostFilePreviewQuery)}
      activePath={activePath}
      copyPath={activePath}
      htmlPreviewUrl={hostFilePreviewQuery.data?.url ?? null}
      lineRange={lineRange}
      markdownLinkRouting={markdownLinkRouting}
      onOpenInEditor={onOpenInEditor}
      statusLabel={null}
    />
  );
}

export function ThreadStorageFilePreviewTabContent({
  activePath,
  copyPath = null,
  isPanelOpen,
  lineRange,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  threadId,
}: ThreadStorageFilePreviewTabContentProps) {
  const threadStorageFilePreviewQuery = useThreadStorageFilePreview(
    threadId,
    activePath,
    { enabled: isPanelOpen },
  );

  const resolvedMarkdownLinkRouting = useMemo(() => {
    return buildMarkdownFileImageRouting({
      path: activePath,
      rootPath: null,
      threadId,
      linkRouting: markdownLinkRouting,
      resolveRelativeSrc: (path) =>
        buildThreadStorageRawContentUrl(threadId, path),
    });
  }, [activePath, markdownLinkRouting, threadId]);

  return (
    <SecondaryPanelFilePreview
      {...filePreviewQueryProps(threadStorageFilePreviewQuery)}
      activePath={activePath}
      copyPath={copyPath}
      htmlPreviewUrl={buildThreadStorageRawContentUrl(threadId, activePath)}
      lineRange={lineRange}
      markdownLinkRouting={resolvedMarkdownLinkRouting}
      onSelectionAddToChat={onSelectionAddToChat}
      onOpenInEditor={onOpenInEditor}
      statusLabel={null}
    />
  );
}

export function AttachmentFilePreviewTabContent({
  isPanelOpen,
  name,
  onSelectionAddToChat,
  path,
  projectId,
}: AttachmentFilePreviewTabContentProps) {
  const attachmentPreviewQuery = useProjectAttachmentPreview(
    projectId,
    path,
    name,
    { enabled: isPanelOpen },
  );

  return (
    <SecondaryPanelFilePreview
      {...filePreviewQueryProps(attachmentPreviewQuery)}
      activePath={name}
      copyPath={null}
      lineRange={null}
      onSelectionAddToChat={onSelectionAddToChat}
      statusLabel={null}
    />
  );
}
