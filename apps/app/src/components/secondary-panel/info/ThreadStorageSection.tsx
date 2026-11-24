import { useMemo, useState } from "react";
import { COARSE_POINTER_TEXT_SM_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { EmptyState } from "@omnyo/shared-ui/empty-state";
import { Icon } from "@omnyo/shared-ui/icon";
import { Input } from "@omnyo/shared-ui/input";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import {
  describeLifecycleError,
  formatLifecycleErrorDescription,
} from "@/lib/lifecycle-errors";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { resolveRightPanelFileIconName } from "../rightPanelFileVisuals";
import type { ThreadStorageBrowserController } from "../useThreadStorageBrowser";
import {
  INFO_LIST_CARET_CLASS,
  infoListCollapses,
  InfoList,
  InfoListMoreRow,
  InfoListRow,
  InfoSection,
} from "./info-list";
import {
  buildThreadStorageTree,
  flattenThreadStorageNode,
  type ThreadStorageFlattenOptions,
  type ThreadStorageTreeRow,
} from "./thread-storage-tree";
import { useInfoSectionCollapse } from "./useInfoSectionCollapse";

const THREAD_STORAGE_FOLDER_CHILD_LIMIT = 5;

const SEARCH_FLATTEN_OPTIONS: ThreadStorageFlattenOptions = {
  isExpanded: () => true,
  showsAllChildren: () => true,
  childLimit: THREAD_STORAGE_FOLDER_CHILD_LIMIT,
};

function threadStorageRowKey(row: ThreadStorageTreeRow): string {
  return row.kind === "more" ? `${row.folderPath}/:more` : row.node.path;
}

export interface ThreadStorageSectionProps {
  controller: ThreadStorageBrowserController;
  filesError?: Error | null;
}

function describeStorageError(error: Error): string {
  const lifecycleErrorDescription = describeLifecycleError({
    error,
    operation: "load_thread_storage",
  });

  return (
    (lifecycleErrorDescription
      ? formatLifecycleErrorDescription(lifecycleErrorDescription)
      : null) ??
    getMutationErrorMessage({
      error,
      fallbackMessage: "Failed to load thread storage",
      lifecycleOperation: "load_thread_storage",
    })
  );
}

const STORAGE_SEARCH_BUTTON_CLASS = cn(
  CONTROL_PRESS_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  "flex size-5 shrink-0 items-center justify-center rounded text-subtle-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:pointer-coarse:-my-2 max-md:pointer-coarse:size-9",
);

export function ThreadStorageSection({
  controller,
  filesError,
}: ThreadStorageSectionProps) {
  const {
    expandedFolders,
    foldersShowingAll,
    lastSelectedPath,
    filteredFiles,
    loadedFiles,
    searchQuery,
    selectedPath,
    selectPath,
    setSearchQuery,
    showAllInFolder,
    toggleFolder,
  } = controller;

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const collapse = useInfoSectionCollapse("threadStorage");

  const tree = useMemo(
    () => buildThreadStorageTree(filteredFiles),
    [filteredFiles],
  );

  const isSearching = searchQuery.trim() !== "";

  const searchRows = useMemo(
    () =>
      isSearching
        ? tree.flatMap((node) =>
            flattenThreadStorageNode(node, SEARCH_FLATTEN_OPTIONS),
          )
        : [],
    [isSearching, tree],
  );

  const revealIndex =
    lastSelectedPath === null
      ? null
      : tree.findIndex(
          (node) =>
            node.path === lastSelectedPath ||
            lastSelectedPath.startsWith(`${node.path}/`),
        );

  if (loadedFiles.length === 0 && filesError == null) return null;

  const isFolderExpanded = (folderPath: string) =>
    isSearching || expandedFolders.has(folderPath);

  const flattenOptions: ThreadStorageFlattenOptions = {
    isExpanded: isFolderExpanded,
    showsAllChildren: (folderPath) => foldersShowingAll.has(folderPath),
    childLimit: THREAD_STORAGE_FOLDER_CHILD_LIMIT,
  };

  const renderRow = (row: ThreadStorageTreeRow) => {
    if (row.kind === "more") {
      return (
        <InfoListMoreRow
          key={`${row.folderPath}/:more`}
          label={`${row.hiddenCount} more`}
          expanded={false}
          depth={row.depth}
          onToggle={() => showAllInFolder(row.folderPath)}
        />
      );
    }

    const { node, depth } = row;

    if (node.kind === "folder") {
      const expanded = isFolderExpanded(node.path);

      return (
        <InfoListRow
          key={node.path}
          depth={depth}
          leading={
            <Icon
              name="ChevronRight"
              className={cn(
                INFO_LIST_CARET_CLASS,
                "text-subtle-foreground",
                expanded && "rotate-90",
              )}
              aria-hidden
            />
          }
          name={
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon
                name={expanded ? "FolderOpen" : "Folder"}
                className="size-3 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate text-foreground">{node.name}</span>
            </span>
          }
          title={node.path}
          expanded={expanded}
          target={
            isSearching
              ? null
              : {
                  kind: "button",
                  onSelect: () => toggleFolder(node.chainPaths),
                }
          }
        />
      );
    }

    return (
      <InfoListRow
        key={node.path}
        depth={depth}
        leading={
          <Icon
            name={resolveRightPanelFileIconName(node.path)}
            className="size-3 text-subtle-foreground"
            aria-hidden
          />
        }
        name={node.name}
        title={`Open ${node.path}`}
        selected={selectedPath === node.path}
        target={{ kind: "button", onSelect: () => selectPath(node.path) }}
        actions={[
          {
            icon: "ExternalLink",
            label: "Open file in tab",
            onSelect: () => selectPath(node.path),
          },
        ]}
      />
    );
  };

  const closeSearch = () => {
    setIsSearchOpen(false);
    setSearchQuery("");
  };

  const searchable = infoListCollapses(loadedFiles.length);

  return (
    <InfoSection
      label="Thread storage"
      count={filesError ? undefined : loadedFiles.length}
      collapse={collapse}
      trailing={
        !searchable ? null : isSearchOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Input
              autoFocus
              aria-label="Search files"
              placeholder="Search files"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onBlur={() => {
                if (searchQuery === "") setIsSearchOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeSearch();
                }
              }}
              className={cn(
                "h-5 min-w-0 flex-1 rounded border-input/50 px-1.5 py-0 focus-visible:ring-0 max-md:pointer-coarse:-my-2 max-md:pointer-coarse:h-9",
                COARSE_POINTER_TEXT_SM_CLASS,
              )}
            />
            <button
              type="button"
              aria-label="Close search"
              onClick={closeSearch}
              className={STORAGE_SEARCH_BUTTON_CLASS}
            >
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="Search files"
            onClick={() => setIsSearchOpen(true)}
            className={STORAGE_SEARCH_BUTTON_CLASS}
          >
            <Icon name="Search" className="size-3" aria-hidden />
          </button>
        )
      }
    >
      {filesError ? (
        <div
          role="alert"
          className="mt-1 flex items-start gap-2 rounded-md border border-surface-destructive-border bg-surface-destructive px-2.5 py-2"
        >
          <Icon
            name="AlertTriangle"
            className="mt-0.5 size-3.5 shrink-0 text-destructive-text"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-xs font-medium leading-5 text-destructive-text">
              Couldn’t list this chat’s files
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              {describeStorageError(filesError)}
            </p>
          </div>
        </div>
      ) : filteredFiles.length === 0 ? (
        <EmptyState
          icon="Search"
          message={`No files match “${searchQuery.trim()}”.`}
        />
      ) : isSearching ? (
        <InfoList
          items={searchRows}
          getKey={threadStorageRowKey}
          renderItem={renderRow}
        />
      ) : (
        <InfoList
          items={tree}
          getKey={(node) => node.path}
          revealIndex={revealIndex === -1 ? null : revealIndex}
          renderItem={(node) =>
            flattenThreadStorageNode(node, flattenOptions).map(renderRow)
          }
        />
      )}
    </InfoSection>
  );
}
