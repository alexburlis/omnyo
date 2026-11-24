import { isRowExpandable } from "@omnyo/client-core";
import type { ThreadTimelineViewRow } from "@omnyo/thread-view";

function visitLiveRows(
  rows: readonly ThreadTimelineViewRow[],
  ids: Set<string>,
): void {
  let firstLiveIndex = rows.length;

  while (firstLiveIndex > 0) {
    const row = rows[firstLiveIndex - 1];

    if (
      row?.kind === "conversation" &&
      (row.role === "assistant" || row.turnRequest.status !== "pending")
    ) {
      break;
    }

    firstLiveIndex -= 1;
  }

  for (let index = firstLiveIndex; index < rows.length; index += 1) {
    const row = rows[index];

    if (
      row === undefined ||
      row.kind === "conversation" ||
      row.status !== "pending" ||
      !isRowExpandable(row)
    ) {
      continue;
    }

    ids.add(row.id);

    if (
      row.kind === "bundle-summary" ||
      row.kind === "step-summary" ||
      row.kind === "turn"
    ) {
      if (row.children !== null) visitLiveRows(row.children, ids);
    } else if (
      row.kind === "work" &&
      row.workKind === "delegation" &&
      row.childRows !== null
    ) {
      visitLiveRows(row.childRows, ids);
    }
  }
}

export function collectLiveTimelineExpansionRowIds({
  rows,
  scopeActive,
}: {
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
}): ReadonlySet<string> {
  const liveExpandedRowIds = new Set<string>();

  if (scopeActive) visitLiveRows(rows, liveExpandedRowIds);

  return liveExpandedRowIds;
}
