import { Fragment, useMemo, useRef, useState } from "react";
import type { TimelineToolArgs } from "@omnyo/server-contract";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import {
  ConversationMessageInlineOverflowToggle,
  useIsOverflowing,
} from "./conversation-message-overflow.js";
import {
  TimelineCodeBlock,
  TimelineDetailHeader,
  TimelineRunningIndicator,
  structuredOutputLanguage,
} from "./TimelineCodeBlock.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";

interface ToolCallDetailBlockProps {
  toolName: string;
  args: TimelineToolArgs;
  output: string;
  streaming?: boolean;
}

function formatArgValue(value: unknown): string {
  if (typeof value === "string") return value;

  if (value === null) return "null";

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}

interface CollapsibleHeaderProps {
  toolName: string;
  argEntries: [string, unknown][];
}

function CollapsibleHeader({ toolName, argEntries }: CollapsibleHeaderProps) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const overflows = useIsOverflowing({
    elementRef: ref,
    enabled: !expanded,
    measurementKey: `${toolName}\u0000${JSON.stringify(argEntries)}`,
  });

  return (
    <>
      <div
        ref={ref}
        className={cn(
          "relative whitespace-pre-wrap break-words leading-relaxed",
          expanded ? null : "line-clamp-3",
        )}
      >
        <span className="font-semibold">{toolName}</span>
        {argEntries.map(([key, value]) => (
          <Fragment key={key}>
            {"\n"}
            <span className="text-timeline-accent">{key}: </span>
            {typeof value === "object" && value !== null ? (
              <TimelineCodeBlock code={formatArgValue(value)} language="json" />
            ) : (
              <span>{formatArgValue(value)}</span>
            )}
          </Fragment>
        ))}
        {overflows && !expanded ? (
          <ConversationMessageInlineOverflowToggle
            buttonBackgroundClassName="bg-surface-recessed-solid"
            fadeFromClassName="from-surface-recessed-solid"
            label="Show more"
            onToggle={() => setExpanded(true)}
          />
        ) : null}
      </div>
      {expanded ? (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className={cn(
              "cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              CONTROL_HOVER_TRANSITION,
            )}
            aria-expanded={true}
          >
            Show less
          </button>
        </div>
      ) : null}
    </>
  );
}

export function ToolCallDetailBlock({
  toolName,
  args,
  output,
  streaming = false,
}: ToolCallDetailBlockProps) {
  const argEntries = args ? Object.entries(args) : [];
  const hasOutput = output.trim().length > 0;

  const outputLanguage = useMemo(
    () => structuredOutputLanguage(output),
    [output],
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border-hairline bg-surface-recessed">
        <TimelineDetailHeader
          label="Input"
          copyText={JSON.stringify(args, null, 2)}
        >
          {streaming ? <TimelineRunningIndicator /> : null}
        </TimelineDetailHeader>
        <div className="px-3 pb-2 font-mono text-xs leading-relaxed text-foreground">
          <CollapsibleHeader toolName={toolName} argEntries={argEntries} />
        </div>
      </div>
      <TimelineDetailHeader label="Output" copyText={output} />
      {hasOutput ? (
        <TimelineDetailScroll
          size="base"
          streaming={streaming}
          contentKey={output}
          scrollClassName="px-3 pb-2 font-mono text-xs leading-relaxed text-muted-foreground"
        >
          {outputLanguage === null ? (
            <pre className="m-0 min-w-0 whitespace-pre">{output}</pre>
          ) : (
            <TimelineCodeBlock code={output} language={outputLanguage} />
          )}
        </TimelineDetailScroll>
      ) : (
        <div className="px-3 pb-2 text-xs text-subtle-foreground">
          {streaming ? "Waiting for output…" : "No output"}
        </div>
      )}
    </div>
  );
}
