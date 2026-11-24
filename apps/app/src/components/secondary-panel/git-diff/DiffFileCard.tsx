import { DiffLoadingSkeleton } from "@/components/code/code-loading-skeletons";
import { DelayedLoading } from "@omnyo/shared-ui/delayed-loading";
import {
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useIntersectionObserver } from "usehooks-ts";
import type { DiffFileEntry } from "@omnyo/server-contract";
import type { DiffPresentation } from "@/components/code/code-rendering";
import {
  getGitDiffCardImageSizeStat,
  GitDiffCardBody,
  GitDiffCardImagePreviewBody,
  useGitDiffCardBody,
  type DiffFileContentsResult,
  type DiffImageSizeStat,
  type GitDiffCardImagePreview,
  type GitDiffCardSvgDisplayMode,
  type RequestDiffFileContents,
} from "@/components/git-diff/GitDiffCardBody";
import {
  GitDiffCardHeader,
  GitDiffCardImageSizeStat,
  GitDiffCardRawToggle,
  gitDiffCardHeaderWrapperClass,
  type GitDiffCardHeaderModel,
} from "@/components/git-diff/GitDiffCardHeader";
import {
  isPreviewableImagePath,
  isSvgGitDiffFile,
  parseGitDiffFiles,
  type ParsedGitDiffFile,
} from "@/components/git-diff/git-diff-parsing";
import { Button } from "@omnyo/shared-ui/button";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import type { DiffPatchState } from "@/hooks/queries/use-environment-diff-patches";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { estimateCardBodyHeight } from "./diffFilesStore";

function formatDiffEntryLabel(entry: DiffFileEntry): string {
  if (
    (entry.changeKind === "renamed" || entry.changeKind === "copied") &&
    entry.previousPath &&
    entry.previousPath !== entry.path
  ) {
    return `${entry.previousPath} -> ${entry.path}`;
  }

  return entry.path;
}

function buildDiffEntryHeaderModel(
  entry: DiffFileEntry,
): GitDiffCardHeaderModel {
  return {
    label: formatDiffEntryLabel(entry),
    path: entry.path,
    openablePath: entry.path,
    changeKind: entry.changeKind,
    insertions: entry.additions,
    deletions: entry.deletions,
  };
}

interface BinaryImagePreviewSource {
  path: string;
  side: "old" | "new";
}

interface BinaryImagePreviewPlan {
  identity: string;
  old: BinaryImagePreviewSource | null;
  new: BinaryImagePreviewSource | null;
}

interface ReadyBinaryImagePreview extends GitDiffCardImagePreview {
  oldSizeBytes: number | null;
  newSizeBytes: number | null;
}

type BinaryImageContentsResult = Extract<
  DiffFileContentsResult,
  { kind: "image" }
>;

type BinaryImagePreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: ReadyBinaryImagePreview }
  | { status: "unavailable" }
  | { status: "error" };

const EMPTY_BINARY_IMAGE_PREVIEW_STATE: BinaryImagePreviewState = {
  status: "idle",
};

function isPreviewableBinaryImageEntry(entry: DiffFileEntry): boolean {
  return (
    entry.binary &&
    (isPreviewableImagePath(entry.path) ||
      isPreviewableImagePath(entry.previousPath ?? undefined))
  );
}

function buildBinaryImagePreviewPlan(
  entry: DiffFileEntry,
): BinaryImagePreviewPlan | null {
  if (!isPreviewableBinaryImageEntry(entry)) {
    return null;
  }

  const previousPath = entry.previousPath ?? entry.path;

  const oldSource: BinaryImagePreviewSource | null =
    entry.changeKind === "added" ? null : { path: previousPath, side: "old" };

  const newSource: BinaryImagePreviewSource | null =
    entry.changeKind === "deleted" ? null : { path: entry.path, side: "new" };

  return {
    identity: `${entry.changeKind}:${oldSource?.path ?? ""}:${
      newSource?.path ?? ""
    }`,
    old: oldSource,
    new: newSource,
  };
}

