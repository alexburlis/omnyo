import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  experimental_copyToClipboard,
  experimental_Diff as Diff,
  experimental_FileLink as FileLink,
  experimental_useAppNavigate,
  UrlLink,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import { toast } from "sonner";
import type { Item } from "../app-logic.js";
import {
  errorText,
  issueModels,
  pullModels,
  relativeTime,
  useIssueMutations,
  useLinks,
  useReadModel,
  useSpawn,
  useViewer,
  type IssueDetail,
  type PullCheck,
  type PullDetail,
  type PullFile,
  type ReviewThread,
  type ThreadLink,
} from "../data.js";
import type { githubRpcContract } from "../server.js";
import { cn } from "../lib/utils.js";
import {
  Avatar,
  CountChip,
  DiffBar,
  DiffNumbers,
  laneClass,
  RefPill,
  SectionLabel,
  StateGlyph,
} from "./glyphs.js";
import { ItemActions } from "./item-actions.js";
import { Markdown } from "./markdown-lite.js";
import { Button } from "./ui/button.js";
import { DelayedLoading } from "./ui/delayed-loading.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";
import { Icon } from "./ui/icon.js";
import { Skeleton } from "./ui/skeleton.js";
import { Textarea } from "./ui/textarea.js";

export type InspectorLayout = "pane" | "page" | "thread";

export interface InspectorNavigation {
  layout: InspectorLayout;
  backLabel?: string;
  onBack?: () => void;
  onClose?: () => void;
  onStep?: (direction: 1 | -1) => void;
}

type VerdictTone = "ready" | "blocked" | "attention" | "merged" | "none";

const CHECK_ORDER: Record<PullCheck["status"], number> = {
  failure: 0,
  pending: 1,
  success: 2,
  neutral: 3,
};

interface PullVerdict {
  tone: VerdictTone;
  title: string;
  detail: string;
}

function pullVerdict(pull: PullDetail): PullVerdict {
  const failing = pull.checks.filter((check) => check.status === "failure").length;
  const pending = pull.checks.filter((check) => check.status === "pending").length;
  const total = pull.checks.length;

  const checksLine =
    total === 0
      ? "No checks reported"
      : failing > 0
        ? `${total - failing} of ${total} checks passing`
        : pending > 0
          ? `${total - pending} of ${total} checks finished`
          : `All ${total} checks passed`;

  if (pull.state === "MERGED") {
    return { tone: "merged", title: `Merged into ${pull.baseRefName}`, detail: checksLine };
  }

  if (pull.state === "CLOSED") {
    return { tone: "none", title: "Closed without merging", detail: checksLine };
  }

  if (pull.state === "DRAFT") {
    return { tone: "none", title: "Draft — not ready to merge", detail: checksLine };
  }

  if (pull.mergeStateStatus === "DIRTY") {
    return { tone: "blocked", title: `Conflicts with ${pull.baseRefName}`, detail: checksLine };
  }

  if (failing > 0 && pull.mergeStateStatus === "UNSTABLE") {
    return {
      tone: "attention",
      title: `${failing} of ${total} check${total === 1 ? "" : "s"} failing`,
      detail: "These checks aren’t required, so GitHub still allows merging",
    };
  }

  if (failing > 0) {
    return {
      tone: "blocked",
      title: `Blocked — ${failing} of ${total} check${total === 1 ? "" : "s"} failing`,
      detail: "Merge is disabled until the failing checks pass",
    };
  }

  if (pull.reviewDecision === "CHANGES_REQUESTED") {
    return { tone: "attention", title: "Changes requested", detail: checksLine };
  }

  if (pull.reviewDecision === "REVIEW_REQUIRED") {
    return { tone: "none", title: "Waiting for review", detail: checksLine };
  }

  if (pending > 0) return { tone: "none", title: "Checks running", detail: checksLine };

  if (pull.mergeStateStatus === "BEHIND") {
    return { tone: "blocked", title: `Behind ${pull.baseRefName}`, detail: checksLine };
  }

  if (pull.mergeStateStatus === "BLOCKED") {
    return { tone: "blocked", title: "Blocked by branch rules", detail: checksLine };
  }

  if (pull.mergeStateStatus === "CLEAN" || pull.mergeStateStatus === "HAS_HOOKS") {
    return {
      tone: "ready",
      title: pull.reviewDecision === "APPROVED" ? "Approved — ready to merge" : "Ready to merge",
      detail: checksLine,
    };
  }

  return { tone: "none", title: "GitHub is still computing mergeability", detail: checksLine };
}

