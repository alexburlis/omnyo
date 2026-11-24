import { DEFAULT_SERVICE_TIER, type ReasoningLevel } from "@omnyo/domain";
import {
  favoriteKey,
  type FavoriteAvailability,
  type FavoriteDescription,
  type FavoriteLanding,
  type ModelFavoriteChipItem,
} from "./model-favorites";
import {
  compareModelPickerLevels,
  modelPickerFavoriteRowKey,
  modelPickerLevelDistance,
  modelPickerRowKey,
} from "./model-picker-menu";
import type { ModelPickerSelection } from "./model-picker-selection";
import type { PickerOption } from "./OptionPicker";

const READY: FavoriteAvailability = { state: "ready" };

const FIT_TOLERANCE_PX = 0.5;

const PILL = { kind: "pill" } as const;

type ProviderIcon = ModelFavoriteChipItem["icon"];

export type FavoriteSelection = Required<ModelPickerSelection>;

export interface CurrentPick {
  selection: FavoriteSelection;
  description: FavoriteDescription;
  icon: ProviderIcon;
  efforts: readonly PickerOption<ReasoningLevel>[];
  landOn: (providerId: string, model: string) => FavoriteLanding;
}

export interface FavoritePick {
  kind: "pick";
  key: string;
  selection: FavoriteSelection;
  effortLabel: string;
  tierLabel: string | null;
  current: boolean;
  pinned: boolean;
  availability: FavoriteAvailability;
}

export interface FavoriteKeep {
  kind: "keep";
  selection: FavoriteSelection;
}

export type FavoriteSegment = FavoritePick | FavoriteKeep;

export interface FavoriteGroup {
  key: string;
  providerId: string;
  model: string;
  modelLabel: string;
  icon: ProviderIcon;
  current: boolean;
  startsNewChat: boolean;
  segments: readonly FavoriteSegment[];
  landing: FavoritePick | null;
}

export interface FavoriteRow {
  key: string;
  modelLabel: string;
  icon: ProviderIcon;
  tierLabel: string | null;
  startsNewChat: boolean;
  current: boolean;
  picks: readonly FavoritePick[];
  landing: FavoritePick | null;
}

export type FavoriteOwner = Pick<FavoriteGroup, "modelLabel" | "startsNewChat">;

export interface FavoriteModel {
  key: string;
  modelLabel: string;
  icon: ProviderIcon;
  current: boolean;
  effortLabel: string | null;
  tierLabel: string | null;
  landing: FavoriteLanding;
  keep: FavoriteSelection | null;
}

export interface FittedGroup {
  key: string;
  current: boolean;
}

export type FavoriteBar<Group extends FittedGroup = FavoriteGroup> =
  | { kind: "track"; groups: readonly Group[]; hidden: number }
  | { kind: "pill" };

export interface FavoriteBars<Group extends FittedGroup = FavoriteGroup> {
  bar: FavoriteBar<Group>;
  all: readonly Group[];
}

export interface TrackWidths {
  available: number;
  fixed: number;
  overflow: number;
  groups: ReadonlyMap<string, number>;
}

export interface ShownGroups {
  available: number;
  keys: readonly string[];
}

export interface FavoriteBarsInput {
  favorites: readonly ModelFavoriteChipItem[];
  current: CurrentPick;
  providerOrder: readonly string[];
  widths: TrackWidths | null;
  shown: ShownGroups | null;
}

type GroupFrame = Pick<
  FavoriteGroup,
  "key" | "providerId" | "model" | "modelLabel" | "icon" | "startsNewChat"
>;

interface DraftGroup {
  frame: GroupFrame;
  picks: FavoritePick[];
}

interface RowFrame {
  providerId: string;
  modelLabel: string;
  icon: ProviderIcon;
  tierLabel: string | null;
  startsNewChat: boolean;
}

interface DraftRow extends RowFrame {
  modelOrder: number;
  picks: FavoritePick[];
}

interface FavoritePartition {
  inPlace: ModelFavoriteChipItem[];
  newChat: ModelFavoriteChipItem[];
}

