import { useMemo, useState } from "react";
import Convert from "ansi-to-html";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import {
  TimelineCodeBlock,
  TimelineDetailHeader,
  TimelineRunningIndicator,
  structuredOutputLanguage,
} from "./TimelineCodeBlock.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";

export interface TerminalOutputBlockProps {
  output: string;
  commandLine: string;
  exitCode: number | null;
  metadataLines: readonly string[];
  streaming: boolean;
}

interface TerminalScrollContentKeyArgs {
  commandLine: string;
  exitCode: number | null;
  metadataLines: readonly string[];
  output: string;
}

const ANSI_THEME_COLORS: Record<number, string> = {
  0: "var(--ansi-0)",
  1: "var(--ansi-1)",
  2: "var(--ansi-2)",
  3: "var(--ansi-3)",
  4: "var(--ansi-4)",
  5: "var(--ansi-5)",
  6: "var(--ansi-6)",
  7: "var(--ansi-7)",
  8: "var(--ansi-8)",
  9: "var(--ansi-9)",
  10: "var(--ansi-10)",
  11: "var(--ansi-11)",
  12: "var(--ansi-12)",
  13: "var(--ansi-13)",
  14: "var(--ansi-14)",
  15: "var(--ansi-15)",
};

const ANSI_COLOR_INDEXES = Object.keys(ANSI_THEME_COLORS).map(Number);

const BACKGROUND_RESET_STYLE = "background-color:var(--background)";

const BACKGROUND_RESET_CONTRAST_STYLE = `${BACKGROUND_RESET_STYLE};color:var(--foreground)`;

function addBackgroundContrastColors(html: string): string {
  let out = html;

  for (const colorIndex of ANSI_COLOR_INDEXES) {
    const backgroundStyle = `background-color:var(--ansi-${colorIndex})`;
    out = out.replaceAll(
      backgroundStyle,
      `${backgroundStyle};color:var(--ansi-bg-fg-${colorIndex})`,
    );
  }

  return out.replaceAll(
    BACKGROUND_RESET_STYLE,
    BACKGROUND_RESET_CONTRAST_STYLE,
  );
}

const ANSI_TO_HTML = new Convert({
  escapeXML: true,
  newline: false,
  stream: false,
  fg: "var(--muted-foreground)",
  bg: "var(--background)",
  colors: ANSI_THEME_COLORS,
});

function stringLengthSum(values: readonly string[]): number {
  let length = 0;

  for (const value of values) {
    length += value.length;
  }

  return length;
}

function terminalScrollContentKey({
  commandLine,
  exitCode,
  metadataLines,
  output,
}: TerminalScrollContentKeyArgs): string {
  return [
    commandLine.length,
    stringLengthSum(metadataLines),
    output.length,
    exitCode ?? "",
  ].join(":");
}

export function TerminalOutputBlock({
  commandLine,
  exitCode,
  metadataLines,
  output,
  streaming,
}: TerminalOutputBlockProps) {
  const renderedOutputHtml = useMemo(
    () =>
      output.length > 0
        ? addBackgroundContrastColors(ANSI_TO_HTML.toHtml(output))
        : null,
    [output],
  );

  const [expandedCommand, setExpandedCommand] = useState(false);
  const isLongCommand = commandLine.split("\n").length > 6;

  const outputLanguage = useMemo(
    () => structuredOutputLanguage(output),
    [output],
  );

  const outputContentKey = terminalScrollContentKey({
    commandLine,
    exitCode,
    metadataLines,
    output,
  });

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {commandLine ? (
        <div className="border-b border-border-hairline bg-surface-recessed pb-2">
          <TimelineDetailHeader
            label="Command"
            copyText={commandLine.replace(/^\$ /u, "")}
          >
            {streaming ? <TimelineRunningIndicator /> : null}
          </TimelineDetailHeader>
          <div
            className={cn(
              "overflow-auto px-3 font-mono text-xs leading-relaxed",
              expandedCommand ? "max-h-[16lh]" : "max-h-[7lh]",
            )}
          >
            <TimelineCodeBlock code={commandLine} language="command" />
          </div>
          {isLongCommand ? (
            <button
              type="button"
              aria-expanded={expandedCommand}
              onClick={() => setExpandedCommand(!expandedCommand)}
              className={cn(
                "cursor-pointer px-3 py-1.5 text-2xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                CONTROL_HOVER_TRANSITION,
              )}
            >
              {expandedCommand ? "Show less" : "Show full command"}
            </button>
          ) : null}
        </div>
      ) : null}
      <TimelineDetailHeader label="Output" copyText={output}>
        {commandLine === "" && streaming ? <TimelineRunningIndicator /> : null}
        {exitCode !== null ? (
          <span
            className={
              exitCode === 0 ? "text-success" : "text-destructive-text"
            }
          >
            exit code {exitCode}
          </span>
        ) : null}
      </TimelineDetailHeader>
      {metadataLines.map((line, index) => (
        <div
          key={`${index}:${line}`}
          className="px-3 pb-1 font-mono text-2xs text-muted-foreground"
        >
          {line}
        </div>
      ))}
      {renderedOutputHtml ? (
        <TimelineDetailScroll
          size="base"
          streaming={streaming}
          contentKey={outputContentKey}
          scrollClassName="px-3 pb-3 font-mono text-xs leading-relaxed text-muted-foreground"
        >
          {outputLanguage === null ? (
            <div
              className="whitespace-pre"
              dangerouslySetInnerHTML={{ __html: renderedOutputHtml }}
            />
          ) : (
            <TimelineCodeBlock code={output} language={outputLanguage} />
          )}
        </TimelineDetailScroll>
      ) : (
        <div className="px-3 pb-3 text-xs text-subtle-foreground">
          {streaming ? "Waiting for output…" : "No output"}
        </div>
      )}
    </div>
  );
}
