import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { ReasoningLevel } from "@omnyo/domain";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@omnyo/shared-ui/context-menu";
import { Icon } from "@omnyo/shared-ui/icon";
import { Pill } from "@omnyo/shared-ui/pill";
import {
  CONTROL_HOVER_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
  DISCLOSURE_CHEVRON_TRANSITION,
  LIST_HOVER_TRANSITION,
  REVEALED_CONTENT_MOTION,
} from "@omnyo/shared-ui/motion";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PickerLoadingRows } from "./PickerLoadingRows";
import {
  FavoriteLevelToggle,
  MODEL_PICKER_CHIP_CLASS_NAME as CHIP_CLASS_NAME,
  MODEL_PICKER_PRESSED_CHIP_CLASS_NAME as PRESSED_CHIP_CLASS_NAME,
} from "./model-picker-chip";
import {
  favoriteActionLabel,
  type FavoritePick,
  type FavoriteRow,
} from "./favorite-bars";
import { favoriteUnavailableReason } from "./model-favorites";
import {
  formatModelLoadErrorTitle,
  ModelLoadErrorMessage,
} from "./model-load-error-message";
import { modelPickerNoticeLine, type ModelPickerNotice } from "./model-notice";
import type { ProviderPickerOption } from "./model-brand-prefix";
import {
  MODEL_PICKER_ALL_MODELS_KEY,
  modelPickerCellsMode,
  modelPickerMoreKey,
  modelPickerGridTemplate,
  splitModelLabelTag,
  type ModelPickerCellsMode,
  type ModelPickerColumn,
  type ModelPickerMatrixGroup,
  type ModelPickerMatrixMore,
  type ModelPickerMatrixRow,
} from "./model-picker-menu";

export interface ModelPickerMatrixStar {
  rowKey: string;
  pressed: boolean;
  disabled: boolean;
  onToggle: () => void;
}

export interface ModelPickerMatrixFavoritesNotice {
  notice: ModelPickerNotice;
  icon: ProviderPickerOption["icon"];
}

export interface ModelPickerMatrixFavorites {
  rows: readonly FavoriteRow[];
  notices: readonly ModelPickerMatrixFavoritesNotice[];
  star: ModelPickerMatrixStar | null;
  revealedKey: string | null;
  onPick: (pick: FavoritePick) => void;
  onTogglePick: (row: FavoriteRow, pick: FavoritePick) => void;
  onReveal: (key: string) => void;
  onConceal: () => void;
}

export interface ModelPickerMatrixProps {
  listRef: RefObject<HTMLDivElement | null>;
  gridId: string;
  optionId: (index: number) => string;
  activeDescendantId: string | undefined;
  open: boolean;
  favorites: ModelPickerMatrixFavorites | null;
  favoriteMenu: ModelPickerMatrixFavoriteMenu | null;
  allModels: ModelPickerMatrixAllModels | null;
  groups: readonly ModelPickerMatrixGroup[];
  columns: readonly ModelPickerColumn[];
  navIndexByKey: ReadonlyMap<string, number>;
  highlightedKey: string | null;
  cursorVisible: boolean;
  reasoningValue: ReasoningLevel;
  editing: boolean;
  isSearching: boolean;
  isFavoriteCell: (row: ModelPickerMatrixRow, level: ReasoningLevel) => boolean;
  onCommit: (row: ModelPickerMatrixRow, level: ReasoningLevel) => void;
  onToggleMore: (providerId: string) => void;
  onToggleHidden: (row: ModelPickerMatrixRow) => void;
  onToggleFavorite: (row: ModelPickerMatrixRow, level: ReasoningLevel) => void;
  onPointerNavigation: () => void;
}

export interface ModelPickerMatrixAllModels {
  onOpen: () => void;
}

export interface ModelPickerMatrixFavoriteMenu {
  full: boolean;
}

interface FavoriteMenuTarget {
  title: string;
  favorite: boolean;
  onToggle: () => void;
}

type ClaimFavoriteMenu = (target: FavoriteMenuTarget) => void;

function keepNativeContextMenu(event: ReactMouseEvent) {
  event.stopPropagation();
}

interface MatrixLayout {
  compact: boolean;
  gridTemplate: CSSProperties | undefined;
  cellsTemplate: CSSProperties;
}

function centerHiddenRowInList(list: HTMLElement, row: HTMLElement) {
  const rowRect = row.getBoundingClientRect();
  const offset = rowRect.top - list.getBoundingClientRect().top;

  if (offset >= 0 && offset + rowRect.height <= list.clientHeight) return;
  list.scrollTop += offset - (list.clientHeight - rowRect.height) / 2;
}