export function buildFavoriteBars({
  favorites,
  current,
  providerOrder,
  widths,
  shown,
}: FavoriteBarsInput): FavoriteBars {
  const { inPlace, newChat } = partitionFavorites(favorites);
  const level = current.selection.reasoningLevel;

  const all = [
    ...(inPlace.length === 0
      ? [fallbackGroup(current)]
      : groupFavorites(inPlace, providerOrder, current, level)),
    ...groupFavorites(newChat, providerOrder, null, level),
  ];

  return fitted(all, widths, shown);
}

export function buildModelBars({
  favorites,
  current,
  providerOrder,
  widths,
  shown,
}: FavoriteBarsInput): FavoriteBars<FavoriteModel> {
  const { inPlace } = partitionFavorites(favorites);

  const all = groupFavorites(
    inPlace,
    providerOrder,
    current,
    current.selection.reasoningLevel,
  ).map((group) => favoriteModel(group, current));

  return fitted(all, widths, shown);
}

export function buildFavoriteRows(
  favorites: readonly ModelFavoriteChipItem[],
  providerOrder: readonly string[],
  level: ReasoningLevel,
  current: CurrentPick | null,
): FavoriteRow[] {
  const { inPlace, newChat } = partitionFavorites(favorites);

  const unpinned =
    current !== null && !favorites.some((item) => item.current)
      ? current
      : null;

  return [
    ...favoriteRows(inPlace, providerOrder, level, unpinned),
    ...favoriteRows(newChat, providerOrder, level, null),
  ];
}

export function favoriteLanding(
  picks: readonly FavoritePick[],
  level: ReasoningLevel,
): FavoritePick | null {
  const distance = (pick: FavoritePick) =>
    modelPickerLevelDistance(pick.selection.reasoningLevel, level);

  return (
    picks
      .filter((pick) => pick.availability.state === "ready")
      .sort((a, b) => distance(a) - distance(b) || comparePicks(a, b))[0] ??
    null
  );
}

export function favoriteActionLabel(
  owner: FavoriteOwner,
  pick: FavoritePick | null,
): string {
  const action = `${owner.startsNewChat ? "New chat with" : "Switch to"} ${owner.modelLabel}`;

  if (pick === null) return action;

  return [action, pick.effortLabel, pick.tierLabel]
    .filter((part) => part !== null)
    .join(", ");
}

export function isFavoritePick(
  segment: FavoriteSegment,
): segment is FavoritePick {
  return segment.kind === "pick";
}

function partitionFavorites(
  favorites: readonly ModelFavoriteChipItem[],
): FavoritePartition {
  const partition: FavoritePartition = { inPlace: [], newChat: [] };

  for (const item of favorites) {
    (item.startsNewChat ? partition.newChat : partition.inPlace).push(item);
  }

  return partition;
}

function currentFrame(current: CurrentPick): GroupFrame {
  return {
    key: modelPickerRowKey(
      current.selection.providerId,
      current.selection.model,
    ),
    providerId: current.selection.providerId,
    model: current.selection.model,
    modelLabel: current.description.modelLabel,
    icon: current.icon,
    startsNewChat: false,
  };
}

function itemFrame(item: ModelFavoriteChipItem): GroupFrame {
  return {
    key: modelPickerRowKey(item.favorite.providerId, item.favorite.model),
    providerId: item.favorite.providerId,
    model: item.favorite.model,
    modelLabel: item.description.modelLabel,
    icon: item.icon,
    startsNewChat: item.startsNewChat,
  };
}

function currentPickSegment(current: CurrentPick): FavoritePick {
  return {
    kind: "pick",
    key: favoriteKey(current.selection),
    selection: current.selection,
    effortLabel: current.description.reasoningLabel,
    tierLabel: null,
    current: true,
    pinned: false,
    availability: READY,
  };
}

function favoritePickSegment(item: ModelFavoriteChipItem): FavoritePick {
  return {
    kind: "pick",
    key: item.key,
    selection: item.selection,
    effortLabel: item.description.reasoningLabel,
    tierLabel: item.description.serviceTierLabel,
    current: item.current,
    pinned: true,
    availability: item.availability,
  };
}

