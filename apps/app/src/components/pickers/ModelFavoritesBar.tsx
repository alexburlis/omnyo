import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { Icon } from "@omnyo/shared-ui/icon";
import { LIST_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import {
  buildFavoriteBars,
  buildModelBars,
  favoriteActionLabel,
  isFavoritePick,
  type CurrentPick,
  type FavoriteBars,
  type FavoriteBarsInput,
  type FavoriteGroup,
  type FavoriteModel,
  type FavoritePick,
  type FavoriteSelection,
  type FittedGroup,
  type ShownGroups,
  type TrackWidths,
} from "./favorite-bars";
import { favoriteUnavailableReason } from "./model-favorites";
import type { ModelPickerSelection } from "./model-picker-selection";
import {
  MODEL_SPEED_BUTTON_CLASS_NAME,
  ModelSpeedControl,
  type ModelSpeed,
} from "./ModelSpeedControl";
import type { FavoritesStore } from "./useModelFavorites";

export type ModelPickerPresentation = "footer" | "bar";

export type ModelPickerSelects = "model-and-effort" | "model";

const SWITCHER_COPY: Record<
  ModelPickerSelects,
  { label: string; hint: string }
> = {
  "model-and-effort": {
    label: "Model and effort",
    hint: "No favorites yet. Star efforts in ⌄ to pin them here.",
  },
  model: {
    label: "Model",
    hint: "No favorites yet. Star models in ⌄ to pin them here.",
  },
};

const FAVORITES_FULL_REASON = "Favorites are full";

const FAVORITES_FAILED_LABEL = "Couldn't load favorites";

const TOOLTIP_DELAY_MS = 300;

const SEGMENT_CLASS_NAME = cn(
  "flex h-7 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
  LIST_HOVER_TRANSITION,
);

const PRESSED_SEGMENT_CLASS_NAME = "bg-state-active text-foreground shadow-xs";

const UNPINNED_SEGMENT_CLASS_NAME =
  "text-foreground outline-1 -outline-offset-1 outline-dashed outline-subtle-foreground";

export const FAVORITE_SEGMENTS_CLASS_NAME =
  "flex items-center gap-px rounded-lg bg-muted p-0.5";

export const FAVORITE_BAR_ICON_SEGMENT_CLASS_NAME = cn(
  SEGMENT_CLASS_NAME,
  "px-1 text-subtle-foreground hover:text-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground data-[state=open]:shadow-xs",
);

const SPEED_SEGMENT_CLASS_NAME = cn(
  FAVORITE_BAR_ICON_SEGMENT_CLASS_NAME,
  "aria-pressed:text-foreground disabled:cursor-default disabled:opacity-60",
);

export interface FavoriteKeepActivation {
  focused: boolean;
}

type LoadedFavorites = { status: "failed" | "ready" } & FavoritesStore;

type PickHandler = (selection: ModelPickerSelection) => void;

type KeepHandler = (
  selection: FavoriteSelection,
  activation: FavoriteKeepActivation,
) => void;

export interface ModelFavoritesBarProps {
  preference: LoadedFavorites;
  current: CurrentPick;
  providerOrder: readonly string[];
  presentation: ModelPickerPresentation;
  selects: ModelPickerSelects;
  speed: ModelSpeed | null;
  allModels: (hidden: number) => ReactElement;
  pill: ReactElement;
  onPick: PickHandler;
  onKeep: KeepHandler;
  onOpenModels: () => void;
}

export function ModelFavoritesBar({
  preference,
  current,
  providerOrder,
  presentation,
  selects,
  speed,
  allModels,
  pill,
  onPick,
  onKeep,
  onOpenModels,
}: ModelFavoritesBarProps) {
  const centered = presentation === "bar";
  const copy = SWITCHER_COPY[selects];

  const track = {
    favorites: preference.items,
    current,
    providerOrder,
    centered,
    label: copy.label,
    speed,
    allModels,
    pill,
  };

  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <div
        data-model-favorites-bar=""
        aria-live="off"
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-2",
          centered ? "items-center" : "items-start",
        )}
      >
        {preference.status === "failed" ? (
          <div className="flex min-w-0 max-w-full items-center gap-2">
            <PillWithSpeed pill={pill} speed={speed} />
            <span className="min-w-0 truncate text-xs text-subtle-foreground">
              {FAVORITES_FAILED_LABEL}
            </span>
          </div>
        ) : selects === "model" ? (
          <FittedTrack
            {...track}
            build={buildModelBars}
            renderGroup={(model) => (
              <TrackModel
                model={model}
                favoritesFull={preference.isFull}
                onPick={onPick}
                onKeep={onKeep}
              />
            )}
          />
        ) : (
          <FittedTrack
            {...track}
            build={buildFavoriteBars}
            renderGroup={(group) =>
              group.current ? (
                <TrackGroup
                  group={group}
                  favoritesFull={preference.isFull}
                  onPick={onPick}
                  onKeep={onKeep}
                  onOpenModels={onOpenModels}
                />
              ) : (
                <TrackChip group={group} onPick={onPick} />
              )
            }
          />
        )}
        {centered &&
        preference.status === "ready" &&
        preference.items.length === 0 ? (
          <p className="text-xs text-subtle-foreground">{copy.hint}</p>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

export function AllModelsIcon() {
  return <Icon name="ChevronDown" aria-hidden className="size-3.5" />;
}

export const ALL_MODELS_COUNT_CLASS_NAME = "text-xs tabular-nums";

export function allModelsLabel(hidden: number): string {
  if (hidden === 0) return "All models";

  return `All models, ${hidden} more ${hidden === 1 ? "favorite" : "favorites"}`;
}

function PillWithSpeed({
  pill,
  speed,
}: {
  pill: ReactElement;
  speed: ModelSpeed | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      {pill}
      {speed === null ? null : (
        <ModelSpeedControl
          speed={speed}
          className={MODEL_SPEED_BUTTON_CLASS_NAME}
        />
      )}
    </div>
  );
}

function readTrackWidths(root: HTMLElement, track: HTMLElement): TrackWidths {
  const groups = [
    ...track.querySelectorAll<HTMLElement>("[data-favorite-group]"),
  ];

  const end = track.querySelector<HTMLElement>("[data-favorite-track-end]");

  const overflow =
    track
      .querySelector<HTMLElement>("[data-favorite-track-overflow]")
      ?.getBoundingClientRect().width ?? 0;

  const starts = [...groups, end].map(
    (element) => element?.getBoundingClientRect().left ?? 0,
  );

  const widths = new Map<string, number>();
  let slots = 0;

  groups.forEach((group, index) => {
    const slot = starts[index + 1] - starts[index];
    widths.set(group.dataset.favoriteGroup ?? "", slot);
    slots += slot;
  });

  return {
    available: root.getBoundingClientRect().width,
    fixed: track.getBoundingClientRect().width - slots - overflow,
    overflow,
    groups: widths,
  };
}

function sameTrackWidths(
  current: TrackWidths | null,
  next: TrackWidths,
): boolean {
  return (
    current !== null &&
    current.available === next.available &&
    current.fixed === next.fixed &&
    current.overflow === next.overflow &&
    current.groups.size === next.groups.size &&
    [...next.groups].every(([key, width]) => current.groups.get(key) === width)
  );
}

function sameShownGroups(
  current: ShownGroups | null,
  next: ShownGroups | null,
): boolean {
  if (current === null || next === null) return current === next;

  return (
    current.available === next.available &&
    current.keys.length === next.keys.length &&
    current.keys.every((key, index) => next.keys[index] === key)
  );
}

function useTrackWidths(
  rootRef: RefObject<HTMLDivElement | null>,
  trackRef: RefObject<HTMLDivElement | null>,
): TrackWidths | null {
  const [widths, setWidths] = useState<TrackWidths | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef(new Set<Element>());

  useLayoutEffect(() => {
    const root = rootRef.current;
    const track = trackRef.current;

    if (root === null || track === null) return;
    const observed = observedRef.current;

    const observer = new ResizeObserver(() => {
      const next = readTrackWidths(root, track);

      flushSync(() =>
        setWidths((current) =>
          sameTrackWidths(current, next) ? current : next,
        ),
      );
    });

    observerRef.current = observer;
    observer.observe(root);
    observer.observe(track);

    return () => {
      observer.disconnect();
      observerRef.current = null;
      observed.clear();
    };
  }, [rootRef, trackRef]);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const observer = observerRef.current;

    if (track === null || observer === null) return;
    const observed = observedRef.current;

    const segments = new Set<Element>(
      track.querySelectorAll(
        "[data-favorite-group], [data-favorite-track-end]",
      ),
    );

    for (const element of observed) {
      if (segments.has(element)) continue;
      observer.unobserve(element);
      observed.delete(element);
    }

    for (const element of segments) {
      if (observed.has(element)) continue;
      observer.observe(element);
      observed.add(element);
    }
  });

  return widths;
}

