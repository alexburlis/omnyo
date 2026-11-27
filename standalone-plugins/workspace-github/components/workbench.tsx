import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { experimental_copyToClipboard, experimental_useAppNavigate } from "@omnyo/plugin-sdk/app";
import { toast } from "sonner";
import { buildSuggestions, type Item, type Suggestion } from "../app-logic.js";
import {
  absoluteTime,
  errorText,
  relativeTime,
  useIssueMutations,
  useSpawn,
  type LinksMap,
  type ThreadLink,
} from "../data.js";
import {
  importantLabel,
  itemKey,
  repoName,
  type TriageSection,
  type TriagedItem,
} from "../launchpad.js";
import {
  CLOSED_ISSUE_PAGE,
  CLOSED_PR_PAGE,
  ISSUE_PAGE,
  PR_PAGE,
  SYNC_INTERVAL_MINUTES,
} from "../limits.js";
import { cn } from "../lib/utils.js";
import {
  Age,
  Avatar,
  ChecksGlyph,
  DiffBar,
  itemIsDraft,
  Kbd,
  LabelPill,
  laneClass,
  RepoTag,
  StateGlyph,
} from "./glyphs.js";
import { StateChangeDialog } from "./item-actions.js";
import { Button } from "./ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Icon } from "./ui/icon.js";

export const workViews = [
  { id: "launchpad", label: "Launchpad", icon: "Layers" },
  { id: "closed", label: "Recently closed", icon: "Archive" },
] as const satisfies readonly { id: string; label: string; icon: string }[];

export type WorkViewId = (typeof workViews)[number]["id"];

export type WorkType = "all" | "pr" | "issue";

export interface SavedView {
  id: string;
  name: string;
  view: WorkViewId;
  type: WorkType;
  query: string;
  scope: string[];
}

export function inView(view: WorkViewId, entry: TriagedItem): boolean {
  return view === "closed" ? entry.triage.group === "closed" : entry.triage.group !== "closed";
}

function RailButton({
  icon,
  label,
  count,
  selected,
  onSelect,
  children,
}: {
  icon: string;
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="group/rail relative">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "grid h-7 w-full grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          selected ? "bg-state-active text-foreground" : "text-foreground/90 hover:bg-state-hover",
        )}
      >
        <Icon
          name={icon}
          aria-hidden="true"
          className={cn("size-3.5", selected ? "text-foreground" : "text-subtle-foreground")}
        />
        <span className="min-w-0 truncate">{label}</span>
        <span className="text-xs tabular-nums text-subtle-foreground">{count}</span>
      </button>
      {children}
    </div>
  );
}

export function RailViews({
  view,
  counts,
  savedViews,
  savedCounts,
  activeSaved,
  canSave,
  onSelect,
  onApplySaved,
  onSave,
  onDeleteSaved,
}: {
  view: WorkViewId;
  counts: Map<WorkViewId, number>;
  savedViews: SavedView[];
  savedCounts: Map<string, number>;
  activeSaved: string | null;
  canSave: boolean;
  onSelect: (view: WorkViewId) => void;
  onApplySaved: (saved: SavedView) => void;
  onSave: (name: string) => void;
  onDeleteSaved: (id: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const submit = () => {
    const trimmed = name.trim();

    if (trimmed.length === 0) return;
    onSave(trimmed);
    setName("");
    setNaming(false);
  };

  return (
    <nav aria-label="Views" className="flex flex-col gap-px px-1.5">
      {workViews.map((entry) => (
        <RailButton
          key={entry.id}
          icon={entry.icon}
          label={entry.label}
          count={counts.get(entry.id) ?? 0}
          selected={activeSaved === null && entry.id === view}
          onSelect={() => onSelect(entry.id)}
        />
      ))}
      {savedViews.length > 0 ? (
        <h3 className="flex h-7 items-center px-2.5 pt-2 text-2xs font-semibold uppercase tracking-wider text-subtle-foreground">
          Saved views
        </h3>
      ) : null}
      {savedViews.map((saved) => (
        <RailButton
          key={saved.id}
          icon="Star"
          label={saved.name}
          count={savedCounts.get(saved.id) ?? 0}
          selected={activeSaved === saved.id}
          onSelect={() => onApplySaved(saved)}
        >
          <button
            type="button"
            aria-label={`Delete saved view ${saved.name}`}
            onClick={() => onDeleteSaved(saved.id)}
            className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded bg-sidebar text-subtle-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/rail:opacity-100"
          >
            <Icon name="X" aria-hidden="true" className="size-3" />
          </button>
        </RailButton>
      ))}
      {naming ? (
        <form
          className="px-1 pt-1"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            autoFocus
            aria-label="Saved view name"
            placeholder="Name this view"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setNaming(false);
              }
            }}
            onBlur={() => {
              if (name.trim().length === 0) setNaming(false);
            }}
            className="h-7 w-full rounded-md border border-border bg-surface-recessed px-2 text-xs text-foreground placeholder:text-subtle-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </form>
      ) : canSave && activeSaved === null ? (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="flex h-7 items-center gap-2 rounded-md px-2.5 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="Plus" aria-hidden="true" className="size-3.5" />
          Save this view
        </button>
      ) : null}
    </nav>
  );
}

