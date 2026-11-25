import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isAbsoluteProjectPath,
  normalizeProjectPathInput,
} from "@omnyo/domain";
import type { HostDirectoryListing } from "@omnyo/server-contract";
import { Button } from "@omnyo/shared-ui/button";
import { DelayedLoading } from "@omnyo/shared-ui/delayed-loading";
import { EmptyState } from "@omnyo/shared-ui/empty-state";
import { Icon, type BuiltinIconName } from "@omnyo/shared-ui/icon";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { Input } from "@omnyo/shared-ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { invalidateHostDirectoryListing } from "@/hooks/cache-owners/host-directory-cache-owner";
import { hostDirectoryQueryOptions } from "@/hooks/queries/host-queries";
import { hostDirectoryQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";

interface Crumb {
  label: string;
  path: string;
}

export function toBreadcrumb(directory: string): Crumb[] {
  const isWindows = /^[A-Za-z]:/.test(directory);

  if (!isWindows) {
    const crumbs: Crumb[] = [{ label: "/", path: "/" }];
    let accumulated = "";

    for (const segment of directory.split("/").filter(Boolean)) {
      accumulated = `${accumulated}/${segment}`;
      crumbs.push({ label: segment, path: accumulated });
    }

    return crumbs;
  }

  const segments = directory.replace(/\//g, "\\").split("\\").filter(Boolean);
  const drive = segments[0] ?? "";
  const crumbs: Crumb[] = [{ label: drive, path: `${drive}\\` }];
  let accumulated = drive;

  for (const segment of segments.slice(1)) {
    accumulated = `${accumulated}\\${segment}`;
    crumbs.push({ label: segment, path: accumulated });
  }

  return crumbs;
}

export function joinHostPath(directory: string, name: string): string {
  if (/^[A-Za-z]:/.test(directory)) {
    return `${directory.replace(/[\\/]+$/, "")}\\${name}`;
  }

  return `${directory.replace(/\/+$/, "")}/${name}`;
}

export function getFolderNameValidationMessage(name: string): string | null {
  if (!name) return "Enter a folder name.";

  if (name === "." || name === "..") return "Enter a folder name.";

  if (/[\\/]/.test(name)) return "Folder names can't contain slashes.";

  return null;
}

const ENTRY_HEIGHT = 36;

const NO_ENTRIES: HostDirectoryListing["entries"] = [];

type FolderSelection = { kind: "current" } | { kind: "entry"; path: string };

type FolderEditor = {
  kind: "path" | "folder";
  value: string;
  error: string | null;
};

interface RemotePathBrowserProps {
  hostId: string;
  initialPath?: string | null;
  allowCreateFolder: boolean;
  selectInitialFolder?: boolean;
  onDirectoryChange: (directory: string | null) => void;
  disabled?: boolean;
}

export function RemotePathBrowser({
  hostId,
  initialPath = null,
  allowCreateFolder,
  selectInitialFolder = true,
  onDirectoryChange,
  disabled = false,
}: RemotePathBrowserProps) {
  const keyboardHelpId = useId();
  const [locations, setLocations] = useState([initialPath]);
  const currentPath = locations.at(-1) ?? null;

  const [selection, setSelection] = useState<FolderSelection | null>(
    selectInitialFolder ? { kind: "current" } : null,
  );

  const [filter, setFilter] = useState("");
  const [editor, setEditor] = useState<FolderEditor | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const breadcrumbRef = useRef<HTMLElement>(null);
  const pathButtonRef = useRef<HTMLButtonElement>(null);
  const newFolderButtonRef = useRef<HTMLButtonElement>(null);
  const isPointerCoarse = usePointerCoarse();
  const queryClient = useQueryClient();

  const { data, isError, error, refetch } = useQuery(
    hostDirectoryQueryOptions(hostId, currentPath),
  );

  const listing = isError ? undefined : data;
  const directory = listing?.directory ?? null;
  const displayPath = directory ?? currentPath;
  const crumbs = displayPath ? toBreadcrumb(displayPath) : [];
  const entries = listing?.entries ?? NO_ENTRIES;

  const visibleEntries = useMemo(() => {
    const search = filter.trim().toLocaleLowerCase();

    return search
      ? entries.filter((entry) =>
          entry.name.toLocaleLowerCase().includes(search),
        )
      : entries;
  }, [entries, filter]);

  const selectedEntry = selection?.kind === "entry" ? selection.path : null;

  const usableSelection =
    directory && !editor
      ? selection?.kind === "current"
        ? directory
        : selectedEntry
      : null;

  const getScrollElement = useCallback(() => scrollRef.current, []);

  const getEntryKey = useCallback(
    (index: number) => visibleEntries[index]?.path ?? index,
    [visibleEntries],
  );

  const virtualizer = useVirtualizer({
    count: visibleEntries.length,
    getScrollElement,
    estimateSize: () => ENTRY_HEIGHT,
    getItemKey: getEntryKey,
    overscan: 10,
  });

  useLayoutEffect(() => {
    onDirectoryChange(usableSelection);
  }, [usableSelection, onDirectoryChange]);

  useEffect(() => {
    const breadcrumb = breadcrumbRef.current;

    if (breadcrumb) breadcrumb.scrollLeft = breadcrumb.scrollWidth;
  }, [displayPath]);

  const resetLocation = (selectFolder: boolean) => {
    virtualizer.scrollToOffset(0);
    setSelection(selectFolder ? { kind: "current" } : null);
    setFilter("");
    setEditor(null);
  };

  const navigateTo = (
    path: string | null,
    selectFolder = selectInitialFolder,
  ) => {
    const home = queryClient.getQueryData<HostDirectoryListing>(
      hostDirectoryQueryKey(hostId, null),
    );

    const location = path === home?.directory ? null : path;

    resetLocation(selectFolder);

    if (location !== currentPath) {
      setLocations((history) => [...history, location]);
    }
  };

  const openFolder = (path: string) => {
    scrollRef.current?.focus({ preventScroll: true });
    navigateTo(path, true);
  };

  const createFolder = useMutation({
    mutationFn: async ({ parent, name }: { parent: string; name: string }) => {
      const path = joinHostPath(parent, name);
      await sdk.files.mkdir({ hostId, path });

      return path;
    },
    onSuccess: async (path, { parent }) => {
      openFolder(path);
      await Promise.all(
        [...new Set([parent, currentPath])].map((directory) =>
          invalidateHostDirectoryListing({ queryClient, hostId, directory }),
        ),
      );
    },
    onError: (mutationError) => {
      const error = getMutationErrorMessage({
        error: mutationError,
        fallbackMessage: "Couldn't create that folder.",
      });

      setEditor((draft) =>
        draft?.kind === "folder" ? { ...draft, error } : draft,
      );
    },
  });

  const interactionDisabled = disabled || createFolder.isPending;
  const canUseListing = directory !== null && !interactionDisabled;

  const submitEditor = () => {
    if (!editor || interactionDisabled) return;

    if (editor.kind === "path") {
      const path = normalizeProjectPathInput(editor.value);

      if (isAbsoluteProjectPath(path)) openFolder(path);
      else setEditor({ ...editor, error: "Enter an absolute folder path." });

      return;
    }

    if (!directory) return;

    const name = editor.value.trim();
    const error = getFolderNameValidationMessage(name);
    setEditor({ ...editor, error });

    if (!error) createFolder.mutate({ parent: directory, name });
  };

  const closeEditor = () => {
    const trigger =
      editor?.kind === "path" ? pathButtonRef : newFolderButtonRef;

    setEditor(null);
    requestAnimationFrame(() => trigger.current?.focus());
  };

  const handleListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canUseListing || event.altKey || event.metaKey || event.ctrlKey)
      return;

    if (
      event.key === "Enter" &&
      event.target === event.currentTarget &&
      selectedEntry
    ) {
      event.preventDefault();
      openFolder(selectedEntry);

      return;
    }

    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

    event.preventDefault();

    const index = visibleEntries.findIndex(
      (entry) => entry.path === selectedEntry,
    );

    const direction = event.key === "ArrowDown" ? 1 : -1;

    let next =
      index < 0 && direction < 0
        ? visibleEntries.length - 1
        : index + direction;

    while (next >= 0 && next < visibleEntries.length) {
      const entry = visibleEntries[next];

      if (entry?.kind === "directory") {
        setSelection({ kind: "entry", path: entry.path });
        virtualizer.scrollToIndex(next);
        scrollRef.current?.focus({ preventScroll: true });

        return;
      }

      next += direction;
    }
  };

  let body: ReactNode;

  if (isError) {
    body = (
      <div className="flex flex-col items-center gap-1 px-3 py-5">
        <EmptyState
          icon="AlertCircle"
          message={getMutationErrorMessage({
            error,
            fallbackMessage: "Couldn't read this folder.",
          })}
          messageClassName="break-words text-destructive"
          className="min-w-0 p-0"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => void refetch()}
        >
          Try again
        </Button>
      </div>
    );
  } else if (!listing) {
    body = (
      <DelayedLoading>
        <EmptyState
          icon="Spinner"
          iconClassName="animate-spin"
          message="Opening folder…"
          className="px-3 py-6"
        />
      </DelayedLoading>
    );
  } else if (visibleEntries.length === 0) {
    body = (
      <EmptyState
        icon={filter.trim() ? "Search" : "FolderOpen"}
        message={filter.trim() ? "No matching items." : "This folder is empty."}
        className="px-3 py-6"
      />
    );
  } else {
    body = (
      <ul
        aria-label="Contents"
        className="relative"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map(({ index, start }) => {
          const entry = visibleEntries[index];

          if (!entry) return null;

          const isFolder = entry.kind === "directory";
          const selected = isFolder && entry.path === selectedEntry;

          return (
            <li
              key={entry.path}
              className={cn(
                "absolute left-0 flex h-9 w-full min-w-0 items-center rounded-md",
                isFolder && "hover:bg-muted",
                selected && "bg-state-active hover:bg-state-active",
              )}
              style={{ top: start }}
            >
              {isFolder ? (
                <>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-pressed={selected}
                    disabled={interactionDisabled}
                    className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-md px-2.5 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => {
                      setSelection({ kind: "entry", path: entry.path });
                      void queryClient.prefetchQuery(
                        hostDirectoryQueryOptions(hostId, entry.path),
                      );
                    }}
                    onDoubleClick={() => openFolder(entry.path)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      openFolder(entry.path);
                    }}
                  >
                    <Icon
                      name={selected ? "FolderOpen" : "Folder"}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate" title={entry.name}>
                      {entry.name}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    tabIndex={-1}
                    className="mr-0.5 size-8 shrink-0 text-muted-foreground"
                    aria-label={`Open ${entry.name}`}
                    disabled={interactionDisabled}
                    onClick={() => openFolder(entry.path)}
                  >
                    <Icon name="ChevronRight" />
                  </Button>
                </>
              ) : (
                <div className="flex min-w-0 items-center gap-2.5 px-2.5 text-sm text-subtle-foreground">
                  <Icon name="File" className="size-4 shrink-0" />
                  <span className="truncate" title={entry.name}>
                    {entry.name}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border">
      <div className="space-y-2 border-b bg-muted/30 p-2">
        <div className="flex min-w-0 items-center gap-1">
          <TooltipProvider>
            {(
              [
                {
                  label: "Go back",
                  icon: "ArrowLeft",
                  disabled: locations.length < 2,
                  run: () => {
                    resetLocation(selectInitialFolder);
                    setLocations((history) => history.slice(0, -1));
                  },
                },
                {
                  label: "Go to parent folder",
                  icon: "ArrowUp",
                  disabled: !listing?.parent,
                  run: () => {
                    if (listing?.parent) navigateTo(listing.parent);
                  },
                },
                {
                  label: "Go to home folder",
                  icon: "Home",
                  disabled: currentPath === null,
                  run: () => navigateTo(null),
                },
              ] satisfies {
                label: string;
                icon: BuiltinIconName;
                disabled: boolean;
                run: () => void;
              }[]
            ).map(({ label, icon, disabled, run }) => (
              <Tooltip key={label}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={label}
                    disabled={interactionDisabled || disabled}
                    onClick={run}
                  >
                    <Icon name={icon} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}
          </TooltipProvider>
          <nav
            ref={breadcrumbRef}
            aria-label="Folder path"
            className="flex h-8 min-w-0 flex-1 items-center overflow-x-auto rounded-md border bg-background px-1 whitespace-nowrap text-xs text-muted-foreground [scrollbar-width:none]"
          >
            {crumbs.length === 0 ? <span className="px-1.5">Home</span> : null}
            {crumbs.map((crumb, index) => {
              const current = index === crumbs.length - 1;

              return (
                <span key={crumb.path} className="flex shrink-0 items-center">
                  {index > 0 ? (
                    <Icon name="ChevronRight" className="size-3 opacity-50" />
                  ) : null}
                  {current ? (
                    <span
                      aria-current="location"
                      title={crumb.path}
                      className="max-w-40 truncate px-1.5 font-medium text-foreground"
                    >
                      {crumb.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={interactionDisabled}
                      title={crumb.path}
                      className={cn(
                        "max-w-32 truncate rounded px-1.5 py-0.5 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                        LIST_HOVER_TRANSITION,
                      )}
                      onClick={() => navigateTo(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="relative min-w-28 flex-1">
            <Icon
              name="Search"
              className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground"
            />
            <Input
              aria-label="Filter folder contents"
              className="h-8 bg-background pl-8"
              placeholder="Filter this folder"
              value={filter}
              disabled={!canUseListing}
              onChange={(event) => {
                setFilter(event.target.value);

                if (selection?.kind === "entry") setSelection(null);
                virtualizer.scrollToOffset(0);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                scrollRef.current?.focus({ preventScroll: true });
              }}
            />
          </div>
          {allowCreateFolder ? (
            <Button
              ref={newFolderButtonRef}
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              disabled={!canUseListing || editor?.kind === "folder"}
              onClick={() =>
                setEditor({ kind: "folder", value: "", error: null })
              }
            >
              <Icon name="FolderPlus" />
              New folder
            </Button>
          ) : null}
          <Button
            ref={pathButtonRef}
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            disabled={interactionDisabled || editor?.kind === "path"}
            onClick={() =>
              setEditor({ kind: "path", value: displayPath ?? "", error: null })
            }
          >
            Go to path
          </Button>
        </div>
        {editor ? (
          <div
            className="space-y-1"
            data-folder-picker-editor
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();

              if (!interactionDisabled) closeEditor();
            }}
          >
            <div className="flex items-center gap-1.5">
              <Input
                key={editor.kind}
                autoFocus={!isPointerCoarse}
                aria-label={
                  editor.kind === "folder" ? "New folder name" : "Project path"
                }
                aria-invalid={!!editor.error}
                spellCheck={false}
                className="h-8 min-w-0 flex-1 bg-background"
                value={editor.value}
                placeholder={
                  editor.kind === "folder"
                    ? "Folder name"
                    : "Enter a folder path"
                }
                disabled={interactionDisabled}
                onFocus={(event) => {
                  if (editor.kind === "path") event.currentTarget.select();
                }}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    value: event.target.value,
                    error: null,
                  })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitEditor();
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                disabled={interactionDisabled}
                onClick={submitEditor}
              >
                {editor.kind === "folder" ? "Create folder" : "Go"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label={
                  editor.kind === "folder"
                    ? "Cancel new folder"
                    : "Cancel go to path"
                }
                disabled={interactionDisabled}
                onClick={closeEditor}
              >
                <Icon name="X" />
              </Button>
            </div>
            {editor.error ? (
              <p role="alert" className="text-xs text-destructive">
                {editor.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <span id={keyboardHelpId} className="sr-only">
        Use the arrow keys to select a folder and Enter to open it.
      </span>
      <div
        ref={scrollRef}
        role="region"
        aria-label="Folder contents"
        aria-describedby={keyboardHelpId}
        aria-busy={!listing && !isError}
        tabIndex={0}
        onKeyDown={handleListKey}
        className="h-[clamp(10rem,36dvh,20rem)] min-h-0 overflow-y-auto overscroll-contain p-1.5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {body}
      </div>
      <div className="flex min-w-0 items-center justify-end border-t bg-muted/30 px-2 py-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8"
          aria-pressed={!!directory && usableSelection === directory}
          disabled={!canUseListing || editor !== null}
          onClick={() => setSelection({ kind: "current" })}
        >
          Select this folder
        </Button>
      </div>
    </div>
  );
}