interface FittedTrackProps<Group extends FittedGroup> {
  favorites: FavoriteBarsInput["favorites"];
  current: CurrentPick;
  providerOrder: readonly string[];
  centered: boolean;
  label: string;
  speed: ModelSpeed | null;
  allModels: (hidden: number) => ReactElement;
  pill: ReactElement;
  build: (input: FavoriteBarsInput) => FavoriteBars<Group>;
  renderGroup: (group: Group) => ReactNode;
}

function FittedTrack<Group extends FittedGroup>({
  favorites,
  current,
  providerOrder,
  centered,
  label,
  speed,
  allModels,
  pill,
  build,
  renderGroup,
}: FittedTrackProps<Group>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const widths = useTrackWidths(rootRef, measureRef);
  const [shown, setShown] = useState<ShownGroups | null>(null);

  const { bar, all } = build({
    favorites,
    current,
    providerOrder,
    widths,
    shown,
  });

  const nextShown: ShownGroups | null =
    widths === null || bar.kind === "pill"
      ? null
      : {
          available: widths.available,
          keys: bar.groups.map((group) => group.key),
        };

  if (!sameShownGroups(shown, nextShown)) setShown(nextShown);

  return (
    <div
      ref={rootRef}
      data-favorite-track-root=""
      className={cn(
        "grid w-full min-w-0 items-center",
        centered ? "justify-items-center" : "justify-items-start",
      )}
    >
      <div
        aria-hidden
        inert
        className="pointer-events-none invisible col-start-1 row-start-1 h-0 min-w-0 max-w-full self-start overflow-hidden"
      >
        <Track
          ref={measureRef}
          className="w-max"
          label={label}
          groups={all}
          renderGroup={renderGroup}
          end={
            <>
              <span
                data-favorite-track-end=""
                className="flex shrink-0 items-center gap-px"
              >
                {speed === null ? null : (
                  <span className={FAVORITE_BAR_ICON_SEGMENT_CLASS_NAME}>
                    <Icon name="Zap" aria-hidden className="size-3.5" />
                  </span>
                )}
                <span className={FAVORITE_BAR_ICON_SEGMENT_CLASS_NAME}>
                  <AllModelsIcon />
                </span>
              </span>
              <span
                data-favorite-track-overflow=""
                className={cn(ALL_MODELS_COUNT_CLASS_NAME, "shrink-0 pl-1")}
              >
                +99
              </span>
            </>
          }
        />
      </div>
      <div className="col-start-1 row-start-1 flex min-w-0 max-w-full items-center">
        {bar.kind === "pill" ? (
          <PillWithSpeed pill={pill} speed={speed} />
        ) : (
          <Track
            label={label}
            groups={bar.groups}
            renderGroup={renderGroup}
            end={
              <>
                {speed === null ? null : (
                  <ModelSpeedControl
                    speed={speed}
                    className={SPEED_SEGMENT_CLASS_NAME}
                  />
                )}
                {allModels(bar.hidden)}
              </>
            }
          />
        )}
      </div>
    </div>
  );
}

