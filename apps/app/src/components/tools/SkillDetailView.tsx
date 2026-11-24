import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { DelayedLoading } from "@omnyo/shared-ui/delayed-loading";
import { EmptyStateBlock } from "@omnyo/shared-ui/empty-state";
import { INSET_FOCUS_RING_CLASS } from "@omnyo/shared-ui/focus-ring";
import { Icon } from "@omnyo/shared-ui/icon";
import { HOVER_REVEAL_NO_HOVER_VISIBLE_CLASS } from "@omnyo/shared-ui/hover-reveal";
import { cn, formatHomePathForDisplay } from "@omnyo/shared-ui/lib/utils";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { ResourceInfiniteScrollSentinel } from "@omnyo/shared-ui/resource-pagination";
import {
  ResourceDefinitionSection,
  ResourceDetailCollection,
  ResourceDetailIncludesSection,
  ResourceDetailPage,
  ResourceDetailPanel,
  ResourceDetailStack,
} from "@omnyo/shared-ui/resource-list";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { FilePreview } from "@/components/secondary-panel/FilePreview.js";
import { ProvenancePill } from "@/components/tools/ProvenancePill";
import { CopyGlyph } from "@/components/ui/copy-button";
import { useClipboardCopy } from "@/lib/clipboard";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing";

type SkillDetailTitleBadge = {
  label: string;
  tooltip: ReactNode;
  accessibleLabel?: string;
};

type SkillDetailContentState =
  | { kind: "loading" }
  | { kind: "error"; message: string; onRetry: () => void }
  | { kind: "ready"; content: string };

interface SkillDetailViewProps {
  leading?: ReactNode;
  title: string;
  path: string;
  pathHref?: string;
  titleBadge?: SkillDetailTitleBadge;
  headerActions?: ReactNode;
  overflowMenu?: ReactNode;
  files: readonly string[];
  selectedPath: string;
  onSelectFile: (path: string) => void;
  contentState: SkillDetailContentState;
  footer?: ReactNode;
  markdownLinkRouting?: MarkdownLinkRouting;
}

const SKILL_PATH_ACTION_CLASS = `group -ml-1.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs text-subtle-foreground ${CONTROL_HOVER_TRANSITION} hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`;

