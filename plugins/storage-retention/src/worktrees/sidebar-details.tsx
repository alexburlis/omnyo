import { useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import type { SidebarRepo } from "./git";

export type WorkItem = {
  key: string;
  label: string;
  path: string;
  kind: string;
  dirtyFiles: string[];
  ahead: number | null;
  base: string | null;
  active: string[];
  error: string | null;
};

type DetailItem = WorkItem & { repoName: string };

function Status({ item }: { item: WorkItem }) {
  return (
    <>
      {item.active.length > 0 && (
        <span className="wt-side-active">
          {item.active.length} active{" "}
          {item.active.length === 1 ? "thread" : "threads"}
        </span>
      )}
      {item.ahead !== null && item.ahead > 0 && (
        <span>
          {item.ahead} unmerged into {item.base}
        </span>
      )}
      {item.error && (
        <span className="wt-side-unknown">Status unavailable</span>
      )}
    </>
  );
}

export function ProjectDetails({
  project,
  work,
  section,
}: {
  project: { repos: SidebarRepo[]; errors: string[] };
  work: WorkItem[];
  section: "checkout" | "work";
}) {
  const [selection, setSelection] = useState<string | null | undefined>();
  const scroller = useRef<HTMLDivElement>(null);
  const workHeading = useRef<HTMLHeadingElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const previous = useRef<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());

  const main = project.repos.flatMap<DetailItem>((repo) => {
    const w = repo.worktrees[0];

    if (!w) return [];
    const key = `${repo.path}:${w.path}`;

    return [
      {
        key,
        label: w.branch ?? "Detached HEAD",
        path: w.path,
        kind: "Checkout",
        dirtyFiles: w.dirtyFiles,
        ahead: w.ahead,
        base: repo.base,
        active: work.find((item) => item.key === key)?.active ?? [],
        error: w.error,
        repoName: repo.path.split("/").at(-1) ?? repo.path,
      },
    ];
  });

  const other = work
    .filter((item) => !main.some((primary) => primary.key === item.key))
    .map((item) => ({
      ...item,
      repoName:
        project.repos
          .find((repo) => item.key.startsWith(`${repo.path}:`))
          ?.path.split("/")
          .at(-1) ?? item.path,
    }));

  const items = [...main, ...other];
  const dirty = items.filter((item) => item.dirtyFiles.length > 0);

  const incomplete =
    project.errors.length > 0 ||
    project.repos.some((repo) => repo.worktrees.some((w) => w.error));

  const automatic =
    section === "checkout" &&
    !incomplete &&
    dirty.length === 1 &&
    main.some((item) => item.key === dirty[0].key)
      ? dirty[0].key
      : null;

  const selected = items.find(
    (item) => item.key === (selection === undefined ? automatic : selection),
  );

  const selectedKey = selected?.key;

  useEffect(() => {
    if (!scroller.current) return;
    scroller.current.scrollTop = 0;

    if (!selectedKey && section === "work" && workHeading.current)
      scroller.current.scrollTop =
        workHeading.current.offsetTop - scroller.current.offsetTop - 10;

    if (selectedKey) {
      previous.current = selectedKey;
      back.current?.focus();
    } else if (previous.current) {
      rows.current.get(previous.current)?.focus();
      previous.current = null;
    }
  }, [selectedKey, section]);

  function row(item: DetailItem) {
    const count = item.dirtyFiles.length;

    return (
      <button
        key={item.key}
        ref={(element) => {
          if (element) rows.current.set(item.key, element);
          else rows.current.delete(item.key);
        }}
        type="button"
        className="wt-side-item"
        onClick={() => setSelection(item.key)}
        aria-label={`${item.kind} ${item.repoName}: ${item.label}, ${count} dirty ${count === 1 ? "file" : "files"}`}
      >
        <Icon
          name={item.kind === "Worktree" ? "Layers" : "GitBranch"}
          aria-hidden="true"
        />
        <span className="wt-side-item-info">
          <b>{item.label}</b>
          <small>
            {item.repoName} · {item.kind}
          </small>
          <span className="wt-side-item-state">
            <Status item={item} />
          </span>
        </span>
        <span
          className={`wt-side-item-count ${count ? "wt-side-dirty" : item.error ? "wt-side-unknown" : "wt-side-clean"}`}
        >
          {count ? (
            `${count} ${count === 1 ? "file" : "files"}`
          ) : item.error ? (
            "?"
          ) : item.kind === "Branch" ? (
            ""
          ) : (
            <Icon name="Check" aria-label="No dirty files" />
          )}
        </span>
        <Icon name="ChevronRight" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div ref={scroller} className="wt-side-details">
      {selected ? (
        <>
          <button
            type="button"
            className="wt-side-back"
            ref={back}
            aria-label="Back to overview"
            onClick={() => setSelection(null)}
          >
            <Icon name="ArrowLeft" aria-hidden="true" />
            Overview
          </button>
          <div className="wt-side-file-heading">
            <h3>{selected.label}</h3>
            <span
              className={
                selected.error
                  ? "wt-side-unknown"
                  : selected.dirtyFiles.length
                    ? "wt-side-dirty"
                    : "wt-side-clean"
              }
            >
              {selected.dirtyFiles.length} dirty{" "}
              {selected.dirtyFiles.length === 1 ? "file" : "files"}
            </span>
          </div>
          <small className="wt-side-file-context">
            {selected.repoName} · {selected.kind}
          </small>
          <div className="wt-side-item-state">
            <Status item={selected} />
          </div>
          {selected.dirtyFiles.length > 0 ? (
            <ul className="wt-side-file-list" aria-label="Dirty files">
              {selected.dirtyFiles.map((file) => {
                const slash = file.lastIndexOf("/");

                return (
                  <li key={file}>
                    <Icon name="FileText" aria-hidden="true" />
                    <span>
                      <strong>{file.slice(slash + 1)}</strong>
                      {slash >= 0 && <small>{file.slice(0, slash)}</small>}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="wt-side-empty">
              {selected.error
                ? "Files could not be checked."
                : "No uncommitted files."}
            </p>
          )}
          {selected.active.map((title, index) => (
            <div className="wt-side-thread" key={`${index}-${title}`}>
              {title}
            </div>
          ))}
        </>
      ) : (
        <>
          <h3>Main checkouts</h3>
          <div className="wt-side-item-group">{main.map(row)}</div>
          {!main.length && (
            <p className="wt-side-empty">No local repositories.</p>
          )}
          <h3 ref={workHeading} className="wt-side-work-heading">
            Work in progress <span>{other.length}</span>
          </h3>
          <div className="wt-side-item-group">{other.map(row)}</div>
          {!other.length && (
            <p className="wt-side-empty">
              {incomplete ||
              project.repos.some((repo) =>
                repo.branches.some((b) => b.ahead === null),
              )
                ? "Some work could not be checked."
                : "No other active or unmerged work."}
            </p>
          )}
        </>
      )}
      {project.errors.length > 0 && (
        <p className="wt-side-unknown wt-side-notice">
          {project.errors.length} repository paths could not be checked.
        </p>
      )}
    </div>
  );
}