const ROW_TEXT_CLASS_NAME =
  "py-1 text-xs max-md:pointer-coarse:py-2 max-md:pointer-coarse:text-sm";

const NAME_TEXT_CLASS_NAME =
  "py-1 text-xs max-md:pointer-coarse:py-0.5 max-md:pointer-coarse:text-sm";

const NAME_HOVER_LANDING_CLASS_NAME =
  "peer-hover/name:[&_[data-model-matrix-name-landing]]:ring-1 peer-hover/name:[&_[data-model-matrix-name-landing]]:ring-inset peer-hover/name:[&_[data-model-matrix-name-landing]]:ring-ring";

const GROUP_LABEL_ROW_CLASS_NAME =
  "sticky top-0 z-10 col-span-full flex select-none bg-background px-2 pb-0.5 pt-1.5";

const SUBGRID_CLASS_NAME = "col-span-full grid grid-cols-subgrid";

const GROUP_LABEL_CLASS_NAME =
  "flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground";

const UNPINNED_CHIP_CLASS_NAME =
  "bg-state-hover font-medium text-foreground outline-1 -outline-offset-1 outline-dashed outline-subtle-foreground";

const STAR_BUTTON_CLASS_NAME = cn(
  "flex size-6 shrink-0 items-center justify-center rounded-md text-subtle-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 max-md:pointer-coarse:size-9",
  CONTROL_PRESS_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
);

const LANDING_CHIP_CLASS_NAME = "ring-1 ring-inset ring-ring";

const FAVORITE_MARK_CLASS_NAME =
  "pointer-events-none absolute -right-0.5 -top-0.5 flex text-subtle-foreground max-md:pointer-coarse:top-1.5";

const UNAVAILABLE_CHIP_CLASS_NAME =
  "cursor-default opacity-60 hover:bg-transparent hover:text-muted-foreground";

const ROW_CLASS_NAME = cn(
  "group/row select-none rounded-sm px-2 pointer-fine:hover:bg-state-hover",
  LIST_HOVER_TRANSITION,
);

const NAME_BUTTON_CLASS_NAME =
  "flex min-w-0 flex-1 cursor-default select-none items-center rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

const ALL_MODELS_BUTTON_CLASS_NAME = cn(
  "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 text-left text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
  ROW_TEXT_CLASS_NAME,
  LIST_HOVER_TRANSITION,
);

function matrixLayout(
  columnCount: number,
  compact: boolean,
  starColumn: boolean,
): MatrixLayout {
  const cellsTemplate: CSSProperties = {
    gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
  };

  return {
    compact,
    gridTemplate: compact
      ? undefined
      : {
          gridTemplateColumns: modelPickerGridTemplate(columnCount, starColumn),
        },
    cellsTemplate,
  };
}