export function RailRepositories({
  repos,
  selected,
  quietCount,
  onToggle,
  onClear,
}: {
  repos: { repo: string; count: number }[];
  selected: string[];
  quietCount: number;
  onToggle: (repo: string) => void;
  onClear: () => void;
}) {
  const [showQuiet, setShowQuiet] = useState(false);
  const visible = showQuiet ? repos : repos.filter((entry) => entry.count > 0);
  const hidden = repos.length - visible.length;

  return (
    <section aria-label="Repositories" className="flex min-h-0 flex-col">
      <div className="flex h-7 items-center justify-between px-4">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-subtle-foreground">
          Repositories
        </h2>
        {selected.length > 0 ? (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={onClear}
          >
            Clear
          </button>
        ) : (
          <span className="text-xs text-subtle-foreground">
            {repos.reduce((total, entry) => total + entry.count, 0)} open
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-px px-1.5">
        {visible.map(({ repo, count }) => {
          const active = selected.includes(repo.toLowerCase());

          return (
            <li key={repo}>
              <button
                type="button"
                aria-pressed={active}
                title={repo}
                onClick={() => onToggle(repo)}
                className={cn(
                  "grid h-6 w-full grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2.5 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  laneClass(repo),
                  active
                    ? "bg-state-active text-foreground"
                    : "text-foreground/90 hover:bg-state-hover",
                )}
              >
                <span className="wgh-lane-dot justify-self-center" aria-hidden="true" />
                <span className="min-w-0 truncate">{repoName(repo)}</span>
                <span className="tabular-nums text-subtle-foreground">{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {hidden > 0 || (showQuiet && quietCount > 0) ? (
        <button
          type="button"
          className="mx-1.5 h-6 rounded-md pl-8 text-left text-xs text-subtle-foreground hover:text-foreground"
          onClick={() => setShowQuiet((value) => !value)}
        >
          {showQuiet ? "Hide quiet repositories" : `+${hidden} with nothing open`}
        </button>
      ) : null}
    </section>
  );
}

function SuggestionIcon({ suggestion }: { suggestion: Suggestion }) {
  if (suggestion.icon === undefined) return null;

  if (suggestion.icon.kind === "state") {
    return (
      <StateGlyph
        kind={suggestion.icon.itemKind}
        state={suggestion.icon.state}
        className="size-3.5"
      />
    );
  }

  return <Avatar login={suggestion.icon.login} />;
}

export function SearchField({
  value,
  onChange,
  vocab,
  viewer,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  vocab: { users: string[]; labels: string[]; repos: string[] };
  viewer: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [highlight, setHighlight] = useState(0);
  const upToCaret = value.slice(0, caret);
  const tokenStart = upToCaret.lastIndexOf(" ") + 1;
  const token = upToCaret.slice(tokenStart);

  const suggestions = useMemo(
    () => (token.length === 0 ? [] : buildSuggestions(token, vocab, viewer).slice(0, 8)),
    [token, vocab, viewer],
  );

  const active = Math.min(highlight, Math.max(0, suggestions.length - 1));
  const showing = open && suggestions.length > 0;

  const accept = (suggestion: Suggestion) => {
    const next = value.slice(0, tokenStart) + suggestion.insert + value.slice(caret);
    onChange(next);
    const position = tokenStart + suggestion.insert.length;
    setCaret(position);
    setHighlight(0);
    setOpen(false);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });
  };

  return (
    <div className="relative order-last min-w-0 flex-1 basis-full @[40rem]/wgh-list:order-none @[40rem]/wgh-list:basis-0">
      <div className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-recessed pl-2 pr-1 focus-within:ring-1 focus-within:ring-ring">
        <Icon
          name="Search"
          aria-hidden="true"
          className="size-3.5 shrink-0 text-subtle-foreground"
        />
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Filter work"
          aria-autocomplete="list"
          aria-expanded={showing}
          aria-controls={showing ? listId : undefined}
          aria-activedescendant={showing ? `${listId}-${active}` : undefined}
          value={value}
          placeholder="Filter by title, #number, repo:, author:, label:"
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-subtle-foreground focus:outline-none"
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setHighlight(0);
            setCaret(event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={() => setCaret(inputRef.current?.selectionStart ?? value.length)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              if (value.length > 0 && !showing) onChange("");
              setOpen(false);
              event.currentTarget.blur();

              return;
            }

            if (!showing) return;

            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight((active + 1) % suggestions.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight((active - 1 + suggestions.length) % suggestions.length);
            } else if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              accept(suggestions[active]);
            }
          }}
        />
        {value.length > 0 ? (
          <button
            type="button"
            className="grid size-5 shrink-0 place-items-center rounded text-subtle-foreground hover:bg-state-hover hover:text-foreground"
            aria-label="Clear filter"
            onClick={() => {
              onChange("");
              setCaret(0);
              inputRef.current?.focus();
            }}
          >
            <Icon name="X" aria-hidden="true" className="size-3" />
          </button>
        ) : (
          <Kbd>/</Kbd>
        )}
      </div>
      {showing ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Filter suggestions"
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {suggestions.map((suggestion, index) => (
            <div
              key={suggestion.insert}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={cn(
                "flex min-h-8 cursor-pointer items-center gap-2 px-2.5 text-xs",
                index === active ? "bg-accent text-accent-foreground" : "text-popover-foreground",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(suggestion)}
              onMouseEnter={() => setHighlight(index)}
            >
              <SuggestionIcon suggestion={suggestion} />
              <span className="min-w-0 truncate font-medium">{suggestion.label}</span>
              {suggestion.hint === undefined ? null : (
                <span className="ml-auto shrink-0 pl-4 text-subtle-foreground">
                  {suggestion.hint}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TypeSegments({
  value,
  counts,
  onChange,
}: {
  value: WorkType;
  counts: Record<WorkType, number>;
  onChange: (value: WorkType) => void;
}) {
  const options: { id: WorkType; label: string }[] = [
    { id: "all", label: "All" },
    { id: "pr", label: "PRs" },
    { id: "issue", label: "Issues" },
  ];

  return (
    <div
      role="group"
      aria-label="Item type"
      className="flex h-7 shrink-0 items-center gap-px rounded-md border border-border bg-surface-recessed p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
          className={cn(
            "flex h-full items-center gap-1.5 rounded px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            option.id === value
              ? "bg-state-active text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
          <span className="tabular-nums text-subtle-foreground">{counts[option.id]}</span>
        </button>
      ))}
    </div>
  );
}

const GROUP_TONE: Record<TriageSection["tone"], { icon: string; count: string }> = {
  ready: {
    icon: "text-success-foreground dark:text-success",
    count: "text-success-foreground dark:text-success",
  },
  blocked: { icon: "text-destructive-text", count: "text-destructive-text" },
  attention: { icon: "text-warning-text", count: "text-warning-text" },
  none: { icon: "text-subtle-foreground", count: "text-muted-foreground" },
};

const GROUP_PREVIEW = 8;

function groupSubtitle(section: TriageSection): string | null {
  const reasons = new Set(section.rows.map((row) => row.triage.reason.toLowerCase()));

  if (section.id === "ready") {
    return section.rows.some((row) => importantLabel(row.item.labels) === "security")
      ? "security first"
      : null;
  }

  if (section.id === "issues") return "opened by you";

  if (section.id === "unknown") return "GitHub has not computed mergeability yet";

  if (section.id === "closed") return null;

  return reasons.size > 0 ? [...reasons].slice(0, 2).join(" · ") : null;
}

export function WorkList({
  sections,
  activeKey,
  collapsed,
  links,
  viewer,
  emptyState,
  heading,
  onMergeAll,
  onToggleGroup,
  onSelect,
  onOpen,
  listRef,
}: {
  sections: TriageSection[];
  activeKey: string | null;
  collapsed: string[];
  links: LinksMap;
  viewer: string | null;
  emptyState: React.ReactNode;
  heading: string;
  onMergeAll?: (pulls: Item[]) => void;
  onToggleGroup: (id: string) => void;
  onSelect: (item: Item) => void;
  onOpen: (item: Item) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const headingId = useId();

  const visibleRows = useMemo(
    () =>
      sections.flatMap((section) => {
        if (collapsed.includes(section.id)) return [];

        const showAll =
          expanded.includes(section.id) ||
          section.rows.length <= GROUP_PREVIEW + 2 ||
          section.rows.findIndex((row) => itemKey(row.item) === activeKey) >= GROUP_PREVIEW;

        return showAll ? section.rows : section.rows.slice(0, GROUP_PREVIEW);
      }),
    [sections, collapsed, expanded, activeKey],
  );

  const focusRow = useCallback(
    (key: string) => {
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector<HTMLButtonElement>(`[data-row-key="${CSS.escape(key)}"]`)
          ?.focus({ preventScroll: false });
      });
    },
    [listRef],
  );

  const move = (direction: 1 | -1) => {
    if (visibleRows.length === 0) return;
    const index = visibleRows.findIndex((row) => itemKey(row.item) === activeKey);

    const next =
      index === -1
        ? direction === 1
          ? 0
          : visibleRows.length - 1
        : Math.min(visibleRows.length - 1, Math.max(0, index + direction));

    const target = visibleRows[next];

    if (target === undefined) return;
    onSelect(target.item);
    focusRow(itemKey(target.item));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target)
    )
      return;

    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      return;

    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      move(-1);
    }
  };

  if (sections.length === 0) {
    return (
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto"
        role="region"
        aria-labelledby={headingId}
      >
        <h2 id={headingId} className="sr-only">
          {heading}
        </h2>
        {emptyState}
      </div>
    );
  }

  const tabbableKey =
    activeKey !== null && visibleRows.some((row) => itemKey(row.item) === activeKey)
      ? activeKey
      : visibleRows[0] === undefined
        ? null
        : itemKey(visibleRows[0].item);

  return (
    <div
      ref={listRef}
      className="min-h-0 flex-1 overflow-y-auto pb-2"
      onKeyDown={onKeyDown}
      aria-labelledby={headingId}
      role="region"
    >
      <h2 id={headingId} className="sr-only">
        {heading}
      </h2>
      {sections.map((section, index) => {
        const isCollapsed = collapsed.includes(section.id);
        const tone = GROUP_TONE[section.tone];
        const subtitle = groupSubtitle(section);

        const showAll =
          expanded.includes(section.id) ||
          section.rows.length <= GROUP_PREVIEW + 2 ||
          section.rows.findIndex((row) => itemKey(row.item) === activeKey) >= GROUP_PREVIEW;

        const rows = showAll ? section.rows : section.rows.slice(0, GROUP_PREVIEW);
        const groupHeadingId = `wgh-group-${section.id}`;

        return (
          <section
            key={section.id}
            aria-labelledby={groupHeadingId}
            className={cn(index > 0 && "border-t border-border-seam")}
          >
            <h3
              id={groupHeadingId}
              className="sticky top-0 z-10 flex items-center bg-background pr-3"
            >
              <button
                type="button"
                aria-expanded={!isCollapsed}
                onClick={() => onToggleGroup(section.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" && !isCollapsed) {
                    event.preventDefault();
                    onToggleGroup(section.id);
                  } else if (event.key === "ArrowRight" && isCollapsed) {
                    event.preventDefault();
                    onToggleGroup(section.id);
                  }
                }}
                className="flex h-7 min-w-0 flex-1 items-center gap-2 pl-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Icon
                  name="ChevronDown"
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0 text-subtle-foreground transition-transform duration-(--motion-duration-base) ease-(--motion-ease-smooth) motion-reduce:transition-none",
                    isCollapsed && "-rotate-90",
                  )}
                />
                <Icon
                  name={section.icon}
                  aria-hidden="true"
                  className={cn("size-3.5 shrink-0", tone.icon)}
                />
                <span className="shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </span>
                <span className={cn("shrink-0 text-xs font-medium tabular-nums", tone.count)}>
                  {section.rows.length}
                </span>
                {subtitle === null ? null : (
                  <span className="min-w-0 truncate text-xs text-subtle-foreground">
                    {subtitle}
                  </span>
                )}
              </button>
              {section.id === "ready" && onMergeAll !== undefined && section.rows.length > 1 ? (
                <button
                  type="button"
                  onClick={() => onMergeAll(section.rows.map((row) => row.item))}
                  className="flex h-5 shrink-0 items-center gap-1.5 rounded px-2 text-xs font-medium text-success-foreground hover:bg-success/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-success"
                >
                  <Icon name="GitMerge" aria-hidden="true" className="size-3.5" />
                  Merge all {section.rows.length}…
                </button>
              ) : null}
            </h3>
            {isCollapsed ? null : (
              <ul>
                {rows.map((row) => (
                  <WorkRow
                    key={itemKey(row.item)}
                    entry={row}
                    active={itemKey(row.item) === activeKey}
                    tabbable={itemKey(row.item) === tabbableKey}
                    links={links[itemKey(row.item)]}
                    viewer={viewer}
                    onSelect={() => onSelect(row.item)}
                    onOpen={() => onOpen(row.item)}
                  />
                ))}
                {showAll ? null : (
                  <li>
                    <button
                      type="button"
                      className="flex h-7 w-full items-center gap-1.5 pl-9 text-left text-xs text-subtle-foreground hover:text-foreground"
                      onClick={() => {
                        setExpanded((previous) => [...previous, section.id]);
                        const revealed = section.rows[GROUP_PREVIEW];

                        if (revealed !== undefined) focusRow(itemKey(revealed.item));
                      }}
                    >
                      <Icon name="ChevronDown" aria-hidden="true" className="size-3" />
                      {section.rows.length - GROUP_PREVIEW} more {section.label.toLowerCase()}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function WorkRow({
  entry,
  active,
  tabbable,
  links,
  viewer,
  onSelect,
  onOpen,
}: {
  entry: TriagedItem;
  active: boolean;
  tabbable: boolean;
  links: ThreadLink[] | undefined;
  viewer: string | null;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { item, triage } = entry;
  const navigate = experimental_useAppNavigate();
  const { spawn, spawningKey } = useSpawn();
  const open = item.state === "OPEN";
  const pill = importantLabel(item.labels);
  const key = itemKey(item);
  const busy = spawningKey === key;
  const showReason = triage.group === "blocked" || triage.group === "follow-up";
  const agentLabel = item.kind === "pr" ? "Review" : "Work on";

  return (
    <li
      className="wgh-row grid h-8 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 pl-4 pr-3"
      data-selected={active}
    >
      <StateGlyph kind={item.kind} state={item.state} draft={itemIsDraft(item)} />
      <button
        type="button"
        data-row-key={key}
        tabIndex={tabbable ? 0 : -1}
        aria-current={active ? "true" : undefined}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onOpen();
          } else if (event.key === "o" && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            navigate.openUrl(item.url);
          }
        }}
        className="flex h-8 min-w-0 items-center gap-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          className={cn(
            "min-w-0 truncate",
            active ? "font-medium text-foreground" : "text-foreground/90",
            item.state !== "OPEN" && "text-muted-foreground",
          )}
        >
          {item.title}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">#{item.number}</span>
        {pill === null ? null : <LabelPill label={pill} />}
        {showReason ? (
          <span className="hidden min-w-0 shrink truncate text-xs text-muted-foreground @[40rem]/wgh-list:inline">
            {triage.reason}
          </span>
        ) : null}
      </button>
      <span className="flex items-center gap-3">
        <RepoTag
          repo={item.repo}
          className="hidden w-24 @[24rem]/wgh-list:flex @[40rem]/wgh-list:w-32"
        />
        {item.kind === "pr" && open ? (
          <span className="hidden w-4 justify-center @[36rem]/wgh-list:flex">
            <ChecksGlyph checks={item.checks} />
          </span>
        ) : (
          <span className="hidden w-4 @[36rem]/wgh-list:block" />
        )}
        <span className="hidden w-12 @[44rem]/wgh-list:flex">
          {item.additions !== undefined && item.deletions !== undefined ? (
            <DiffBar additions={item.additions} deletions={item.deletions} />
          ) : null}
        </span>
        <Avatar login={item.author} className="hidden @[44rem]/wgh-list:block" />
        <Age iso={item.updatedAt} className="w-7 text-right" />
      </span>
      <div className="wgh-row-actions" onClick={(event) => event.stopPropagation()}>
        {links === undefined || links.length === 0 ? null : (
          <Button
            size="icon"
            variant="ghost"
            tabIndex={active ? 0 : -1}
            className="size-6 text-muted-foreground"
            aria-label={`Open agent chat for #${item.number}`}
            onClick={() => navigate.toThread(links[links.length - 1]!.threadId)}
          >
            <Icon name="Bot" aria-hidden="true" className="size-3.5" />
          </Button>
        )}
        {open ? (
          <Button
            size="icon"
            variant="ghost"
            tabIndex={active ? 0 : -1}
            disabled={spawningKey !== null}
            aria-busy={busy}
            className="size-6 text-muted-foreground"
            aria-label={`${agentLabel} ${item.repo}#${item.number} with agent`}
            onClick={() => spawn(item.kind, item.repo, item.number)}
          >
            <Icon name={busy ? "Spinner" : "Sparkles"} aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
        {triage.group === "ready" ? (
          <Button
            size="icon"
            variant="ghost"
            tabIndex={active ? 0 : -1}
            className="size-6 text-success-foreground dark:text-success"
            aria-label={`Merge #${item.number}…`}
            onClick={onOpen}
          >
            <Icon name="GitMerge" aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          tabIndex={active ? 0 : -1}
          className="size-6 text-muted-foreground"
          aria-label={`Open #${item.number} on GitHub`}
          onClick={() => navigate.openUrl(item.url)}
        >
          <Icon name="ExternalLink" aria-hidden="true" className="size-3.5" />
        </Button>
        <RowMenu item={item} links={links} tabbable={active} viewer={viewer} />
      </div>
    </li>
  );
}

function RowMenu({
  item,
  links,
  tabbable,
  viewer,
}: {
  item: Item;
  links: ThreadLink[] | undefined;
  tabbable: boolean;
  viewer: string | null;
}) {
  const navigate = experimental_useAppNavigate();
  const { setAssignees } = useIssueMutations();
  const [changingState, setChangingState] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            tabIndex={tabbable ? 0 : -1}
            className="size-6 text-muted-foreground"
            aria-label={`Actions for #${item.number}`}
          >
            <Icon name="MoreHorizontal" aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {item.kind === "issue" ? (
            <DropdownMenuItem onSelect={() => setChangingState(true)}>
              {item.state === "OPEN" ? "Close issue…" : "Reopen issue…"}
            </DropdownMenuItem>
          ) : null}
          {item.kind === "issue" && item.state === "OPEN" && viewer !== null ? (
            <ViewerAssignItem item={item} viewer={viewer} setAssignees={setAssignees} />
          ) : null}
          {links?.map((link, index) => (
            <DropdownMenuItem key={link.threadId} onSelect={() => navigate.toThread(link.threadId)}>
              Open agent chat{links.length > 1 ? ` ${index + 1}` : ""}
            </DropdownMenuItem>
          ))}
          {item.kind === "issue" || (links?.length ?? 0) > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => navigate.openUrl(item.url)}>
            Open on GitHub ↗
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void experimental_copyToClipboard({ text: item.url }).then((copied) => {
                if (copied) toast.success("Link copied");
                else toast.error("Could not copy the link");
              });
            }}
          >
            Copy link
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {item.kind === "issue" ? (
        <StateChangeDialog
          kind="issue"
          repo={item.repo}
          number={item.number}
          state={item.state}
          open={changingState}
          onOpenChange={setChangingState}
        />
      ) : null}
    </>
  );
}

function ViewerAssignItem({
  item,
  viewer,
  setAssignees,
}: {
  item: Item;
  viewer: string;
  setAssignees: ReturnType<typeof useIssueMutations>["setAssignees"];
}) {
  const assigned = item.assignees.includes(viewer);

  return (
    <DropdownMenuItem
      onSelect={() => {
        const next = assigned
          ? item.assignees.filter((login) => login !== viewer)
          : [...item.assignees, viewer];

        setAssignees(item.repo, item.number, next)
          .then(() =>
            toast.success(
              assigned ? `Unassigned from #${item.number}` : `Assigned to #${item.number}`,
            ),
          )
          .catch((error) => toast.error(errorText(error)));
      }}
    >
      {assigned ? "Unassign me" : "Assign to me"}
    </DropdownMenuItem>
  );
}

export const shortcuts = [
  { keys: ["j", "↓"], action: "Move to the next item" },
  { keys: ["k", "↑"], action: "Move to the previous item" },
  { keys: ["↵"], action: "Open the item in the inspector" },
  { keys: ["o"], action: "Open the item on GitHub" },
  { keys: ["←", "→"], action: "Collapse or expand a group header" },
  { keys: ["/"], action: "Focus the filter" },
  { keys: ["esc"], action: "Close the inspector or the filter" },
  { keys: ["?"], action: "Show these shortcuts" },
];

export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Work through the Launchpad without the mouse.</DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-1.5">
          {shortcuts.map((entry) => (
            <div key={entry.action} className="flex items-center justify-between gap-4 text-sm">
              <dt className="text-foreground">{entry.action}</dt>
              <dd className="flex shrink-0 gap-1">
                {entry.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

export function StatusBar({
  lastSyncedAt,
  incomplete,
  syncing,
  onSync,
  onShowShortcuts,
}: {
  lastSyncedAt: string | null;
  incomplete: boolean;
  syncing: boolean;
  onSync: () => void;
  onShowShortcuts: () => void;
}) {
  const next =
    lastSyncedAt === null
      ? null
      : new Date(Date.parse(lastSyncedAt) + SYNC_INTERVAL_MINUTES * 60_000).toISOString();

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-border-seam bg-sidebar px-3 text-xs text-subtle-foreground">
      <span className="hidden items-center gap-3 @[36rem]/wgh-list:flex">
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
          move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd>
          open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>o</Kbd>
          GitHub
        </span>
        <span className="flex items-center gap-1">
          <Kbd>/</Kbd>
          search
        </span>
      </span>
      <span className="ml-auto flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-5 items-center gap-1.5 rounded px-1.5 hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", incomplete ? "bg-warning" : "bg-success")}
              />
              {incomplete ? "Sync incomplete" : "Recent cache"}
              <Icon name="Info" aria-hidden="true" className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>What this list covers</DropdownMenuLabel>
            <div className="flex flex-col gap-1.5 px-2 pb-2 text-xs text-muted-foreground">
              <p>
                Per repository: up to {PR_PAGE} open and {CLOSED_PR_PAGE} recently closed pull
                requests, and up to {ISSUE_PAGE} open and {CLOSED_ISSUE_PAGE} closed issues you
                created.
              </p>
              <p>
                {lastSyncedAt === null
                  ? "Not synced yet."
                  : `Last synced ${relativeTime(lastSyncedAt)} (${absoluteTime(lastSyncedAt)}).`}{" "}
                Background sync runs every {SYNC_INTERVAL_MINUTES} minutes
                {next === null ? "." : `; next about ${absoluteTime(next)}.`}
              </p>
              {incomplete ? (
                <p className="text-warning-text">
                  Some repositories or machines did not sync, so counts may be missing items.
                </p>
              ) : null}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={syncing} onSelect={onSync}>
              <Icon name="ArrowReloadHorizontal" aria-hidden="true" className="size-3.5" />
              {syncing ? "Syncing…" : "Sync now"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label="Keyboard shortcuts"
          onClick={onShowShortcuts}
          className="grid h-5 place-items-center rounded px-1 hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Kbd>?</Kbd>
        </button>
      </span>
    </div>
  );
}

export function usePersistentState<Value>(
  key: string,
  parse: (raw: string) => Value,
  fallback: Value,
): [Value, (value: Value) => void] {
  const [value, setValue] = useState<Value>(() => {
    try {
      const raw = window.localStorage.getItem(key);

      return raw === null ? fallback : parse(raw);
    } catch {
      return fallback;
    }
  });

  const update = useCallback(
    (next: Value) => {
      setValue(next);

      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {}
    },
    [key],
  );

  return [value, update];
}

export function useSlashFocus(inputRef: React.RefObject<HTMLInputElement | null>) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = root.current;

    if (node === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;

      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      event.preventDefault();
      inputRef.current?.focus();
    };

    node.addEventListener("keydown", onKeyDown);

    return () => node.removeEventListener("keydown", onKeyDown);
  }, [inputRef]);

  return root;
}
