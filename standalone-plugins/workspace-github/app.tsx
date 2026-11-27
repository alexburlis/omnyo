import { z } from "zod";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useAppNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@omnyo/plugin-sdk/app";
import { toast } from "sonner";
import {
  matchesQuery,
  parseQuery,
  parseSubPath,
  routeToSubPath,
  type Item,
  type Route,
} from "./app-logic.js";
import {
  absoluteTime,
  errorText,
  pullModels,
  relativeTime,
  statusModels,
  useGithubRefresh,
  useItems,
  useLinks,
  useStatus,
  useViewer,
  type RepoInfo,
  type Status,
} from "./data.js";
import {
  groupTriaged,
  itemKey,
  triage,
  type TriageGroupId,
  type TriagedItem,
} from "./launchpad.js";
import type { githubRpcContract } from "./server.js";
import { ReadModels } from "./read-models.js";
import { EmptyState } from "./components/empty-state.js";
import { GithubNavCounts, GithubNavIcon } from "./components/github-nav-icon.js";
import { IssueInspector, PullInspector, type InspectorNavigation } from "./components/inspector.js";
import { RepositorySettings } from "./components/repository-settings.js";
import { SyncNotice, failedRepo } from "./components/sync-notice.js";
import {
  inView,
  RailRepositories,
  RailViews,
  SearchField,
  ShortcutSheet,
  StatusBar,
  TypeSegments,
  usePersistentState,
  useSlashFocus,
  WorkList,
  workViews,
  type SavedView,
  type WorkType,
  type WorkViewId,
} from "./components/workbench.js";
import { BulkMergeDialog } from "./components/bulk-merge.js";
import { StateGlyph } from "./components/glyphs.js";
import { Button } from "./components/ui/button.js";
import { DelayedLoading } from "./components/ui/delayed-loading.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import { Icon } from "./components/ui/icon.js";
import { Input } from "./components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
import { Skeleton } from "./components/ui/skeleton.js";
import { Textarea } from "./components/ui/textarea.js";
import { cn } from "./lib/utils.js";
import "./workbench.css";

const PANEL_PATH = "workspace-github";

const STORAGE_PREFIX = "omnyo-plugin-workspace-github";

const viewSchema = z.enum(workViews.map((entry) => entry.id));

const typeSchema = z.enum(["all", "pr", "issue"]);

const stringListSchema = z.array(z.string());

const parseView = (raw: string) => viewSchema.parse(JSON.parse(raw));

const parseType = (raw: string) => typeSchema.parse(JSON.parse(raw));

const parseList = (raw: string) => stringListSchema.parse(JSON.parse(raw));

const parseText = (raw: string) => z.string().parse(JSON.parse(raw));

const savedViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  view: viewSchema,
  type: typeSchema,
  query: z.string(),
  scope: stringListSchema,
});

const parseSavedViews = (raw: string) =>
  z
    .array(z.json())
    .parse(JSON.parse(raw))
    .flatMap((entry) => {
      const saved = savedViewSchema.safeParse(entry);

      return saved.success ? [saved.data] : [];
    });

const noSavedViews: SavedView[] = [];

function sameScope(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

const emptyList: string[] = [];

const emptyItems: Item[] = [];

function useSubPathRoute(subPath: string): [Route, (route: Route, replace?: boolean) => void] {
  const appNavigate = experimental_useAppNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);

  const navigate = useCallback(
    (next: Route, replace = false) => {
      appNavigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next), replace });
    },
    [appNavigate],
  );

  return [route, navigate];
}

function routeKey(route: Route): string | null {
  if (route.view === "pull") return `pr:${route.repo}#${route.number}`;

  if (route.view === "issue") return `issue:${route.repo}#${route.number}`;

  return null;
}

function itemRoute(item: Item): Route {
  return item.kind === "pr"
    ? { view: "pull", repo: item.repo, number: item.number }
    : { view: "issue", repo: item.repo, number: item.number };
}

function syncIncomplete(status: Status | null, statusFailed: boolean, repos: string[]): boolean {
  if (statusFailed || status === null) return true;

  if (!status.ghOk || status.lastSyncedAt === null || status.notices.length > 0) return true;

  return status.warnings.some((warning) => {
    const repo = failedRepo(warning);

    return repo === undefined || repos.length === 0 || repos.includes(repo.toLowerCase());
  });
}