interface TrackProps<Group extends FittedGroup> {
  ref?: Ref<HTMLDivElement>;
  className?: string;
  label: string;
  groups: readonly Group[];
  renderGroup: (group: Group) => ReactNode;
  end: ReactNode;
}

function Track<Group extends FittedGroup>({
  ref,
  className,
  label,
  groups,
  renderGroup,
  end,
}: TrackProps<Group>) {
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className={cn(FAVORITE_SEGMENTS_CLASS_NAME, "h-8 shrink-0", className)}
    >
      {groups.map((group) => (
        <Fragment key={group.key}>
          {renderGroup(group)}
          <span aria-hidden className="mx-px h-3.5 w-px shrink-0 bg-input" />
        </Fragment>
      ))}
      {end}
    </div>
  );
}

function TrackModel({
  model,
  favoritesFull,
  onPick,
  onKeep,
}: {
  model: FavoriteModel;
  favoritesFull: boolean;
  onPick: PickHandler;
  onKeep: KeepHandler;
}) {
  return (
    <div
      data-favorite-group={model.key}
      className="flex shrink-0 items-center gap-px"
    >
      <TrackModelSegment model={model} onPick={onPick} />
      {model.keep === null ? null : (
        <KeepSegment
          selection={model.keep}
          full={favoritesFull}
          onKeep={onKeep}
        />
      )}
    </div>
  );
}

