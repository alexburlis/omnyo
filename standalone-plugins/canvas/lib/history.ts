import { isDeepStrictEqual } from "node:util";
import type { PluginApi, JsonValue } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  historyEntrySchema,
  historySummaryEntrySchema,
  type HistorySummary,
  type CanvasHistory,
  type HistoryEntry,
  type MutationActor,
} from "../contract.ts";

type Database = ReturnType<PluginApi["storage"]["database"]>;

export type AuthorState = ReadonlyMap<string, ReadonlyMap<string, JsonValue>>;

const patchSchema = z.object({
  target: z.string(),
  field: z.string(),
  before: z.json(),
  after: z.json(),
  beforeMissing: z.boolean(),
  afterMissing: z.boolean(),
  beforeActor: z.enum(["human", "agent", "system"]),
  beforeWriter: z.number(),
  afterWriter: z.number(),
});

type Patch = z.infer<typeof patchSchema>;

const recordSchema = z.object({
  id: z.string(),
  revision: z.number(),
  actor: z.enum(["human", "agent", "system"]),
  label: z.string(),
  created_at: z.number(),
  state: z.enum(["applied", "undone"]),
  fields_json: z.string(),
  activity_revision: z.number(),
  activity_actor: z.enum(["human", "agent", "system"]),
  activity_action: z.enum(["edit", "undo", "redo"]),
  activity_at: z.number(),
});

type HistoryRecord = z.infer<typeof recordSchema>;

export class CanvasJournal {
  constructor(
    private readonly database: Database,
    private readonly snapshot: (threadId: string) => AuthorState,
    private readonly write: (
      threadId: string,
      patch: Patch,
      value: JsonValue,
      missing: boolean,
    ) => void,
    private readonly revision: (threadId: string) => number,
    private readonly bump: (threadId: string) => number,
    private readonly finish: (
      threadId: string,
      targets: readonly string[],
      revision: number,
    ) => void,
    private readonly error: (message: string) => Error,
  ) {}

  versions(threadId: string, target: string): Record<string, number> {
    const rows = z
      .array(z.object({ field: z.string(), version: z.number() }))
      .parse(
        this.database
          .prepare(
            "SELECT field, version FROM canvas_field_versions WHERE thread_id = ? AND target = ?",
          )
          .all(threadId, target),
      );

    return Object.fromEntries(rows.map((row) => [row.field, row.version]));
  }

  private writer(threadId: string, target: string, field: string): number {
    const row = this.database
      .prepare(
        "SELECT writer FROM canvas_field_versions WHERE thread_id = ? AND target = ? AND field = ?",
      )
      .get(threadId, target, field);

    return row === undefined ? 0 : z.object({ writer: z.number() }).parse(row).writer;
  }

  private writerActor(threadId: string, target: string, field: string): MutationActor {
    const row = this.database
      .prepare(
        "SELECT writer_actor FROM canvas_field_versions WHERE thread_id = ? AND target = ? AND field = ?",
      )
      .get(threadId, target, field);

    return row === undefined
      ? "system"
      : z.object({ writer_actor: z.enum(["human", "agent", "system"]) }).parse(row).writer_actor;
  }

  humanFields(threadId: string, target: string, fields: readonly string[]): string[] {
    return fields.filter((field) => this.writerActor(threadId, target, field) === "human");
  }

  private setWriter(
    threadId: string,
    patch: Patch,
    writer: number,
    actor: MutationActor,
    version: number,
  ): void {
    this.database
      .prepare(
        "INSERT INTO canvas_field_versions(thread_id, target, field, writer, version, writer_actor) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, target, field) DO UPDATE SET writer = excluded.writer, version = excluded.version, writer_actor = excluded.writer_actor",
      )
      .run(threadId, patch.target, patch.field, writer, version, actor);
  }

