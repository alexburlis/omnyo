import type { ReactNode } from "react";
import type { SystemExecutionOptionsModelLoadError } from "@omnyo/server-contract";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { Icon } from "@omnyo/shared-ui/icon";
import { useUrlAnchorClickHandler } from "@/lib/url-open-routing";

interface ModelLoadErrorMessageProps {
  error: SystemExecutionOptionsModelLoadError;
  providerLabel: string;
  installUrl?: string;
}

interface FormatModelLoadErrorTextArgs {
  error: SystemExecutionOptionsModelLoadError;
  providerLabel: string;
}

export function formatModelLoadErrorSummary({
  providerLabel,
}: Pick<FormatModelLoadErrorTextArgs, "providerLabel">): string {
  return `Could not load models for ${providerLabel}.`;
}

export function formatModelLoadErrorReason({
  error,
}: Pick<FormatModelLoadErrorTextArgs, "error">): string | null {
  switch (error.code) {
    case "provider_unavailable":
      return "Provider plugin failed to load";
    case "missing_executable":
      return "CLI not found";
    case "auth_required":
      return "Not signed in";
    case "timeout":
      return "Timed out";
    case "failed":
      return error.detail;
  }
}

export function formatModelLoadErrorText(
  args: FormatModelLoadErrorTextArgs,
): string {
  const summary = formatModelLoadErrorSummary(args);
  const reason = formatModelLoadErrorReason(args);

  return reason === null ? summary : `${summary} ${reason}.`;
}

export function formatModelLoadErrorTitle(
  args: FormatModelLoadErrorTextArgs,
): string {
  const summary = formatModelLoadErrorSummary(args);
  const detail = args.error.detail ?? formatModelLoadErrorReason(args);

  return detail === null ? summary : `${summary}\n${detail}`;
}

function InlineCodeText({ text }: { text: string }): ReactNode {
  const segments = text.split("`");

  if (segments.length < 3 || segments.length % 2 === 0) return text;

  return segments.map((segment, index) =>
    index % 2 === 1 ? (
      <code
        key={index}
        className="rounded-xs bg-state-hover px-1 py-px font-mono text-2xs text-foreground"
      >
        {segment}
      </code>
    ) : (
      segment
    ),
  );
}

export function ModelLoadErrorMessage({
  error,
  providerLabel,
  installUrl,
}: ModelLoadErrorMessageProps): ReactNode {
  const helpUrl = error.code === "missing_executable" ? installUrl : undefined;
  const handleHelpLinkClick = useUrlAnchorClickHandler(helpUrl);
  const reason = formatModelLoadErrorReason({ error });

  const signInGuidance =
    error.code === "auth_required" && error.detail !== reason
      ? error.detail
      : null;

  const reasonIsDetail = error.code === "failed";

  return (
    <span className="flex items-start gap-2" data-model-load-error="">
      <Icon
        name="AlertTriangle"
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-warning-text"
      />
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-foreground">
          {formatModelLoadErrorSummary({ providerLabel })}
        </span>
        {reason === null ? null : (
          <span
            className={cn(
              "mt-0.5 line-clamp-3 block break-words [overflow-wrap:anywhere]",
              reasonIsDetail
                ? "text-muted-foreground"
                : "font-medium text-warning-text",
            )}
          >
            {helpUrl === undefined ? (
              reason
            ) : (
              <a
                href={helpUrl}
                target="_blank"
                rel="noreferrer"
                onClick={handleHelpLinkClick}
                className={cn(
                  "rounded-xs underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                  CONTROL_HOVER_TRANSITION,
                )}
              >
                {reason}
              </a>
            )}
          </span>
        )}
        {signInGuidance === null ? null : (
          <span className="mt-0.5 block break-words text-muted-foreground [overflow-wrap:anywhere]">
            <InlineCodeText text={signInGuidance} />
          </span>
        )}
      </span>
    </span>
  );
}
