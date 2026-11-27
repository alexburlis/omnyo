import { z } from "zod";
import type { Dataset } from "./source-contract";

export const datasetReadSchema = z
  .object({
    sourceId: z.string().min(1).max(40),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
    columns: z.array(z.string().min(1).max(80)).min(1).max(24).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export function datasetPage(dataset: Dataset, input: z.infer<typeof datasetReadSchema>) {
  if (input.expectedRevision !== undefined && input.expectedRevision !== dataset.revision)
    throw new Error("Dataset changed. Read its latest revision and restart pagination.");

  const columns = input.columns
    ? input.columns.map((key) => {
        const column = dataset.columns.find((entry) => entry.key === key);

        if (!column) throw new Error(`Unknown dataset column: ${key}`);

        return column;
      })
    : dataset.columns;

  const rows: Dataset["rows"] = [];
  let bytes = 0;

  for (const row of dataset.rows.slice(input.offset, input.offset + input.limit)) {
    const projected = Object.fromEntries(
      columns.map((column) => [column.key, row[column.key] ?? null]),
    );

    const size = Buffer.byteLength(JSON.stringify(projected));

    if (bytes + size > 30000) {
      if (!rows.length)
        throw new Error("One row exceeds the inspection limit. Select fewer columns.");
      break;
    }

    bytes += size;
    rows.push(projected);
  }

  const next = input.offset + rows.length;

  return {
    sourceId: dataset.sourceId,
    revision: dataset.revision,
    capturedAt: dataset.capturedAt,
    provenance: dataset.provenance,
    columns,
    rows,
    offset: input.offset,
    totalRows: dataset.rows.length,
    nextOffset: next < dataset.rows.length ? next : null,
  };
}
