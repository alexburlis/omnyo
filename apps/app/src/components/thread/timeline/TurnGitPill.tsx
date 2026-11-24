import type {
  GitActivity,
  GitActivityCommit,
  GitActivityPush,
} from "@omnyo/domain";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import { Pill } from "@omnyo/shared-ui/pill";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import {
  formatGitActivityRemoteLabel,
  formatTurnGitActivitySentence,
  gitActivityCommitWebUrl,
  plural,
  shortGitSha,
  summarizeTurnGitActivity,
  type TurnGitActivitySummary,
} from "@omnyo/thread-view";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import type { ThreadTimelineLinkHandler } from "./types.js";

interface TurnGitPillProps {
  activity: GitActivity;
  onOpenLink?: ThreadTimelineLinkHandler;
}

interface TurnGitActivityDetailsProps {
  activity: GitActivity;
  onOpenLink?: ThreadTimelineLinkHandler;
}

interface TurnGitCommitRowProps {
  activity: GitActivity;
  commit: GitActivityCommit;
  onOpenLink?: ThreadTimelineLinkHandler;
}

interface TurnGitPushRowProps {
  activity: GitActivity;
  push: GitActivityPush;
}

const PILL_CLASS = `inline-flex h-5 max-w-full cursor-pointer items-center gap-1 rounded-full border border-border bg-background px-2 text-2xs tabular-nums text-muted-foreground ${CONTROL_PRESS_TRANSITION} ${CONTROL_PRESS_FEEDBACK} hover:text-foreground data-[state=open]:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:h-7`;

const SECTION_TITLE_CLASS = "px-1.5 text-xs font-medium text-muted-foreground";

const COMMIT_ROW_BUTTON_CLASS =
  "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:py-2";

const COMMIT_LINK_CLASS = `inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground ${CONTROL_PRESS_TRANSITION} ${CONTROL_PRESS_FEEDBACK} hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-8`;

function pushTargetLabel(targets: readonly string[]): string {
  return targets.length === 1
    ? (targets[0] ?? "")
    : plural(targets.length, "branch", "branches");
}

function PillSeparator() {
  return (
    <span aria-hidden="true" className="text-subtle-foreground">
      ·
    </span>
  );
}