export interface DiffFileCardProps {
  entry: DiffFileEntry;
  presentation: DiffPresentation;
  filePathRoot?: string | null;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  patchState: DiffPatchState;
  onLoadPatch: () => void;
  onRetry: () => void;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  onSelectionAddToChat?: (text: string) => void;
}

function arePatchStatesEqual(a: DiffPatchState, b: DiffPatchState): boolean {
  return (
    a.status === b.status &&
    a.patch === b.patch &&
    a.truncated === b.truncated &&
    a.error === b.error
  );
}

function areDiffFileCardPropsEqual(
  previous: DiffFileCardProps,
  next: DiffFileCardProps,
): boolean {
  return (
    previous.entry === next.entry &&
    previous.presentation === next.presentation &&
    previous.filePathRoot === next.filePathRoot &&
    previous.isCollapsed === next.isCollapsed &&
    previous.onToggleCollapsed === next.onToggleCollapsed &&
    previous.onLoadPatch === next.onLoadPatch &&
    previous.onRetry === next.onRetry &&
    previous.onOpenFileInEditor === next.onOpenFileInEditor &&
    previous.onOpenFilePreview === next.onOpenFilePreview &&
    previous.onRequestFileContents === next.onRequestFileContents &&
    previous.onSelectionAddToChat === next.onSelectionAddToChat &&
    arePatchStatesEqual(previous.patchState, next.patchState)
  );
}

async function resolveBinaryImagePreviewSource(
  source: BinaryImagePreviewSource | null,
  fetcher: RequestDiffFileContents,
): Promise<BinaryImageContentsResult | null> {
  if (source === null) {
    return null;
  }

  const result = await fetcher(source.path, source.side);

  return result?.kind === "image" ? result : null;
}