function PanelHeader() {
  const { status, error: statusError } = useStatus();
  const { syncing, failure, refresh } = useGithubRefresh();

  const healthy =
    failure === null &&
    statusError === null &&
    status !== null &&
    status.ghOk &&
    status.lastSyncedAt !== null;

  const label =
    statusError !== null
      ? "Sync status unavailable"
      : failure !== null
        ? "Refresh failed"
        : status === null
          ? "Loading…"
          : status.ghState === "unavailable"
            ? "GitHub unavailable"
            : !status.ghOk
              ? "GitHub sign-in required"
              : status.lastSyncedAt === null
                ? "Waiting for first sync"
                : `Synced ${relativeTime(status.lastSyncedAt)}`;

  return (
    <>
      <span
        className="flex min-w-0 items-center gap-1.5 text-xs text-subtle-foreground"
        title={failure ?? (status?.lastSyncedAt ? absoluteTime(status.lastSyncedAt) : undefined)}
        role="status"
      >
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", healthy ? "bg-success" : "bg-warning")}
        />
        <span className="truncate">
          {status === null && statusError === null && failure === null ? (
            <DelayedLoading>{label}</DelayedLoading>
          ) : (
            label
          )}
        </span>
      </span>
      <Button
        size="icon"
        variant="outline"
        className="size-8"
        disabled={syncing}
        onClick={refresh}
        aria-label={syncing ? "Syncing GitHub data" : "Refresh GitHub data"}
      >
        <Icon
          name="ArrowReloadHorizontal"
          aria-hidden="true"
          className={cn("size-4", syncing && "animate-spin motion-reduce:animate-none")}
        />
      </Button>
    </>
  );
}

