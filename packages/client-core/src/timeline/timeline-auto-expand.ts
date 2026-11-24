import {
  assertNever,
  findTimelineFrontierRow,
  hasTimelineExplorationIntent,
  isTimelineActivityRow,
  type ThreadTimelineViewRow,
  type TimelineViewWorkRow,
  type TimelineWorkSummaryChild,
} from "@omnyo/thread-view";
import { deferredTimelineContentItemId } from "./deferred-content.js";

interface CollectTimelineAutoExpansionRowIdsArgs {
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
}

export interface TimelineAutoExpansionRowIds {
  liveExpandedRowIds: ReadonlySet<string>;
}

function isWorkRowExpandable(row: TimelineViewWorkRow): boolean {
  switch (row.workKind) {
    case "web-search":
    case "web-fetch":
    case "approval":
      return false;
    case "image-generation":
      return row.status !== "pending" || Boolean(row.path || row.error);
    case "image-view":
      return true;
    case "question":
      return row.lifecycle === "answered" || row.lifecycle === "resolving";
    case "form":
      return (
        row.presentation.detail !== undefined &&
        row.presentation.detail.trim().length > 0
      );
    case "command":
      return !hasTimelineExplorationIntent(row);
    case "tool":
      return true;
    case "file-read":
    case "search":
      return false;
    case "plan-steps":
      return row.steps.length > 0;
    case "extension":
      return (
        row.presentation.detail !== undefined &&
        row.presentation.detail.trim().length > 0
      );
    case "file-change":
      return true;
    case "delegation":
      return (
        row.childRows === null ||
        row.childRows.length > 0 ||
        row.output.trim().length > 0
      );
    case "workflow":
      return (
        row.workflow !== null || row.summary !== null || row.error !== null
      );
    default:
      return assertNever(row);
  }
}

export function isRowExpandable(row: ThreadTimelineViewRow): boolean {
  switch (row.kind) {
    case "conversation":
      return false;
    case "system":
      return (
        !isTimelineActivityRow(row) &&
        (deferredTimelineContentItemId(row) !== null ||
          (row.detail !== null && row.detail.trim().length > 0))
      );
    case "bundle-summary":
    case "step-summary":
      return row.children.length > 0;
    case "turn":
      return true;
    case "work":
      return isWorkRowExpandable(row);
    default:
      return assertNever(row);
  }
}

export function isNonExpandableSummary(
  children: readonly TimelineWorkSummaryChild[],
): boolean {
  return (
    children.length > 0 && children.every((child) => !isRowExpandable(child))
  );
}

function shouldAutoExpandLiveFrontierRow(row: ThreadTimelineViewRow): boolean {
  if (!isRowExpandable(row)) {
    return false;
  }

  switch (row.kind) {
    case "system":
      return row.status === "pending";
    case "bundle-summary":
      return true;
    case "work":
      return (
        row.workKind === "delegation" ||
        row.workKind === "image-view" ||
        (row.workKind === "workflow" && row.status === "pending")
      );
    case "conversation":
    case "step-summary":
    case "turn":
      return false;
    default:
      return assertNever(row);
  }
}

function visitForLiveFrontierAutoExpand(
  rows: readonly ThreadTimelineViewRow[],
  scopeActive: boolean,
  ids: Set<string>,
): void {
  if (!scopeActive) {
    return;
  }

  const frontier = findTimelineFrontierRow(rows);

  if (frontier && shouldAutoExpandLiveFrontierRow(frontier)) {
    ids.add(frontier.id);
  }

  for (const row of rows) {
    if (
      row.kind === "work" &&
      row.workKind === "delegation" &&
      row.status === "pending" &&
      row.childRows !== null
    ) {
      visitForLiveFrontierAutoExpand(row.childRows, true, ids);
    }
  }
}

function visitRecentWorkRows(
  rows: readonly ThreadTimelineViewRow[],
  work: TimelineViewWorkRow[],
): void {
  for (const row of rows) {
    if (row.kind === "conversation" && row.role === "user") work.length = 0;

    if (
      row.kind === "work" &&
      (row.workKind === "command" || row.workKind === "tool")
    ) {
      if (isRowExpandable(row)) work.push(row);
    } else if (
      row.kind === "bundle-summary" ||
      row.kind === "step-summary" ||
      (row.kind === "turn" && row.status === "pending")
    ) {
      if (row.children !== null) visitRecentWorkRows(row.children, work);
    }
  }
}

export function collectTimelineAutoExpansionRowIds({
  rows,
  scopeActive,
}: CollectTimelineAutoExpansionRowIdsArgs): TimelineAutoExpansionRowIds {
  const liveExpandedRowIds = new Set<string>();
  visitForLiveFrontierAutoExpand(rows, scopeActive, liveExpandedRowIds);

  if (scopeActive) {
    const work: TimelineViewWorkRow[] = [];
    visitRecentWorkRows(rows, work);

    for (const row of work.slice(-2)) liveExpandedRowIds.add(row.id);
  }

  return {
    liveExpandedRowIds,
  };
}