const VERDICT_ICON: Record<VerdictTone, { icon: string; tone: string }> = {
  ready: {
    icon: "CircleCheck",
    tone: "text-success-foreground dark:text-success",
  },
  blocked: { icon: "CircleX", tone: "text-destructive-text" },
  attention: { icon: "AlertCircle", tone: "text-warning-text" },
  merged: { icon: "GitMerge", tone: "text-pr-merged" },
  none: { icon: "Info", tone: "text-muted-foreground" },
};

const CHECK_GLYPH: Record<PullCheck["status"], { icon: string; tone: string; label: string }> = {
  success: {
    icon: "Check",
    tone: "text-success-foreground dark:text-success",
    label: "Passed",
  },
  failure: { icon: "CircleX", tone: "text-destructive-text", label: "Failing" },
  pending: { icon: "Clock", tone: "text-warning-text dark:text-attention", label: "Running" },
  neutral: { icon: "Minus", tone: "text-subtle-foreground", label: "Skipped" },
};

function Verdict({
  tone,
  title,
  detail,
  code,
  children,
}: {
  tone: VerdictTone;
  title: string;
  detail: string;
  code?: string;
  children?: React.ReactNode;
}) {
  const glyph = VERDICT_ICON[tone];

  return (
    <section className="wgh-verdict px-3 py-2.5" data-tone={tone} aria-label="Merge status">
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon name={glyph.icon} aria-hidden="true" className={cn("size-4", glyph.tone)} />
        <span className="min-w-0 flex-1">{title}</span>
        {code === undefined ? null : (
          <span className="shrink-0 font-mono text-2xs font-medium tracking-wide text-subtle-foreground">
            {code}
          </span>
        )}
      </p>
      <p className="mt-0.5 pl-6 text-xs text-muted-foreground">{detail}</p>
      {children}
    </section>
  );
}

