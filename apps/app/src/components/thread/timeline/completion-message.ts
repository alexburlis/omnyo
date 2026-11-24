import type { ThreadWorkSummary } from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";

export function selectCompletionMessageId(
  rows: readonly TimelineRow[],
  work: ThreadWorkSummary,
): string | null {
  const sourceSeq = work.assessment.sourceSeq;

  if (
    sourceSeq === null ||
    !work.archive.recommended ||
    !work.archive.eligible ||
    work.assessment.availability !== "available"
  )
    return null;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];

    if (
      row?.kind === "turn" ||
      (row?.kind === "conversation" && row.role === "user")
    )
      return null;

    if (row?.kind !== "conversation" || row.role !== "assistant") continue;

    if (row.status === "streaming" || row.sourceSeqEnd > sourceSeq) return null;

    return row.id;
  }

  return null;
}