function compareEfforts(
  a: PickerOption<ReasoningLevel>,
  b: PickerOption<ReasoningLevel>,
): number {
  return compareModelPickerLevels(a.value, b.value);
}

function tierRank(tierLabel: string | null): number {
  return tierLabel === null ? 0 : 1;
}

function comparePicks(a: FavoritePick, b: FavoritePick): number {
  return (
    compareModelPickerLevels(
      a.selection.reasoningLevel,
      b.selection.reasoningLevel,
    ) || tierRank(a.tierLabel) - tierRank(b.tierLabel)
  );
}

function fallbackGroup(current: CurrentPick): FavoriteGroup {
  const level = current.selection.reasoningLevel;

  const efforts = current.efforts.some((effort) => effort.value === level)
    ? current.efforts
    : [
        ...current.efforts,
        { value: level, label: current.description.reasoningLabel },
      ];

  const picks = [...efforts]
    .sort(compareEfforts)
    .map((effort): FavoritePick => {
      const selection = { ...current.selection, reasoningLevel: effort.value };

      return {
        kind: "pick",
        key: favoriteKey(selection),
        selection,
        effortLabel: effort.label,
        tierLabel: null,
        current: effort.value === level,
        pinned: false,
        availability: READY,
      };
    });

  return {
    ...currentFrame(current),
    current: true,
    segments: [...picks, { kind: "keep", selection: current.selection }],
    landing: favoriteLanding(picks, level),
  };
}

function providerRank(
  providerOrder: readonly string[],
  providerId: string,
): number {
  const index = providerOrder.indexOf(providerId);

  return index === -1 ? providerOrder.length : index;
}

function groupFavorites(
  favorites: readonly ModelFavoriteChipItem[],
  providerOrder: readonly string[],
  current: CurrentPick | null,
  level: ReasoningLevel,
): FavoriteGroup[] {
  const drafts = new Map<string, DraftGroup>();

  const place = (frame: GroupFrame, pick: FavoritePick) => {
    const draft = drafts.get(frame.key);

    if (draft === undefined) {
      drafts.set(frame.key, { frame, picks: [pick] });

      return;
    }

    draft.picks.push(pick);
  };

  for (const item of favorites) {
    place(itemFrame(item), favoritePickSegment(item));
  }

  const unpinned =
    current !== null && !favorites.some((item) => item.current)
      ? current
      : null;

  if (unpinned !== null) {
    place(currentFrame(unpinned), currentPickSegment(unpinned));
  }

  return [...drafts.values()]
    .sort(
      (a, b) =>
        providerRank(providerOrder, a.frame.providerId) -
        providerRank(providerOrder, b.frame.providerId),
    )
    .map(({ frame, picks }): FavoriteGroup => {
      const sorted = [...picks].sort(comparePicks);
      const holdsCurrent = sorted.some((pick) => pick.current);

      return {
        ...frame,
        current: holdsCurrent,
        segments:
          holdsCurrent && unpinned !== null
            ? [...sorted, { kind: "keep", selection: unpinned.selection }]
            : sorted,
        landing: favoriteLanding(sorted, level),
      };
    });
}