export function ModelPickerMatrix({
  listRef,
  gridId,
  optionId,
  activeDescendantId,
  open,
  favorites,
  favoriteMenu,
  allModels,
  groups,
  columns,
  navIndexByKey,
  highlightedKey,
  cursorVisible,
  reasoningValue,
  editing,
  isSearching,
  isFavoriteCell,
  onCommit,
  onToggleMore,
  onToggleHidden,
  onToggleFavorite,
  onPointerNavigation,
}: ModelPickerMatrixProps) {
  const isCompactViewport = useIsCompactViewport();
  const pointerCoarse = usePointerCoarse();
  const pendingMenuTargetRef = useRef<FavoriteMenuTarget | null>(null);
  const menuOpenRef = useRef(false);
  const menuFocusReturnRef = useRef<HTMLElement | null>(null);
  const menuDismissClickRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const [menuTarget, setMenuTarget] = useState<FavoriteMenuTarget | null>(null);

  const menuEnabled =
    favoriteMenu !== null && !isCompactViewport && !pointerCoarse;

  const claimMenu: ClaimFavoriteMenu | undefined = menuEnabled
    ? (target) => {
        pendingMenuTargetRef.current ??= target;
      }
    : undefined;

  const layout = matrixLayout(
    columns.length,
    isCompactViewport,
    favorites !== null && favorites.star !== null,
  );

  const centerOnScrollRef = useRef(true);

  const domIdFor = (key: string): string | undefined => {
    const index = navIndexByKey.get(key);

    return index === undefined ? undefined : optionId(index);
  };

  const highlightedDomId =
    highlightedKey === null ? undefined : domIdFor(highlightedKey);

  useLayoutEffect(() => {
    if (!open) {
      centerOnScrollRef.current = true;

      return;
    }

    if (highlightedDomId === undefined) return;
    const center = centerOnScrollRef.current;
    centerOnScrollRef.current = false;

    const row = document.getElementById(highlightedDomId);
    const list = listRef.current;

    if (row === null || list === null) return;

    if (center) {
      centerHiddenRowInList(list, row);
    } else {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedDomId, listRef, open]);

  const cursorOn = (key: string) => cursorVisible && key === highlightedKey;

  const renderRow = (
    row: ModelPickerMatrixRow,
    onRevealEnd: (() => void) | null,
  ) => (
    <MatrixRow
      key={row.key}
      row={row}
      onRevealEnd={onRevealEnd}
      domId={domIdFor(row.key)}
      layout={layout}
      columns={columns}
      mode={modelPickerCellsMode({ kind: "row", row }, editing)}
      highlighted={cursorOn(row.key)}
      ringed={!editing && cursorOn(row.key)}
      reasoningValue={reasoningValue}
      editing={editing}
      isFavoriteCell={isFavoriteCell}
      onCommit={onCommit}
      onToggleHidden={onToggleHidden}
      onToggleFavorite={onToggleFavorite}
      claimMenu={claimMenu}
    />
  );

  const grid = (
    <div
      ref={listRef}
      id={gridId}
      role="grid"
      aria-label="Models"
      aria-activedescendant={activeDescendantId}
      tabIndex={-1}
      onContextMenuCapture={() => {
        pendingMenuTargetRef.current = null;
        const focused = document.activeElement;

        if (
          focused instanceof HTMLElement &&
          focused !== document.body &&
          focused.closest('[role="menu"]') === null
        ) {
          menuFocusReturnRef.current = focused;
        }
      }}
      onMouseDown={(event) => {
        if (menuEnabled && event.button === 2) event.preventDefault();
      }}
      onPointerDownCapture={() => {
        menuDismissClickRef.current = false;
      }}
      onClickCapture={(event) => {
        if (!menuDismissClickRef.current) return;
        menuDismissClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse" && cursorVisible)
          onPointerNavigation();
      }}
      className={cn(
        "min-h-0 flex-1 scroll-pt-8 overflow-y-auto overscroll-contain px-1 pb-1 pt-0 outline-none",
        !isCompactViewport && "grid max-h-[20rem] content-start gap-x-1",
      )}
      style={layout.gridTemplate}
    >
      {favorites === null || favorites.rows.length === 0 ? null : (
        <FavoritesRowGroup
          favorites={favorites}
          compact={layout.compact}
          renderRow={(row, reasonId) => (
            <FavoriteMatrixRow
              key={row.key}
              row={row}
              domId={domIdFor(row.key)}
              layout={layout}
              columns={columns}
              highlighted={cursorOn(row.key)}
              ringed={cursorOn(row.key)}
              reasonId={reasonId}
              favorites={favorites}
              claimMenu={claimMenu}
            />
          )}
        />
      )}
      {favorites === null
        ? null
        : favorites.notices.map((entry) => (
            <FavoritesNoticeRow key={entry.notice.providerId} entry={entry} />
          ))}
      {allModels === null ? null : (
        <AllModelsRow
          domId={domIdFor(MODEL_PICKER_ALL_MODELS_KEY)}
          highlighted={cursorOn(MODEL_PICKER_ALL_MODELS_KEY)}
          separated={favorites !== null && favorites.rows.length > 0}
          onOpen={allModels.onOpen}
        />
      )}
      {groups.map((group) => (
        <div
          key={group.providerId}
          role="rowgroup"
          className={layout.compact ? undefined : SUBGRID_CLASS_NAME}
        >
          <MatrixGroupLabel group={group} />
          {group.notice === null ? null : (
            <MatrixGroupNotice notice={group.notice} />
          )}
          <MatrixGroupBody
            group={group}
            renderRow={renderRow}
            moreDomId={domIdFor(modelPickerMoreKey(group.providerId))}
            moreHighlighted={cursorOn(modelPickerMoreKey(group.providerId))}
            onToggleMore={onToggleMore}
          />
        </div>
      ))}
      {isSearching && groups.length === 0 ? (
        <div
          onContextMenu={keepNativeContextMenu}
          className={cn(
            "col-span-full px-2 text-muted-foreground",
            ROW_TEXT_CLASS_NAME,
          )}
        >
          No models match your search
        </div>
      ) : null}
    </div>
  );

  return (
    <ContextMenu
      modal={false}
      open={menuOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          menuOpenRef.current = false;
          setMenuOpen(false);

          return;
        }

        const target = pendingMenuTargetRef.current;
        pendingMenuTargetRef.current = null;

        if (target === null) return;
        menuOpenRef.current = true;
        setMenuTarget(target);
        setMenuOpen(true);
      }}
    >
      <ContextMenuTrigger asChild disabled={!menuEnabled}>
        {grid}
      </ContextMenuTrigger>
      {favoriteMenu === null || menuTarget === null ? null : (
        <ContextMenuContent
          aria-label={`${menuTarget.title} actions`}
          className="max-w-64"
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDownOutside={(event) => {
            const { button, target } = event.detail.originalEvent;

            menuDismissClickRef.current =
              button === 0 &&
              target instanceof Node &&
              listRef.current?.contains(target) === true;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();

            if (menuOpenRef.current) return;
            menuFocusReturnRef.current?.focus({ preventScroll: true });
          }}
        >
          <ContextMenuLabel className="truncate">
            {menuTarget.title}
          </ContextMenuLabel>
          <ContextMenuItem
            disabled={!menuTarget.favorite && favoriteMenu.full}
            onSelect={menuTarget.onToggle}
          >
            {menuTarget.favorite ? "Remove from favorites" : "Add to favorites"}
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

function FavoritesRowGroup({
  favorites,
  compact,
  renderRow,
}: {
  favorites: ModelPickerMatrixFavorites;
  compact: boolean;
  renderRow: (row: FavoriteRow, reasonId: string | undefined) => ReactNode;
}) {
  const reasonId = useId();

  const revealed = favorites.rows
    .flatMap((row) => row.picks)
    .find((pick) => pick.key === favorites.revealedKey);

  const reason =
    revealed === undefined
      ? null
      : favoriteUnavailableReason(revealed.availability);

  return (
    <div
      role="rowgroup"
      aria-label="Favorites"
      className={cn("relative pt-1", !compact && SUBGRID_CLASS_NAME)}
    >
      {favorites.rows.map((row) =>
        renderRow(row, reason === null ? undefined : reasonId),
      )}
      {reason === null ? null : (
        <div role="row" className={cn("col-span-full", compact && "px-2 pb-1")}>
          <div role="gridcell">
            <p
              id={reasonId}
              data-model-favorite-reason=""
              className={cn(
                "truncate text-xs text-subtle-foreground",
                compact
                  ? "max-md:pointer-coarse:text-sm"
                  : "pointer-events-none absolute left-2 top-full z-20 mt-0.5 max-w-[calc(100%-1rem)] rounded-sm border border-border bg-background px-1.5 py-0.5",
              )}
            >
              {reason}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function AllModelsRow({
  domId,
  highlighted,
  separated,
  onOpen,
}: {
  domId: string | undefined;
  highlighted: boolean;
  separated: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      role="row"
      id={domId}
      data-model-matrix-row={MODEL_PICKER_ALL_MODELS_KEY}
      className={cn(
        "col-span-full",
        separated && "mt-1 border-t border-border pt-1",
      )}
    >
      <div role="gridcell">
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            ALL_MODELS_BUTTON_CLASS_NAME,
            highlighted && "bg-state-hover text-foreground",
          )}
        >
          <span className="min-w-0 truncate">All models</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-subtle-foreground">
            <span className="pointer-coarse:hidden">Type to search</span>
            <Icon name="ChevronRight" aria-hidden className="size-3.5" />
          </span>
        </button>
      </div>
    </div>
  );
}

function MatrixGroupLabel({ group }: { group: ModelPickerMatrixGroup }) {
  const GroupIcon = group.icon;

  return (
    <div role="row" className={GROUP_LABEL_ROW_CLASS_NAME}>
      <div role="rowheader" className={GROUP_LABEL_CLASS_NAME}>
        {GroupIcon ? <GroupIcon className="size-4 shrink-0" /> : null}
        <span className="min-w-0 truncate">{group.label}</span>
        {group.newChat ? (
          <Pill
            variant="outline"
            size="sm"
            className="shrink-0 font-normal text-subtle-foreground"
          >
            New chat
          </Pill>
        ) : null}
      </div>
    </div>
  );
}

function MatrixGroupNotice({ notice }: { notice: ModelPickerNotice }) {
  return (
    <div
      role="row"
      className="col-span-full"
      data-model-picker-notice={notice.providerId}
      onContextMenu={keepNativeContextMenu}
    >
      <div
        role="gridcell"
        className="px-2 pb-1 pt-0.5 text-xs leading-relaxed max-md:pointer-coarse:pb-2"
      >
        <span className="block text-warning-text">{notice.summary}</span>
        {notice.detail === null ? null : (
          <span className="block text-muted-foreground">{notice.detail}</span>
        )}
      </div>
    </div>
  );
}

function FavoritesNoticeRow({
  entry,
}: {
  entry: ModelPickerMatrixFavoritesNotice;
}) {
  const NoticeIcon = entry.icon;

  return (
    <div
      role="row"
      className="col-span-full"
      data-model-picker-notice={entry.notice.providerId}
      onContextMenu={keepNativeContextMenu}
    >
      <div
        role="gridcell"
        className="flex items-start gap-1.5 px-2 py-1 text-xs leading-relaxed text-warning-text"
      >
        {NoticeIcon ? (
          <NoticeIcon className="mt-0.5 size-3.5 shrink-0" />
        ) : null}
        <span className="min-w-0">{modelPickerNoticeLine(entry.notice)}</span>
      </div>
    </div>
  );
}

function MatrixGroupBody({
  group,
  renderRow,
  moreDomId,
  moreHighlighted,
  onToggleMore,
}: {
  group: ModelPickerMatrixGroup;
  renderRow: (
    row: ModelPickerMatrixRow,
    onRevealEnd: (() => void) | null,
  ) => ReactNode;
  moreDomId: string | undefined;
  moreHighlighted: boolean;
  onToggleMore: (providerId: string) => void;
}) {
  const { body } = group;

  const moreState =
    body.kind !== "rows" || body.more === null
      ? "none"
      : body.more.expanded
        ? "expanded"
        : "collapsed";

  const [previousMoreState, setPreviousMoreState] = useState(moreState);
  const [revealing, setRevealing] = useState(false);

  if (moreState !== previousMoreState) {
    setPreviousMoreState(moreState);
    setRevealing(previousMoreState === "collapsed" && moreState === "expanded");
  }

  const endReveal = () => setRevealing(false);

  if (body.kind === "loading") {
    return (
      <div role="row" className="col-span-full">
        <div role="gridcell">
          <PickerLoadingRows
            label="Loading models"
            rowDataAttribute="data-model-loading-row"
          />
        </div>
      </div>
    );
  }

  if (body.kind === "error" || body.kind === "empty") {
    const error = body.kind === "error" ? body.error : null;

    return (
      <div
        role="row"
        className="col-span-full"
        onContextMenu={keepNativeContextMenu}
      >
        <div
          role="gridcell"
          className={cn(
            "text-xs leading-relaxed text-muted-foreground",
            error !== null
              ? "mx-1 mb-1.5 mt-0.5 rounded-md border border-warning/20 bg-warning/5 px-2.5 py-2"
              : "px-2 pb-2 pt-0.5 max-md:pointer-coarse:pb-3",
          )}
          title={
            error === null
              ? undefined
              : formatModelLoadErrorTitle({ error, providerLabel: group.label })
          }
        >
          {error !== null ? (
            <ModelLoadErrorMessage
              error={error}
              providerLabel={group.label}
              {...(group.installUrl === undefined
                ? {}
                : { installUrl: group.installUrl })}
            />
          ) : body.kind === "error" ? (
            "Could not load models."
          ) : (
            "No models available"
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {body.rows.map((row) => renderRow(row, null))}
      {body.more === null ? null : (
        <MoreRow
          providerId={group.providerId}
          more={body.more}
          domId={moreDomId}
          highlighted={moreHighlighted}
          onToggle={onToggleMore}
        />
      )}
      {body.more?.expanded
        ? body.more.rows.map((row) =>
            renderRow(row, revealing ? endReveal : null),
          )
        : null}
    </>
  );
}

function MoreRow({
  providerId,
  more,
  domId,
  highlighted,
  onToggle,
}: {
  providerId: string;
  more: ModelPickerMatrixMore;
  domId: string | undefined;
  highlighted: boolean;
  onToggle: (providerId: string) => void;
}) {
  return (
    <div
      role="row"
      id={domId}
      className={cn(
        "col-span-full rounded-sm px-2",
        highlighted && "bg-state-hover",
      )}
    >
      <div role="gridcell">
        <button
          type="button"
          aria-expanded={more.expanded}
          onClick={() => onToggle(providerId)}
          className={cn(
            "flex cursor-default select-none items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
            ROW_TEXT_CLASS_NAME,
            CONTROL_HOVER_TRANSITION,
          )}
        >
          <span>{more.expanded ? "Show fewer" : `${more.count} more`}</span>
          <Icon
            name="ChevronDown"
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              DISCLOSURE_CHEVRON_TRANSITION,
              more.expanded && "rotate-180",
            )}
          />
        </button>
      </div>
    </div>
  );
}

function MatrixCell({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="gridcell"
      className={cn("flex items-center justify-center", className)}
    >
      {children}
    </div>
  );
}

function MatrixCells({
  layout,
  mode,
  highlighted,
  children,
}: {
  layout: MatrixLayout;
  mode: ModelPickerCellsMode;
  highlighted: boolean;
  children: ReactNode;
}) {
  if (!layout.compact) return children;

  if (mode === "reveal" && !highlighted) return null;

  return (
    <div
      className={cn(
        "grid pb-1 max-md:pointer-coarse:pb-0.5",
        NAME_HOVER_LANDING_CLASS_NAME,
      )}
      style={layout.cellsTemplate}
    >
      {children}
    </div>
  );
}

interface MatrixRowProps {
  row: ModelPickerMatrixRow;
  onRevealEnd: (() => void) | null;
  domId: string | undefined;
  layout: MatrixLayout;
  columns: readonly ModelPickerColumn[];
  mode: ModelPickerCellsMode;
  highlighted: boolean;
  ringed: boolean;
  reasoningValue: ReasoningLevel;
  editing: boolean;
  isFavoriteCell: (row: ModelPickerMatrixRow, level: ReasoningLevel) => boolean;
  onCommit: (row: ModelPickerMatrixRow, level: ReasoningLevel) => void;
  onToggleHidden: (row: ModelPickerMatrixRow) => void;
  onToggleFavorite: (row: ModelPickerMatrixRow, level: ReasoningLevel) => void;
  claimMenu: ClaimFavoriteMenu | undefined;
}

function MatrixRow({
  row,
  onRevealEnd,
  domId,
  layout,
  columns,
  mode,
  highlighted,
  ringed,
  reasoningValue,
  editing,
  isFavoriteCell,
  onCommit,
  onToggleHidden,
  onToggleFavorite,
  claimMenu,
}: MatrixRowProps) {
  const { base, tag } = splitModelLabelTag(row.label);
  const qualifier = row.option.routeProviderId;

  const nameTitle =
    row.option.disabledReason ??
    (qualifier ? `${row.label} · ${qualifier}` : row.label);

  const nameContent = (
    <span className="min-w-0 truncate" title={nameTitle}>
      {base}
      {tag ? (
        <span className="ml-1.5 text-subtle-foreground">{tag}</span>
      ) : null}
      {qualifier ? (
        <span className="ml-1.5 text-subtle-foreground">{qualifier}</span>
      ) : null}
    </span>
  );

  const claimLevel = (level: ReasoningLevel) => {
    if (claimMenu === undefined) return;

    const option = row.option.reasoningOptions.find(
      (candidate) => candidate.value === level,
    );

    if (option === undefined) return;
    claimMenu({
      title: `${row.label} · ${option.label}`,
      favorite: isFavoriteCell(row, level),
      onToggle: () => onToggleFavorite(row, level),
    });
  };

  const cells = columns.map((column) => {
    const option = row.option.reasoningOptions.find((candidate) =>
      column.levels.includes(candidate.value),
    );

    if (option === undefined) {
      return <div key={column.level} role="gridcell" />;
    }

    const level = option.value;
    const favorite = isFavoriteCell(row, level);

    if (editing) {
      return (
        <MatrixCell key={column.level}>
          <FavoriteLevelToggle
            modelLabel={row.label}
            levelLabel={option.label}
            favorite={favorite}
            onContextMenu={() => claimLevel(level)}
            onToggle={() => onToggleFavorite(row, level)}
          />
        </MatrixCell>
      );
    }

    const selected = row.selected && level === reasoningValue;
    const landsHere = level === row.landingLevel;
    const landing = ringed && landsHere && !selected;

    return (
      <MatrixCell key={column.level} className={NAME_HOVER_LANDING_CLASS_NAME}>
        <button
          type="button"
          aria-label={`${row.label}, ${option.label} reasoning${favorite ? ", favorite" : ""}`}
          aria-pressed={selected}
          data-model-matrix-cell={level}
          data-model-matrix-name-landing={
            landsHere && !selected ? "" : undefined
          }
          data-landing={landing ? "" : undefined}
          data-favorite={favorite ? "" : undefined}
          disabled={!row.selectable}
          onContextMenu={() => claimLevel(level)}
          onClick={() => onCommit(row, level)}
          className={cn(
            CHIP_CLASS_NAME,
            "relative disabled:cursor-not-allowed disabled:opacity-60",
            favorite ? "text-foreground" : "text-subtle-foreground",
            selected && PRESSED_CHIP_CLASS_NAME,
            landing && LANDING_CHIP_CLASS_NAME,
          )}
        >
          <span>{option.label}</span>
          {favorite ? (
            <span
              aria-hidden
              data-model-favorite-mark=""
              className={FAVORITE_MARK_CLASS_NAME}
            >
              <Icon name="Star" className="size-2 fill-current" />
            </span>
          ) : null}
        </button>
      </MatrixCell>
    );
  });

  return (
    <div
      role="row"
      id={domId}
      data-model-matrix-row={row.key}
      data-model-matrix-cells={mode}
      data-active={highlighted ? "" : undefined}
      onContextMenu={() => claimLevel(row.landingLevel)}
      onAnimationEnd={
        onRevealEnd === null
          ? undefined
          : (event) => {
              if (event.target === event.currentTarget) onRevealEnd();
            }
      }
      className={cn(
        ROW_CLASS_NAME,
        layout.compact
          ? "flex flex-col"
          : cn(SUBGRID_CLASS_NAME, "items-center"),
        highlighted && "bg-state-hover",
        editing && row.hidden && "opacity-60",
        onRevealEnd !== null && REVEALED_CONTENT_MOTION,
      )}
    >
      <div
        role="gridcell"
        className="peer/name flex min-w-0 items-center gap-1"
      >
        {editing ? (
          <button
            type="button"
            aria-label={row.hidden ? `Show ${row.label}` : `Hide ${row.label}`}
            onClick={() => onToggleHidden(row)}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-sm text-subtle-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-9",
              CONTROL_PRESS_TRANSITION,
              CONTROL_PRESS_FEEDBACK,
            )}
          >
            <Icon
              name={row.hidden ? "EyeOff" : "Eye"}
              aria-hidden
              className="size-3.5"
            />
          </button>
        ) : null}
        {editing ? (
          <span
            className={cn(
              "flex min-w-0 flex-1 items-center",
              NAME_TEXT_CLASS_NAME,
            )}
          >
            {nameContent}
          </span>
        ) : (
          <button
            type="button"
            data-model-matrix-name=""
            disabled={!row.selectable}
            onClick={() => onCommit(row, row.landingLevel)}
            className={cn(NAME_BUTTON_CLASS_NAME, NAME_TEXT_CLASS_NAME)}
          >
            {nameContent}
          </button>
        )}
      </div>
      <MatrixCells layout={layout} mode={mode} highlighted={highlighted}>
        {cells}
      </MatrixCells>
    </div>
  );
}

interface FavoriteMatrixRowProps {
  row: FavoriteRow;
  domId: string | undefined;
  layout: MatrixLayout;
  columns: readonly ModelPickerColumn[];
  highlighted: boolean;
  ringed: boolean;
  reasonId: string | undefined;
  favorites: ModelPickerMatrixFavorites;
  claimMenu: ClaimFavoriteMenu | undefined;
}

function FavoriteMatrixRow({
  row,
  domId,
  layout,
  columns,
  highlighted,
  ringed,
  reasonId,
  favorites,
  claimMenu,
}: FavoriteMatrixRowProps) {
  const ProviderIcon = row.icon;

  const claimPick = (pick: FavoritePick | null) => {
    if (claimMenu === undefined || pick === null) return;
    claimMenu({
      title: [row.modelLabel, pick.effortLabel, pick.tierLabel]
        .filter((part) => part !== null)
        .join(" · "),
      favorite: pick.pinned,
      onToggle: () => favorites.onTogglePick(row, pick),
    });
  };

  const cell = (pick: FavoritePick, key: string) => {
    const landsHere = row.landing?.key === pick.key && !pick.current;

    return (
      <MatrixCell key={key} className={NAME_HOVER_LANDING_CLASS_NAME}>
        <FavoritePickChip
          row={row}
          pick={pick}
          landing={ringed && landsHere}
          nameLanding={landsHere}
          reasonId={pick.key === favorites.revealedKey ? reasonId : undefined}
          favorites={favorites}
          onContextMenu={() => claimPick(pick)}
        />
      </MatrixCell>
    );
  };

  const star =
    favorites.star !== null && favorites.star.rowKey === row.key
      ? favorites.star
      : null;

  const shadow = row.picks.every((pick) => !pick.pinned);

  const cells = layout.compact ? (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-end gap-1",
        NAME_HOVER_LANDING_CLASS_NAME,
      )}
    >
      {row.picks.map((pick) => cell(pick, pick.key))}
      {star === null ? null : <FavoriteStarToggle star={star} />}
    </div>
  ) : (
    <>
      {columns.map((column) => {
        const pick = row.picks.find((candidate) =>
          column.levels.includes(candidate.selection.reasoningLevel),
        );

        return pick === undefined ? (
          <div key={column.level} role="gridcell" />
        ) : (
          cell(pick, column.level)
        );
      })}
      {favorites.star === null ? null : (
        <div role="gridcell" className="flex items-center justify-center">
          {star === null ? null : <FavoriteStarToggle star={star} />}
        </div>
      )}
    </>
  );

  const name = (
    <>
      {ProviderIcon ? (
        <span aria-hidden className="flex shrink-0">
          <ProviderIcon className="size-4" />
        </span>
      ) : null}
      <span
        className={cn("min-w-0 truncate", shadow && "text-muted-foreground")}
      >
        {row.modelLabel}
      </span>
      {row.tierLabel === null ? null : (
        <span className="flex shrink-0 items-center gap-0.5 text-subtle-foreground">
          <Icon name="Zap" aria-hidden className="size-3 fill-current" />
          {row.tierLabel}
        </span>
      )}
      {row.startsNewChat ? (
        <Icon
          name="MessageSquarePlus"
          aria-hidden
          className="size-3 shrink-0 text-subtle-foreground"
        />
      ) : null}
    </>
  );

  const { landing } = row;

  return (
    <div
      role="row"
      id={domId}
      data-model-matrix-row={row.key}
      data-model-matrix-cells="favorites"
      data-active={highlighted ? "" : undefined}
      onContextMenu={() => claimPick(row.landing)}
      className={cn(
        ROW_CLASS_NAME,
        layout.compact
          ? "flex items-center justify-between gap-2"
          : cn(SUBGRID_CLASS_NAME, "items-center"),
        highlighted && "bg-state-hover",
      )}
    >
      <div role="gridcell" className="peer/name flex min-w-0 items-center">
        <button
          type="button"
          data-model-favorite-name=""
          aria-hidden
          tabIndex={-1}
          disabled={landing === null}
          onClick={() => {
            if (landing !== null) favorites.onPick(landing);
          }}
          className={cn(
            NAME_BUTTON_CLASS_NAME,
            "gap-1.5",
            NAME_TEXT_CLASS_NAME,
          )}
        >
          {name}
        </button>
      </div>
      {cells}
    </div>
  );
}

function FavoritePickChip({
  row,
  pick,
  landing,
  nameLanding,
  reasonId,
  favorites,
  onContextMenu,
}: {
  row: FavoriteRow;
  pick: FavoritePick;
  landing: boolean;
  nameLanding: boolean;
  reasonId: string | undefined;
  favorites: ModelPickerMatrixFavorites;
  onContextMenu: () => void;
}) {
  const reason = favoriteUnavailableReason(pick.availability);

  return (
    <button
      type="button"
      data-model-favorite-option={pick.key}
      aria-label={favoriteActionLabel(row, pick)}
      aria-pressed={pick.current}
      aria-disabled={reason === null ? undefined : true}
      aria-describedby={reasonId}
      data-landing={landing ? "" : undefined}
      data-model-matrix-name-landing={nameLanding ? "" : undefined}
      onFocus={() => {
        if (reason === null) {
          favorites.onConceal();

          return;
        }

        favorites.onReveal(pick.key);
      }}
      onBlur={() => {
        if (reason !== null) favorites.onConceal();
      }}
      onContextMenu={onContextMenu}
      onClick={() => {
        if (reason === null) {
          favorites.onPick(pick);

          return;
        }

        favorites.onReveal(pick.key);
      }}
      className={cn(
        CHIP_CLASS_NAME,
        pick.current &&
          (pick.pinned ? PRESSED_CHIP_CLASS_NAME : UNPINNED_CHIP_CLASS_NAME),
        reason !== null && UNAVAILABLE_CHIP_CLASS_NAME,
        landing && LANDING_CHIP_CLASS_NAME,
      )}
    >
      <span title={reason ?? undefined}>{pick.effortLabel}</span>
    </button>
  );
}

function FavoriteStarToggle({ star }: { star: ModelPickerMatrixStar }) {
  return (
    <button
      type="button"
      data-model-favorite-star=""
      aria-label={star.pressed ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={star.pressed}
      disabled={star.disabled}
      onClick={star.onToggle}
      className={STAR_BUTTON_CLASS_NAME}
    >
      <Icon
        name="Star"
        aria-hidden
        className={cn(
          "size-3.5",
          star.pressed && "fill-current text-foreground",
        )}
      />
    </button>
  );
}