function TrackModelSegment({
  model,
  onPick,
}: {
  model: FavoriteModel;
  onPick: PickHandler;
}) {
  const reasonId = useId();
  const reason = favoriteUnavailableReason(model.landing);
  const ProviderIcon = model.icon;

  const button = (
    <button
      type="button"
      aria-pressed={model.current}
      aria-disabled={reason === null ? undefined : true}
      aria-describedby={reason === null ? undefined : reasonId}
      aria-label={
        model.tierLabel === null
          ? undefined
          : `${model.modelLabel}, ${model.tierLabel}`
      }
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!model.current && model.landing.state === "ready") {
          onPick(model.landing.selection);
        }
      }}
      className={cn(
        favoritePickClassName({
          current: model.current,
          pinned: model.keep === null,
          ready: reason === null,
        }),
        "gap-1 px-1",
      )}
    >
      <ProviderMark icon={ProviderIcon} />
      <SegmentText
        label={model.modelLabel}
        current={model.current}
        tierLabel={model.tierLabel}
        title={
          model.effortLabel === null
            ? undefined
            : `${model.modelLabel} · ${model.effortLabel}`
        }
      />
    </button>
  );

  return reason === null ? (
    button
  ) : (
    <ReasonTooltip reason={reason} reasonId={reasonId}>
      {button}
    </ReasonTooltip>
  );
}

function TrackGroup({
  group,
  favoritesFull,
  onPick,
  onKeep,
  onOpenModels,
}: {
  group: FavoriteGroup;
  favoritesFull: boolean;
  onPick: PickHandler;
  onKeep: KeepHandler;
  onOpenModels: () => void;
}) {
  const captionId = useId();

  return (
    <div
      role="group"
      aria-labelledby={captionId}
      data-favorite-group={group.key}
      className="flex shrink-0 items-center gap-px"
    >
      <button
        type="button"
        aria-label={`Change model (${group.modelLabel})`}
        aria-haspopup="dialog"
        onClick={onOpenModels}
        className={cn(
          "h-7 rounded-md outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
          LIST_HOVER_TRANSITION,
        )}
      >
        <FavoriteGroupCaption group={group} id={captionId} />
      </button>
      {group.segments.map((segment) =>
        segment.kind === "pick" ? (
          <TrackPickSegment key={segment.key} pick={segment} onPick={onPick} />
        ) : (
          <KeepSegment
            key="keep"
            selection={segment.selection}
            full={favoritesFull}
            onKeep={onKeep}
          />
        ),
      )}
    </div>
  );
}

function TrackChip({
  group,
  onPick,
}: {
  group: FavoriteGroup;
  onPick: PickHandler;
}) {
  const reasonId = useId();
  const { landing } = group;
  const firstPick = group.segments.find(isFavoritePick);

  const reason =
    landing === null && firstPick !== undefined
      ? favoriteUnavailableReason(firstPick.availability)
      : null;

  const button = (
    <button
      type="button"
      aria-label={favoriteActionLabel(group, landing)}
      aria-disabled={landing === null ? true : undefined}
      aria-describedby={reason === null ? undefined : reasonId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (landing !== null) onPick(landing.selection);
      }}
      className={cn(
        favoritePickClassName({
          current: false,
          pinned: true,
          ready: landing !== null,
        }),
        "gap-1 px-1",
      )}
    >
      <ProviderMark icon={group.icon} />
      <span
        title={
          landing === null
            ? undefined
            : `${group.modelLabel} · ${landing.effortLabel}`
        }
      >
        {group.modelLabel}
      </span>
      {group.startsNewChat ? (
        <Icon
          name="MessageSquarePlus"
          aria-hidden
          className="size-3 shrink-0 text-subtle-foreground"
        />
      ) : null}
    </button>
  );

  return (
    <div data-favorite-group={group.key} className="flex shrink-0 items-center">
      {reason === null ? (
        button
      ) : (
        <ReasonTooltip reason={reason} reasonId={reasonId}>
          {button}
        </ReasonTooltip>
      )}
    </div>
  );
}

