import { useMemo, useState } from "react";
import {
  experimental_ThreadMergeBasePicker as ThreadMergeBasePicker,
  experimental_useThreadGit as useThreadGit,
} from "@omnyo/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import { Icon } from "@/components/ui/icon";
import { MetaChip } from "@/components/ui/meta-chip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ChangeGroup } from "./ChangeGroup";
import { DiffTally } from "./DiffTally";
import { PullRequestCard } from "./PullRequestCard";
import {
  GIT_TONE_TEXT_CLASS,
  formatCount,
  pluralize,
  toGitHeaderModel,
  type GitChangeGroup,
  type GitFileRow,
  type GitHeaderModel,
  type GitSync,
  type GitTreeState,
  type ReadyThreadGit,
} from "./model";

const PILL_CLASS = cn(
  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
  "border-border/70 font-normal data-[state=open]:bg-state-active [&_[data-icon-root]]:size-3.5",
);

const JOINED_START_CLASS = "rounded-r-none focus-visible:z-10";

const JOINED_END_CLASS = "rounded-l-none border-l-0 focus-visible:z-10";

const ICON_TRIGGER_CLASS = cn(
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  "relative text-muted-foreground data-[state=open]:bg-state-active",
);

const COMPACT_DOT_CLASS: Record<GitTreeState, string | null> = {
  changed: "bg-warning",
  newFilesOnly: "bg-muted-foreground",
  clean: null,
};

function syncDescription(
  count: number,
  direction: "ahead" | "behind",
  baseBranch: string | null,
): string {
  const commits = pluralize(count, "commit", "commits");
  const base = baseBranch ?? "the base branch";

  return direction === "ahead"
    ? `${commits} on this branch that ${base} doesn’t have yet`
    : `${commits} on ${base} that this branch doesn’t have yet`;
}

function SyncArrows({ sync }: { sync: GitSync }) {
  if (sync.aheadCount === 0 && sync.behindCount === 0) return null;

  return (
    <span className="shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">
      {sync.aheadCount > 0 ? `↑${formatCount(sync.aheadCount)}` : null}
      {sync.aheadCount > 0 && sync.behindCount > 0 ? " " : null}
      {sync.behindCount > 0 ? `↓${formatCount(sync.behindCount)}` : null}
    </span>
  );
}

function SyncChips({ sync }: { sync: GitSync }) {
  if (sync.aheadCount === 0 && sync.behindCount === 0) return null;

  return (
    <span className="flex shrink-0 items-center gap-1">
      {sync.aheadCount > 0 ? (
        <MetaChip
          icon="ArrowUp"
          label={formatCount(sync.aheadCount)}
          description={syncDescription(
            sync.aheadCount,
            "ahead",
            sync.baseBranch,
          )}
        />
      ) : null}
      {sync.behindCount > 0 ? (
        <MetaChip
          icon="ArrowDown"
          label={formatCount(sync.behindCount)}
          tone="attention"
          description={syncDescription(
            sync.behindCount,
            "behind",
            sync.baseBranch,
          )}
        />
      ) : null}
    </span>
  );
}

function TriggerDetail({ model }: { model: GitHeaderModel }) {
  switch (model.tree) {
    case "changed":
      return model.changesTally.insertions + model.changesTally.deletions >
        0 ? (
        <DiffTally tally={model.changesTally} />
      ) : (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {pluralize(model.changedFileCount, "file", "files")}
        </span>
      );
    case "newFilesOnly":
      return (
        <span className="shrink-0 whitespace-nowrap text-subtle-foreground tabular-nums">
          +{formatCount(model.newFileCount)} new
        </span>
      );
    case "clean":
      return <SyncArrows sync={model.sync} />;
  }
}

function groupDetail(group: GitChangeGroup, sync: GitSync): string {
  if (group.id === "committed" && sync.aheadCount > 0) {
    return `${pluralize(sync.aheadCount, "commit", "commits")} ahead of ${sync.baseBranch}`;
  }

  return formatCount(group.fileCount);
}

function CleanState({ sync }: { sync: GitSync }) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-2">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-success/12 text-success-foreground">
        <Icon name="Check" aria-hidden="true" className="size-3.5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium leading-5 text-foreground">
          Working tree clean
        </p>
        <p className="truncate text-xs leading-5 text-muted-foreground">
          {sync.state === "inSync"
            ? `Up to date with ${sync.baseBranch}`
            : "No uncommitted changes."}
        </p>
      </div>
    </div>
  );
}