function PillCommits({ label }: { label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Icon name="GitCommit" className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function PillPush({ label }: { label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Icon
        name="ArrowUp"
        className="size-3 shrink-0 text-success"
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function PillWarning({ label }: { label: string }) {
  return <span className="shrink-0 text-warning-text">{label}</span>;
}

function TurnGitPillLabel({ summary }: { summary: TurnGitActivitySummary }) {
  const commits = plural(summary.commitCount, "commit");
  const target = pushTargetLabel(summary.pushTargets);

  switch (summary.state) {
    case "pushed":
      return (
        <>
          <PillCommits label={commits} />
          <PillSeparator />
          <PillPush label={target} />
        </>
      );
    case "partly-pushed":
      return (
        <>
          <PillCommits label={commits} />
          <PillSeparator />
          <PillPush label={target} />
          <PillSeparator />
          <PillWarning label={`${summary.unpushedCount} not pushed`} />
        </>
      );
    case "not-pushed":
      return (
        <>
          <PillCommits
            label={
              summary.commitBranch === null
                ? commits
                : `${commits} on ${summary.commitBranch}`
            }
          />
          <PillSeparator />
          <PillWarning label="Not pushed" />
        </>
      );
    case "push-only":
      return <PillPush label={`Pushed to ${target}`} />;
    case "none":
      return null;
  }
}

function TurnGitCommitRow({
  activity,
  commit,
  onOpenLink,
}: TurnGitCommitRowProps) {
  const pushed = commit.remoteRefs.length > 0;
  const webUrl = pushed ? gitActivityCommitWebUrl(activity, commit) : null;

  return (
    <li className="flex min-w-0 items-center gap-0.5">
      <button
        type="button"
        className={COMMIT_ROW_BUTTON_CLASS}
        title="Copy commit SHA"
        onClick={() => {
          void copyToClipboardWithToast(commit.sha, {
            successMessage: "Commit SHA copied",
            errorMessage: "Failed to copy commit SHA",
          });
        }}
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            pushed ? "bg-success" : "border border-warning-text",
          )}
        />
        <span className="sr-only">{pushed ? "Pushed" : "Not pushed"}</span>
        <span className="shrink-0 font-mono text-muted-foreground">
          {shortGitSha(commit.sha)}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground">
          {commit.subject}
        </span>
        {commit.branch === null ? null : (
          <span className="max-w-24 shrink-0 truncate text-muted-foreground">
            {commit.branch}
          </span>
        )}
      </button>
      {webUrl === null ? null : (
        <a
          href={webUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Open commit on GitHub"
          className={COMMIT_LINK_CLASS}
          onClick={(event) => {
            if (onOpenLink?.({ href: webUrl })) event.preventDefault();
          }}
        >
          <Icon name="ExternalLink" className="size-3" aria-hidden="true" />
        </a>
      )}
    </li>
  );
}

function TurnGitPushRow({ activity, push }: TurnGitPushRowProps) {
  const remoteLabel =
    formatGitActivityRemoteLabel(activity, push.remote) ?? push.remote;

  const range =
    push.oldSha === null
      ? shortGitSha(push.newSha)
      : `${shortGitSha(push.oldSha)}..${shortGitSha(push.newSha)}`;

  return (
    <li className="flex min-w-0 flex-col gap-0.5 px-1.5 py-1 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon
          name="ArrowUp"
          className="size-3 shrink-0 text-success"
          aria-hidden="true"
        />
        <span className="shrink-0 font-mono text-foreground">
          {push.branch}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          → {remoteLabel}
        </span>
        {push.commitCount === null ? null : (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {plural(push.commitCount, "commit")}
          </span>
        )}
        {push.forced ? (
          <Pill variant="outline" size="sm" className="text-warning-text">
            forced
          </Pill>
        ) : null}
        {push.oldSha === null ? (
          <Pill variant="outline" size="sm" className="text-muted-foreground">
            new branch
          </Pill>
        ) : null}
      </div>
      <span className="pl-4.5 font-mono text-2xs text-muted-foreground">
        {range}
      </span>
    </li>
  );
}

function TurnGitActivityDetails({
  activity,
  onOpenLink,
}: TurnGitActivityDetailsProps) {
  return (
    <div className="flex flex-col gap-3">
      {activity.commits.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className={SECTION_TITLE_CLASS}>Commits</h3>
          <ul className="flex flex-col">
            {activity.commits.map((commit, index) => (
              <TurnGitCommitRow
                key={`${index}:${commit.sha}`}
                activity={activity}
                commit={commit}
                onOpenLink={onOpenLink}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {activity.pushes.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className={SECTION_TITLE_CLASS}>Pushes</h3>
          <ul className="flex flex-col">
            {activity.pushes.map((push, index) => (
              <TurnGitPushRow
                key={`${index}:${push.remote}:${push.branch}`}
                activity={activity}
                push={push}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function TurnGitPill({ activity, onOpenLink }: TurnGitPillProps) {
  const summary = summarizeTurnGitActivity(activity);
  const sentence = formatTurnGitActivitySentence(summary);

  if (sentence === null) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Git: ${sentence}`}
          className={PILL_CLASS}
          data-turn-git-pill=""
        >
          <TurnGitPillLabel summary={summary} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        mobileTitle="Git activity"
        aria-label="Git activity"
        className="w-80 max-w-[calc(100vw-1.5rem)] p-1.5"
      >
        <TurnGitActivityDetails activity={activity} onOpenLink={onOpenLink} />
      </PopoverContent>
    </Popover>
  );
}
