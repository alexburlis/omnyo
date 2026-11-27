import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button.js";
import { Icon } from "./ui/icon.js";

const STORAGE_KEY = "omnyo-plugin-workspace-github:dismissed-sync-notice";

const SYNC_ERROR = /^Sync failed for ([^;]+); any displayed rows are from the previous sync\.$/u;

const MISSING_FOLDER = /^Could not inspect (.+): ENOENT:/u;

export function failedRepo(warning: string): string | undefined {
  return SYNC_ERROR.exec(warning)?.[1];
}

function groupNotices(warnings: string[], notices: string[], error: string | null) {
  const folders = new Set<string>();
  const repositories = new Set<string>();
  const offline = new Set(notices);
  const other = new Set<string>();

  for (const warning of warnings) {
    const repo = failedRepo(warning);
    const folder = MISSING_FOLDER.exec(warning)?.[1];

    if (repo !== undefined) repositories.add(repo);
    else if (folder !== undefined) folders.add(folder);
    else other.add(warning);
  }

  const groups = [
    {
      title: "Missing folders",
      entries: [...folders],
      hint: "Reconnect the drive or update the project source, then refresh.",
    },
    {
      title: "Repositories that failed to sync",
      entries: [...repositories],
      hint: "Rows for these repositories are from the last successful sync.",
    },
    { title: "Machine status", entries: [...offline], hint: null },
    { title: "Other sync issues", entries: [...other], hint: null },
    { title: "GitHub status unavailable", entries: error === null ? [] : [error], hint: null },
  ];

  return groups.flatMap((group) =>
    group.entries.length === 0 ? [] : [{ ...group, entries: group.entries.sort() }],
  );
}

export function SyncNotice({
  warnings,
  notices,
  error,
  loaded,
  scope = "sync",
}: {
  warnings: string[];
  notices: string[];
  error: string | null;
  loaded: boolean;
  scope?: "sync" | "discovery";
}) {
  const storageKey = `${STORAGE_KEY}:${scope}`;
  const groups = useMemo(() => groupNotices(warnings, notices, error), [warnings, notices, error]);
  const count = groups.reduce((total, group) => total + group.entries.length, 0);
  const signature = JSON.stringify(groups.map(({ title, entries }) => [title, entries]));
  const [expanded, setExpanded] = useState<string | null>(null);

  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return window.sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });

  const detailId = useId();
  const restore = useRef<HTMLButtonElement>(null);

  const saveDismissed = (value: string | null) => {
    setDismissed(value);

    try {
      if (value === null) window.sessionStorage.removeItem(storageKey);
      else window.sessionStorage.setItem(storageKey, value);
    } catch {}
  };

  useEffect(() => {
    if (loaded && count === 0 && dismissed !== null) saveDismissed(null);
  }, [count, dismissed, loaded]);

  if (count === 0) return null;

  const hidden = dismissed === signature;
  const open = !hidden && expanded === signature;
  const hasWarnings = warnings.length > 0 || error !== null;

  const title =
    scope === "discovery" ? "Discovery issues" : hasWarnings ? "Sync issues" : "Sync notices";

  return (
    <section
      aria-label={scope === "sync" ? "GitHub sync health" : "Repository discovery health"}
      className={
        hidden ? "flex justify-end" : "overflow-hidden rounded-lg border border-border bg-card"
      }
    >
      <div className={hidden ? "flex items-center" : "flex min-h-10 items-center gap-2 px-2"}>
        <button
          ref={restore}
          type="button"
          aria-controls={detailId}
          aria-expanded={open}
          onClick={() => {
            if (hidden) saveDismissed(null);
            setExpanded(open ? null : signature);
          }}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon
            name={hasWarnings ? "TriangleAlert" : "Info"}
            aria-hidden="true"
            className={`size-4 shrink-0 ${hasWarnings ? "text-warning-text" : "text-muted-foreground"}`}
          />
          <span className="min-w-0 flex-1 whitespace-nowrap">
            {title} <span className="tabular-nums text-muted-foreground">({count})</span>
          </span>
          {hidden ? null : (
            <span className="shrink-0 text-muted-foreground max-[360px]:sr-only">
              {open ? "Hide details" : "Show details"}
            </span>
          )}
          <Icon
            name={open ? "ChevronUp" : "ChevronDown"}
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        </button>
        {hidden ? null : (
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label={
              scope === "sync"
                ? "Dismiss GitHub sync notice"
                : "Dismiss repository discovery notice"
            }
            onClick={() => {
              saveDismissed(signature);
              setExpanded(null);
              restore.current?.focus();
            }}
          >
            <Icon name="X" aria-hidden="true" />
          </Button>
        )}
      </div>
      <div
        id={detailId}
        hidden={!open}
        className="max-h-72 space-y-3 overflow-y-auto border-t border-border px-4 py-3"
      >
        {groups.map(({ title: groupTitle, entries, hint }) => (
          <section key={groupTitle} aria-label={groupTitle} className="space-y-1">
            <h3 className="text-sm font-medium">
              {groupTitle}{" "}
              <span className="text-xs tabular-nums text-muted-foreground">({entries.length})</span>
            </h3>
            {hint === null ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
            <ul className="mt-1 space-y-1 border-l border-border pl-3 text-xs text-muted-foreground">
              {entries.map((entry) => (
                <li key={entry} className="break-all">
                  {entry}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
