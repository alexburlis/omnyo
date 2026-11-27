import { reasoningLevelValues, type ReasoningLevel } from "@omnyo/domain";
import type { SystemExecutionOptionsModelLoadError } from "@omnyo/server-contract";
import type { FavoriteRow } from "./favorite-bars";
import type { ProviderPickerOption } from "./model-brand-prefix";
import type { ModelPickerNotice } from "./model-notice";
import type { ModelPickerOption } from "./model-picker-option";
import type { PickerOption } from "./OptionPicker";

export const MODEL_PICKER_MENU_WIDTH_CLASS_NAME =
  "w-max min-w-60 max-w-[min(28rem,calc(100vw-1rem))]";

const MODEL_PICKER_NAME_COLUMN_MIN_WIDTH = "5rem";

const MODEL_PICKER_STAR_COLUMN_WIDTH = "1.75rem";

export const MODEL_PICKER_ALL_MODELS_KEY = "all-models";

export function modelPickerGridTemplate(
  columnCount: number,
  starColumn: boolean,
): string {
  return [
    `minmax(${MODEL_PICKER_NAME_COLUMN_MIN_WIDTH}, 1fr)`,
    columnCount === 0 ? null : `repeat(${columnCount}, auto)`,
    starColumn ? MODEL_PICKER_STAR_COLUMN_WIDTH : null,
  ]
    .filter((track) => track !== null)
    .join(" ");
}

interface ModelLabelParts {
  base: string;
  tag: string | null;
}

export function splitModelLabelTag(label: string): ModelLabelParts {
  const match = label.match(/^(.*\S)\s*\(([^()]+)\)$/u);

  if (!match) {
    return { base: label, tag: null };
  }

  return { base: match[1], tag: match[2] };
}

export function modelPickerRowKey(providerId: string, model: string): string {
  return `${providerId}\0${model}`;
}

export function modelPickerMoreKey(providerId: string): string {
  return `more\0${providerId}`;
}

export function modelPickerFavoriteRowKey(
  providerId: string,
  model: string,
  serviceTier: string,
): string {
  return `favorite\0${providerId}\0${model}\0${serviceTier}`;
}

const ULTRA_COLUMN_LEVEL: ReasoningLevel = "ultra";

const ULTRA_COLUMN_LEVELS: readonly ReasoningLevel[] = ["ultracode", "ultra"];

const MODEL_PICKER_LEVEL_ORDER: readonly ReasoningLevel[] = [
  ...reasoningLevelValues.filter(
    (level) => !ULTRA_COLUMN_LEVELS.includes(level),
  ),
  ...ULTRA_COLUMN_LEVELS,
];

const ULTRA_COLUMN_RANK =
  MODEL_PICKER_LEVEL_ORDER.length - ULTRA_COLUMN_LEVELS.length;

export function modelPickerLevelRank(level: ReasoningLevel): number | null {
  const rank = MODEL_PICKER_LEVEL_ORDER.indexOf(level);

  return rank === -1 ? null : rank;
}

export function compareModelPickerLevels(
  a: ReasoningLevel,
  b: ReasoningLevel,
): number {
  const aRank = modelPickerLevelRank(a);
  const bRank = modelPickerLevelRank(b);

  if (aRank === null || bRank === null) {
    return aRank === bRank ? 0 : aRank === null ? 1 : -1;
  }

  return aRank - bRank;
}

export function sameModelPickerColumn(
  a: ReasoningLevel,
  b: ReasoningLevel,
): boolean {
  return (
    a === b ||
    (ULTRA_COLUMN_LEVELS.includes(a) && ULTRA_COLUMN_LEVELS.includes(b))
  );
}

function modelPickerColumnRank(level: ReasoningLevel): number | null {
  return ULTRA_COLUMN_LEVELS.includes(level)
    ? ULTRA_COLUMN_RANK
    : modelPickerLevelRank(level);
}

export function modelPickerLevelDistance(
  a: ReasoningLevel,
  b: ReasoningLevel,
): number {
  if (sameModelPickerColumn(a, b)) return 0;
  const aRank = modelPickerColumnRank(a);
  const bRank = modelPickerColumnRank(b);

  return aRank === null || bRank === null
    ? Number.POSITIVE_INFINITY
    : Math.abs(aRank - bRank);
}

export interface ModelPickerColumn {
  level: ReasoningLevel;
  levels: readonly ReasoningLevel[];
}

