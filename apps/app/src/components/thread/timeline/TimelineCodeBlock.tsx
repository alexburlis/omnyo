import { useMemo, type ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { highlightMarkdownCode } from "@/components/ui/markdown-code-highlight";
import "@/components/ui/markdown-code-highlight.css";

export function highlightCommand(command: string): string {
  const lines = command.split("\n");
  const first = lines[0] ?? "";

  const heredoc =
    /\b(python(?:\d(?:\.\d+)?)?|node|ruby)\b[^\n]*<<\s*['"]?(\w+)['"]?\s*$/u.exec(
      first,
    );

  const end = lines.at(-1);

  if (heredoc !== null && end?.trim() === heredoc[2] && lines.length > 2) {
    const language = heredoc[1]?.startsWith("python")
      ? "python"
      : heredoc[1] === "node"
        ? "javascript"
        : "ruby";

    return [
      highlightMarkdownCode({ code: first, language: "shell" }),
      highlightMarkdownCode({ code: lines.slice(1, -1).join("\n"), language }),
      highlightMarkdownCode({ code: end, language: "shell" }),
    ].join("\n");
  }

  return highlightMarkdownCode({ code: command, language: "shell" });
}

export function structuredOutputLanguage(output: string): "json" | null {
  if (output.length > 128_000 || !/^[\s]*[\[{]/u.test(output)) return null;

  try {
    JSON.parse(output);

    return "json";
  } catch {
    return null;
  }
}

export function TimelineCodeBlock({
  code,
  language,
}: {
  code: string;
  language: "command" | "json";
}) {
  const html = useMemo(
    () =>
      code.length > 128_000
        ? null
        : language === "command"
          ? highlightCommand(code)
          : highlightMarkdownCode({ code, language }),
    [code, language],
  );

  if (html === null)
    return (
      <code className="block whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {code}
      </code>
    );

  return (
    <code
      className="omnyo-code-highlight block whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function TimelineDetailHeader({
  label,
  copyText,
  children,
}: {
  label: string;
  copyText: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2 px-3 text-2xs font-medium text-muted-foreground">
      <span>{label}</span>
      {children}
      <CopyButton
        text={copyText}
        label={`Copy ${label.toLowerCase()}`}
        className="ml-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

export function TimelineRunningIndicator() {
  return (
    <span
      role="status"
      aria-label="Running"
      className="inline-flex items-center gap-1.5 text-timeline-accent"
    >
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full bg-current motion-safe:animate-pulse motion-reduce:animate-none"
      />
      Running
    </span>
  );
}