function useBinaryImagePreview({
  enabled,
  onRequestFileContents,
  plan,
}: {
  enabled: boolean;
  onRequestFileContents?: RequestDiffFileContents;
  plan: BinaryImagePreviewPlan | null;
}): BinaryImagePreviewState {
  const [state, setState] = useState<BinaryImagePreviewState>(
    EMPTY_BINARY_IMAGE_PREVIEW_STATE,
  );

  const statusRef = useRef<BinaryImagePreviewState["status"]>("idle");
  const planIdentity = plan?.identity ?? "none";

  useEffect(() => {
    statusRef.current = "idle";
    setState(EMPTY_BINARY_IMAGE_PREVIEW_STATE);
  }, [planIdentity, onRequestFileContents]);

  useEffect(() => {
    if (
      !enabled ||
      plan === null ||
      onRequestFileContents === undefined ||
      statusRef.current !== "idle"
    ) {
      return;
    }

    let cancelled = false;
    statusRef.current = "loading";
    setState({ status: "loading" });

    void Promise.all([
      resolveBinaryImagePreviewSource(plan.old, onRequestFileContents),
      resolveBinaryImagePreviewSource(plan.new, onRequestFileContents),
    ])
      .then(([oldResult, newResult]) => {
        if (cancelled) return;

        if (oldResult === null && newResult === null) {
          statusRef.current = "unavailable";
          setState({ status: "unavailable" });

          return;
        }

        statusRef.current = "ready";
        setState({
          status: "ready",
          preview: {
            oldImageUrl: oldResult?.dataUrl ?? null,
            newImageUrl: newResult?.dataUrl ?? null,
            oldSizeBytes: oldResult?.sizeBytes ?? null,
            newSizeBytes: newResult?.sizeBytes ?? null,
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          statusRef.current = "error";
          setState({ status: "error" });
        }
      });

    return () => {
      cancelled = true;

      if (statusRef.current === "loading") {
        statusRef.current = "idle";
      }
    };
  }, [enabled, onRequestFileContents, plan]);

  return state;
}

export const DiffFileCard = memo(function DiffFileCard({
  entry,
  presentation,
  filePathRoot,
  isCollapsed,
  onToggleCollapsed,
  patchState,
  onLoadPatch,
  onRetry,
  onOpenFileInEditor,
  onOpenFilePreview,
  onRequestFileContents,
  onSelectionAddToChat,
}: DiffFileCardProps) {
  const headerModel = useMemo(() => buildDiffEntryHeaderModel(entry), [entry]);

  const parsedFile = useMemo<ParsedGitDiffFile | null>(() => {
    if (patchState.status !== "loaded" || patchState.patch === undefined) {
      return null;
    }

    return parseGitDiffFiles(patchState.patch)[0] ?? null;
  }, [patchState.patch, patchState.status]);

  const [svgDisplayMode, setSvgDisplayMode] =
    useState<GitDiffCardSvgDisplayMode>("preview");

  useEffect(() => {
    setSvgDisplayMode("preview");
  }, [entry.path, entry.previousPath, patchState.patch]);

  const toggleSvgDisplayMode = () => {
    setSvgDisplayMode((currentMode) =>
      currentMode === "preview" ? "raw" : "preview",
    );
  };

  const changedLines = entry.additions + entry.deletions;
  const isBodyHidden = isCollapsed;

  const binaryImagePreviewPlan = useMemo(
    () => buildBinaryImagePreviewPlan(entry),
    [entry],
  );

  const shouldDirectlyPreviewBinaryImage =
    binaryImagePreviewPlan !== null && onRequestFileContents !== undefined;

  const binaryImagePreviewState = useBinaryImagePreview({
    enabled: !isBodyHidden && shouldDirectlyPreviewBinaryImage,
    onRequestFileContents,
    plan: binaryImagePreviewPlan,
  });

  const binaryImageSizeStat = useMemo<DiffImageSizeStat | null>(() => {
    if (binaryImagePreviewState.status !== "ready") {
      return null;
    }

    return getGitDiffCardImageSizeStat(
      binaryImagePreviewState.preview,
      entry.changeKind,
    );
  }, [binaryImagePreviewState, entry.changeKind]);

  const supportsSvgRawToggle =
    !isBodyHidden &&
    parsedFile !== null &&
    parsedFile.type !== "rename-pure" &&
    onRequestFileContents !== undefined &&
    isSvgGitDiffFile(parsedFile);

  const { ref: stickySentinelRef, isIntersecting } = useIntersectionObserver({
    initialIsIntersecting: true,
    threshold: 1,
  });

  const isHeaderStuck = !isIntersecting;

  return (
    <div className="overflow-clip rounded-lg border border-border bg-background">
      <div ref={stickySentinelRef} className="h-0" />
      <div
        className={cn(
          gitDiffCardHeaderWrapperClass({
            stickyHeader: true,
            isBodyHidden,
            isStuck: isHeaderStuck,
            showStuckHeaderEdge: false,
          }),
          "-mt-px border-t border-border",
        )}
      >
        <GitDiffCardHeader
          model={headerModel}
          previousPath={entry.previousPath}
          filePathRoot={filePathRoot}
          onOpenFileInEditor={onOpenFileInEditor}
          onOpenFilePreview={onOpenFilePreview}
          isCollapsed={isCollapsed}
          onToggleCollapsed={onToggleCollapsed}
          hasChanges
          statSlot={
            shouldDirectlyPreviewBinaryImage ? (
              binaryImageSizeStat !== null ? (
                <GitDiffCardImageSizeStat stat={binaryImageSizeStat} />
              ) : (
                <span />
              )
            ) : undefined
          }
          actionSlot={
            supportsSvgRawToggle ? (
              <GitDiffCardRawToggle
                fileLabel={headerModel.label}
                isRaw={svgDisplayMode === "raw"}
                onToggle={toggleSvgDisplayMode}
              />
            ) : undefined
          }
        />
      </div>
      {isBodyHidden ? null : (
        <DiffFileCardBody
          entry={entry}
          changedLines={changedLines}
          presentation={presentation}
          parsedFile={parsedFile}
          patchState={patchState}
          svgDisplayMode={svgDisplayMode}
          onLoadPatch={onLoadPatch}
          onRetry={onRetry}
          onOpenFilePreview={onOpenFilePreview}
          onRequestFileContents={onRequestFileContents}
          onSelectionAddToChat={onSelectionAddToChat}
          binaryImagePreviewState={
            shouldDirectlyPreviewBinaryImage
              ? binaryImagePreviewState
              : undefined
          }
        />
      )}
    </div>
  );
}, areDiffFileCardPropsEqual);

interface DiffFileCardBodyProps {
  entry: DiffFileEntry;
  changedLines: number;
  presentation: DiffPresentation;
  parsedFile: ParsedGitDiffFile | null;
  patchState: DiffPatchState;
  svgDisplayMode: GitDiffCardSvgDisplayMode;
  onLoadPatch: () => void;
  onRetry: () => void;
  onOpenFilePreview?: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  onSelectionAddToChat?: (text: string) => void;
  binaryImagePreviewState?: BinaryImagePreviewState;
}

function DiffFileCardNotice({
  icon,
  tone = "neutral",
  title,
  description,
  action,
}: {
  icon: IconName;
  tone?: "neutral" | "error";
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className="flex min-w-0 items-center gap-3 px-3 py-3"
    >
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-full",
          tone === "error"
            ? "bg-surface-destructive text-destructive-text"
            : "bg-state-hover text-muted-foreground",
        )}
      >
        <Icon name={icon} className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-xs font-medium leading-5",
            tone === "error" ? "text-destructive-text" : "text-foreground",
          )}
        >
          {title}
        </p>
        {description === undefined ? null : (
          <p className="text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}

function DiffFileCardOpenFileAction({
  path,
  onOpenFilePreview,
}: {
  path: string;
  onOpenFilePreview?: (path: string) => void;
}) {
  if (!onOpenFilePreview) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="soft"
      size="xs"
      aria-label={`Open file ${path}`}
      onClick={() => onOpenFilePreview(path)}
    >
      <Icon name="File" aria-hidden />
      Open file
    </Button>
  );
}

function DiffFileCardLoadDiffNotice({
  changedLines,
  entry,
  onLoadPatch,
}: {
  changedLines: number;
  entry: DiffFileEntry;
  onLoadPatch: () => void;
}) {
  return (
    <DiffFileCardNotice
      icon={entry.binary ? "FileAttachment" : "FileDiff"}
      title={
        entry.binary
          ? "Binary file"
          : `${changedLines.toLocaleString()} changed lines`
      }
      description={
        entry.binary
          ? "Binary changes aren’t loaded until you ask for them."
          : "Large diffs load when you ask, to keep this panel fast."
      }
      action={
        <Button type="button" variant="soft" size="xs" onClick={onLoadPatch}>
          Load diff
        </Button>
      }
    />
  );
}

function DiffFileCardBody({
  entry,
  changedLines,
  presentation,
  parsedFile,
  patchState,
  svgDisplayMode,
  onLoadPatch,
  onRetry,
  onOpenFilePreview,
  onRequestFileContents,
  onSelectionAddToChat,
  binaryImagePreviewState,
}: DiffFileCardBodyProps) {
  if (binaryImagePreviewState !== undefined) {
    if (
      binaryImagePreviewState.status === "idle" ||
      binaryImagePreviewState.status === "loading"
    ) {
      return (
        <DelayedLoading>
          <DiffLoadingSkeleton />
        </DelayedLoading>
      );
    }

    if (binaryImagePreviewState.status === "ready") {
      return (
        <GitDiffCardImagePreviewBody
          preview={binaryImagePreviewState.preview}
          fileDiffLabel={formatDiffEntryLabel(entry)}
        />
      );
    }

    if (patchState.status === "idle") {
      return (
        <DiffFileCardLoadDiffNotice
          entry={entry}
          changedLines={changedLines}
          onLoadPatch={onLoadPatch}
        />
      );
    }
  }

  if (patchState.status === "error") {
    return (
      <DiffFileCardNotice
        icon="AlertTriangle"
        tone="error"
        title="Couldn’t load this file’s diff"
        description={patchState.error ?? undefined}
        action={
          <Button type="button" variant="soft" size="xs" onClick={onRetry}>
            <Icon name="RotateCcw" aria-hidden />
            Retry
          </Button>
        }
      />
    );
  }

  if (entry.loadMode === "too_large") {
    return (
      <DiffFileCardNotice
        icon="FileDiff"
        title="Too large to show here"
        description={`${changedLines.toLocaleString()} changed lines. Open the file to read it in full.`}
        action={
          <DiffFileCardOpenFileAction
            path={entry.path}
            onOpenFilePreview={onOpenFilePreview}
          />
        }
      />
    );
  }

  if (entry.loadMode === "on_demand" && patchState.status === "idle") {
    return (
      <DiffFileCardLoadDiffNotice
        entry={entry}
        changedLines={changedLines}
        onLoadPatch={onLoadPatch}
      />
    );
  }

  if (parsedFile === null) {
    if (patchState.status === "loaded") {
      return (
        <DiffFileCardNotice
          icon={entry.binary ? "FileAttachment" : "DiffRenamed"}
          title={entry.binary ? "Binary file changed" : "No line changes"}
          description={
            entry.binary
              ? "Its contents can’t be compared line by line here."
              : "There is nothing to compare line by line. Usually only the name or file mode changed."
          }
          action={
            <DiffFileCardOpenFileAction
              path={entry.path}
              onOpenFilePreview={onOpenFilePreview}
            />
          }
        />
      );
    }

    return (
      <div style={{ minHeight: estimateCardBodyHeight(entry) }}>
        <DelayedLoading>
          <DiffLoadingSkeleton />
        </DelayedLoading>
      </div>
    );
  }

  return (
    <DiffFileCardRenderedBody
      entry={entry}
      parsedFile={parsedFile}
      patchText={patchState.truncated ? undefined : patchState.patch}
      presentation={presentation}
      svgDisplayMode={svgDisplayMode}
      truncated={patchState.truncated ?? false}
      onOpenFilePreview={onOpenFilePreview}
      onRequestFileContents={onRequestFileContents}
      onSelectionAddToChat={onSelectionAddToChat}
    />
  );
}

interface DiffFileCardRenderedBodyProps {
  entry: DiffFileEntry;
  parsedFile: ParsedGitDiffFile;
  patchText?: string;
  presentation: DiffPresentation;
  svgDisplayMode: GitDiffCardSvgDisplayMode;
  truncated: boolean;
  onOpenFilePreview?: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  onSelectionAddToChat?: (text: string) => void;
}

function DiffFileCardRenderedBody({
  entry,
  parsedFile,
  patchText,
  presentation,
  svgDisplayMode,
  truncated,
  onOpenFilePreview,
  onRequestFileContents,
  onSelectionAddToChat,
}: DiffFileCardRenderedBodyProps) {
  const bodyState = useGitDiffCardBody({
    fileDiff: parsedFile,
    changeKind: entry.changeKind,
    onRequestFileContents,
    patchText,
  });

  return (
    <>
      <GitDiffCardBody
        state={bodyState}
        presentation={presentation}
        svgDisplayMode={svgDisplayMode}
        reservesCollapseGutter
        defersOffscreenRendering={false}
        onSelectionAddToChat={onSelectionAddToChat}
      />
      {truncated ? (
        <div className="border-t border-border">
          <DiffFileCardNotice
            icon="ListEnd"
            title="The rest of this diff is hidden"
            description="It’s too long to show in full here. Open the file to read all of it."
            action={
              <DiffFileCardOpenFileAction
                path={entry.path}
                onOpenFilePreview={onOpenFilePreview}
              />
            }
          />
        </div>
      ) : null}
    </>
  );
}
