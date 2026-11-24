import { useEffect, useState } from "react";
import {
  assertNever,
  fileNameFromPath,
  type TimelineViewWorkRow,
} from "@omnyo/thread-view";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import { EventCodeBlock } from "../../ui/event-code-block.js";
import { ImageLightbox } from "../../ui/image-lightbox.js";
import { EmptyStatePanel } from "@omnyo/shared-ui/empty-state";
import { LazyTerminalOutputBlock } from "./LazyTerminalOutputBlock.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import { LazyTimelineFileDiffBlock } from "./LazyTimelineFileDiffBlock.js";
import { ToolCallDetailBlock } from "./ToolCallDetailBlock.js";
import { QuestionWorkRowBody } from "./QuestionWorkRowBody.js";
import { WorkflowWorkRowBody } from "./WorkflowWorkRowBody.js";
import {
  PlanStepsWorkRowBody,
  PresentationDetail,
} from "./PresentationWorkRowBodies.js";
import {
  useTimelineWorkRowFullOutput,
  type TimelinePreviewableWorkRow,
  type TimelineWorkRowFullOutput,
  type TimelineWorkRowFullOutputState,
} from "./useTimelineWorkRowFullOutput.js";
import { buildThreadHostFileContentUrl } from "@/lib/file-content-urls";
import type { ThreadTimelineImageViewSrcResolver } from "./types.js";

interface WorkRowBodyProps {
  resolveImageViewSrc?: ThreadTimelineImageViewSrcResolver;
  row: TimelineViewWorkRow;
  workspaceRootPath: string | undefined;
}

type ImageWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "image-view" | "image-generation" }
>;

interface ImageWorkRowBodyProps {
  resolveImageViewSrc?: ThreadTimelineImageViewSrcResolver;
  row: ImageWorkRow;
}

interface CommandWorkRowBodyProps {
  row: Extract<TimelineViewWorkRow, { workKind: "command" }>;
}

interface ToolWorkRowBodyProps {
  row: Extract<TimelineViewWorkRow, { workKind: "tool" }>;
}

interface OutputPreviewNoteProps {
  fullOutput: TimelineWorkRowFullOutput;
  row: TimelinePreviewableWorkRow;
}

interface OutputPreviewNoteArgs {
  state: TimelineWorkRowFullOutputState;
  totalChars: number;
}

interface ResolveImageViewSourceArgs {
  resolveImageViewSrc: ThreadTimelineImageViewSrcResolver | undefined;
  row: ImageWorkRow;
}

function resolveImageViewSources({
  resolveImageViewSrc,
  row,
}: ResolveImageViewSourceArgs): { original: string; preview: string } | null {
  if (!row.path || (row.workKind === "image-generation" && row.error)) {
    return null;
  }

  if (resolveImageViewSrc) {
    const src = resolveImageViewSrc({ path: row.path, threadId: row.threadId });

    return { original: src, preview: src };
  }

  const original = buildThreadHostFileContentUrl(row.threadId, row.path);

  return {
    original,
    preview:
      row.workKind === "image-view"
        ? buildThreadHostFileContentUrl(row.threadId, row.path, "960")
        : original,
  };
}

function ImageWorkRowBody({ resolveImageViewSrc, row }: ImageWorkRowBodyProps) {
  const [loadError, setLoadError] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const sources = resolveImageViewSources({ resolveImageViewSrc, row });
  const imageSrc = sources?.original ?? null;
  const imageName = row.path ? fileNameFromPath(row.path) : "";
  const imageAlt = `${row.workKind === "image-generation" ? "Generated" : "Viewed"} image: ${imageName}`;

  useEffect(() => {
    setLoadError(false);
    setLightboxOpen(false);
  }, [imageSrc, row.completedAt, row.status]);

  if (loadError || !sources) {
    return (
      <EmptyStatePanel className="rounded-lg">
        <div className="whitespace-pre-wrap break-words">
          {row.workKind === "image-generation" && row.error
            ? row.error
            : "Image preview unavailable."}
        </div>
        <div className="mt-1 break-all font-mono text-xs">{row.path}</div>
      </EmptyStatePanel>
    );
  }

  return (
    <>
      <button
        type="button"
        className={cn(
          "block w-full max-w-80 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-w-96",
          CONTROL_PRESS_TRANSITION,
          CONTROL_PRESS_FEEDBACK,
        )}
        onClick={() => setLightboxOpen(true)}
        aria-label={`Open image preview: ${imageName}`}
      >
        <img
          src={sources.preview}
          alt=""
          className="block h-auto w-full object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setLoadError(true)}
        />
      </button>
      <ImageLightbox
        imageAlt={imageAlt}
        imageSrc={lightboxOpen ? sources.original : null}
        onClose={() => setLightboxOpen(false)}
        title={imageAlt}
      />
    </>
  );
}