  run<Result extends { revision: number }>(
    threadId: string,
    label: string,
    actor: MutationActor,
    action: () => Result,
  ): Result & { changeId: string | null } {
    const previousRevision = this.revision(threadId);
    const unchanged = new Error("Unchanged Canvas operation");
    let noOp: Result | undefined;

    try {
      return this.database.transaction(() => {
        const before = this.snapshot(threadId);
        const result = action();
        const after = this.snapshot(threadId);
        const patches: Patch[] = [];

        for (const target of new Set([...before.keys(), ...after.keys()])) {
          const previous = before.get(target);
          const next = after.get(target);

          for (const field of new Set([...(previous?.keys() ?? []), ...(next?.keys() ?? [])])) {
            const left = previous?.get(field);
            const right = next?.get(field);

            if (isDeepStrictEqual(left, right)) continue;
            patches.push({
              target,
              field,
              before: left ?? null,
              after: right ?? null,
              beforeMissing: left === undefined,
              afterMissing: right === undefined,
              beforeActor: this.writerActor(threadId, target, field),
              beforeWriter: this.writer(threadId, target, field),
              afterWriter: result.revision,
            });
          }
        }

        if (patches.length === 0) {
          noOp = result;
          throw unchanged;
        }

        this.finish(threadId, [...new Set(patches.map((patch) => patch.target))], result.revision);
        const now = Date.now();
        const id = String(result.revision);
        this.database
          .prepare(
            "INSERT INTO canvas_history(thread_id, id, revision, actor, label, created_at, state, fields_json, activity_revision, activity_actor, activity_action, activity_at) VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, 'edit', ?)",
          )
          .run(
            threadId,
            id,
            result.revision,
            actor,
            label,
            now,
            JSON.stringify(patches),
            result.revision,
            actor,
            now,
          );

        for (const patch of patches)
          this.setWriter(threadId, patch, patch.afterWriter, actor, result.revision);
        this.database
          .prepare(
            "DELETE FROM canvas_history WHERE thread_id = ? AND id NOT IN (SELECT id FROM canvas_history WHERE thread_id = ? ORDER BY revision DESC LIMIT 200)",
          )
          .run(threadId, threadId);

        return { ...result, changeId: id };
      })();
    } catch (error) {
      if (error === unchanged && noOp !== undefined)
        return { ...noOp, revision: previousRevision, changeId: null };
      throw error;
    }
  }

  private records(threadId: string): HistoryRecord[] {
    return z
      .array(recordSchema)
      .parse(
        this.database
          .prepare("SELECT * FROM canvas_history WHERE thread_id = ? ORDER BY revision DESC")
          .all(threadId),
      );
  }

  private candidate(
    threadId: string,
    action: "undo" | "redo",
    changeId?: string,
  ): HistoryRecord | undefined {
    const row =
      changeId === undefined
        ? this.database
            .prepare(
              action === "undo"
                ? "SELECT * FROM canvas_history WHERE thread_id = ? AND state = ? ORDER BY revision DESC LIMIT 1"
                : "SELECT * FROM canvas_history WHERE thread_id = ? AND state = ? ORDER BY activity_revision DESC, revision DESC LIMIT 1",
            )
            .get(threadId, action === "undo" ? "applied" : "undone")
        : this.database
            .prepare("SELECT * FROM canvas_history WHERE thread_id = ? AND id = ?")
            .get(threadId, changeId);

    return row === undefined ? undefined : recordSchema.parse(row);
  }

  private conflicts(threadId: string, entry: HistoryRecord, action: "undo" | "redo"): string[] {
    const state = this.snapshot(threadId);

    return z
      .array(patchSchema)
      .parse(JSON.parse(entry.fields_json))
      .flatMap((patch) => {
        const expectedWriter = action === "undo" ? patch.afterWriter : patch.beforeWriter;
        const expected = action === "undo" ? patch.after : patch.before;
        const actual = state.get(patch.target)?.get(patch.field);

        const matchesValue =
          action === "redo" && patch.beforeMissing
            ? true
            : action === "undo" && patch.afterMissing
              ? actual === undefined
              : isDeepStrictEqual(actual, expected);

        return this.writer(threadId, patch.target, patch.field) === expectedWriter && matchesValue
          ? []
          : [`${patch.target}.${patch.field}`];
      });
  }

