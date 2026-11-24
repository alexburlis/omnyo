import type { ThreadTimelineViewRow } from "@omnyo/thread-view";

export const PAST_ROW_DIM_CLASS_NAME = "opacity-40";

export function isActiveLatestBundleSummary({
  activeLatestBundleId,
  row,
  scopeActive,
}: {
  activeLatestBundleId: string | null;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
}): boolean {
  return (
    row.kind === "bundle-summary" &&
    row.status === "pending" &&
    scopeActive &&
    row.id === activeLatestBundleId
  );
}

export function pastRowDimClassName(args: {
  activeLatestBundleId: string | null;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
}): string | undefined {
  if (isActiveLatestBundleSummary(args)) return undefined;
  const { row } = args;

  switch (row.kind) {
    case "system":
      if (
        row.systemKind === "operation" &&
        (row.operationKind === "warning" || row.operationKind === "deprecation")
      )
        return undefined;

      return row.status === "completed" ? PAST_ROW_DIM_CLASS_NAME : undefined;
    case "work":
    case "turn":
    case "bundle-summary":
    case "step-summary":
      return row.status === "completed" ? PAST_ROW_DIM_CLASS_NAME : undefined;
    case "conversation":
      return undefined;
  }
}