function outputPreviewNoteText({
  state,
  totalChars,
}: OutputPreviewNoteArgs): string | null {
  const total = `${totalChars.toLocaleString()} characters`;

  switch (state) {
    case "streaming-preview":
      return `Preview of ${total}. The full output loads when this finishes.`;
    case "limited-preview":
      return `Preview of ${total}. The full output exceeds the detail response limit.`;
    case "expired-preview":
      return `Preview of ${total}. The full output is no longer available because its retention period ended.`;
    case "loading":
      return `Loading the full output (${total})…`;
    case "error":
      return `Failed to load the full output (${total}).`;
    case "complete":
    case "loaded":
      return null;
    default:
      return assertNever(state);
  }
}

function OutputPreviewNote({ fullOutput, row }: OutputPreviewNoteProps) {
  if (row.outputPreview === undefined) {
    return null;
  }

  const text = outputPreviewNoteText({
    state: fullOutput.state,
    totalChars: row.outputPreview.totalChars,
  });

  if (text === null) {
    return null;
  }

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      data-testid="timeline-output-preview-note"
    >
      <span>{text}</span>
      {fullOutput.state === "error" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={fullOutput.retry}
          className="h-6 cursor-pointer px-2"
        >
          <Icon name="RotateCcw" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function CommandWorkRowBody({ row }: CommandWorkRowBodyProps) {
  const fullOutput = useTimelineWorkRowFullOutput(row);

  return (
    <div className="space-y-1">
      <LazyTerminalOutputBlock
        commandLine={`$ ${row.command}`}
        metadataLines={row.source ? [`source: ${row.source}`] : []}
        output={fullOutput.output}
        exitCode={row.exitCode}
        streaming={row.status === "pending"}
      />
      <OutputPreviewNote fullOutput={fullOutput} row={row} />
    </div>
  );
}

function ToolWorkRowBody({ row }: ToolWorkRowBodyProps) {
  const fullOutput = useTimelineWorkRowFullOutput(row);

  return (
    <div className="space-y-1">
      <PresentationDetail presentation={row.presentation} />
      <ToolCallDetailBlock
        toolName={row.toolName}
        args={row.toolArgs}
        output={fullOutput.output}
        streaming={row.status === "pending"}
      />
      <OutputPreviewNote fullOutput={fullOutput} row={row} />
    </div>
  );
}

export function WorkRowBody({
  resolveImageViewSrc,
  row,
  workspaceRootPath,
}: WorkRowBodyProps) {
  switch (row.workKind) {
    case "command":
      return <CommandWorkRowBody row={row} />;
    case "tool":
      return <ToolWorkRowBody row={row} />;
    case "file-change":
      return (
        <div className="space-y-2">
          {row.stderr ? (
            <TimelineDetailScroll
              size="base"
              contentKey={row.stderr}
              className="rounded-md"
            >
              <EventCodeBlock
                tone="danger"
                className="rounded-none border-0 px-2 py-1.5"
              >
                {row.stderr}
              </EventCodeBlock>
            </TimelineDetailScroll>
          ) : null}
          {row.stderr && !row.change.diff?.trim() ? null : (
            <LazyTimelineFileDiffBlock
              change={row.change}
              workspaceRootPath={workspaceRootPath}
            />
          )}
        </div>
      );
    case "delegation":
      return null;
    case "question":
      return <QuestionWorkRowBody row={row} />;
    case "form":
      return <PresentationDetail presentation={row.presentation} />;
    case "workflow":
      return (
        <div className="space-y-2">
          <PresentationDetail presentation={row.presentation} />
          <WorkflowWorkRowBody row={row} />
        </div>
      );
    case "plan-steps":
      return <PlanStepsWorkRowBody row={row} />;
    case "extension":
      return <PresentationDetail presentation={row.presentation} />;
    case "image-generation":
    case "image-view":
      return (
        <ImageWorkRowBody row={row} resolveImageViewSrc={resolveImageViewSrc} />
      );
    case "approval":
    case "web-search":
    case "web-fetch":
    case "file-read":
    case "search":
      return null;
    default:
      return assertNever(row);
  }
}