function ChecksList({ checks }: { checks: PullCheck[] }) {
  const [expanded, setExpanded] = useState(false);

  const sorted = useMemo(
    () => [...checks].sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]),
    [checks],
  );

  if (sorted.length === 0) return null;
  const visible = expanded ? sorted : sorted.slice(0, 5);

  return (
    <ul className="mt-2 border-t border-border-seam pt-1" aria-label="Checks">
      {visible.map((check, index) => {
        const glyph = CHECK_GLYPH[check.status];

        return (
          <li
            key={`${check.name}-${index}`}
            className="grid min-h-6 grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-x-2 text-xs"
          >
            <Icon name={glyph.icon} aria-hidden="true" className={cn("size-3.5", glyph.tone)} />
            <span className="min-w-0 truncate font-mono text-foreground" title={check.name}>
              {check.name}
            </span>
            {check.url.length > 0 ? (
              <UrlLink
                href={check.url}
                className="text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {glyph.label} ↗
              </UrlLink>
            ) : (
              <span className="text-subtle-foreground">{glyph.label}</span>
            )}
          </li>
        );
      })}
      {sorted.length > 5 ? (
        <li>
          <button
            type="button"
            className="h-6 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show fewer checks" : `Show ${sorted.length - 5} more checks`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function MetaGrid({ cells }: { cells: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl
      className="grid overflow-hidden rounded-md border border-border-seam bg-surface-raised"
      style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
    >
      {cells.map((cell, index) => (
        <div
          key={cell.label}
          className={cn("min-w-0 px-2.5 py-1.5", index > 0 && "border-l border-border-seam")}
        >
          <dt className="text-2xs font-semibold uppercase tracking-wider text-subtle-foreground">
            {cell.label}
          </dt>
          <dd className="mt-0.5 truncate text-sm text-foreground">{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function InspectorSection({
  label,
  count,
  aside,
  children,
}: {
  label: string;
  count?: number;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border-seam px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5">
        <SectionLabel>{label}</SectionLabel>
        {count === undefined ? null : <CountChip>{count}</CountChip>}
        {aside === undefined ? null : <span className="ml-auto text-xs">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function CollapsibleBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = body.length > 1600;

  if (body.trim().length === 0) {
    return <p className="text-sm text-muted-foreground">No description.</p>;
  }

  return (
    <div>
      <div className={cn("relative", long && !expanded && "max-h-80 overflow-hidden")}>
        <Markdown content={body} className="text-sm" />
        {long && !expanded ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
        ) : null}
      </div>
      {long ? (
        <button
          type="button"
          className="mt-1 h-6 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show full description"}
        </button>
      ) : null}
    </div>
  );
}

function InspectorHeader({
  kind,
  state,
  draft,
  title,
  repo,
  number,
  url,
  updatedAt,
  navigation,
  children,
}: {
  kind: "issue" | "pr";
  state: string;
  draft: boolean;
  title: string;
  repo: string;
  number: number;
  url: string;
  updatedAt: string;
  navigation: InspectorNavigation;
  children?: React.ReactNode;
}) {
  const navigate = experimental_useAppNavigate();

  return (
    <header className="px-4 pb-3 pt-3.5">
      {navigation.onBack === undefined ? null : (
        <Button
          size="sm"
          variant="ghost"
          className={cn(
            "-ml-2 mb-1.5 h-7 gap-1 px-2 text-xs text-muted-foreground",
            navigation.layout === "pane" && "@[60rem]/wgh:hidden",
          )}
          onClick={navigation.onBack}
        >
          <Icon name="ArrowLeft" aria-hidden="true" className="size-3.5" />
          {navigation.backLabel ?? "Back"}
        </Button>
      )}
      <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2.5">
        <StateGlyph kind={kind} state={state} draft={draft} className="mt-0.5" />
        <h2
          className={cn(
            "min-w-0 font-semibold text-foreground",
            navigation.layout === "page" ? "text-lead" : "text-base",
          )}
        >
          {title}
        </h2>
        <div className="-mt-1 flex items-center">
          {navigation.onStep === undefined ? null : (
            <>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground"
                aria-label="Previous item"
                onClick={() => navigation.onStep?.(-1)}
              >
                <Icon name="ChevronUp" aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground"
                aria-label="Next item"
                onClick={() => navigation.onStep?.(1)}
              >
                <Icon name="ChevronDown" aria-hidden="true" />
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground"
                aria-label={`More actions for #${number}`}
              >
                <Icon name="MoreHorizontal" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => navigate.openUrl(url)}>
                Open on GitHub ↗
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void experimental_copyToClipboard({ text: url }).then((copied) => {
                    if (copied) toast.success("Link copied");
                    else toast.error("Could not copy the link");
                  });
                }}
              >
                Copy link
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {navigation.onClose === undefined ? null : (
            <Button
              size="icon"
              variant="ghost"
              className="hidden size-7 text-muted-foreground @[60rem]/wgh:inline-flex"
              aria-label="Close inspector"
              onClick={navigation.onClose}
            >
              <Icon name="X" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
      <p className="ml-6.5 mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-subtle-foreground">
        <span className={cn("wgh-lane-dot", laneClass(repo))} aria-hidden="true" />
        <span className="min-w-0 truncate text-muted-foreground">{repo}</span>
        <span className="shrink-0 tabular-nums">#{number}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">updated {relativeTime(updatedAt)}</span>
      </p>
      {children}
    </header>
  );
}

function AgentLinks({ links }: { links: ThreadLink[] | undefined }) {
  const navigate = experimental_useAppNavigate();

  if (links === undefined || links.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Icon name="Bot" aria-hidden="true" className="size-3.5" />
      {links.map((link, index) => (
        <button
          key={link.threadId}
          type="button"
          className="rounded px-1.5 py-0.5 text-foreground ring-1 ring-inset ring-border hover:bg-state-hover"
          onClick={() => navigate.toThread(link.threadId)}
        >
          Agent chat{links.length > 1 ? ` ${index + 1}` : ""} · {relativeTime(link.createdAt)}
        </button>
      ))}
    </div>
  );
}

function InspectorSkeleton({ navigation }: { navigation: InspectorNavigation }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      {navigation.onBack === undefined ? null : (
        <Button
          size="sm"
          variant="ghost"
          className={cn(
            "-ml-2 h-7 w-fit gap-1 px-2 text-xs text-muted-foreground",
            navigation.layout === "pane" && "@[60rem]/wgh:hidden",
          )}
          onClick={navigation.onBack}
        >
          <Icon name="ArrowLeft" aria-hidden="true" className="size-3.5" />
          {navigation.backLabel ?? "Back"}
        </Button>
      )}
      <DelayedLoading>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </DelayedLoading>
    </div>
  );
}

function InspectorError({
  repo,
  number,
  message,
  url,
  onRetry,
  navigation,
}: {
  repo: string;
  number: number;
  message: string;
  url: string | null;
  onRetry: () => void;
  navigation: InspectorNavigation;
}) {
  const navigate = experimental_useAppNavigate();

  return (
    <div className="flex flex-col gap-3 p-4">
      {navigation.onBack === undefined ? null : (
        <Button
          size="sm"
          variant="ghost"
          className={cn(
            "-ml-2 h-7 w-fit gap-1 px-2 text-xs text-muted-foreground",
            navigation.layout === "pane" && "@[60rem]/wgh:hidden",
          )}
          onClick={navigation.onBack}
        >
          <Icon name="ArrowLeft" aria-hidden="true" className="size-3.5" />
          {navigation.backLabel ?? "Back"}
        </Button>
      )}
      <div role="alert" className="wgh-verdict px-3 py-2.5" data-tone="blocked">
        <p className="text-sm font-semibold text-foreground">
          Couldn’t load #{number} from {repo}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{message}</p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
        {url === null ? null : (
          <Button size="sm" variant="ghost" onClick={() => navigate.openUrl(url)}>
            Open on GitHub ↗
          </Button>
        )}
      </div>
    </div>
  );
}

function FileRow({
  environmentId,
  file,
  url,
}: {
  environmentId: string | null;
  file: PullFile;
  url: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const slash = file.path.lastIndexOf("/");

  return (
    <li>
      <div className="grid min-h-6 grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-x-1.5 text-xs">
        <button
          type="button"
          className="grid size-3.5 place-items-center text-subtle-foreground hover:text-foreground"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`Show diff for ${file.path}`}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon
            name="ChevronRight"
            aria-hidden="true"
            className={cn(
              "size-3 transition-transform duration-(--motion-duration-base) ease-(--motion-ease-smooth) motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </button>
        {environmentId === null || file.status === "removed" ? (
          <span className="min-w-0 truncate font-mono" title={file.path}>
            <span className="text-subtle-foreground">{file.path.slice(0, slash + 1)}</span>
            <span className="text-foreground">{file.path.slice(slash + 1)}</span>
          </span>
        ) : (
          <FileLink
            className="min-w-0 truncate font-mono text-foreground hover:underline"
            target={{ kind: "workspace", environmentId, path: file.path }}
          >
            {file.path}
          </FileLink>
        )}
        <span className="flex items-center gap-2">
          {file.status === "modified" ? null : (
            <span className="text-2xs uppercase tracking-wide text-subtle-foreground">
              {file.status}
            </span>
          )}
          <DiffNumbers additions={file.additions} deletions={file.deletions} />
        </span>
      </div>
      {open ? (
        <div id={panelId} className="my-1.5 overflow-hidden rounded-md border border-border">
          {file.patch !== null ? (
            <Diff patch={file.patch} path={file.path} />
          ) : (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Diff too large to show here —{" "}
              <UrlLink href={`${url}/files`} className="underline">
                view on GitHub ↗
              </UrlLink>
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

const REVIEW_STATE_LABELS = new Map<string, string>(
  Object.entries({
    APPROVED: "approved",
    CHANGES_REQUESTED: "requested changes",
    COMMENTED: "commented",
    DISMISSED: "dismissed",
    PENDING: "review requested",
  }),
);

function reviewStateClass(state: string): string {
  if (state === "APPROVED") return "text-success-foreground dark:text-success";

  if (state === "CHANGES_REQUESTED") return "text-warning-text";

  return "text-muted-foreground";
}

function ActivityEntry({
  author,
  createdAt,
  body,
  badge,
}: {
  author: string;
  createdAt: string;
  body: string;
  badge?: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5">
      <Avatar login={author} className="mt-0.5" />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{author}</span>
          {badge}
          <span>· {relativeTime(createdAt)}</span>
        </p>
        {body.length > 0 ? <Markdown content={body} className="mt-1 text-sm" /> : null}
      </div>
    </li>
  );
}

function ReviewThreadEntry({ thread }: { thread: ReviewThread }) {
  return (
    <li className="overflow-hidden rounded-md border border-border">
      <p className="flex items-center gap-1 border-b border-border bg-surface-recessed px-2.5 py-1 font-mono text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{thread.path}</span>
        {thread.line !== null ? <span className="shrink-0">:{thread.line}</span> : null}
      </p>
      {thread.diffHunk.length > 0 ? (
        <div className="border-b border-border">
          <Diff patch={thread.diffHunk} path={thread.path} />
        </div>
      ) : null}
      <ul className="flex flex-col gap-3 p-2.5">
        {thread.comments.map((entry, index) => (
          <ActivityEntry
            key={index}
            author={entry.author}
            createdAt={entry.createdAt}
            body={entry.body}
          />
        ))}
      </ul>
    </li>
  );
}

function CommentBox({
  number,
  onSubmit,
}: {
  number: number;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const id = useId();

  const post = () => {
    if (comment.trim().length === 0 || posting) return;
    setPosting(true);
    onSubmit(comment)
      .then(() => setComment(""))
      .catch((error) => toast.error(errorText(error)))
      .finally(() => setPosting(false));
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="sr-only">
        Comment on #{number}
      </label>
      <Textarea
        id={id}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            post();
          }
        }}
        placeholder="Leave a comment…"
        rows={3}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="text-2xs text-subtle-foreground">⌘↵ to send</span>
        <Button size="sm" disabled={posting || comment.trim().length === 0} onClick={post}>
          {posting ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function AgentButton({
  kind,
  repo,
  number,
  open,
}: {
  kind: "issue" | "pr";
  repo: string;
  number: number;
  open: boolean;
}) {
  const { spawn, spawningKey } = useSpawn();
  const busy = spawningKey === `${kind}:${repo}#${number}`;
  const label = kind === "pr" ? "Review with agent" : "Work on with agent";

  return (
    <Button
      className="h-8 w-full gap-2"
      disabled={!open || spawningKey !== null}
      aria-busy={busy}
      onClick={() => spawn(kind, repo, number)}
    >
      <Icon name="Sparkles" aria-hidden="true" className="size-4" />
      {busy ? "Starting…" : label}
    </Button>
  );
}

export function PullInspector({
  repo,
  number,
  navigation,
  workspaceEnvironmentId = null,
}: {
  repo: string;
  number: number;
  navigation: InspectorNavigation;
  workspaceEnvironmentId?: string | null;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const { links } = useLinks();
  const navigate = experimental_useAppNavigate();

  const fetchPull = useCallback(
    () => rpc.call("getPull", { repo, number }).then((result) => result.pull),
    [rpc, repo, number],
  );

  const {
    value: pull,
    error,
    refreshing,
    reload,
  } = useReadModel(pullModels, `${repo}#${number}`, fetchPull);

  if (error !== null && pull === null) {
    return (
      <InspectorError
        repo={repo}
        number={number}
        message={error}
        url={null}
        onRetry={reload}
        navigation={navigation}
      />
    );
  }

  if (pull === null) return <InspectorSkeleton navigation={navigation} />;

  const verdict = pullVerdict(pull);
  const open = pull.state === "OPEN" || pull.state === "DRAFT";

  const reviewComments = pull.reviewThreads.reduce(
    (total, thread) => total + thread.comments.length,
    0,
  );

  const reviewLabel =
    pull.reviewDecision === "APPROVED"
      ? "Approved"
      : pull.reviewDecision === "CHANGES_REQUESTED"
        ? "Changes requested"
        : pull.reviewDecision === "REVIEW_REQUIRED"
          ? "Required"
          : "Not required";

  return (
    <article className="flex min-w-0 flex-col" aria-label={`Pull request #${number}`}>
      <InspectorHeader
        kind="pr"
        state={pull.state}
        draft={pull.state === "DRAFT"}
        title={pull.title}
        repo={repo}
        number={number}
        url={pull.url}
        updatedAt={pull.updatedAt}
        navigation={navigation}
      >
        <div className="ml-6.5 mt-2.5 flex min-w-0 items-center gap-1.5">
          <Avatar login={pull.author} />
          <RefPill name={pull.headRefName} tinted repo={repo} />
          <Icon
            name="ArrowRight"
            aria-hidden="true"
            className="size-3 shrink-0 text-subtle-foreground"
          />
          <span className="shrink-0">
            <RefPill name={pull.baseRefName} tinted={false} repo={repo} />
          </span>
        </div>
      </InspectorHeader>

      <div className="flex flex-col gap-3 px-4 pb-4">
        {error !== null ? (
          <p role="alert" className="text-xs text-destructive-text">
            Couldn’t refresh: {error}. Showing the last loaded details.
          </p>
        ) : refreshing ? (
          <DelayedLoading>
            <p className="text-xs text-subtle-foreground">Refreshing…</p>
          </DelayedLoading>
        ) : null}
        <MetaGrid
          cells={[
            {
              label: "Changes",
              value: (
                <span className="flex flex-col gap-1">
                  <DiffNumbers additions={pull.additions} deletions={pull.deletions} />
                  <DiffBar additions={pull.additions} deletions={pull.deletions} track={64} />
                </span>
              ),
            },
            { label: "Files", value: <span className="tabular-nums">{pull.changedFiles}</span> },
            {
              label: "Comments",
              value: <span className="tabular-nums">{pull.comments.length + reviewComments}</span>,
            },
            { label: "Review", value: reviewLabel },
          ]}
        />
        <Verdict
          tone={verdict.tone}
          title={verdict.title}
          detail={verdict.detail}
          code={open ? pull.mergeStateStatus : undefined}
        >
          <ChecksList checks={pull.checks} />
        </Verdict>
        {open ? <AgentButton kind="pr" repo={repo} number={number} open={open} /> : null}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
          <ItemActions
            kind="pr"
            repo={repo}
            number={number}
            state={pull.state}
            onChanged={reload}
            summary={[
              `${verdict.title}. ${verdict.detail}.`,
              `Review: ${reviewLabel.toLowerCase()} · ${pull.changedFiles} file${pull.changedFiles === 1 ? "" : "s"}, +${pull.additions} −${pull.deletions}`,
              `${pull.headRefName} → ${pull.baseRefName}`,
            ]}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => navigate.openUrl(pull.url)}
          >
            Open on GitHub
            <Icon name="ExternalLink" aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
        <AgentLinks links={links[`pr:${repo}#${number}`]} />
      </div>

      <InspectorSection label="Description" aside={<Avatar login={pull.author} />}>
        <CollapsibleBody body={pull.body} />
      </InspectorSection>

      {pull.files.length > 0 ? (
        <InspectorSection
          label="Files changed"
          count={pull.files.length}
          aside={<DiffNumbers additions={pull.additions} deletions={pull.deletions} />}
        >
          <ul>
            {pull.files.map((file) => (
              <FileRow
                key={file.path}
                environmentId={workspaceEnvironmentId}
                file={file}
                url={pull.url}
              />
            ))}
          </ul>
        </InspectorSection>
      ) : null}

      <PullActivity pull={pull} />

      <InspectorSection label="Comment">
        <CommentBox
          number={number}
          onSubmit={(body) =>
            rpc.call("commentPull", { repo, number, body }).then(() => {
              reload();
            })
          }
        />
      </InspectorSection>
    </article>
  );
}

function PullActivity({ pull }: { pull: PullDetail }) {
  const entries = useMemo(() => {
    const merged: { author: string; body: string; createdAt: string; review: string | null }[] = [
      ...pull.comments.map((comment) => ({ ...comment, review: null })),
      ...pull.reviews
        .filter((review) => review.body.length > 0 || review.state !== "COMMENTED")
        .map((review) => ({
          author: review.author,
          body: review.body,
          createdAt: review.createdAt,
          review: review.state,
        })),
    ];

    return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [pull]);

  const reviewers = useMemo(() => {
    const latest = new Map<string, string>();

    for (const review of pull.reviews) {
      if (review.author.length > 0) latest.set(review.author, review.state);
    }

    for (const login of pull.reviewRequests) latest.set(login, "PENDING");

    return [...latest];
  }, [pull]);

  if (entries.length === 0 && pull.reviewThreads.length === 0 && reviewers.length === 0) {
    return null;
  }

  return (
    <InspectorSection label="Activity" count={entries.length + pull.reviewThreads.length}>
      {reviewers.length > 0 ? (
        <ul className="mb-3 flex flex-wrap gap-1.5" aria-label="Reviewers">
          {reviewers.map(([login, state]) => (
            <li
              key={login}
              className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs ring-1 ring-inset ring-border"
            >
              <Avatar login={login} />
              <span className="text-foreground">{login}</span>
              <span className={reviewStateClass(state)}>
                {REVIEW_STATE_LABELS.get(state) ?? state.toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="flex flex-col gap-3">
        {entries.map((entry, index) => (
          <ActivityEntry
            key={index}
            author={entry.author}
            createdAt={entry.createdAt}
            body={entry.body}
            badge={
              entry.review === null ? undefined : (
                <span className={cn("font-medium", reviewStateClass(entry.review))}>
                  {REVIEW_STATE_LABELS.get(entry.review) ?? entry.review.toLowerCase()}
                </span>
              )
            }
          />
        ))}
        {pull.reviewThreads.map((thread, index) => (
          <ReviewThreadEntry key={index} thread={thread} />
        ))}
      </ul>
    </InspectorSection>
  );
}

function PickerMenu({
  label,
  values,
  load,
  render,
  onToggle,
  empty,
}: {
  label: string;
  values: string[];
  load: () => Promise<string[]>;
  render: (value: string) => React.ReactNode;
  onToggle: (value: string, enabled: boolean) => void;
  empty: string;
}) {
  const [options, setOptions] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const open = () => {
    if (options !== null) return;
    load().then(setOptions, (error) => setLoadError(errorText(error)));
  };

  const ordered =
    options === null
      ? null
      : [...new Set([...values, ...options])].sort((a, b) => a.localeCompare(b));

  return (
    <DropdownMenu onOpenChange={(next) => next && open()}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-xs text-muted-foreground"
          aria-label={`Edit ${label.toLowerCase()}`}
        >
          Edit
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>
        ) : ordered === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>{empty}</DropdownMenuItem>
        ) : (
          ordered.map((value) => (
            <DropdownMenuCheckboxItem
              key={value}
              checked={values.includes(value)}
              onCheckedChange={(checked) => onToggle(value, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              {render(value)}
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LabelSwatch({ color }: { color: string | undefined }) {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full bg-muted-foreground"
      style={color === undefined ? undefined : { backgroundColor: `#${color}` }}
    />
  );
}

const issueEditFields: ("assignees" | "labels")[] = ["assignees", "labels"];

function sameMembers(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

export function IssueInspector({
  repo,
  number,
  listItem,
  relatedPulls,
  navigation,
}: {
  repo: string;
  number: number;
  listItem: Item | null;
  relatedPulls: Item[];
  navigation: InspectorNavigation;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const { links } = useLinks();
  const { login: viewer } = useViewer();
  const { setAssignees, setLabels } = useIssueMutations();
  const navigate = experimental_useAppNavigate();

  const fetchIssue = useCallback(
    () => rpc.call("getIssue", { repo, number }).then((result) => result.issue),
    [rpc, repo, number],
  );

  const {
    value: loaded,
    error,
    reload,
  } = useReadModel(issueModels, `${repo}#${number}`, fetchIssue);

  const [override, setOverride] = useState<{
    assignees?: string[];
    labels?: string[];
  }>({});

  useEffect(() => {
    if (loaded === null) return;

    setOverride((previous) => {
      const next = { ...previous };
      let settled = false;

      for (const field of issueEditFields) {
        const pending = previous[field];

        if (pending !== undefined && sameMembers(pending, loaded[field])) {
          next[field] = undefined;
          settled = true;
        }
      }

      return settled ? next : previous;
    });
  }, [loaded]);

  if (error !== null && loaded === null) {
    return (
      <InspectorError
        repo={repo}
        number={number}
        message={error}
        url={listItem?.url ?? null}
        onRetry={reload}
        navigation={navigation}
      />
    );
  }

  if (loaded === null) return <InspectorSkeleton navigation={navigation} />;

  const issue: IssueDetail = {
    ...loaded,
    assignees: override.assignees ?? loaded.assignees,
    labels: override.labels ?? loaded.labels,
  };

  const open = issue.state === "OPEN";

  const toggle = (field: "assignees" | "labels", value: string, enabled: boolean) => {
    const current = issue[field];

    const next = enabled
      ? [...new Set([...current, value])]
      : current.filter((entry) => entry !== value);

    setOverride((previous) => ({ ...previous, [field]: next }));

    const write =
      field === "assignees" ? setAssignees(repo, number, next) : setLabels(repo, number, next);

    write.then(reload, (failure) => {
      toast.error(errorText(failure));
      setOverride((previous) => ({ ...previous, [field]: undefined }));
      reload();
    });
  };

  const labelColors = listItem?.labelColors ?? {};
  const assignedToYou = viewer !== null && issue.assignees.includes(viewer);

  return (
    <article className="flex min-w-0 flex-col" aria-label={`Issue #${number}`}>
      <InspectorHeader
        kind="issue"
        state={issue.state}
        draft={false}
        title={issue.title}
        repo={repo}
        number={number}
        url={issue.url}
        updatedAt={issue.updatedAt}
        navigation={navigation}
      />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <MetaGrid
          cells={[
            {
              label: "Author",
              value: (
                <span className="flex items-center gap-1.5">
                  <Avatar login={issue.author} />
                  <span className="truncate">{issue.author}</span>
                </span>
              ),
            },
            {
              label: "Comments",
              value: <span className="tabular-nums">{issue.comments.length}</span>,
            },
            {
              label: "Linked PRs",
              value: <span className="tabular-nums">{relatedPulls.length}</span>,
            },
          ]}
        />
        <Verdict
          tone={open ? "none" : "merged"}
          title={open ? (assignedToYou ? "Open · assigned to you" : "Open") : "Closed"}
          detail={
            relatedPulls.length > 0
              ? `${relatedPulls.length} pull request${relatedPulls.length === 1 ? "" : "s"} will close this issue`
              : open
                ? "No pull request references this issue yet"
                : `Closed · updated ${relativeTime(issue.updatedAt)}`
          }
        >
          {relatedPulls.length > 0 ? (
            <ul className="mt-2 border-t border-border-seam pt-1">
              {relatedPulls.map((pull) => (
                <li key={`${pull.repo}#${pull.number}`}>
                  <button
                    type="button"
                    className="grid min-h-6 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 text-left text-xs hover:text-foreground"
                    onClick={() =>
                      navigate.toPluginPanel("workspace-github", {
                        subPath: `pulls/${pull.repo}/${pull.number}`,
                      })
                    }
                  >
                    <StateGlyph kind="pr" state={pull.state} className="size-3.5" />
                    <span className="min-w-0 truncate text-foreground">{pull.title}</span>
                    <span className="text-subtle-foreground">#{pull.number}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </Verdict>
        {open ? <AgentButton kind="issue" repo={repo} number={number} open={open} /> : null}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
          <ItemActions
            kind="issue"
            repo={repo}
            number={number}
            state={issue.state}
            onChanged={reload}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => navigate.openUrl(issue.url)}
          >
            Open on GitHub
            <Icon name="ExternalLink" aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
        <AgentLinks links={links[`issue:${repo}#${number}`]} />
      </div>

      <InspectorSection
        label="Assignees"
        aside={
          <PickerMenu
            label="Assignees"
            values={issue.assignees}
            load={() => rpc.call("assignableUsers", { repo }).then((result) => result.users)}
            render={(login) => (
              <span className="flex min-w-0 items-center gap-2">
                <Avatar login={login} />
                <span className="truncate">
                  {login}
                  {login === viewer ? " (you)" : ""}
                </span>
              </span>
            )}
            onToggle={(login, enabled) => toggle("assignees", login, enabled)}
            empty="No assignable users"
          />
        }
      >
        {issue.assignees.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one assigned</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {issue.assignees.map((login) => (
              <li
                key={login}
                className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-foreground ring-1 ring-inset ring-border"
              >
                <Avatar login={login} />
                {login}
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>

      <InspectorSection
        label="Labels"
        aside={
          <PickerMenu
            label="Labels"
            values={issue.labels}
            load={() => rpc.call("repositoryLabels", { repo }).then((result) => result.labels)}
            render={(label) => (
              <span className="flex min-w-0 items-center gap-2">
                <LabelSwatch color={labelColors[label]} />
                <span className="truncate">{label}</span>
              </span>
            )}
            onToggle={(label, enabled) => toggle("labels", label, enabled)}
            empty="No labels in this repository"
          />
        }
      >
        {issue.labels.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {issue.labels.map((label) => (
              <li
                key={label}
                className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-foreground ring-1 ring-inset ring-border"
              >
                <LabelSwatch color={labelColors[label]} />
                {label}
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>

      <InspectorSection label="Description" aside={<Avatar login={issue.author} />}>
        <CollapsibleBody body={issue.body} />
      </InspectorSection>

      {issue.comments.length > 0 ? (
        <InspectorSection label="Activity" count={issue.comments.length}>
          <ul className="flex flex-col gap-3">
            {issue.comments.map((entry, index) => (
              <ActivityEntry
                key={index}
                author={entry.author}
                createdAt={entry.createdAt}
                body={entry.body}
              />
            ))}
          </ul>
        </InspectorSection>
      ) : null}

      <InspectorSection label="Comment">
        <CommentBox
          number={number}
          onSubmit={(body) =>
            rpc.call("commentIssue", { repo, number, body }).then(() => {
              reload();
            })
          }
        />
      </InspectorSection>
    </article>
  );
}
