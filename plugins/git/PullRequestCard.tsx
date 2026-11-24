import type {
  ExperimentalThreadGitMergeMethod,
  ExperimentalThreadGitPullRequestActions,
} from "@omnyo/plugin-sdk/app";
import { UrlLink } from "@omnyo/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  GIT_TONE_TEXT_CLASS,
  MERGE_METHOD_LABEL,
  type GitPullRequestModel,
} from "./model";

const MERGE_METHODS: readonly ExperimentalThreadGitMergeMethod[] = [
  "merge",
  "squash",
  "rebase",
];

const ACTION_BUTTON_CLASS =
  "h-6 px-2 text-xs font-normal [&_[data-icon-root]]:size-3";

function PullRequestAction({
  actions,
}: {
  actions: ExperimentalThreadGitPullRequestActions;
}) {
  const { isPending, markReady, merge, convertToDraft, mergeMethod } = actions;

  if (markReady !== null) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        className={ACTION_BUTTON_CLASS}
        onClick={markReady}
      >
        Mark ready
      </Button>
    );
  }

  if (merge === null && convertToDraft === null) return null;

  return (
    <span className="flex items-center">
      {merge !== null ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending}
          className={cn(ACTION_BUTTON_CLASS, "rounded-r-none border-r-0")}
          onClick={() => merge(mergeMethod)}
        >
          {MERGE_METHOD_LABEL[mergeMethod].short}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            aria-label="More pull request actions"
            className={cn(
              ACTION_BUTTON_CLASS,
              "w-6 px-0",
              merge !== null && "rounded-l-none",
            )}
          >
            <Icon name="ChevronDown" aria-hidden="true" className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" mobileTitle="Pull request">
          {merge !== null
            ? MERGE_METHODS.map((method) => (
                <DropdownMenuItem key={method} onSelect={() => merge(method)}>
                  {MERGE_METHOD_LABEL[method].long}
                  {method === mergeMethod ? (
                    <Icon
                      name="Check"
                      aria-hidden="true"
                      className="ml-auto size-3.5"
                    />
                  ) : null}
                </DropdownMenuItem>
              ))
            : null}
          {merge !== null && convertToDraft !== null ? (
            <DropdownMenuSeparator />
          ) : null}
          {convertToDraft !== null ? (
            <DropdownMenuItem onSelect={convertToDraft}>
              Convert to draft
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

export function PullRequestCard({
  pullRequest,
  actions,
}: {
  pullRequest: GitPullRequestModel;
  actions: ExperimentalThreadGitPullRequestActions | null;
}) {
  const toneClass = GIT_TONE_TEXT_CLASS[pullRequest.tone];

  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-lg border border-border bg-surface-raised px-2.5 py-2.5 shadow-card">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-state-hover">
        <Icon
          name={pullRequest.icon}
          aria-hidden="true"
          className={cn("size-3.5", toneClass)}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <UrlLink
          href={pullRequest.url}
          target="_blank"
          rel="noreferrer"
          title={pullRequest.title}
          className="min-w-0 truncate text-xs font-medium text-foreground hover:underline"
        >
          <span className="text-muted-foreground tabular-nums">
            #{pullRequest.number}
          </span>{" "}
          {pullRequest.title}
        </UrlLink>
        <span
          className={cn(
            "inline-flex h-5 w-fit items-center gap-1.5 rounded-full bg-state-hover px-2 text-xs font-medium",
            toneClass,
          )}
        >
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-current"
          />
          {pullRequest.statusLabel}
        </span>
      </div>
      {actions !== null ? (
        <span className="shrink-0 self-center">
          <PullRequestAction actions={actions} />
        </span>
      ) : null}
    </div>
  );
}