function LoadingTrigger({ isCompactViewport }: { isCompactViewport: boolean }) {
  const icon = (
    <Icon
      name="GitBranch"
      aria-hidden="true"
      className="size-3.5 shrink-0 animate-pulse text-muted-foreground motion-reduce:animate-none"
    />
  );

  return (
    <span
      role="status"
      aria-label="Git: loading"
      className={cn(
        "inline-flex items-center gap-1.5",
        isCompactViewport
          ? COARSE_POINTER_HEADER_ICON_BUTTON_CLASS
          : "h-7 rounded-md border border-border/70 px-2",
        "justify-center",
      )}
    >
      {icon}
      {isCompactViewport ? null : (
        <span className="h-2 w-16 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
      )}
    </span>
  );
}

function ReadyGitControl({
  git,
  isCompactViewport,
}: {
  git: ReadyThreadGit;
  isCompactViewport: boolean;
}) {
  const model = useMemo(() => toGitHeaderModel(git), [git]);
  const [open, setOpen] = useState(false);
  const { commit } = git;
  const showsCommit = commit !== null && !isCompactViewport;

  const quiet =
    model.tree === "clean" &&
    (model.sync.state === "inSync" || model.sync.state === "noBase");

  const compactDot = COMPACT_DOT_CLASS[model.tree];

  const openFile = (file: GitFileRow) => {
    setOpen(false);
    git.openFile({ path: file.path, source: file.source });
  };

  const openDiffPanel = () => {
    setOpen(false);
    git.openDiffPanel();
  };

  const runCommit = (run: () => void) => {
    setOpen(false);
    run();
  };

  return (
    <span className="flex min-w-0 items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {isCompactViewport ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={model.accessibleLabel}
              className={ICON_TRIGGER_CLASS}
            >
              <Icon name="GitBranch" aria-hidden="true" />
              {compactDot === null ? null : (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1 right-1 size-1.5 rounded-full",
                    compactDot,
                  )}
                />
              )}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={model.accessibleLabel}
              className={cn(
                PILL_CLASS,
                "min-w-0 max-w-48 gap-1.5",
                showsCommit && JOINED_START_CLASS,
              )}
            >
              <Icon
                name="GitBranch"
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span
                className={cn(
                  "min-w-0 truncate",
                  quiet ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {model.branchShortLabel}
              </span>
              <TriggerDetail model={model} />
              {model.pullRequest === null ? null : (
                <Icon
                  name={model.pullRequest.icon}
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0",
                    GIT_TONE_TEXT_CLASS[model.pullRequest.tone],
                  )}
                />
              )}
            </Button>
          )}
        </PopoverTrigger>
        <PopoverContent
          align="end"
          mobileTitle="Git"
          className="flex w-96 max-w-[calc(100vw-1.5rem)] flex-col p-0"
        >
          <div className="flex min-w-0 items-center gap-2 border-b border-border/70 px-3 py-2 text-xs">
            <Icon
              name="GitBranch"
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span
              className="min-w-0 truncate font-medium text-foreground"
              title={model.branchLabel}
            >
              {model.branchLabel}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
              <SyncChips sync={model.sync} />
              {model.sync.baseBranch === null ? null : <span>into</span>}
              <ThreadMergeBasePicker align="end" />
            </span>
          </div>
          <div className="max-h-[min(60vh,22rem)] min-h-0 overflow-y-auto p-1.5">
            {model.pullRequest === null ? null : (
              <div className="px-0.5 pb-1.5">
                <PullRequestCard
                  pullRequest={model.pullRequest}
                  actions={git.pullRequestActions}
                />
              </div>
            )}
            {model.tree === "clean" ? <CleanState sync={model.sync} /> : null}
            {model.groups.map((group) => (
              <ChangeGroup
                key={group.id}
                group={group}
                detail={groupDetail(group, model.sync)}
                onOpenFile={openFile}
                onOpenDiffPanel={openDiffPanel}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border/70 px-2 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={openDiffPanel}
            >
              <Icon name="FileDiff" aria-hidden="true" className="size-3.5" />
              Review all changes
            </Button>
            {commit === null ? null : (
              <Button
                type="button"
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => runCommit(commit)}
              >
                Commit…
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {showsCommit ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(PILL_CLASS, "shrink-0", JOINED_END_CLASS)}
          onClick={commit}
        >
          Commit
        </Button>
      ) : null}
    </span>
  );
}

export function GitHeaderControl({
  isCompactViewport,
}: {
  isCompactViewport: boolean;
}) {
  const git = useThreadGit();

  if (git === null) return null;

  if (git.status === "loading") {
    return <LoadingTrigger isCompactViewport={isCompactViewport} />;
  }

  return <ReadyGitControl git={git} isCompactViewport={isCompactViewport} />;
}