function InspectorSummary({
  counts,
  onReveal,
  lastSyncedAt,
}: {
  counts: Map<TriageGroupId, number>;
  onReveal: (groups: TriageGroupId[]) => void;
  lastSyncedAt: string | null;
}) {
  const sum = (groups: TriageGroupId[]) =>
    groups.reduce((total, group) => total + (counts.get(group) ?? 0), 0);

  const lines: { groups: TriageGroupId[]; icon: string; tone: string; text: string }[] = [
    {
      groups: ["ready"],
      icon: "GitMerge",
      tone:
        sum(["ready"]) > 0 ? "text-success-foreground dark:text-success" : "text-subtle-foreground",
      text: `${sum(["ready"])} pull requests can be merged`,
    },
    {
      groups: ["blocked", "follow-up", "needs-review"],
      icon: "CircleX",
      tone:
        sum(["blocked", "follow-up", "needs-review"]) > 0
          ? "text-destructive-text"
          : "text-subtle-foreground",
      text: `${sum(["blocked", "follow-up", "needs-review"])} blocked or need follow-up`,
    },
    {
      groups: ["waiting", "unknown"],
      icon: "CircleDashed",
      tone: "text-subtle-foreground",
      text: `${sum(["waiting", "unknown"])} waiting on reviews, checks or GitHub`,
    },
    {
      groups: ["draft"],
      icon: "GitPullRequestDraft",
      tone: "text-subtle-foreground",
      text: `${sum(["draft"])} drafts`,
    },
    {
      groups: ["issues"],
      icon: "Circle",
      tone: "text-subtle-foreground",
      text: `${sum(["issues"])} open issues you created`,
    },
  ];

  return (
    <div className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-base font-semibold text-foreground">Launchpad</h2>
        <p className="mt-0.5 text-xs text-subtle-foreground">
          Select an item to inspect it here.
          {lastSyncedAt === null ? null : ` Synced ${relativeTime(lastSyncedAt)}.`}
        </p>
      </div>
      <ul className="flex flex-col gap-1">
        {lines.map((line) => (
          <li key={line.text}>
            <button
              type="button"
              disabled={sum(line.groups) === 0}
              className="group flex h-7 items-center gap-2 text-sm text-foreground disabled:text-muted-foreground"
              onClick={() => onReveal(line.groups)}
            >
              <Icon name={line.icon} aria-hidden="true" className={cn("size-4", line.tone)} />
              <span className="underline-offset-2 group-enabled:group-hover:underline">
                {line.text}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewIssueForm({
  repos,
  defaultRepo,
  onCreated,
  onCancel,
}: {
  repos: RepoInfo[];
  defaultRepo: string | null;
  onCreated: (repo: string, number: number | null) => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [repo, setRepo] = useState(defaultRepo ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [creating, setCreating] = useState(false);
  const titleId = useId();
  const bodyId = useId();
  const repoId = useId();

  const create = () => {
    if (creating || title.trim().length === 0 || repo.length === 0) return;
    setCreating(true);
    rpc
      .call("createIssue", { repo, title, body })
      .then((result) => {
        toast.success("Issue created");
        onCreated(repo, result.number);
      })
      .catch((error) => toast.error(errorText(error)))
      .finally(() => setCreating(false));
  };

  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <div className="flex items-center gap-2">
        <StateGlyph kind="issue" state="OPEN" />
        <h2 className="text-base font-semibold text-foreground">New issue</h2>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={repoId} className="text-xs font-medium text-muted-foreground">
          Repository
        </label>
        <Select value={repo} onValueChange={setRepo}>
          <SelectTrigger id={repoId} className="w-full">
            <SelectValue placeholder="Choose a repository" />
          </SelectTrigger>
          <SelectContent>
            {repos.map((entry) => (
              <SelectItem key={entry.repo} value={entry.repo}>
                {entry.repo}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={titleId} className="text-xs font-medium text-muted-foreground">
          Title
        </label>
        <Input id={titleId} value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={bodyId} className="text-xs font-medium text-muted-foreground">
          Description (Markdown)
        </label>
        <Textarea
          id={bodyId}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              create();
            }
          }}
          rows={8}
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={creating || title.trim().length === 0 || repo.length === 0}
        >
          {creating ? "Creating…" : "Create issue"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ListLoading() {
  return (
    <DelayedLoading>
      <div
        className="flex flex-col gap-2 px-4 py-3"
        role="status"
        aria-label="Loading cached items"
      >
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <Skeleton key={row} className="h-4" style={{ width: `${90 - row * 8}%` }} />
        ))}
      </div>
    </DelayedLoading>
  );
}

function GithubPanel({ subPath }: PluginNavPanelProps) {
  const [route, navigate] = useSubPathRoute(subPath);
  const { status, error: statusError } = useStatus();
  const [itemModels] = useState(() => new ReadModels<Item[]>(1, 8 * 1024 * 1024, 30_000));
  const { items, error: itemsError, reload } = useItems(itemModels);
  const { login: viewer, failed: viewerFailed } = useViewer();
  const { links, failed: linksFailed } = useLinks();

  const [view, setView] = usePersistentState<WorkViewId>(
    `${STORAGE_PREFIX}:view`,
    parseView,
    "launchpad",
  );

  const [type, setType] = usePersistentState<WorkType>(`${STORAGE_PREFIX}:type`, parseType, "all");
  const [query, setQuery] = usePersistentState<string>(`${STORAGE_PREFIX}:filter`, parseText, "");

  const [scope, setScope] = usePersistentState<string[]>(
    `${STORAGE_PREFIX}:scope`,
    parseList,
    emptyList,
  );

  const [collapsed, setCollapsed] = usePersistentState<string[]>(
    `${STORAGE_PREFIX}:collapsed`,
    parseList,
    emptyList,
  );

  const [savedViews, setSavedViews] = usePersistentState<SavedView[]>(
    `${STORAGE_PREFIX}:saved-views`,
    parseSavedViews,
    noSavedViews,
  );

  const [managing, setManaging] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [bulkPulls, setBulkPulls] = useState<Item[] | null>(null);
  const { syncing, refresh } = useGithubRefresh();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listColumnRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useSlashFocus(inputRef);
  const activeKey = routeKey(route);

  const parsed = useMemo(() => parseQuery(query), [query]);

  const triaged = useMemo<TriagedItem[] | null>(
    () => items?.map((item) => ({ item, triage: triage(item, viewer) })) ?? null,
    [items, viewer],
  );

  const scoped = useMemo(
    () =>
      triaged?.filter(
        (entry) =>
          (scope.length === 0 || scope.includes(entry.item.repo.toLowerCase())) &&
          matchesQuery(entry.item, parsed, viewer),
      ) ?? [],
    [triaged, scope, parsed, viewer],
  );

  const typed = useMemo(
    () => scoped.filter((entry) => type === "all" || entry.item.kind === type),
    [scoped, type],
  );

  const viewCounts = useMemo(() => {
    const counts = new Map<WorkViewId, number>();

    for (const entry of workViews) {
      counts.set(entry.id, typed.filter((row) => inView(entry.id, row)).length);
    }

    return counts;
  }, [typed]);

  const typeCounts = useMemo(() => {
    const inCurrent = scoped.filter((entry) => inView(view, entry));

    return {
      all: inCurrent.length,
      pr: inCurrent.filter((entry) => entry.item.kind === "pr").length,
      issue: inCurrent.filter((entry) => entry.item.kind === "issue").length,
    };
  }, [scoped, view]);

  const sections = useMemo(
    () => groupTriaged(typed.filter((entry) => inView(view, entry))),
    [typed, view],
  );

  const orderedRows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

  const groupCounts = useMemo(() => {
    const counts = new Map<TriageGroupId, number>();

    for (const entry of typed) {
      counts.set(entry.triage.group, (counts.get(entry.triage.group) ?? 0) + 1);
    }

    return counts;
  }, [typed]);

  const savedCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const saved of savedViews) {
      const savedQuery = parseQuery(saved.query);

      counts.set(
        saved.id,
        (triaged ?? []).filter(
          (entry) =>
            inView(saved.view, entry) &&
            (saved.type === "all" || entry.item.kind === saved.type) &&
            (saved.scope.length === 0 || saved.scope.includes(entry.item.repo.toLowerCase())) &&
            matchesQuery(entry.item, savedQuery, viewer),
        ).length,
      );
    }

    return counts;
  }, [savedViews, triaged, viewer]);

  const activeSaved =
    savedViews.find(
      (saved) =>
        saved.view === view &&
        saved.type === type &&
        saved.query.trim() === query.trim() &&
        sameScope(saved.scope, scope),
    )?.id ?? null;

  const canSave =
    query.trim().length > 0 || scope.length > 0 || type !== "all" || view !== "launchpad";

  const selectView = (next: WorkViewId) => {
    if (activeSaved !== null) {
      setType("all");
      setQuery("");
      setScope([]);
    }

    setView(next);
  };

  const applySaved = (saved: SavedView) => {
    setView(saved.view);
    setType(saved.type);
    setQuery(saved.query);
    setScope(saved.scope);
  };

  const saveView = (name: string) =>
    setSavedViews([
      ...savedViews,
      { id: crypto.randomUUID(), name, view, type, query: query.trim(), scope },
    ]);

  const revealGroups = (groups: TriageGroupId[]) => {
    const target = sections.find((section) => groups.some((group) => group === section.id));

    if (target === undefined) return;

    if (collapsed.includes(target.id)) {
      setCollapsed(collapsed.filter((entry) => entry !== target.id));
    }

    requestAnimationFrame(() => {
      const header = listRef.current?.querySelector<HTMLButtonElement>(
        `#wgh-group-${CSS.escape(target.id)} button`,
      );

      header?.scrollIntoView({ block: "start" });
      header?.focus({ preventScroll: true });
    });
  };

  const repoRows = useMemo(() => {
    const counts = new Map<string, { repo: string; count: number }>();

    for (const info of status?.repos ?? []) {
      counts.set(info.repo.toLowerCase(), { repo: info.repo, count: 0 });
    }

    for (const entry of triaged ?? []) {
      const key = entry.item.repo.toLowerCase();
      const row = counts.get(key) ?? { repo: entry.item.repo, count: 0 };

      if (entry.item.state === "OPEN" && (type === "all" || entry.item.kind === type))
        row.count += 1;
      counts.set(key, row);
    }

    return [...counts.values()].sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
  }, [status, triaged, type]);

  const vocab = useMemo(() => {
    const users = new Set<string>();
    const labels = new Set<string>();

    for (const item of items ?? []) {
      if (item.author.length > 0) users.add(item.author);

      for (const login of item.assignees) users.add(login);

      for (const label of item.labels) labels.add(label);
    }

    return {
      users: [...users].sort((a, b) => a.localeCompare(b)),
      labels: [...labels].sort((a, b) => a.localeCompare(b)),
      repos: repoRows.map((row) => row.repo),
    };
  }, [items, repoRows]);

  const selectItem = useCallback(
    (item: Item, replace = false) => navigate(itemRoute(item), replace),
    [navigate],
  );

  const closeInspector = useCallback(() => {
    navigate({ view: "list" });
    requestAnimationFrame(() => {
      if (activeKey === null) return;
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-row-key="${CSS.escape(activeKey)}"]`)
        ?.focus();
    });
  }, [navigate, activeKey]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const index = orderedRows.findIndex((row) => itemKey(row.item) === activeKey);
      const next = orderedRows[index === -1 ? 0 : index + direction];

      if (next !== undefined) selectItem(next.item, true);
    },
    [orderedRows, activeKey, selectItem],
  );

  useEffect(() => {
    const node = rootRef.current;

    if (node === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

      if (target instanceof HTMLElement && target.closest("[role='dialog'],[role='menu']") !== null)
        return;

      if (event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setShowShortcuts(true);

        return;
      }

      if (event.key !== "Escape" || route.view === "list") return;
      closeInspector();
    };

    node.addEventListener("keydown", onKeyDown);

    return () => node.removeEventListener("keydown", onKeyDown);
  }, [rootRef, route.view, closeInspector]);

  useEffect(() => {
    if (activeKey === null) return;
    const column = listColumnRef.current;

    if (column === null || window.getComputedStyle(column).display !== "none") return;
    inspectorRef.current?.focus({ preventScroll: true });
  }, [activeKey]);

  const warnings = useMemo(() => {
    if (status === null) return emptyList;

    if (status.ghState === "unavailable") {
      return [
        `GitHub is unavailable${status.ghError === null ? "" : `: ${status.ghError}`}. Check that the machine running Omnyo is connected, then refresh.`,
        ...status.warnings,
      ];
    }

    if (!status.ghOk) {
      return [
        `GitHub CLI is not signed in on the machine running Omnyo${status.ghError === null ? "" : ` (${status.ghError})`}. Run “gh auth login” there, then refresh.`,
        ...status.warnings,
      ];
    }

    return status.warnings;
  }, [status]);

  const incomplete = syncIncomplete(status, statusError !== null, scope);
  const filtered = query.trim().length > 0 || scope.length > 0;
  const trackedRepos = status?.repos ?? [];
  const selected = items?.find((item) => itemKey(item) === activeKey) ?? null;
  const inspecting = route.view !== "list";

  const relatedPulls =
    route.view === "issue"
      ? (items ?? []).filter((item) =>
          (item.linkedIssues ?? []).some(
            (issue) =>
              issue.repo.toLowerCase() === route.repo.toLowerCase() &&
              issue.number === route.number,
          ),
        )
      : [];

  const navigation: InspectorNavigation = {
    layout: "pane",
    backLabel: workViews.find((entry) => entry.id === view)?.label ?? "Launchpad",
    onBack: closeInspector,
    onClose: closeInspector,
    onStep: orderedRows.some((row) => itemKey(row.item) === activeKey) ? step : undefined,
  };

  const emptyState =
    items === null ? (
      itemsError === null ? (
        <ListLoading />
      ) : (
        <div className="flex items-center justify-between gap-3 px-4 py-4">
          <p role="alert" className="text-sm">
            Couldn’t load cached GitHub items: {itemsError}
          </p>
          <Button size="sm" variant="outline" onClick={reload}>
            Retry
          </Button>
        </div>
      )
    ) : trackedRepos.length === 0 && items.length === 0 && !incomplete ? (
      <EmptyState
        icon="Github"
        title="No tracked repositories"
        message="Add an Omnyo project with a GitHub checkout, or add owner/repo under Settings → Plugins → GitHub → Extra repositories."
      />
    ) : filtered ? (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <p className="text-sm font-medium text-foreground">Nothing matches</p>
        <p className="text-xs text-muted-foreground">
          No {type === "pr" ? "pull requests" : type === "issue" ? "issues" : "items"} in{" "}
          {workViews.find((entry) => entry.id === view)?.label ?? "this view"} match the filter
          {scope.length > 0 ? " and repository scope" : ""}.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setQuery("");
            setScope([]);
          }}
        >
          Clear filters
        </Button>
      </div>
    ) : type === "issue" && view === "launchpad" ? (
      <EmptyState
        icon="Circle"
        title="No open issues you created"
        message="GitHub caches issues opened by your GitHub account in tracked repositories. Issues other people opened stay on GitHub."
      />
    ) : typeCounts.all > 0 ? (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <p className="text-sm font-medium text-foreground">
          No {type === "pr" ? "pull requests" : "issues"} in{" "}
          {workViews.find((entry) => entry.id === view)?.label ?? "this view"}
        </p>
        <p className="text-xs text-muted-foreground">
          {typeCounts.all} {typeCounts.all === 1 ? "item is" : "items are"} hidden by the type
          filter.
        </p>
        <Button size="sm" variant="outline" onClick={() => setType("all")}>
          Show all types
        </Button>
      </div>
    ) : view === "closed" ? (
      <EmptyState icon="Archive" message="Nothing closed or merged in the recent sync window." />
    ) : (
      <div className="flex flex-col items-center">
        <EmptyState
          icon="CircleCheck"
          title={incomplete ? "Nothing here in the cache" : "You’re all caught up"}
          message={
            incomplete
              ? "Sync coverage is incomplete, so this view may be missing items."
              : "Nothing open needs you right now."
          }
        />
        {incomplete ? (
          <Button size="sm" variant="outline" disabled={syncing} onClick={refresh}>
            {syncing ? "Syncing…" : "Refresh now"}
          </Button>
        ) : null}
      </div>
    );

  let inspector: React.ReactNode;

  if (route.view === "pull") {
    inspector = (
      <PullInspector
        key={activeKey}
        repo={route.repo}
        number={route.number}
        navigation={navigation}
      />
    );
  } else if (route.view === "issue") {
    inspector = (
      <IssueInspector
        key={activeKey}
        repo={route.repo}
        number={route.number}
        listItem={selected}
        relatedPulls={relatedPulls}
        navigation={navigation}
      />
    );
  } else if (route.view === "new") {
    inspector = (
      <NewIssueForm
        repos={trackedRepos}
        defaultRepo={
          scope.length === 1
            ? (trackedRepos.find((entry) => entry.repo.toLowerCase() === scope[0])?.repo ?? null)
            : parsed.repos.length === 1
              ? (trackedRepos.find((entry) => entry.repo.toLowerCase() === parsed.repos[0])?.repo ??
                null)
              : null
        }
        onCreated={(repo, number) =>
          navigate(number === null ? { view: "list" } : { view: "issue", repo, number })
        }
        onCancel={() => navigate({ view: "list" })}
      />
    );
  } else {
    inspector = (
      <InspectorSummary
        counts={groupCounts}
        onReveal={(groups) => {
          if (view !== "launchpad") setView("launchpad");
          revealGroups(groups);
        }}
        lastSyncedAt={status?.lastSyncedAt ?? null}
      />
    );
  }

  const toggleScope = (repo: string) => {
    const key = repo.toLowerCase();

    setScope(scope.includes(key) ? scope.filter((entry) => entry !== key) : [...scope, key]);
  };

  return (
    <div
      ref={rootRef}
      className="@container/wgh flex min-h-0 flex-1 flex-col bg-background"
      data-testid="github-workbench"
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 @[60rem]/wgh:grid-cols-[minmax(0,1fr)_26rem] @[76rem]/wgh:grid-cols-[12.5rem_minmax(0,1fr)_28rem]">
        <aside
          aria-label="Launchpad navigation"
          className="hidden min-h-0 flex-col gap-2 overflow-y-auto border-r border-border-seam bg-sidebar pt-2 @[76rem]/wgh:flex"
        >
          <h2 className="flex h-7 items-center px-4 text-2xs font-semibold uppercase tracking-wider text-subtle-foreground">
            Views
          </h2>
          <RailViews
            view={view}
            counts={viewCounts}
            savedViews={savedViews}
            savedCounts={savedCounts}
            activeSaved={activeSaved}
            canSave={canSave}
            onSelect={selectView}
            onApplySaved={applySaved}
            onSave={saveView}
            onDeleteSaved={(id) => setSavedViews(savedViews.filter((saved) => saved.id !== id))}
          />
          <div className="mx-3 h-px bg-border-seam" />
          <RailRepositories
            repos={repoRows}
            selected={scope}
            quietCount={repoRows.filter((row) => row.count === 0).length}
            onToggle={toggleScope}
            onClear={() => setScope([])}
          />
          <button
            type="button"
            className="mt-auto flex h-9 shrink-0 items-center gap-2 border-t border-border-seam px-4 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setManaging(true)}
          >
            <Icon name="FolderGit" aria-hidden="true" className="size-3.5" />
            Manage repositories
            <span className="ml-auto tabular-nums text-subtle-foreground">
              {status === null ? "" : trackedRepos.length}
            </span>
          </button>
        </aside>

        <div
          ref={listColumnRef}
          className={cn(
            "@container/wgh-list flex min-h-0 min-w-0 flex-col",
            inspecting && "hidden @[60rem]/wgh:flex",
          )}
        >
          <div className="flex shrink-0 flex-col gap-2 border-b border-border-seam px-3 py-2">
            <SyncNotice
              warnings={warnings}
              notices={status?.notices ?? emptyList}
              error={statusError}
              loaded={status !== null}
            />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="w-36 shrink-0 @[76rem]/wgh:hidden">
                <Select
                  value={activeSaved === null ? view : `saved:${activeSaved}`}
                  onValueChange={(next) => {
                    const saved = savedViews.find((entry) => `saved:${entry.id}` === next);

                    if (saved !== undefined) applySaved(saved);
                    else selectView(viewSchema.parse(next));
                  }}
                >
                  <SelectTrigger aria-label="View" className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {workViews.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.label} · {viewCounts.get(entry.id) ?? 0}
                      </SelectItem>
                    ))}
                    {savedViews.map((saved) => (
                      <SelectItem key={saved.id} value={`saved:${saved.id}`}>
                        {saved.name} · {savedCounts.get(saved.id) ?? 0}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <SearchField
                value={query}
                onChange={setQuery}
                vocab={vocab}
                viewer={viewer}
                inputRef={inputRef}
              />
              <TypeSegments value={type} counts={typeCounts} onChange={setType} />
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 text-muted-foreground"
                aria-label="New issue"
                disabled={!status?.ghOk || trackedRepos.length === 0}
                onClick={() => navigate({ view: "new" })}
              >
                <Icon name="Plus" aria-hidden="true" className="size-4" />
              </Button>
            </div>
            {scope.length > 0 || viewerFailed || linksFailed ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground">
                {scope.length > 0 ? (
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground ring-1 ring-inset ring-border hover:bg-state-hover"
                    onClick={() => setScope([])}
                    aria-label="Clear repository scope"
                  >
                    {scope.length === 1 ? scope[0] : `${scope.length} repositories`}
                    <Icon name="X" aria-hidden="true" className="size-3" />
                  </button>
                ) : null}
                {viewerFailed ? (
                  <span>Couldn’t read your GitHub login, so @me filters match nothing</span>
                ) : null}
                {linksFailed ? <span>Agent chat links unavailable</span> : null}
              </div>
            ) : null}
          </div>
          <WorkList
            sections={sections}
            activeKey={activeKey}
            collapsed={collapsed}
            links={links}
            viewer={viewer}
            emptyState={emptyState}
            heading={`${workViews.find((entry) => entry.id === view)?.label ?? "Launchpad"} · ${orderedRows.length} ${type === "pr" ? "pull requests" : type === "issue" ? "issues" : "items"}`}
            onMergeAll={view === "launchpad" ? setBulkPulls : undefined}
            onToggleGroup={(id) =>
              setCollapsed(
                collapsed.includes(id)
                  ? collapsed.filter((entry) => entry !== id)
                  : [...collapsed, id],
              )
            }
            onSelect={(item) => selectItem(item, route.view !== "list")}
            onOpen={(item) => selectItem(item)}
            listRef={listRef}
          />
          <StatusBar
            lastSyncedAt={status?.lastSyncedAt ?? null}
            incomplete={incomplete && status !== null}
            syncing={syncing}
            onSync={refresh}
            onShowShortcuts={() => setShowShortcuts(true)}
          />
        </div>

        <div
          className={cn(
            "min-h-0 min-w-0 overflow-y-auto border-border-seam @[60rem]/wgh:border-l",
            inspecting ? "block" : "hidden @[60rem]/wgh:block",
          )}
          aria-label="Inspector"
          role="region"
          ref={inspectorRef}
          tabIndex={-1}
        >
          {inspector}
        </div>
      </div>

      <ShortcutSheet open={showShortcuts} onOpenChange={setShowShortcuts} />
      <BulkMergeDialog
        pulls={bulkPulls ?? emptyItems}
        open={bulkPulls !== null}
        onOpenChange={(open) => {
          if (!open) setBulkPulls(null);
        }}
      />
      <Dialog open={managing} onOpenChange={setManaging}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Repositories</DialogTitle>
            <DialogDescription>Choose which repositories appear in GitHub.</DialogDescription>
          </DialogHeader>
          {managing ? <RepositorySettings /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PullPicker({ onPick }: { onPick: (repo: string, number: number) => void }) {
  const [model] = useState(() => new ReadModels<Item[]>(1, 8 * 1024 * 1024, 30_000));
  const { items, error } = useItems(model);

  if (error !== null) return <EmptyState message={error} />;

  if (items === null) return <ListLoading />;

  const open = items.filter((item) => item.kind === "pr" && item.state === "OPEN");

  if (open.length === 0) {
    return <EmptyState message="No open pull requests in the tracked repositories." />;
  }

  return (
    <ul className="overflow-hidden rounded-md border border-border">
      {open.map((item) => (
        <li key={itemKey(item)} className="border-b border-border-seam last:border-b-0">
          <button
            type="button"
            className="grid min-h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 px-2.5 text-left text-sm hover:bg-state-hover"
            onClick={() => onPick(item.repo, item.number)}
          >
            <StateGlyph kind="pr" state={item.state} />
            <span className="min-w-0 truncate">{item.title}</span>
            <span className="text-xs text-subtle-foreground">#{item.number}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PullPanelTab({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [lookup, setLookup] = useState<"loading" | "failed" | "done">("loading");
  const [attempt, setAttempt] = useState(0);

  const [selected, setSelected] = useState<{
    repo: string;
    number: number;
    environmentId: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLookup("loading");
    rpc.call("pullForThread", { threadId }).then(
      (result) => {
        if (cancelled) return;

        if (result.pull !== null) setSelected(result.pull);
        setLookup("done");
      },
      () => {
        if (!cancelled) setLookup("failed");
      },
    );

    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, attempt]);

  if (lookup === "loading") return <ListLoading />;

  if (lookup === "failed" && selected === null) {
    return (
      <div className="flex items-center justify-between gap-3 p-3">
        <p role="alert" className="text-sm">
          Couldn’t check which pull request this chat is linked to.
        </p>
        <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          Retry
        </Button>
      </div>
    );
  }

  if (selected === null) {
    return (
      <div className="flex flex-col gap-3 p-1">
        <p className="text-xs text-muted-foreground">
          No pull request is linked to this chat yet. Pick one:
        </p>
        <PullPicker onPick={(repo, number) => setSelected({ repo, number, environmentId: null })} />
      </div>
    );
  }

  return (
    <PullInspector
      repo={selected.repo}
      number={selected.number}
      workspaceEnvironmentId={selected.environmentId}
      navigation={{ layout: "thread", backLabel: "All PRs", onBack: () => setSelected(null) }}
    />
  );
}

function NavigationCounts() {
  useRealtime("data-changed", () => {
    pullModels.invalidate();
    statusModels.invalidate();
  });

  return <GithubNavCounts />;
}

export default definePluginApp((app) => {
  app.experimental_icons.register({
    name: "workspace-github/counts",
    component: GithubNavIcon,
  });
  app.slots.experimental_appOverlay({
    id: "navigation-counts",
    component: NavigationCounts,
  });
  app.slots.settingsSection({
    id: "repositories",
    title: "Excluded repositories",
    description: "Choose the repositories shown in GitHub.",
    component: RepositorySettings,
  });
  app.slots.navPanel({
    id: "github",
    title: "GitHub",
    icon: "workspace-github/counts",
    path: PANEL_PATH,
    component: GithubPanel,
    headerContent: PanelHeader,
  });
  app.slots.threadPanelAction({
    id: "pull",
    title: "GitHub PR",
    icon: "Github",
    component: PullPanelTab,
  });
});