function SkillPath({ path, href }: { path: string; href?: string }) {
  const { copied, copy } = useClipboardCopy({
    text: path,
    errorMessage: "Failed to copy path.",
  });

  const displayPath = formatHomePathForDisplay(path);

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${path} in a new tab`}
              className={SKILL_PATH_ACTION_CLASS}
            >
              <span className="truncate font-mono">{displayPath}</span>
              <Icon
                name="ExternalLink"
                className="size-3 shrink-0"
                aria-hidden
              />
            </a>
          ) : (
            <button
              type="button"
              aria-label={`Copy skill path: ${path}`}
              onClick={() => void copy()}
              className={SKILL_PATH_ACTION_CLASS}
            >
              <span className="truncate font-mono">{displayPath}</span>
              <CopyGlyph
                copied={copied}
                className={cn(
                  "size-3 shrink-0 opacity-0 transition-opacity duration-(--motion-duration-fast) group-hover:opacity-100 group-focus-visible:opacity-100",
                  HOVER_REVEAL_NO_HOVER_VISIBLE_CLASS,
                )}
              />
            </button>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {href ? "Open on skills.sh" : copied ? "Copied" : "Copy path"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function getSkillDirectoryPath(path: string): string {
  return path.replace(/[\\/]SKILL\.md$/i, "");
}

function skillFileDisplayName(path: string, directoryPath: string): string {
  const prefix = `${directoryPath}/`;

  if (directoryPath !== path && path.startsWith(prefix)) {
    return path.slice(prefix.length);
  }

  return formatHomePathForDisplay(path);
}

function SkillFileLabel({
  name,
  heading = false,
}: {
  name: string;
  heading?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon
        name="FileText"
        aria-hidden
        className={cn(
          "shrink-0 text-subtle-foreground",
          heading ? "size-4" : "size-3.5",
        )}
      />
      <span
        className={cn(
          "min-w-0 truncate font-mono",
          heading ? "text-sm" : "text-xs",
        )}
      >
        {name}
      </span>
    </span>
  );
}

const SKILL_FILE_ROW_CLASS = cn(
  "flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:bg-state-hover hover:text-foreground aria-pressed:bg-state-active aria-pressed:text-foreground",
  CONTROL_HOVER_TRANSITION,
  INSET_FOCUS_RING_CLASS,
);

function SkillFileList({
  files,
  directoryPath,
  selectedPath,
  onSelectFile,
}: {
  files: readonly string[];
  directoryPath: string;
  selectedPath: string;
  onSelectFile: (path: string) => void;
}) {
  return (
    <ResourceDetailCollection className="max-h-48 overflow-auto">
      {files.map((path) => (
        <button
          key={path}
          type="button"
          title={formatHomePathForDisplay(path)}
          aria-pressed={path === selectedPath}
          onClick={() => onSelectFile(path)}
          className={SKILL_FILE_ROW_CLASS}
        >
          <SkillFileLabel name={skillFileDisplayName(path, directoryPath)} />
          {path === selectedPath ? (
            <span className="ml-auto shrink-0 text-2xs text-subtle-foreground">
              Showing
            </span>
          ) : null}
        </button>
      ))}
    </ResourceDetailCollection>
  );
}

function SkillContentSkeleton({ name }: { name: string }) {
  return (
    <ResourceDetailPanel
      surface="recessed"
      className="min-h-25 px-4 py-4 shadow-none"
    >
      <DelayedLoading>
        <div
          role="status"
          aria-label={`Loading ${name}`}
          className="flex flex-col gap-2.5"
        >
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-3/5" />
        </div>
      </DelayedLoading>
    </ResourceDetailPanel>
  );
}

const SKILL_CONTENT_CHUNK_LINES = 120;

export function splitMarkdownIntoChunks(content: string): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of lines) {
    current.push(line);

    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
    }

    if (
      !inFence &&
      current.length >= SKILL_CONTENT_CHUNK_LINES &&
      line.trim() === ""
    ) {
      chunks.push(current.join("\n"));
      current = [];
    }
  }

  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }

  return chunks;
}

function ScrollingSkillContent({
  path,
  content,
  markdown,
  markdownLinkRouting,
}: {
  path: string;
  content: string;
  markdown: boolean;
  markdownLinkRouting?: MarkdownLinkRouting;
}) {
  const chunks = useMemo(
    () => (markdown ? splitMarkdownIntoChunks(content) : [content]),
    [content, markdown],
  );

  const [visibleChunkCount, setVisibleChunkCount] = useState(1);
  const shownChunks = chunks.slice(0, visibleChunkCount);

  return (
    <ResourceDetailPanel surface="recessed" className="shadow-none">
      <div
        data-skill-content-viewport
        data-infinite-scroll-root
        className="max-h-[60dvh] overflow-y-auto overscroll-contain"
      >
        {shownChunks.map((chunk, index) => (
          <FilePreview
            key={index}
            path={path}
            headerMode="none"
            markdownLinkRouting={markdownLinkRouting}
            state={{
              kind: "ready",
              file: {
                name: path.split("/").at(-1) ?? path,
                contents: chunk,
              },
              lineRange: null,
              textPreviewKind: markdown ? "markdown" : null,
            }}
          />
        ))}
        <ResourceInfiniteScrollSentinel
          itemCount={shownChunks.length}
          hasMore={visibleChunkCount < chunks.length}
          onLoadMore={() =>
            setVisibleChunkCount((current) =>
              Math.min(current + 1, chunks.length),
            )
          }
        />
      </div>
    </ResourceDetailPanel>
  );
}

export function SkillDetailView({
  leading,
  title,
  path,
  pathHref,
  titleBadge,
  headerActions,
  overflowMenu,
  files,
  selectedPath,
  onSelectFile,
  contentState,
  footer,
  markdownLinkRouting,
}: SkillDetailViewProps) {
  const directoryPath = getSkillDirectoryPath(path);
  const selectedName = skillFileDisplayName(selectedPath, directoryPath);
  const selectedFileIsMarkdown = selectedPath.toLowerCase().endsWith(".md");

  const titleMeta =
    titleBadge === undefined ? undefined : (
      <ProvenancePill
        label={titleBadge.label}
        tooltip={titleBadge.tooltip}
        accessibleLabel={titleBadge.accessibleLabel}
      />
    );

  return (
    <ResourceDetailPage
      leading={leading}
      title={title}
      titleMeta={titleMeta}
      metadata={<SkillPath path={directoryPath} href={pathHref} />}
      overflowMenu={overflowMenu}
      actions={headerActions}
    >
      <ResourceDetailStack>
        {files.length > 1 ? (
          <ResourceDetailIncludesSection label="Files">
            <SkillFileList
              files={files}
              directoryPath={directoryPath}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          </ResourceDetailIncludesSection>
        ) : null}

        <ResourceDefinitionSection
          label={
            <span title={formatHomePathForDisplay(selectedPath)}>
              <SkillFileLabel name={selectedName} heading />
            </span>
          }
        >
          {contentState.kind === "loading" ? (
            <SkillContentSkeleton name={selectedName} />
          ) : contentState.kind === "error" ? (
            <ResourceDetailPanel surface="recessed" className="shadow-none">
              <div role="alert">
                <EmptyStateBlock
                  icon="FileQuestion"
                  tone="error"
                  className="py-8"
                  title={contentState.message}
                  description="Check that the file still exists, then try again."
                  actions={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={contentState.onRetry}
                    >
                      <Icon name="RotateCcw" aria-hidden />
                      Retry
                    </Button>
                  }
                />
              </div>
            </ResourceDetailPanel>
          ) : (
            <ScrollingSkillContent
              key={`${selectedPath}:${contentState.content}`}
              path={selectedPath}
              content={contentState.content}
              markdown={selectedFileIsMarkdown}
              markdownLinkRouting={markdownLinkRouting}
            />
          )}
        </ResourceDefinitionSection>
      </ResourceDetailStack>
      {footer}
    </ResourceDetailPage>
  );
}