export function modelPickerColumns(
  rows: readonly (readonly ReasoningLevel[])[],
): ModelPickerColumn[] {
  const levels = new Set(rows.flat());

  const mergeUltra = !rows.some((row) =>
    ULTRA_COLUMN_LEVELS.every((level) => row.includes(level)),
  );

  const columns: ModelPickerColumn[] = [];

  for (const level of [...levels].sort(compareModelPickerLevels)) {
    const columnLevel =
      mergeUltra && ULTRA_COLUMN_LEVELS.includes(level)
        ? ULTRA_COLUMN_LEVEL
        : level;

    const index = columns.findIndex((column) => column.level === columnLevel);

    if (index !== -1) {
      columns[index] = {
        ...columns[index],
        levels: [...columns[index].levels, level],
      };
      continue;
    }

    columns.push({ level: columnLevel, levels: [level] });
  }

  return columns;
}

export type ModelPickerCellsMode = "all" | "favorites" | "reveal";

export type ModelPickerCellsRow =
  | { kind: "favorite" }
  | { kind: "row"; row: Pick<ModelPickerMatrixRow, "selected"> };

export function modelPickerCellsMode(
  entry: ModelPickerCellsRow,
  editing: boolean,
): ModelPickerCellsMode {
  if (entry.kind === "favorite") return "favorites";

  return editing || entry.row.selected ? "all" : "reveal";
}

export function stepRowReasoningLevel(
  options: readonly PickerOption<ReasoningLevel>[],
  current: ReasoningLevel,
  direction: 1 | -1,
): ReasoningLevel | null {
  const ordered = options
    .map((option) => option.value)
    .sort(compareModelPickerLevels);

  const index = ordered.indexOf(current);

  if (index < 0) return null;

  return ordered[index + direction] ?? null;
}

export interface ModelPickerMatrixRow {
  reasoningPending?: boolean;
  key: string;
  providerId: string;
  option: ModelPickerOption;
  label: string;
  hidden: boolean;
  selected: boolean;
  selectable: boolean;
  landingLevel: ReasoningLevel;
}

export interface ModelPickerMatrixMore {
  count: number;
  expanded: boolean;
  rows: readonly ModelPickerMatrixRow[];
}

export type ModelPickerMatrixBody =
  | { kind: "loading" }
  | { kind: "error"; error: SystemExecutionOptionsModelLoadError | null }
  | { kind: "empty" }
  | {
      kind: "rows";
      rows: readonly ModelPickerMatrixRow[];
      more: ModelPickerMatrixMore | null;
    };

export interface ModelPickerMatrixGroup {
  providerId: string;
  label: string;
  icon: ProviderPickerOption["icon"];
  installUrl: string | undefined;
  newChat: boolean;
  notice: ModelPickerNotice | null;
  body: ModelPickerMatrixBody;
}

export type ModelPickerNavEntry =
  | { kind: "favorite"; key: string; row: FavoriteRow }
  | { kind: "all"; key: string }
  | { kind: "row"; key: string; row: ModelPickerMatrixRow }
  | { kind: "more"; key: string; providerId: string };

function groupNavEntries(
  groups: readonly ModelPickerMatrixGroup[],
): ModelPickerNavEntry[] {
  return groups.flatMap((group): ModelPickerNavEntry[] => {
    if (group.body.kind !== "rows") return [];
    const { rows, more } = group.body;

    const entries: ModelPickerNavEntry[] = rows.map((row) => ({
      kind: "row",
      key: row.key,
      row,
    }));

    if (more === null) return entries;

    return [
      ...entries,
      {
        kind: "more",
        key: modelPickerMoreKey(group.providerId),
        providerId: group.providerId,
      },
      ...(more.expanded
        ? more.rows.map((row): ModelPickerNavEntry => ({
            kind: "row",
            key: row.key,
            row,
          }))
        : []),
    ];
  });
}

export function modelPickerNavEntries(
  favorites: readonly FavoriteRow[],
  allModels: boolean,
  groups: readonly ModelPickerMatrixGroup[],
): ModelPickerNavEntry[] {
  return [
    ...favorites.map((row): ModelPickerNavEntry => ({
      kind: "favorite",
      key: row.key,
      row,
    })),
    ...(allModels
      ? [{ kind: "all", key: MODEL_PICKER_ALL_MODELS_KEY } as const]
      : []),
    ...groupNavEntries(groups),
  ];
}

export function modelPickerVisibleRows(
  groups: readonly ModelPickerMatrixGroup[],
): ModelPickerMatrixRow[] {
  return groupNavEntries(groups).flatMap((entry) =>
    entry.kind === "row" ? [entry.row] : [],
  );
}