function favoriteRows(
  favorites: readonly ModelFavoriteChipItem[],
  providerOrder: readonly string[],
  level: ReasoningLevel,
  unpinned: CurrentPick | null,
): FavoriteRow[] {
  const drafts = new Map<string, DraftRow>();
  const modelOrder = new Map<string, number>();

  const place = (
    key: string,
    modelKey: string,
    frame: RowFrame,
    pick: FavoritePick,
  ) => {
    const order = modelOrder.get(modelKey) ?? modelOrder.size;
    const draft = drafts.get(key);
    modelOrder.set(modelKey, order);

    if (draft === undefined) {
      drafts.set(key, { ...frame, modelOrder: order, picks: [pick] });

      return;
    }

    draft.picks.push(pick);
  };

  for (const item of favorites) {
    const { providerId, model, serviceTier } = item.favorite;

    place(
      modelPickerFavoriteRowKey(providerId, model, serviceTier),
      modelPickerRowKey(providerId, model),
      {
        providerId,
        modelLabel: item.description.modelLabel,
        icon: item.icon,
        tierLabel: item.description.serviceTierLabel,
        startsNewChat: item.startsNewChat,
      },
      favoritePickSegment(item),
    );
  }

  if (unpinned !== null) {
    const { providerId, model } = unpinned.selection;

    place(
      modelPickerFavoriteRowKey(providerId, model, DEFAULT_SERVICE_TIER),
      modelPickerRowKey(providerId, model),
      {
        providerId,
        modelLabel: unpinned.description.modelLabel,
        icon: unpinned.icon,
        tierLabel: null,
        startsNewChat: false,
      },
      currentPickSegment(unpinned),
    );
  }

  return [...drafts]
    .sort(
      ([, a], [, b]) =>
        providerRank(providerOrder, a.providerId) -
          providerRank(providerOrder, b.providerId) ||
        a.modelOrder - b.modelOrder ||
        tierRank(a.tierLabel) - tierRank(b.tierLabel),
    )
    .map(([key, draft]): FavoriteRow => {
      const sorted = [...draft.picks].sort(comparePicks);

      return {
        key,
        modelLabel: draft.modelLabel,
        icon: draft.icon,
        tierLabel: draft.tierLabel,
        startsNewChat: draft.startsNewChat,
        current: sorted.some((pick) => pick.current),
        picks: sorted,
        landing: favoriteLanding(sorted, level),
      };
    });
}

function favoriteModel(
  group: FavoriteGroup,
  current: CurrentPick,
): FavoriteModel {
  const pinned = group.segments
    .filter(isFavoritePick)
    .some((pick) => pick.pinned);

  return {
    key: group.key,
    modelLabel: group.modelLabel,
    icon: group.icon,
    current: group.current,
    effortLabel: group.current ? current.description.reasoningLabel : null,
    tierLabel: group.current ? current.description.serviceTierLabel : null,
    landing: group.current
      ? { state: "ready", selection: current.selection }
      : current.landOn(group.providerId, group.model),
    keep: pinned ? null : current.selection,
  };
}

function fitted<Group extends FittedGroup>(
  all: readonly Group[],
  widths: TrackWidths | null,
  shown: ShownGroups | null,
): FavoriteBars<Group> {
  return {
    bar:
      widths === null
        ? { kind: "track", groups: all, hidden: 0 }
        : fitBar(all, widths, shown),
    all,
  };
}

function fitBar<Group extends FittedGroup>(
  groups: readonly Group[],
  widths: TrackWidths,
  previous: ShownGroups | null,
): FavoriteBar<Group> {
  const widthOf = (group: Group) => widths.groups.get(group.key) ?? 0;

  const widthOfAll = (list: readonly Group[]) =>
    list.reduce((total, group) => total + widthOf(group), 0);

  const track = (shown: readonly Group[]): FavoriteBar<Group> => ({
    kind: "track",
    groups: shown,
    hidden: groups.length - shown.length,
  });

  const roomy = widths.available - widths.fixed + FIT_TOLERANCE_PX;

  if (widthOfAll(groups) <= roomy) return track(groups);

  const budget = roomy - widths.overflow;

  const kept =
    previous === null || previous.available !== widths.available
      ? []
      : groups.filter((group) => previous.keys.includes(group.key));

  if (
    kept.length > 0 &&
    kept.length === previous?.keys.length &&
    kept.some((group) => group.current) &&
    widthOfAll(kept) <= budget
  ) {
    return track(kept);
  }

  const shown: Group[] = [];
  let used = 0;

  for (const group of groups) {
    if (used + widthOf(group) > budget) break;
    shown.push(group);
    used += widthOf(group);
  }

  const current = groups.find((group) => group.current);

  if (current !== undefined && !shown.includes(current)) {
    while (shown.length > 0 && used + widthOf(current) > budget) {
      const dropped = shown.pop();

      if (dropped !== undefined) used -= widthOf(dropped);
    }

    if (used + widthOf(current) > budget) return PILL;
    shown.push(current);
  }

  return shown.length === 0 ? PILL : track(shown);
}
