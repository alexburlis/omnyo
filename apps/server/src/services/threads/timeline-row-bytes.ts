import type { TimelineRow } from "@omnyo/server-contract";

const bytesByRows = new WeakMap<readonly TimelineRow[], number>();

export function timelineRowsEnvelopeByteLength(value: {
  rows: readonly TimelineRow[];
}): number {
  let rowsBytes = bytesByRows.get(value.rows);

  if (rowsBytes === undefined) {
    rowsBytes = Buffer.byteLength(JSON.stringify(value.rows), "utf8");
    bytesByRows.set(value.rows, rowsBytes);
  }

  return (
    Buffer.byteLength(JSON.stringify({ ...value, rows: [] }), "utf8") +
    rowsBytes -
    2
  );
}
