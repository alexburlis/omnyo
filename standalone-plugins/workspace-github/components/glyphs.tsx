import type { Item } from "../app-logic.js";
import { absoluteTime } from "../data.js";
import { compactAge, diffBarWidths, laneIndex, repoName } from "../launchpad.js";
import { cn } from "../lib/utils.js";
import { Icon } from "./ui/icon.js";

type StateKind = "issue" | "pr";

function stateParts(kind: StateKind, state: string, draft: boolean) {
  if (kind === "issue") {
    return state === "OPEN"
      ? {
          icon: "Circle",
          tone: "text-success-foreground dark:text-success",
          label: "Open issue",
        }
      : { icon: "CircleCheck", tone: "text-pr-merged", label: "Closed issue" };
  }

  if (state === "MERGED") return { icon: "GitMerge", tone: "text-pr-merged", label: "Merged" };

  if (state === "CLOSED") {
    return { icon: "GitPullRequestClosed", tone: "text-destructive-text", label: "Closed" };
  }

  if (draft || state === "DRAFT") {
    return { icon: "GitPullRequestDraft", tone: "text-subtle-foreground", label: "Draft" };
  }

  return {
    icon: "GitPullRequest",
    tone: "text-success-foreground dark:text-success",
    label: "Open",
  };
}

export function StateGlyph({
  kind,
  state,
  draft = false,
  className,
}: {
  kind: StateKind;
  state: string;
  draft?: boolean;
  className?: string;
}) {
  const parts = stateParts(kind, state, draft);

  return (
    <Icon
      name={parts.icon}
      aria-label={parts.label}
      className={cn("size-4 shrink-0", parts.tone, className)}
    />
  );
}

export function itemIsDraft(item: Item): boolean {
  return item.pullReview === "draft" || item.pullMerge === "DRAFT";
}

export function ChecksGlyph({ checks }: { checks: Item["checks"] }) {
  if (checks === "success") {
    return (
      <Icon
        name="Check"
        aria-label="Checks passing"
        className="size-3.5 text-success-foreground dark:text-success"
      />
    );
  }

  if (checks === "failure") {
    return (
      <Icon name="CircleX" aria-label="Checks failing" className="size-3.5 text-destructive-text" />
    );
  }

  if (checks === "pending") {
    return (
      <Icon
        name="Clock"
        aria-label="Checks running"
        className="size-3.5 text-warning-text dark:text-attention"
      />
    );
  }

  return (
    <span aria-label="No checks reported" className="text-xs text-subtle-foreground">
      –
    </span>
  );
}

export function DiffBar({
  additions,
  deletions,
  track = 48,
}: {
  additions: number;
  deletions: number;
  track?: number;
}) {
  const { added, removed } = diffBarWidths(additions, deletions, track);

  return (
    <span
      className="wgh-diff-track"
      style={{ width: track }}
      role="img"
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      <span className="h-full bg-diff-added" style={{ width: added }} />
      <span className="h-full bg-diff-removed" style={{ width: removed }} />
    </span>
  );
}

export function DiffNumbers({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-success-foreground dark:text-success">+{additions}</span>{" "}
      <span className="text-destructive-text">−{deletions}</span>
    </span>
  );
}

export function laneClass(repo: string): string {
  return `wgh-lane-${laneIndex(repo)}`;
}

export function RepoTag({ repo, className }: { repo: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        laneClass(repo),
        className,
      )}
      title={repo}
    >
      <span className="wgh-lane-dot" aria-hidden="true" />
      <span className="min-w-0 truncate">{repoName(repo)}</span>
    </span>
  );
}

export function RefPill({ name, tinted, repo }: { name: string; tinted: boolean; repo: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded px-1.5 font-mono text-xs",
        tinted ? cn("wgh-ref", laneClass(repo)) : "text-foreground ring-1 ring-inset ring-border",
      )}
      title={name}
    >
      <Icon name="GitBranch" aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

export function Avatar({ login, className }: { login: string; className?: string }) {
  const bot = login.startsWith("app/") || login.endsWith("[bot]");

  if (bot || login.length === 0) {
    return (
      <span
        title={login.replace(/^app\//, "") || "GitHub app"}
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full bg-state-active text-muted-foreground",
          className,
        )}
      >
        <Icon name="Bot" aria-hidden="true" className="size-3" />
      </span>
    );
  }

  return (
    <img
      src={`https://github.com/${encodeURIComponent(login)}.png?size=40`}
      alt={login}
      title={login}
      loading="lazy"
      className={cn("size-4 shrink-0 rounded-full bg-muted", className)}
    />
  );
}

export function Age({ iso, className }: { iso: string; className?: string }) {
  return (
    <time
      dateTime={iso}
      title={absoluteTime(iso)}
      className={cn("tabular-nums text-xs text-subtle-foreground", className)}
    >
      {compactAge(iso)}
    </time>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-grid h-4 min-w-4 place-items-center rounded border border-border bg-surface-raised px-1 font-mono text-2xs font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function LabelPill({ label }: { label: string }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded px-1 text-2xs font-medium text-warning-text ring-1 ring-inset ring-warning/45">
      {label}
    </span>
  );
}

export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h3
      className={cn(
        "flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle-foreground",
        className,
      )}
    >
      {children}
    </h3>
  );
}

export function CountChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-grid h-4 min-w-4 place-items-center rounded bg-state-active px-1 text-2xs font-medium tabular-nums text-foreground">
      {children}
    </span>
  );
}