function ProviderMark({ icon: ProviderIcon }: { icon: FavoriteGroup["icon"] }) {
  return ProviderIcon ? (
    <span aria-hidden className="flex shrink-0">
      <ProviderIcon className="size-4" />
    </span>
  ) : null;
}

function FavoriteGroupCaption({
  group,
  id,
}: {
  group: FavoriteGroup;
  id: string;
}) {
  return (
    <span
      id={id}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap pl-1.5 pr-1 text-xs",
        group.current ? "text-foreground" : "text-subtle-foreground",
      )}
    >
      <ProviderMark icon={group.icon} />
      <span className="min-w-0 truncate">{group.modelLabel}</span>
    </span>
  );
}

function favoritePickClassName({
  current,
  pinned,
  ready,
}: {
  current: boolean;
  pinned: boolean;
  ready: boolean;
}): string {
  return cn(
    SEGMENT_CLASS_NAME,
    "px-1.5",
    !current
      ? "text-muted-foreground"
      : pinned
        ? PRESSED_SEGMENT_CLASS_NAME
        : UNPINNED_SEGMENT_CLASS_NAME,
    ready ? !current && "hover:text-foreground" : "cursor-default opacity-60",
  );
}

function SegmentText({
  label,
  current,
  tierLabel,
  title,
}: {
  label: string;
  current: boolean;
  tierLabel: string | null;
  title?: string;
}) {
  return (
    <>
      <span className="grid justify-items-center" title={title}>
        <span
          className={cn("col-start-1 row-start-1", current && "font-medium")}
        >
          {label}
        </span>
        <span
          aria-hidden
          className="invisible col-start-1 row-start-1 font-medium"
        >
          {label}
        </span>
      </span>
      {tierLabel === null ? null : (
        <span
          role="img"
          aria-label={`${tierLabel} mode`}
          className="inline-flex shrink-0"
        >
          <Icon
            name="Zap"
            aria-hidden
            className="size-3 shrink-0 fill-current"
          />
        </span>
      )}
    </>
  );
}

function ReasonTooltip({
  reason,
  reasonId,
  children,
}: {
  reason: string;
  reasonId: string;
  children: ReactElement;
}) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} hidden>
        {reason}
      </span>
    </>
  );
}

function TrackPickSegment({
  pick,
  onPick,
}: {
  pick: FavoritePick;
  onPick: PickHandler;
}) {
  const reasonId = useId();
  const reason = favoriteUnavailableReason(pick.availability);

  const button = (
    <button
      type="button"
      aria-pressed={pick.current}
      aria-disabled={reason === null ? undefined : true}
      aria-describedby={reason === null ? undefined : reasonId}
      aria-label={
        pick.tierLabel === null
          ? undefined
          : `${pick.effortLabel}, ${pick.tierLabel}`
      }
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (reason === null) onPick(pick.selection);
      }}
      className={favoritePickClassName({
        current: pick.current,
        pinned: pick.pinned,
        ready: reason === null,
      })}
    >
      <SegmentText
        label={pick.effortLabel}
        current={pick.current}
        tierLabel={pick.tierLabel}
      />
    </button>
  );

  return reason === null ? (
    button
  ) : (
    <ReasonTooltip reason={reason} reasonId={reasonId}>
      {button}
    </ReasonTooltip>
  );
}

function KeepSegment({
  selection,
  full,
  onKeep,
}: {
  selection: FavoriteSelection;
  full: boolean;
  onKeep: KeepHandler;
}) {
  const reasonId = useId();

  const button = (
    <button
      type="button"
      aria-label="Add to favorites"
      aria-disabled={full ? true : undefined}
      aria-describedby={full ? reasonId : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (full) return;
        onKeep(selection, {
          focused: event.currentTarget === document.activeElement,
        });
      }}
      className={cn(
        FAVORITE_BAR_ICON_SEGMENT_CLASS_NAME,
        full && "cursor-default opacity-60 hover:text-subtle-foreground",
      )}
    >
      <Icon name="Star" aria-hidden className="size-3.5" />
    </button>
  );

  return full ? (
    <ReasonTooltip reason={FAVORITES_FULL_REASON} reasonId={reasonId}>
      {button}
    </ReasonTooltip>
  ) : (
    button
  );
}
