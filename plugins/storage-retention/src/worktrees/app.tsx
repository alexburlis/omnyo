import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import {
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
  experimental_Icon as Icon,
  experimental_Diff as Diff,
} from "@omnyo/plugin-sdk/app";
import { Button } from "@omnyo/shared-ui/button";
import type { rpcContract } from "./contract";
import type { Repo } from "./git";
import type { CleanupItem } from "./cleanup-plan";
import type { CleanupOutcome } from "./contract";
import { SidebarStatus } from "./sidebar";
import "./style.css";

type Selection = {
  projectId: string;
  repo: string;
  target: string;
  base: string;
  mode: "working" | "branch";
};

type Entry = {
  projectId: string;
  projectName: string;
  path: string;
  repo: Repo | null;
  error: string | null;
  storagePending: boolean;
};

type Filter = "All" | "Changes" | "Diverged" | "Safe cleanup" | "Clean";

type Sort = "status" | "storage" | "files" | "divergence";

type Worktree = Repo["worktrees"][number];

type Branch = Repo["branches"][number];

type Metric = {
  key: string;
  storage: number | null;
  files: number | null;
  divergence: number | null;
  dirty: boolean;
  ahead: number | null;
};

type Confirmation = {
  token: string;
  path?: string;
  branch: string;
  base: string;
  kind: "folder" | "branch";
  repo?: string;
  estimatedBytes?: number | null;
};

function divergence(ahead: number | null, behind: number | null) {
  return ahead === null || behind === null ? null : ahead + behind;
}

function comparisonState(ahead: number | null, behind: number | null) {
  if (ahead === null || behind === null) return "Unknown";

  if (ahead > 0) return behind > 0 ? "Diverged" : "Ahead";

  return behind > 0 ? "Behind" : "Up to date";
}

function ComparisonBadge({ ahead, behind }: Pick<Branch, "ahead" | "behind">) {
  const state = comparisonState(ahead, behind);

  return (
    <span
      className={`wt-badge ${state === "Ahead" || state === "Diverged" ? "wt-unmerged" : ""}`}
    >
      {state}
    </span>
  );
}

function matches(
  filter: Filter,
  dirty: boolean,
  ahead: number | null,
  behind: number | null,
  ready = false,
  unavailable = false,
) {
  const commits = divergence(ahead, behind);

  return (
    filter === "All" ||
    (filter === "Changes" && (dirty || (commits ?? 0) > 0)) ||
    (filter === "Diverged" && comparisonState(ahead, behind) === "Diverged") ||
    (filter === "Safe cleanup" && ready) ||
    (filter === "Clean" && !unavailable && !dirty && commits === 0)
  );
}

