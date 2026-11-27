import { z } from "zod";
import {
  bentoColumns,
  flowLeaves,
  type Board,
  type CanvasNode,
  type CanvasHistory,
} from "../contract.ts";
import type { SourceState } from "../source-contract.ts";
import { islandGroups } from "./composition.ts";
import { CanvasError } from "./errors.ts";

export function describeBoard(board: Board | null): string {
  if (board === null) return "Canvas is off for this chat.";

  if (board.nodes.length === 0) return `Board revision ${board.revision}: empty.`;

  const lines = [`Board revision ${board.revision}, ${board.nodes.length} nodes`];

  if (board.composition) {
    const islands = islandGroups(board.composition.root);

    if (islands.length > 0) {
      lines.push("Islands, in reading order:");

      for (const island of islands)
        lines.push(
          `- ${island.id}: ${island.island.title}${island.island.question ? ` — ${island.island.question}` : ""} [${island.flow}${island.flow === "bento" ? ` ${island.columns ?? bentoColumns} columns` : ""}, ${island.island.accent ?? "neutral"}${island.island.offset ? ", moved by hand" : ""}] ${flowLeaves(
            island,
          )
            .map((leaf) => leaf.node)
            .join(", ")}`,
        );
    }

    lines.push(`Composition: ${JSON.stringify(board.composition)}`);
  }

  for (const section of board.sections) {
    lines.push(`## ${section}`);

    for (const node of board.nodes.filter((entry) => entry.section === section)) {
      const details = [
        node.kind,
        node.state,
        node.progress === null ? null : `${Math.round(node.progress * 100)}%`,
        node.tone === "neutral" ? null : node.tone,
        node.pinned ? "pinned" : null,
      ].filter((value) => value !== null);

      const excerpt = (node.body ?? node.href ?? "").replace(/\s+/gu, " ").slice(0, 80);

      lines.push(
        `- ${node.id} (${details.join(", ")}) ${node.title ?? ""}${excerpt ? ` — ${excerpt}` : ""}`,
      );
    }
  }

  for (const edge of board.edges)
    lines.push(`${edge.from} → ${edge.to}${edge.label === null ? "" : ` (${edge.label})`}`);

  return lines.join("\n");
}

export function describeNode(node: CanvasNode): string {
  const lines = [
    `Canvas node "${node.id}" (${node.kind}) in section ${node.section}: ${node.title ?? "untitled"}`,
  ];

  if (node.state !== null) lines.push(`State: ${node.state}`);

  if (node.options.length > 0) lines.push(`Options: ${node.options.join(" | ")}`);

  if (node.href !== null) lines.push(`Link: ${node.href}`);

  if (node.body !== null) lines.push(node.body.slice(0, 4000));

  if (node.html !== null) lines.push(`HTML source:\n${node.html.slice(0, 12000)}`);

  if (node.binding) lines.push(`Binding: ${JSON.stringify(node.binding)}`);
  lines.push("Use canvas_inspect for field versions and current render evidence before editing.");

  return lines.join("\n");
}

export const historyRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(20).default(10),
    changeId: z.string().optional(),
    fieldOffset: z.number().int().nonnegative().default(0),
  })
  .strict();

export function sourcePreview(state: SourceState) {
  const { config: _config, ...definition } = state.source.definition;
  const columns = state.dataset?.columns.slice(0, 8) ?? [];

  return {
    source: { ...state.source, definition },
    dataset:
      state.dataset === null
        ? null
        : {
            ...state.dataset,
            columns,
            rows: state.dataset.rows.slice(0, 5).map((row) =>
              Object.fromEntries(
                columns.map((column) => {
                  const value = row[column.key] ?? null;
                  const text = z.string().safeParse(value);

                  return [column.key, text.success ? text.data.slice(0, 80) : value];
                }),
              ),
            ),
            rowCount: state.dataset.rows.length,
            columnCount: state.dataset.columns.length,
            preview: true,
          },
  };
}

export function historyPreview(
  history: CanvasHistory,
  input: z.infer<typeof historyRequestSchema>,
) {
  if (input.changeId !== undefined) {
    const entry = history.entries.find((value) => value.id === input.changeId);

    if (entry === undefined)
      throw new CanvasError(`History change ${input.changeId} is not retained`);
    const fields = [];
    let bytes = 0;

    for (const field of entry.fields.slice(input.fieldOffset)) {
      const size = Buffer.byteLength(JSON.stringify(field));

      if (fields.length > 0 && bytes + size > 650000) break;
      fields.push(field);
      bytes += size;

      if (fields.length === 20) break;
    }

    const next = input.fieldOffset + fields.length;

    return {
      entries: [{ ...entry, fields, fieldCount: entry.fields.length }],
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      totalEntries: history.entries.length,
      fullDetail: true,
      nextFieldOffset: next < entry.fields.length ? next : null,
    };
  }

  return {
    entries: history.entries.slice(0, input.limit).map((entry) => ({
      ...entry,
      fieldCount: entry.fields.length,
      fields: entry.fields.slice(0, 10).map((field) => ({
        ...field,
        before: JSON.stringify(field.before).slice(0, 250),
        after: JSON.stringify(field.after).slice(0, 250),
      })),
    })),
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    totalEntries: history.entries.length,
    fullDetail: false,
  };
}