  summary(threadId: string, limit: number, offset: number): HistorySummary {
    const rows = z
      .array(
        recordSchema.omit({ fields_json: true }).extend({
          field_count: z.number().int().nonnegative(),
          targets_json: z.string(),
        }),
      )
      .parse(
        this.database
          .prepare(
            "SELECT id, revision, actor, label, created_at, state, activity_revision, activity_actor, activity_action, activity_at, json_array_length(fields_json) AS field_count, (SELECT json_group_array(target) FROM (SELECT DISTINCT json_extract(value, '$.target') AS target FROM json_each(fields_json))) AS targets_json FROM canvas_history WHERE thread_id = ? ORDER BY activity_revision DESC, revision DESC LIMIT ? OFFSET ?",
          )
          .all(threadId, limit, offset),
      );

    const entries = rows.map((entry) =>
      historySummaryEntrySchema.parse({
        id: entry.id,
        revision: entry.revision,
        actor: entry.actor,
        label: entry.label,
        createdAt: entry.created_at,
        state: entry.state,
        fieldCount: entry.field_count,
        targets: z.array(z.string()).parse(JSON.parse(entry.targets_json)),
        lastAction: entry.activity_action,
        lastActor: entry.activity_actor,
        lastActivityAt: entry.activity_at,
      }),
    );

    const undo = this.candidate(threadId, "undo");
    const redo = this.candidate(threadId, "redo");

    const count = z
      .object({ total: z.number().int().nonnegative() })
      .parse(
        this.database
          .prepare("SELECT COUNT(*) AS total FROM canvas_history WHERE thread_id = ?")
          .get(threadId),
      );

    return {
      entries,
      total: count.total,
      canUndo: undo !== undefined && this.conflicts(threadId, undo, "undo").length === 0,
      canRedo: redo !== undefined && this.conflicts(threadId, redo, "redo").length === 0,
    };
  }

  detail(threadId: string, changeId: string): HistoryEntry {
    const entry = this.candidate(threadId, "undo", changeId);

    if (entry === undefined) throw this.error(`History change ${changeId} is not retained`);

    return historyEntrySchema.parse({
      id: entry.id,
      revision: entry.revision,
      actor: entry.actor,
      label: entry.label,
      createdAt: entry.created_at,
      state: entry.state,
      fields: z.array(patchSchema).parse(JSON.parse(entry.fields_json)),
      lastAction: entry.activity_action,
      lastActor: entry.activity_actor,
      lastActivityAt: entry.activity_at,
    });
  }

  history(threadId: string): CanvasHistory {
    const entries: HistoryEntry[] = this.records(threadId).map((entry) =>
      historyEntrySchema.parse({
        id: entry.id,
        revision: entry.revision,
        actor: entry.actor,
        label: entry.label,
        createdAt: entry.created_at,
        state: entry.state,
        fields: z.array(patchSchema).parse(JSON.parse(entry.fields_json)),
        lastAction: entry.activity_action,
        lastActor: entry.activity_actor,
        lastActivityAt: entry.activity_at,
      }),
    );

    const undo = this.candidate(threadId, "undo");
    const redo = this.candidate(threadId, "redo");

    return {
      entries,
      canUndo: undo !== undefined && this.conflicts(threadId, undo, "undo").length === 0,
      canRedo: redo !== undefined && this.conflicts(threadId, redo, "redo").length === 0,
    };
  }

  apply(threadId: string, action: "undo" | "redo", actor: MutationActor, changeId?: string) {
    return this.database.transaction(() => {
      const entry = this.candidate(threadId, action, changeId);

      if (entry === undefined) throw this.error(`Nothing to ${action}`);

      if (entry.state !== (action === "undo" ? "applied" : "undone"))
        throw this.error(`Change ${entry.id} is already ${entry.state}`);
      const conflicts = this.conflicts(threadId, entry, action);

      if (conflicts.length > 0)
        throw this.error(`Cannot ${action}: later edits conflict with ${conflicts.join(", ")}`);
      const patches = z.array(patchSchema).parse(JSON.parse(entry.fields_json));
      const revision = this.bump(threadId);

      for (const patch of patches) {
        this.write(
          threadId,
          patch,
          action === "undo" ? patch.before : patch.after,
          action === "undo" && patch.beforeMissing,
        );
        this.setWriter(
          threadId,
          patch,
          action === "undo" ? patch.beforeWriter : patch.afterWriter,
          action === "undo" ? patch.beforeActor : entry.actor,
          revision,
        );
      }

      this.finish(threadId, [...new Set(patches.map((patch) => patch.target))], revision);
      this.database
        .prepare(
          "UPDATE canvas_history SET state = ?, activity_revision = ?, activity_actor = ?, activity_action = ?, activity_at = ? WHERE thread_id = ? AND id = ?",
        )
        .run(
          action === "undo" ? "undone" : "applied",
          revision,
          actor,
          action,
          Date.now(),
          threadId,
          entry.id,
        );

      return { revision, changeId: entry.id };
    })();
  }
}