function bytesLabel(bytes: number) {
  const unit =
    bytes >= 1_000_000_000
      ? "GB"
      : bytes >= 1_000_000
        ? "MB"
        : bytes >= 1_000
          ? "KB"
          : "B";

  const divisor =
    unit === "GB"
      ? 1_000_000_000
      : unit === "MB"
        ? 1_000_000
        : unit === "KB"
          ? 1_000
          : 1;

  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / divisor)} ${unit}`;
}

function folderSize(w: Worktree, pending = false) {
  return pending
    ? "Measuring folder size…"
    : w.storage.status === "measured" && w.storage.allocatedBytes !== null
      ? `${bytesLabel(w.storage.allocatedBytes)} folder`
      : w.storage.allocatedBytes !== null
        ? `Partial size · at least ${bytesLabel(w.storage.allocatedBytes)}`
        : "Folder size unavailable";
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function spaceEstimate(items: CleanupItem[]) {
  const folders = items.filter((item) => item.kind === "folder");

  const bytes = folders.reduce(
    (sum, item) => sum + (item.estimatedBytes ?? 0),
    0,
  );

  const unknown = folders.filter((item) => item.estimatedBytes === null).length;

  return {
    branchesOnly: items.length > 0 && folders.length === 0,
    bytes,
    unknown,
  };
}

function estimateLabel(items: CleanupItem[]) {
  const { branchesOnly, bytes, unknown } = spaceEstimate(items);

  return branchesOnly
    ? "Branch names only"
    : `${bytesLabel(bytes)} estimated${unknown ? ` · ${plural(unknown, "folder size", "folder sizes")} unknown` : ""}`;
}

function spaceSummary(items: CleanupItem[]) {
  const { branchesOnly, bytes, unknown } = spaceEstimate(items);

  return branchesOnly
    ? "Branch names hold no files, so this frees no disk space"
    : `${bytesLabel(bytes)} estimated folder space${unknown ? ` · ${plural(unknown, "folder size", "folder sizes")} unknown` : ""}`;
}

function refLabel(ref: string) {
  return ref.replace(/^refs\/(?:heads|remotes)\//, "");
}

function commitsLabel(
  ahead: number | null,
  behind: number | null,
  base: string | null,
) {
  return ahead === null || behind === null
    ? base
      ? `Comparison unavailable vs ${base}`
      : "Comparison unavailable"
    : `${ahead} ahead · ${behind} behind vs ${base}`;
}

function treeMetric(w: Worktree): Metric {
  return {
    key: w.path,
    storage: w.storage.allocatedBytes,
    files: w.error ? null : w.dirtyFiles.length,
    divergence: divergence(w.ahead, w.behind),
    dirty: w.dirty,
    ahead: w.ahead,
  };
}

function branchMetric(b: Branch): Metric {
  return {
    key: b.name,
    storage: null,
    files: null,
    divergence: divergence(b.ahead, b.behind),
    dirty: false,
    ahead: b.ahead,
  };
}

function compareMetric(a: Metric, b: Metric, sort: Sort) {
  if (sort === "status")
    return (
      Number(b.dirty) - Number(a.dirty) ||
      (b.ahead ?? -1) - (a.ahead ?? -1) ||
      a.key.localeCompare(b.key)
    );
  const av = a[sort];
  const bv = b[sort];

  return av === null
    ? bv === null
      ? a.key.localeCompare(b.key)
      : 1
    : bv === null
      ? -1
      : bv - av || a.key.localeCompare(b.key);
}

export function ProjectGitStatus() {
  return <SidebarStatus />;
}

function shortPath(path: string) {
  return path.replace(/^\/Users\/[^/]+\//, "~/");
}

function CleanupReview({
  items,
  entries,
}: {
  items: CleanupItem[];
  entries: Entry[];
}) {
  return (
    <div className="wt-cleanup-review">
      <ul className="wt-cleanup-safety">
        <li>
          Every commit stays in a local branch that is kept, named on each item.
        </li>
        {items.some((item) => item.kind === "folder") && (
          <li>
            A folder goes only when Git finds no uncommitted, untracked or
            ignored files, nothing locks it and no Omnyo chat or project uses
            it. Main checkouts always stay.
          </li>
        )}
        {items.some((item) => item.kind === "branch") && (
          <li>
            A branch goes only when no folder uses it and Git confirms it is
            merged.
          </li>
        )}
        <li>
          Each item is checked again right before removal. Anything that changed
          since the scan is kept and reported.
        </li>
        <li>Nothing is forced, and remote branches are never touched.</li>
      </ul>
      <div className="wt-cleanup-list">
        {[...new Set(items.map((item) => item.repo))].map((repo) => {
          const group = items.filter((item) => item.repo === repo);

          const worktrees =
            entries.find((entry) => entry.path === repo)?.repo?.worktrees ?? [];

          return (
            <section key={repo}>
              <h3>
                {group[0].projectName}
                <small>{repo}</small>
              </h3>
              {group.map((item) => {
                const branch =
                  item.kind === "folder"
                    ? worktrees.find(
                        (worktree) => worktree.path === item.target,
                      )?.branch
                    : null;

                const deletedToo = group.some(
                  (other) => other.kind === "branch" && other.target === branch,
                );

                return (
                  <div
                    className="wt-cleanup-item"
                    key={`${item.kind}-${item.target}`}
                  >
                    <span className="wt-cleanup-kind">
                      {item.kind === "folder"
                        ? "Remove folder"
                        : "Delete branch"}
                    </span>
                    <strong>{item.target}</strong>
                    <span>
                      Commits kept in <b>{item.base}</b> ·{" "}
                      {item.kind === "branch"
                        ? "no files"
                        : [
                            item.estimatedBytes === null
                              ? "size unknown"
                              : `about ${bytesLabel(item.estimatedBytes)}`,
                            branch
                              ? `branch ${branch} ${deletedToo ? "is deleted too" : "stays"}`
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                    </span>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CleanupOutcomeView({ outcome }: { outcome: CleanupOutcome }) {
  const folders = outcome.removed.filter((item) => item.kind === "folder");
  const branches = outcome.removed.length - folders.length;
  const freed = folders.reduce((sum, item) => sum + (item.freedBytes ?? 0), 0);
  const unmeasured = folders.filter((item) => item.freedBytes === null).length;

  const deleted = `Deleted ${plural(branches, "branch", "branches")}`;

  const details = [
    folders.length
      ? `Removed ${plural(folders.length, "folder", "folders")}`
      : "",
    folders.length && branches ? deleted : "",
    outcome.skipped.length ? `${outcome.skipped.length} kept` : "",
    new Date(outcome.finishedAt).toLocaleString(),
  ].filter(Boolean);

  return (
    <div className="wt-cleanup-result">
      <p role="status">
        <strong className="wt-freed">
          {folders.length
            ? unmeasured === folders.length
              ? "Freed space not measured"
              : `Freed ${unmeasured ? "at least " : ""}${bytesLabel(freed)}`
            : branches
              ? deleted
              : "Nothing removed"}
        </strong>
        <span>{details.join(" · ")}</span>
      </p>
      {(folders.length > 0 || branches > 0) && (
        <small>
          {folders.length
            ? "Measured just before removal. Disk free space can lag while local snapshots hold the files."
            : "Branch names hold no files, so no disk space was freed."}
        </small>
      )}
      <details>
        <summary>Cleanup details</summary>
        {outcome.removed.map((item) => (
          <p key={`${item.repo}-${item.kind}-${item.target}`}>
            {item.kind === "folder"
              ? `Removed folder ${shortPath(item.target)} · ${item.freedBytes === null ? "size not measured" : bytesLabel(item.freedBytes)}`
              : `Deleted branch ${item.target} · commits kept in ${item.base} · ${shortPath(item.repo)}`}
          </p>
        ))}
        {outcome.skipped.map((item) => (
          <p key={`${item.repo}-${item.kind}-${item.target}`}>
            Kept {item.kind}{" "}
            {item.kind === "folder" ? shortPath(item.target) : item.target} ·{" "}
            {item.reason}
          </p>
        ))}
      </details>
    </div>
  );
}

export function WorktreesSection({
  machineName,
  onSummaryChange,
}: {
  machineName?: string;
  onSummaryChange: (summary: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);

  const [scanState, setScanState] = useState<z.infer<
    typeof rpcContract.savedScan.output
  > | null>(null);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [sort, setSort] = useState<Sort>("status");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [file, setFile] = useState("");
  const [patch, setPatch] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [split, setSplit] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const [cleanupProgress, setCleanupProgress] = useState(0);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const cleanupId = useRef<{ id: string; total: number } | null>(null);
  const [purging, setPurging] = useState(false);
  const [preparing, setPreparing] = useState(false);

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set(),
  );

  const [cleanupReview, setCleanupReview] = useState<{
    snapshotId: string;
    items: CleanupItem[];
    entries: Entry[];
  } | null>(null);

  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  const inspectorTrigger = useRef<HTMLButtonElement | null>(null);
  const inspectorTarget = selection?.target;
  const inspectorRepo = selection?.repo;
  const mutationPending = useRef(false);
  const snapshotId = useRef<string | undefined>(undefined);
  snapshotId.current = scanState?.snapshot?.id;

  function restoreFocus() {
    const target = actionTrigger.current;

    if (target?.isConnected) target.focus();
    else sectionHeading.current?.focus();
  }

  const report = (error: Error) => setBulkError(error.message);

  useEffect(() => {
    if (inspectorTarget && inspectorRepo) inspectorHeading.current?.focus();
  }, [inspectorRepo, inspectorTarget]);
  useEffect(() => {
    if (bulkError) errorNotice.current?.focus();
  }, [bulkError]);
  useEffect(() => {
    if (confirmation) confirmationHeading.current?.focus();
  }, [confirmation]);
  useEffect(() => {
    if (cleanupReview) reviewHeading.current?.focus();
  }, [cleanupReview]);
  useRealtime("cleanup-progress", (payload) => {
    const event = z
      .object({ token: z.string(), done: z.number(), total: z.number() })
      .safeParse(payload);

    if (event.success && event.data.token === cleanupId.current?.id)
      setCleanupProgress(event.data.done);
  });
  useRealtime("scan-changed", () => setRefresh((value) => value + 1));
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function read() {
      try {
        const result = await rpc.call("savedScan");

        if (!active) return;
        setScanState(result);
        setLoadError(null);
        setEntries(
          result.snapshot?.entries.map((entry) => ({
            ...entry,
            storagePending: false,
          })) ?? [],
        );
        setIssues(result.snapshot?.issues ?? []);
        setBusy(result.scanning);

        if (result.scanning) timer = setTimeout(() => void read(), 2000);
      } catch (error) {
        if (active) {
          setBusy(false);
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void read();

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [rpc, refresh, connection]);
  useEffect(() => {
    setFiles(null);
    setFile("");
    setPatch(null);
    setDiffError(null);

    if (!selection) return;
    let active = true;
    rpc.call("files", selection).then(
      (result) => {
        if (active) {
          setFiles(result);
          setFile(result[0] ?? "");
        }
      },
      (error) => {
        if (active) setDiffError(error.message);
      },
    );

    return () => {
      active = false;
    };
  }, [rpc, selection]);
  useEffect(() => {
    setPatch(null);
    setDiffError(null);

    if (!selection || !file) return;
    let active = true;
    rpc.call("diff", { ...selection, path: file }).then(
      (result) => {
        if (active) setPatch(result.patch);
      },
      (error) => {
        if (active) setDiffError(error.message);
      },
    );

    return () => {
      active = false;
    };
  }, [rpc, selection, file]);
  const worktrees = entries.flatMap((e) => e.repo?.worktrees ?? []);

  const looseBranches = entries.flatMap(
    (e) => e.repo?.branches.filter((b) => !b.worktrees.length) ?? [],
  );

  const cleanupItems = scanState?.snapshot?.items ?? [];

  const removableFolders = cleanupItems.filter(
    (item) => item.kind === "folder",
  ).length;

  const deletableBranches = cleanupItems.filter(
    (item) => item.kind === "branch",
  ).length;

  const lastCleanup = scanState?.lastCleanup ?? null;

  const changes = (item: { ahead: number | null; behind: number | null }) =>
    (divergence(item.ahead, item.behind) ?? 0) > 0;

  const counts = {
    All: worktrees.length + looseBranches.length,
    Changes:
      worktrees.filter((w) => w.dirty || changes(w)).length +
      looseBranches.filter(changes).length,
    Diverged: [...worktrees, ...looseBranches].filter(
      ({ ahead, behind }) => comparisonState(ahead, behind) === "Diverged",
    ).length,
    "Safe cleanup":
      worktrees.filter((w) => w.purgeReady).length +
      looseBranches.filter((b) => b.deleteReady).length,
    Clean:
      worktrees.filter(
        (w) => !w.error && !w.dirty && divergence(w.ahead, w.behind) === 0,
      ).length +
      looseBranches.filter((b) => divergence(b.ahead, b.behind) === 0).length,
  };

  const search = query.toLowerCase().trim();

  function visibleRows(entry: Entry) {
    const repoMatch = `${entry.projectName} ${entry.path}`
      .toLowerCase()
      .includes(search);

    const trees =
      entry.repo?.worktrees.filter(
        (w) =>
          matches(
            filter,
            w.dirty,
            w.ahead,
            w.behind,
            w.purgeReady,
            Boolean(w.error),
          ) &&
          (repoMatch || `${w.branch} ${w.path}`.toLowerCase().includes(search)),
      ) ?? [];

    const branches =
      entry.repo?.branches.filter(
        (b) =>
          b.worktrees.length === 0 &&
          matches(filter, false, b.ahead, b.behind, b.deleteReady) &&
          (repoMatch || b.name.toLowerCase().includes(search)),
      ) ?? [];

    return { trees, branches, repoMatch };
  }

  function leadingMetric(group: Entry[]) {
    return group
      .flatMap((entry) => {
        const rows = visibleRows(entry);

        return [
          ...rows.trees.map(treeMetric),
          ...rows.branches.map(branchMetric),
        ];
      })
      .sort((a, b) => compareMetric(a, b, sort))[0];
  }

  function compareEntries(a: Entry[], b: Entry[]) {
    const am = leadingMetric(a);
    const bm = leadingMetric(b);

    return am && bm ? compareMetric(am, bm, sort) : am ? -1 : bm ? 1 : 0;
  }

  const projects = [...new Set(entries.map((e) => e.projectName))].sort(
    (a, b) =>
      compareEntries(
        entries.filter((e) => e.projectName === a),
        entries.filter((e) => e.projectName === b),
      ) || a.localeCompare(b),
  );

  const selectedEntry = entries.find((e) => e.path === selection?.repo);
  const selectedRepo = selectedEntry?.repo;

  const selectedTree =
    selection?.mode === "working"
      ? selectedRepo?.worktrees.find((w) => w.path === selection.target)
      : null;

  const allIssues = [
    ...issues,
    ...entries.flatMap((e) => (e.error ? [`${e.path}: ${e.error}`] : [])),
  ];

  const missingInactiveEnvironments =
    scanState?.snapshot?.missingInactiveEnvironments ?? [];

  const summary = loadError
    ? "Worktree scan unavailable"
    : scanState?.snapshot
      ? cleanupItems.length
        ? `${plural(cleanupItems.length, "item", "items")} ready · ${estimateLabel(cleanupItems)}${allIssues.length ? " · Partial scan" : ""}`
        : allIssues.length
          ? "No reviewed items · Partial scan"
          : "Nothing ready to clean"
      : busy
        ? "Waiting for the first scan"
        : "No saved scan yet";

  useEffect(() => onSummaryChange(summary), [onSummaryChange, summary]);

  function open(
    entry: Entry,
    target: string,
    mode: "working" | "branch",
    trigger: HTMLButtonElement,
  ) {
    if (!entry.repo?.base) return;
    const { base, baseRef, branches } = entry.repo;
    inspectorTrigger.current = trigger;
    setSelection({
      projectId: entry.projectId,
      repo: entry.path,
      target,
      mode,
      base:
        baseRef ??
        (branches.some(({ name }) => name === base)
          ? `refs/heads/${base}`
          : `refs/remotes/${base}`),
    });
  }

  function closeInspector() {
    setSelection(null);
    const trigger = inspectorTrigger.current;

    if (trigger?.isConnected) trigger.focus();
    else sectionHeading.current?.focus();
  }

  return (
    <section className="wt-app" aria-labelledby="storage-worktrees">
      <header className="wt-header">
        <div>
          <h2 id="storage-worktrees" tabIndex={-1} ref={sectionHeading}>
            Worktrees &amp; branches
          </h2>
          <p className="wt-scope">
            {machineName ?? "Coordinator"} · Configured local repositories
          </p>
          <p>
            {plural(entries.length, "repository", "repositories")} ·{" "}
            {plural(worktrees.length, "working folder", "working folders")} ·{" "}
            {plural(looseBranches.length, "branch", "branches")} without folders
          </p>
        </div>
        <div className="wt-refresh">
          <span role="status">
            {scanState?.snapshot
              ? `Last scan ${new Date(scanState.snapshot.scannedAt).toLocaleString()}`
              : "No saved scan yet"}
            {scanState?.scanning && " · Scanning…"}
          </span>
          <span
            className="wt-measure-status"
            title={
              scanState
                ? `Next scan ${new Date(scanState.nextScanAt).toLocaleString()}`
                : undefined
            }
          >
            Automatically scans every 3 hours
          </span>
          <Button
            size="sm"
            className="wt-cleanup-all"
            disabled={
              busy ||
              purging ||
              preparing ||
              Boolean(loadError) ||
              !cleanupItems.length
            }
            onClick={(event) => {
              const id = scanState?.snapshot?.id;

              if (!id || mutationPending.current) return;
              actionTrigger.current = event.currentTarget;
              setConfirmation(null);
              setBulkError(null);
              setCleanupReview({
                snapshotId: id,
                items: [...cleanupItems],
                entries,
              });
            }}
          >
            <Icon name="Archive" aria-hidden="true" />
            {purging
              ? `Cleaning up ${cleanupProgress}/${cleanupId.current?.total ?? cleanupItems.length}…`
              : `Review cleanup (${cleanupItems.length})`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || purging}
            onClick={async () => {
              setBusy(true);

              if (loadError) {
                setRefresh((value) => value + 1);

                return;
              }

              setBulkError(null);

              try {
                const result = await rpc.call("rescan");
                setScanState(result);
                setBusy(result.scanning);
                setRefresh((value) => value + 1);
              } catch (error) {
                setBulkError(
                  error instanceof Error ? error.message : String(error),
                );
                setBusy(false);
              }
            }}
          >
            {loadError
              ? "Retry"
              : !scanState
                ? "Loading scan…"
                : busy
                  ? "Scanning…"
                  : "Rescan"}
          </Button>
        </div>
      </header>
      <div className="wt-toolbar">
        <div className="wt-filters" aria-label="Inventory status">
          {(
            [
              "All",
              "Changes",
              "Diverged",
              "Safe cleanup",
              "Clean",
            ] satisfies Filter[]
          ).map((value) => (
            <button
              key={value}
              data-tone={
                value === "Changes" || value === "Diverged"
                  ? "amber"
                  : value === "Safe cleanup"
                    ? "green"
                    : value === "Clean"
                      ? "slate"
                      : "blue"
              }
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              <span className="wt-stat-label">{value}</span>
              <strong>{counts[value]}</strong>
            </button>
          ))}
        </div>
        <label className="wt-sort">
          Sort
          <span className="wt-select">
            <select
              aria-label="Sort inventory"
              value={sort}
              onChange={(e) => {
                const value = e.target.value;

                if (
                  value === "status" ||
                  value === "storage" ||
                  value === "files" ||
                  value === "divergence"
                )
                  setSort(value);
              }}
            >
              <option value="status">Status</option>
              <option value="storage">Largest folders</option>
              <option value="files">Most changed files</option>
              <option value="divergence">Most divergence</option>
            </select>
            <Icon
              name="ChevronDown"
              aria-hidden="true"
              className="wt-select-chevron"
            />
          </span>
        </label>
        <input
          type="search"
          aria-label="Find repository or branch"
          placeholder="Find project, branch or path…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="wt-cleanup-guide">
        <Icon name="Archive" aria-hidden="true" />
        <strong>
          {removableFolders} {removableFolders === 1 ? "folder" : "folders"}{" "}
          removable · {deletableBranches}{" "}
          {deletableBranches === 1 ? "branch" : "branches"} deletable across all
          projects
        </strong>
        <span>
          {spaceSummary(cleanupItems)}
          {allIssues.length > 0 &&
            ` · Partial inventory: ${allIssues.length} ${allIssues.length === 1 ? "path" : "paths"} unchecked`}
          .
        </span>
        {sort !== "status" && (
          <small className="wt-sort-help">
            {sort === "storage"
              ? "Largest folders first; shared Git storage excluded."
              : sort === "files"
                ? "Most uncommitted files first; branch refs have no working files."
                : "Most ahead + behind commits first, against each repository’s shown baseline."}{" "}
            Projects and repositories follow their top matching item.
          </small>
        )}
      </div>
      {(bulkError || loadError || scanState?.lastError) && (
        <p role="alert" className="wt-error" tabIndex={-1} ref={errorNotice}>
          {bulkError || loadError || scanState?.lastError}
        </p>
      )}
      {preparing && (
        <p role="status" className="wt-preparing">
          Checking cleanup safety…
        </p>
      )}
      {lastCleanup && !purging && <CleanupOutcomeView outcome={lastCleanup} />}
      {filter === "Safe cleanup" && !busy && counts["Safe cleanup"] === 0 && (
        <p className="wt-empty">
          Nothing is safe to remove right now. Protected items show why under
          All.
        </p>
      )}
      {allIssues.length > 0 && (
        <details className="wt-issues">
          <summary className="wt-disclosure">
            <Icon
              name="ChevronRight"
              aria-hidden="true"
              className="wt-disclosure-chevron"
            />
            <Icon
              name="AlertTriangle"
              aria-hidden="true"
              className="wt-disclosure-warning"
            />
            {allIssues.length}{" "}
            {allIssues.length === 1 ? "path needs" : "paths need"} attention
            <span className="wt-disclosure-hint">
              Not checked in the last scan, so totals may be low
            </span>
          </summary>
          {allIssues.map((issue, index) => (
            <p key={`${index}-${issue}`}>{issue}</p>
          ))}
        </details>
      )}
      {missingInactiveEnvironments.length > 0 && (
        <details className="wt-issues">
          <summary className="wt-disclosure">
            <Icon
              name="ChevronRight"
              aria-hidden="true"
              className="wt-disclosure-chevron"
            />
            {plural(
              missingInactiveEnvironments.length,
              "missing inactive workspace",
              "missing inactive workspaces",
            )}
          </summary>
          {missingInactiveEnvironments.map(({ projectId, path }) => (
            <p key={JSON.stringify([projectId, path])}>{path}</p>
          ))}
        </details>
      )}
      {cleanupReview && (
        <section
          className="wt-confirm wt-bulk-review"
          aria-labelledby="wt-review-title"
          aria-busy={purging}
        >
          <h3 id="wt-review-title" tabIndex={-1} ref={reviewHeading}>
            Review worktree cleanup
          </h3>
          <p>
            {plural(cleanupReview.items.length, "item", "items")} ·{" "}
            {plural(
              cleanupReview.items.filter((item) => item.kind === "folder")
                .length,
              "folder",
              "folders",
            )}{" "}
            ·{" "}
            {plural(
              cleanupReview.items.filter((item) => item.kind === "branch")
                .length,
              "branch",
              "branches",
            )}{" "}
            · {estimateLabel(cleanupReview.items)}
          </p>
          <p>
            This review includes all projects, regardless of the current search
            or filter.
          </p>
          <CleanupReview
            items={cleanupReview.items}
            entries={cleanupReview.entries}
          />
          {cleanupReview.snapshotId !== scanState?.snapshot?.id && (
            <p role="alert" className="wt-error">
              The saved scan changed. Close this review and review the latest
              scan.
            </p>
          )}
          {purging && (
            <p role="status">
              Cleaning up {cleanupProgress}/
              {cleanupId.current?.total ?? cleanupReview.items.length}…
            </p>
          )}
          <footer>
            <Button
              variant="outline"
              disabled={purging}
              onClick={() => {
                setCleanupReview(null);
                restoreFocus();
              }}
            >
              Close review
            </Button>
            <Button
              variant="destructive"
              disabled={
                busy ||
                purging ||
                Boolean(loadError) ||
                cleanupReview.snapshotId !== scanState?.snapshot?.id
              }
              onClick={async () => {
                if (
                  mutationPending.current ||
                  cleanupReview.snapshotId !== snapshotId.current
                )
                  return;
                mutationPending.current = true;
                cleanupId.current = {
                  id: cleanupReview.snapshotId,
                  total: cleanupReview.items.length,
                };
                setPurging(true);
                setBulkError(null);
                setCleanupProgress(0);

                try {
                  await rpc.call("cleanSaved", {
                    snapshotId: cleanupReview.snapshotId,
                  });
                  setCleanupReview(null);
                  restoreFocus();
                } catch (error) {
                  setBulkError(
                    error instanceof Error ? error.message : String(error),
                  );
                  setCleanupReview(null);
                  restoreFocus();
                } finally {
                  cleanupId.current = null;
                  mutationPending.current = false;
                  setPurging(false);
                  setRefresh((value) => value + 1);
                }
              }}
            >
              Confirm cleanup ({cleanupReview.items.length})
            </Button>
          </footer>
        </section>
      )}
      {confirmation && (
        <section
          className="wt-confirm"
          aria-labelledby="wt-confirm-title"
          aria-busy={purging}
        >
          <h3 id="wt-confirm-title" tabIndex={-1} ref={confirmationHeading}>
            {confirmation.kind === "folder"
              ? "Remove this working folder?"
              : "Delete this local branch?"}
          </h3>
          <p className="wt-confirm-path">
            {confirmation.path ?? confirmation.branch}
          </p>
          {confirmation.repo && (
            <p className="wt-confirm-path">{confirmation.repo}</p>
          )}
          <p>
            {confirmation.kind === "folder" ? (
              <>
                Removes the directory. Branch{" "}
                <strong>{confirmation.branch}</strong> stays and appears under
                “Branches without a folder”.
              </>
            ) : (
              <>
                Deletes the local branch name. Its commits remain in{" "}
                <strong>{confirmation.base}</strong>. No files or remote
                branches are removed.
              </>
            )}
          </p>
          {confirmation.kind === "folder" && (
            <p className="wt-space-summary">
              Estimated folder space:{" "}
              {confirmation.estimatedBytes == null
                ? "unknown"
                : bytesLabel(confirmation.estimatedBytes)}
              . Filesystem sharing can reduce the space recovered.
            </p>
          )}
          <p>Safety checks run again before removal.</p>
          <footer>
            <Button
              variant="outline"
              disabled={purging}
              onClick={() => {
                setConfirmation(null);
                restoreFocus();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={purging}
              onClick={async () => {
                if (mutationPending.current) return;
                mutationPending.current = true;
                setPurging(true);
                setBulkError(null);

                try {
                  await rpc.call(
                    confirmation.kind === "folder" ? "purge" : "deleteBranch",
                    {
                      token: confirmation.token,
                    },
                  );
                  setConfirmation(null);
                  restoreFocus();
                  setRefresh((n) => n + 1);
                } catch (error) {
                  report(
                    error instanceof Error ? error : new Error(String(error)),
                  );
                  setConfirmation(null);
                  restoreFocus();
                } finally {
                  mutationPending.current = false;
                  setPurging(false);
                }
              }}
            >
              {purging
                ? "Removing…"
                : confirmation.kind === "folder"
                  ? "Remove folder"
                  : "Delete branch"}
            </Button>
          </footer>
        </section>
      )}
      <div className={`wt-body ${selection ? "wt-with-diff" : ""}`}>
        <div className="wt-inventory" aria-label="Local repositories">
          {busy && entries.length === 0 && (
            <div
              className="wt-skeleton"
              aria-label="Loading repository inventory"
            >
              <div />
              <div />
              <div />
            </div>
          )}
          {projects.map((project) => {
            const projectEntries = entries
              .filter((e) => e.projectName === project)
              .sort(
                (a, b) =>
                  compareEntries([a], [b]) || a.path.localeCompare(b.path),
              );

            const visible = projectEntries.some((entry) => {
              const rows = visibleRows(entry);

              return entry.repo
                ? rows.trees.length > 0 || rows.branches.length > 0
                : rows.repoMatch;
            });

            if (!visible) return null;

            return (
              <details
                key={project}
                aria-label={project}
                className="wt-project"
                open={
                  Boolean(search) ||
                  filter !== "All" ||
                  expandedProjects.has(project) ||
                  projectEntries.some((entry) => entry.path === selection?.repo)
                }
                onToggle={(event) => {
                  if (search || filter !== "All") return;
                  const isOpen = event.currentTarget.open;
                  setExpandedProjects((current) => {
                    if (current.has(project) === isOpen) return current;
                    const next = new Set(current);

                    if (isOpen) next.add(project);
                    else next.delete(project);

                    return next;
                  });
                }}
              >
                <summary
                  className="wt-project-heading"
                  onClick={(event) => {
                    if (
                      search ||
                      filter !== "All" ||
                      projectEntries.some(
                        (entry) => entry.path === selection?.repo,
                      )
                    )
                      event.preventDefault();
                  }}
                >
                  <Icon
                    name="ChevronRight"
                    className="wt-disclosure-chevron"
                    aria-hidden="true"
                  />
                  <h3>
                    <span className="wt-project-icon">
                      <Icon name="Folder" aria-hidden="true" />
                    </span>
                    {project}
                  </h3>
                  <span>
                    {projectEntries.length}{" "}
                    {projectEntries.length === 1 ? "repo" : "repos"}
                  </span>
                  {projectEntries.some((e) =>
                    e.repo?.worktrees.some((w) => w.dirty),
                  ) && (
                    <span className="wt-project-dirty">
                      {projectEntries.reduce(
                        (n, e) =>
                          n +
                          (e.repo?.worktrees.filter((w) => w.dirty).length ??
                            0),
                        0,
                      )}{" "}
                      dirty
                    </span>
                  )}
                </summary>
                {projectEntries.map((entry) => {
                  const repo = entry.repo;
                  const rows = visibleRows(entry);
                  const { repoMatch } = rows;

                  const trees = rows.trees.sort((a, b) =>
                    compareMetric(treeMetric(a), treeMetric(b), sort),
                  );

                  const branches = rows.branches.sort((a, b) =>
                    compareMetric(branchMetric(a), branchMetric(b), sort),
                  );

                  if (repo && !trees.length && !branches.length) return null;

                  if (!repoMatch && !repo) return null;

                  return (
                    <article
                      key={entry.path}
                      className="wt-repo"
                      aria-label={entry.path}
                    >
                      <div className="wt-repo-heading">
                        <h3>
                          <Icon
                            name="GitBranch"
                            className="wt-repo-icon"
                            aria-hidden="true"
                          />
                          {entry.path.split("/").at(-1)}
                        </h3>
                        <span title={entry.path}>{shortPath(entry.path)}</span>
                        {repo?.base && <small>vs {repo.base}</small>}
                      </div>
                      {!repo && (
                        <p className="wt-pending">
                          {entry.error
                            ? "Could not read this repository"
                            : "Checking Git status…"}
                        </p>
                      )}
                      {trees.length > 0 && (
                        <div className="wt-section-heading">
                          <Icon name="Folder" aria-hidden="true" />
                          <h4>Working folders</h4>
                          <b>{trees.length}</b>
                          <span>
                            Checked-out branches · may contain uncommitted files
                          </span>
                        </div>
                      )}
                      {trees.map((w) => (
                        <div
                          key={w.path}
                          className={`wt-row ${selection?.target === w.path ? "wt-selected" : ""}`}
                        >
                          <button
                            className="wt-open"
                            title={`View changes in ${w.path}`}
                            disabled={!repo?.base || w.missing || w.bare}
                            onClick={(event) =>
                              open(
                                entry,
                                w.path,
                                "working",
                                event.currentTarget,
                              )
                            }
                          >
                            <span className="wt-identity">
                              <span
                                className="wt-branch"
                                title={w.branch ?? w.head}
                              >
                                <Icon
                                  name="GitBranch"
                                  className="wt-row-icon"
                                  aria-hidden="true"
                                />
                                {w.branch ?? "Detached HEAD"}
                              </span>
                              <span
                                className="wt-storage"
                                title={`Allocated folder estimate; shared Git storage excluded. Measured ${new Date(w.storage.measuredAt).toLocaleString()}${w.storage.error ? `. ${w.storage.error}` : ""}`}
                              >
                                {folderSize(w, entry.storagePending)}
                              </span>
                              <span className="wt-path" title={w.path}>
                                {shortPath(w.path)}
                              </span>
                            </span>
                            <span className="wt-condition">
                              <ComparisonBadge
                                ahead={w.ahead}
                                behind={w.behind}
                              />
                              {w.error ? (
                                <span className="wt-badge wt-unavailable">
                                  Unavailable
                                </span>
                              ) : w.dirty ? (
                                <span className="wt-badge wt-dirty">
                                  Uncommitted edits
                                </span>
                              ) : null}
                              <span className="wt-metrics">
                                {w.error
                                  ? "Changed files unknown"
                                  : `${w.dirtyFiles.length} changed ${w.dirtyFiles.length === 1 ? "file" : "files"}`}{" "}
                                ·{" "}
                                {commitsLabel(
                                  w.ahead,
                                  w.behind,
                                  repo?.base ?? null,
                                )}
                              </span>
                              <span className="wt-protection">
                                {w.purgeReady
                                  ? `Safe to remove folder · Commits kept in local ${w.preserveIn}`
                                  : `Keep folder · ${w.reasons
                                      .map((reason) =>
                                        reason ===
                                        "Used by Omnyo environment or project source"
                                          ? "Used by Omnyo"
                                          : reason,
                                      )
                                      .join(" · ")}`}
                              </span>
                            </span>
                          </button>
                          {w.purgeReady && (
                            <button
                              className="wt-purge"
                              disabled={busy || purging || preparing}
                              onClick={async (event) => {
                                if (mutationPending.current) return;
                                mutationPending.current = true;
                                actionTrigger.current = event.currentTarget;
                                setCleanupReview(null);
                                setBulkError(null);
                                setPreparing(true);

                                try {
                                  const result = await rpc.call("prepare", {
                                    projectId: entry.projectId,
                                    repo: entry.path,
                                    path: w.path,
                                  });

                                  setConfirmation({
                                    ...result,
                                    kind: "folder",
                                    repo: entry.path,
                                  });
                                } catch (error) {
                                  report(
                                    error instanceof Error
                                      ? error
                                      : new Error(String(error)),
                                  );
                                } finally {
                                  mutationPending.current = false;
                                  setPreparing(false);
                                }
                              }}
                            >
                              Remove folder…
                            </button>
                          )}
                        </div>
                      ))}
                      {branches.length > 0 && (
                        <>
                          <div className="wt-section-heading wt-loose-heading">
                            <Icon name="GitBranch" aria-hidden="true" />
                            <h4>Branches without a folder</h4>
                            <b>{branches.length}</b>
                            <span>Not checked out · no uncommitted files</span>
                          </div>
                          {branches.map((b) => (
                            <div key={b.name} className="wt-row wt-branch-row">
                              <button
                                className="wt-open"
                                title={`View changes on ${b.name}`}
                                disabled={!repo?.base}
                                onClick={(event) =>
                                  open(
                                    entry,
                                    b.name,
                                    "branch",
                                    event.currentTarget,
                                  )
                                }
                              >
                                <span className="wt-identity">
                                  <span className="wt-branch" title={b.name}>
                                    <Icon
                                      name="GitBranch"
                                      className="wt-row-icon"
                                      aria-hidden="true"
                                    />
                                    {b.name}
                                  </span>
                                  <span className="wt-storage">
                                    No folder · shared Git storage
                                  </span>
                                </span>
                                <span className="wt-condition">
                                  <ComparisonBadge
                                    ahead={b.ahead}
                                    behind={b.behind}
                                  />
                                  <span className="wt-metrics">
                                    {commitsLabel(
                                      b.ahead,
                                      b.behind,
                                      repo?.base ?? null,
                                    )}
                                  </span>
                                  <span className="wt-protection">
                                    {b.deleteReady
                                      ? `Safe to delete branch · Commits kept in local ${b.deleteBase}`
                                      : `Keep branch · ${b.reasons.join(" · ")}`}
                                  </span>
                                </span>
                              </button>
                              {b.deleteReady && (
                                <button
                                  className="wt-purge"
                                  disabled={busy || purging || preparing}
                                  onClick={async (event) => {
                                    if (mutationPending.current) return;
                                    mutationPending.current = true;
                                    actionTrigger.current = event.currentTarget;
                                    setCleanupReview(null);
                                    setBulkError(null);
                                    setPreparing(true);

                                    try {
                                      const result = await rpc.call(
                                        "prepareBranch",
                                        {
                                          projectId: entry.projectId,
                                          repo: entry.path,
                                          branch: b.name,
                                        },
                                      );

                                      setConfirmation({
                                        ...result,
                                        kind: "branch",
                                        repo: entry.path,
                                      });
                                    } catch (error) {
                                      report(
                                        error instanceof Error
                                          ? error
                                          : new Error(String(error)),
                                      );
                                    } finally {
                                      mutationPending.current = false;
                                      setPreparing(false);
                                    }
                                  }}
                                >
                                  Delete branch…
                                </button>
                              )}
                            </div>
                          ))}
                        </>
                      )}
                    </article>
                  );
                })}
              </details>
            );
          })}
          {!busy &&
            entries.length > 0 &&
            !entries.some((entry) => {
              const rows = visibleRows(entry);

              return (
                rows.trees.length > 0 ||
                rows.branches.length > 0 ||
                (!entry.repo && rows.repoMatch)
              );
            }) && (
              <div className="wt-empty">
                <p role="status">
                  No repositories or branches match this search and filter.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setFilter("All");
                  }}
                >
                  Clear filters
                </Button>
              </div>
            )}
          {!busy && entries.length === 0 && (
            <p className="wt-empty">No local repositories found.</p>
          )}
        </div>
        {selection && (
          <aside
            className="wt-detail"
            aria-label="Changes inspector"
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.stopPropagation();
              closeInspector();
            }}
          >
            <header>
              <div>
                <h2 ref={inspectorHeading} tabIndex={-1}>
                  {selection.mode === "working"
                    ? selection.target.split("/").at(-1)
                    : selection.target}
                </h2>
                <p>
                  {selection.mode === "working"
                    ? "Working files"
                    : "Committed changes"}{" "}
                  <span>vs {refLabel(selection.base)}</span>
                </p>
                <p className="wt-detail-storage">
                  {selectedTree
                    ? folderSize(selectedTree, selectedEntry?.storagePending)
                    : "No folder · shared Git storage"}
                </p>
              </div>
              <button
                aria-label="Close changes inspector"
                onClick={closeInspector}
              >
                ×
              </button>
            </header>
            <div className="wt-diff-tools">
              <details>
                <summary>Compare with {refLabel(selection.base)}</summary>
                <div className="wt-base-list">
                  {[
                    ...new Set([
                      selection.base,
                      ...(selectedRepo?.branches.map(
                        (b) => `refs/heads/${b.name}`,
                      ) ?? []),
                    ]),
                  ].map((base) => (
                    <button
                      key={base}
                      aria-pressed={selection.base === base}
                      onClick={() => setSelection({ ...selection, base })}
                    >
                      {refLabel(base)}
                    </button>
                  ))}
                </div>
              </details>
              <button onClick={() => setSplit((v) => !v)}>
                {split ? "Unified" : "Split"} view
              </button>
            </div>
            {diffError && (
              <p role="alert" className="wt-error">
                {diffError}
              </p>
            )}
            {files === null && !diffError ? (
              <p className="wt-empty">Loading changed files…</p>
            ) : files?.length === 0 ? (
              <p className="wt-empty">
                No changes against {refLabel(selection.base)}.
              </p>
            ) : (
              <>
                <nav className="wt-files" aria-label="Changed files">
                  {files?.map((path) => (
                    <button
                      key={path}
                      aria-pressed={path === file}
                      onClick={() => setFile(path)}
                    >
                      {path}
                    </button>
                  ))}
                </nav>
                <div className="wt-patch">
                  {patch !== null ? (
                    patch ? (
                      <Diff
                        path={file}
                        patch={patch}
                        view={split ? "split" : "unified"}
                      />
                    ) : (
                      <p>No text changes.</p>
                    )
                  ) : (
                    !diffError && <p>Loading diff…</p>
                  )}
                </div>
              </>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
