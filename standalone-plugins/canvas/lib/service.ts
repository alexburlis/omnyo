import { linkedBoardKeys, publishProjectChange } from "./board-notifications.ts";
import { CanvasError } from "./errors.ts";
import { isDeepStrictEqual } from "node:util";
import { canvasMigrations, boardTables } from "./storage.ts";
import { createHash } from "node:crypto";
import type { PluginApi, JsonValue } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  compositionSchema,
  isIsland,
  nodeExtrasSchema,
  nodeFieldsSchema,
  type EditInput,
  type MutationActor,
  type NodeInspection,
  flowLeaves,
  nodeKinds,
  nodeTones,
  realtimeChannel,
  statusStates,
  type Board,
  type ComposeInput,
  type Composition,
  type CanvasEdge,
  type CanvasMode,
  type CanvasNode,
  type NodeFields,
  type NodeInput,
  starters,
  type Starter,
  type UpdateInput,
} from "../contract.ts";
import { CanvasJournal, type AuthorState } from "./history.ts";
import {
  boardKeySchema,
  boardReferenceSchema,
  type BoardKey,
  type BoardReference,
} from "../project-contract.ts";
import {
  assemble,
  compositionNotes,
  decompose,
  islandGroups,
  placeholderIds,
  placeIsland,
  type Decomposition,
} from "./composition.ts";

export const maxActiveNodes = 200;

export const maxMediaBytes = 20 * 1024 * 1024;

const defaultSection = "Notes";

export const offMessage =
  "Canvas is off for this chat. Turn it on with omnyo canvas on, or ask the user to switch on Canvas in the composer.";

export function movedMessage(chat: string): string {
  return `Canvas is off for this chat: its board moved to chat ${chat}, which continues this work. Change the board from that chat, or run omnyo canvas on to start a new board here.`;
}

const threadRowSchema = z.object({ revision: z.number(), seen_revision: z.number() });

const modeRowSchema = threadRowSchema.extend({
  enabled: z.number(),
  started_by: z.enum(starters),
  moved_to: z.string().nullable(),
  carried_from: z.string().nullable(),
});

const nodeRowSchema = z.object({
  id: z.string(),
  kind: z.enum(nodeKinds),
  ord: z.number(),
  section: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  tone: z.enum(nodeTones),
  pinned: z.number(),
  wide: z.number(),
  href: z.string().nullable(),
  language: z.string().nullable(),
  html: z.string().nullable(),
  options_json: z.string(),
  recommended: z.string().nullable(),
  progress: z.number().nullable(),
  state: z.enum(statusStates).nullable(),
  asset_id: z.string().nullable(),
  archived: z.number(),
  extras_json: z.string(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  created_revision: z.number(),
  updated_revision: z.number(),
  updated_at: z.number(),
});

type NodeRow = z.infer<typeof nodeRowSchema>;

const edgeRowSchema = z.object({
  from_id: z.string(),
  to_id: z.string(),
  label: z.string().nullable(),
});

const sectionRowSchema = z.object({ name: z.string() });

const assetRowSchema = z.object({ mime: z.string(), content: z.instanceof(Buffer) });

const assetMetadataSchema = z.object({
  mime: z.string(),
  byteLength: z.number().int().nonnegative(),
});

const countSchema = z.object({ count: z.number() });

const movedThreadSchema = z.object({
  started_by: z.enum(starters),
  revision: z.number(),
  seen_revision: z.number(),
  composition_json: z.string().nullable(),
  layout_json: z.string().nullable(),
  islands_json: z.string().nullable(),
});

function rawExtras(row: NodeRow): Record<string, JsonValue> {
  return z.record(z.string(), z.json()).parse(JSON.parse(row.extras_json));
}

function extras(row: NodeRow) {
  const raw = rawExtras(row);

  return nodeExtrasSchema.parse(
    Object.fromEntries(
      nodeExtrasSchema
        .keyof()
        .options.filter((key) => key in raw)
        .map((key) => [key, raw[key]]),
    ),
  );
}

function toNode(row: NodeRow): CanvasNode {
  return {
    ...extras(row),
    id: row.id,
    kind: row.kind,
    order: row.ord,
    section: row.section,
    title: row.title,
    body: row.body,
    tone: row.tone,
    pinned: row.pinned === 1,
    wide: row.wide === 1,
    href: row.href,
    language: row.language,
    html: row.html,
    options: z.array(z.string()).parse(JSON.parse(row.options_json)),
    recommended: row.recommended,
    progress: row.progress,
    state: row.state,
    assetId: row.asset_id,
    position: row.x === null || row.y === null ? null : { x: row.x, y: row.y },
    createdRevision: row.created_revision,
    updatedRevision: row.updated_revision,
    updatedAt: row.updated_at,
  };
}

export function mediaMime(bytes: Buffer): string {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";

  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";

  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)))
    return "image/gif";

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";

  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") return "video/mp4";

  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return "video/webm";

  throw new CanvasError("Unsupported file. Use PNG, JPEG, GIF, WebP, MP4, MOV or WebM.");
}

function canvasAttempt<Value>(action: () => Value): Value {
  try {
    return action();
  } catch (error) {
    if (error instanceof CanvasError) throw error;

    if (error instanceof z.ZodError)
      throw new CanvasError(error.issues.map((issue) => issue.message).join("; "));

    throw new CanvasError(error instanceof Error ? error.message : "The arrangement is invalid");
  }
}

function changedLayoutFields(
  before: Decomposition,
  after: Decomposition,
): [target: string, field: string, name: string][] {
  const changed: [string, string, string][] = [];

  if (!isDeepStrictEqual(before.skeleton, after.skeleton))
    changed.push(["board", "composition", "composition"]);

  for (const id of new Set([...before.islands.keys(), ...after.islands.keys()]))
    if (!isDeepStrictEqual(before.islands.get(id), after.islands.get(id)))
      changed.push([`island:${id}`, "layout", `island ${id}`]);

  return changed;
}

function composeLabel(before: Composition | null, after: Composition | null): string {
  const changed = changedLayoutFields(decompose(before), decompose(after));

  if (changed.length !== 1 || changed[0]?.[0] === "board") return "Arrange modules";

  const id = changed[0]?.[0].slice(7);

  const previous =
    before === null ? undefined : islandGroups(before.root).find((entry) => entry.id === id);

  const next =
    after === null ? undefined : islandGroups(after.root).find((entry) => entry.id === id);

  if (previous === undefined || next === undefined) return "Arrange modules";
  const { offset: previousOffset, ...previousRest } = previous.island;
  const { offset: nextOffset, ...nextRest } = next.island;

  return isDeepStrictEqual(
    z.json().parse(JSON.parse(JSON.stringify({ ...previous, island: previousRest }))),
    z.json().parse(JSON.parse(JSON.stringify({ ...next, island: nextRest }))),
  ) &&
    !isDeepStrictEqual(z.json().parse(previousOffset ?? null), z.json().parse(nextOffset ?? null))
    ? `Move ${next.island.title}`
    : `Arrange ${next.island.title}`;
}

export class CanvasService {
  private readonly pending = new Map<string, number>();
  private signalTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly journal: CanvasJournal;

  constructor(private readonly api: PluginApi) {
    api.storage.migrate(api.storage.database(), canvasMigrations);
    this.journal = new CanvasJournal(
      this.database(),
      (threadId) => this.authorState(threadId),
      (threadId, patch, value, missing) =>
        this.writeAuthorField(threadId, patch.target, patch.field, value, missing),
      (threadId) => this.requireCanvas(threadId).revision,
      (threadId) => this.bump(threadId),
      (threadId, targets, revision) => this.finishHistory(threadId, targets, revision),
      (message) => new CanvasError(message),
    );
    api.onDispose(() => {
      if (this.signalTimer !== undefined) clearTimeout(this.signalTimer);
      this.pending.clear();
    });
  }

  private database() {
    return this.api.storage.database();
  }

  resolveBoard(reference: BoardKey | BoardReference): BoardKey {
    let key = z
      .union([
        boardKeySchema,
        boardReferenceSchema.transform((address) =>
          "sectionId" in address ? address.sectionId : address.threadId,
        ),
      ])
      .parse(reference);

    const visited = new Set<string>();

    while (true) {
      if (visited.has(key)) throw new CanvasError("Canvas board links form a cycle");
      visited.add(key);

      const row = this.database()
        .prepare("SELECT board_key FROM canvas_board_aliases WHERE old_key = ?")
        .get(key);

      if (row === undefined) {
        const link = this.database()
          .prepare(
            "SELECT region_id FROM canvas_chats WHERE thread_id = ? AND region_id IS NOT NULL",
          )
          .get(key);

        return link === undefined ? key : z.object({ region_id: z.string() }).parse(link).region_id;
      }

      key = z.object({ board_key: z.string() }).parse(row).board_key;
    }
  }

  assertWritable(board: BoardKey, actor: MutationActor): void {
    const row = this.database()
      .prepare(
        "SELECT r.locked,r.archived_at,p.archived_at AS project_archived_at FROM canvas_regions r JOIN canvas_projects p ON p.project_id=r.project_id WHERE r.id=?",
      )
      .get(board);

    if (row === undefined) {
      if (board.startsWith("sec_")) throw new CanvasError("Canvas section not found");

      return;
    }

    const section = z
      .object({
        locked: z.number(),
        archived_at: z.number().nullable(),
        project_archived_at: z.number().nullable(),
      })
      .parse(row);

    if (section.project_archived_at !== null)
      throw new CanvasError("This project canvas is archived");

    if (section.archived_at !== null)
      throw new CanvasError("This Canvas section is archived; restore it before editing");

    if (actor === "agent" && section.locked === 1)
      throw new CanvasError("This Canvas section is locked for agents");
  }

  private notify(threadId: string, revision: number): void {
    this.pending.set(threadId, revision);

    if (this.signalTimer !== undefined) return;
    this.signalTimer = setTimeout(() => {
      this.signalTimer = undefined;

      for (const [id, value] of this.pending) {
        for (const key of linkedBoardKeys(this.database(), id))
          this.api.realtime.publish(realtimeChannel, { threadId: key, revision: value });

        publishProjectChange(this.api, id);
      }

      this.pending.clear();
    }, 50);
  }

  enable(threadId: string, startedBy: Starter): boolean {
    const result = this.database()
      .prepare(
        "INSERT INTO canvas_threads(thread_id, created_at, started_by) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET enabled = 1, started_by = excluded.started_by, moved_to = NULL WHERE enabled = 0",
      )
      .run(threadId, Date.now(), startedBy);

    if (result.changes === 1) this.notify(threadId, this.requireCanvas(threadId).revision);

    return result.changes === 1;
  }

  disable(threadId: string): CanvasMode {
    const result = this.database()
      .prepare("UPDATE canvas_threads SET enabled = 0 WHERE thread_id = ? AND enabled = 1")
      .run(threadId);

    if (result.changes === 1) this.notify(threadId, this.mode(threadId).revision);

    return { canvas: false, unseen: false, startedBy: null, movedTo: null };
  }

  private mode(threadId: string) {
    const row = this.database()
      .prepare(
        "SELECT enabled, started_by, revision, seen_revision, moved_to, carried_from FROM canvas_threads WHERE thread_id = ?",
      )
      .get(threadId);

    return row === undefined
      ? {
          enabled: 0,
          started_by: "user" as const,
          revision: 0,
          seen_revision: 0,
          moved_to: null,
          carried_from: null,
        }
      : modeRowSchema.parse(row);
  }

  status(threadId: string): CanvasMode {
    const row = this.mode(threadId);

    return {
      canvas: row.enabled === 1,
      unseen: row.enabled === 1 && row.revision > row.seen_revision,
      startedBy: row.enabled === 1 ? row.started_by : null,
      movedTo: row.enabled === 1 ? null : row.moved_to,
    };
  }

  moveBoard(from: string, to: string, moveSources: () => number) {
    return this.transfer(from, to, moveSources, from);
  }

  returnBoard(from: string, to: string, moveSources: () => number) {
    return this.transfer(from, to, moveSources, this.mode(to).carried_from);
  }

  private transfer(
    from: string,
    to: string,
    moveSources: () => number,
    carriedFrom: string | null,
  ) {
    if (from === to) throw new CanvasError("Name the other chat whose board should move here");

    const source = movedThreadSchema
      .nullable()
      .parse(
        this.database()
          .prepare(
            "SELECT started_by, revision, seen_revision, composition_json, layout_json, islands_json FROM canvas_threads WHERE thread_id = ?",
          )
          .get(from) ?? null,
      );

    const modules = this.activeCount(from);

    if (source === null || (modules === 0 && !from.startsWith("sec_")))
      throw new CanvasError(`Chat ${from} has no Canvas board to move`);
    const target = this.mode(to);

    for (const table of boardTables) {
      const row = this.database()
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE thread_id = ?`)
        .get(to);

      if (countSchema.parse(row).count > 0)
        throw new CanvasError(
          "This chat already has a board. Move a board only into a chat whose Canvas is empty.",
        );
    }

    const revision = Math.max(source.revision, target.revision) + 1;
    const seen = source.seen_revision >= source.revision ? revision : source.seen_revision;

    const sources = this.database().transaction(() => {
      this.database()
        .prepare(
          "INSERT INTO canvas_threads(thread_id, created_at, started_by) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET enabled = 1",
        )
        .run(to, Date.now(), source.started_by);

      for (const table of boardTables)
        this.database()
          .prepare(`UPDATE ${table} SET thread_id = ? WHERE thread_id = ?`)
          .run(to, from);
      this.database()
        .prepare("UPDATE canvas_threads SET moved_to = ? WHERE moved_to = ? AND thread_id <> ?")
        .run(to, from, to);
      this.database()
        .prepare(
          "UPDATE canvas_threads SET started_by = ?, revision = ?, seen_revision = ?, composition_json = ?, layout_json = ?, islands_json = ?, moved_to = NULL, carried_from = ? WHERE thread_id = ?",
        )
        .run(
          source.started_by,
          revision,
          seen,
          source.composition_json,
          source.layout_json,
          source.islands_json,
          carriedFrom,
          to,
        );
      this.database()
        .prepare(
          "UPDATE canvas_threads SET enabled = 0, revision = revision + 1, composition_json = NULL, layout_json = NULL, islands_json = NULL, moved_to = ? WHERE thread_id = ?",
        )
        .run(to, from);

      return moveSources();
    })();

    this.notify(to, revision);
    this.notify(from, source.revision + 1);

    return { from, to, revision, modules, sources };
  }

  isCanvas(threadId: string): boolean {
    return this.mode(threadId).enabled === 1;
  }

  hasLiveBoard(threadId: string): boolean {
    return this.isCanvas(threadId) && this.activeCount(threadId) > 0;
  }

  returnTarget(threadId: string): string | null {
    const origin = this.mode(threadId).carried_from;

    if (origin === null || !this.hasLiveBoard(threadId)) return null;
    const home = this.mode(origin);

    return home.enabled === 0 && home.moved_to === threadId ? origin : null;
  }

  private requireCanvas(threadId: string) {
    const row = this.mode(threadId);

    if (row.enabled !== 1)
      throw new CanvasError(row.moved_to === null ? offMessage : movedMessage(row.moved_to));

    return row;
  }

  private bump(threadId: string): number {
    const { revision } = this.requireCanvas(threadId);
    const next = revision + 1;

    this.database()
      .prepare("UPDATE canvas_threads SET revision = ? WHERE thread_id = ?")
      .run(next, threadId);

    return next;
  }

  private node(threadId: string, id: string): NodeRow | null {
    const row = this.database()
      .prepare("SELECT * FROM nodes WHERE thread_id = ? AND id = ? AND archived = 0")
      .get(threadId, id);

    return row === undefined ? null : nodeRowSchema.parse(row);
  }

  private requireNode(threadId: string, id: string): NodeRow {
    const row = this.node(threadId, id);

    if (row === null)
      throw new CanvasError(`No node "${id}" on this board. Read the board with canvas_show.`);

    return row;
  }

  private lastSection(threadId: string): string {
    const row = this.database()
      .prepare(
        "SELECT section AS name FROM nodes WHERE thread_id = ? AND archived = 0 ORDER BY created_revision DESC, ord DESC LIMIT 1",
      )
      .get(threadId);

    return row === undefined ? defaultSection : sectionRowSchema.parse(row).name;
  }

  private ensureSection(threadId: string, name: string): void {
    this.database()
      .prepare(
        "INSERT OR IGNORE INTO sections(thread_id, name, ord) VALUES (?, ?, (SELECT COALESCE(MAX(ord), 0) + 1 FROM sections WHERE thread_id = ?))",
      )
      .run(threadId, name, threadId);
  }

  private nextOrder(threadId: string, after: NodeRow | null): number {
    if (after !== null) {
      const row = this.database()
        .prepare(
          "SELECT MIN(ord) AS next FROM nodes WHERE thread_id = ? AND section = ? AND ord > ? AND archived = 0",
        )
        .get(threadId, after.section, after.ord);

      const next = z.object({ next: z.number().nullable() }).parse(row).next;

      return next === null ? after.ord + 1 : (after.ord + next) / 2;
    }

    const row = this.database()
      .prepare("SELECT COALESCE(MAX(ord), 0) AS last FROM nodes WHERE thread_id = ?")
      .get(threadId);

    return z.object({ last: z.number() }).parse(row).last + 1;
  }

  private freeId(threadId: string): string {
    const row = this.database()
      .prepare("SELECT COUNT(*) AS count FROM nodes WHERE thread_id = ?")
      .get(threadId);

    let index = countSchema.parse(row).count + 1;

    while (
      this.database()
        .prepare("SELECT 1 FROM nodes WHERE thread_id = ? AND id = ?")
        .get(threadId, `n${index}`) !== undefined
    )
      index += 1;

    return `n${index}`;
  }

  private activeCount(threadId: string): number {
    const row = this.database()
      .prepare("SELECT COUNT(*) AS count FROM nodes WHERE thread_id = ? AND archived = 0")
      .get(threadId);

    return countSchema.parse(row).count;
  }

  private insert(
    threadId: string,
    revision: number,
    input: NodeInput,
    assetId: string | null,
  ): string {
    const id = input.id ?? this.freeId(threadId);

    if (
      this.database()
        .prepare("SELECT 1 FROM nodes WHERE thread_id = ? AND id = ?")
        .get(threadId, id) !== undefined
    )
      throw new CanvasError(`Node "${id}" already exists. Use canvas_update to change it.`);

    const after = input.after === undefined ? null : this.requireNode(threadId, input.after);
    const section = input.section ?? after?.section ?? this.lastSection(threadId);

    this.ensureSection(threadId, section);
    this.database()
      .prepare(
        `INSERT INTO nodes(thread_id, id, kind, ord, section, title, body, tone, pinned, wide, href, language, html, options_json, recommended, progress, state, asset_id, created_revision, updated_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        id,
        input.kind,
        this.nextOrder(threadId, after),
        section,
        input.title ?? null,
        input.body ?? null,
        input.tone ?? "neutral",
        input.pinned === true ? 1 : 0,
        (input.wide ?? (input.kind === "image" || input.kind === "video")) ? 1 : 0,
        input.href ?? null,
        input.language ?? null,
        input.html ?? null,
        JSON.stringify(input.options ?? []),
        input.recommended ?? null,
        input.progress ?? null,
        input.state ?? null,
        assetId,
        revision,
        revision,
        Date.now(),
      );

    const values = Object.fromEntries(
      nodeExtrasSchema
        .keyof()
        .options.filter((key) => key in input)
        .map((key) => [key, input[key]]),
    );

    this.database()
      .prepare("UPDATE nodes SET extras_json = ? WHERE thread_id = ? AND id = ?")
      .run(JSON.stringify(values), threadId, id);

    return id;
  }

  private addRaw(threadId: string, nodes: readonly NodeInput[]) {
    this.requireCanvas(threadId);

    if (this.activeCount(threadId) + nodes.length > maxActiveNodes)
      throw new CanvasError(
        `A board holds at most ${maxActiveNodes} active nodes. Archive superseded nodes first.`,
      );

    const ids = this.database().transaction(() => {
      const revision = this.bump(threadId);

      const added = nodes.map((node) => this.insert(threadId, revision, node, null));

      return { revision, added };
    })();

    return ids;
  }

  private addMediaRaw(
    threadId: string,
    bytes: Buffer,
    input: Pick<NodeInput, "id" | "title" | "body" | "section" | "wide" | "after">,
  ) {
    this.requireCanvas(threadId);

    if (bytes.length > maxMediaBytes)
      throw new CanvasError("Images and videos are limited to 20 MiB");

    if (this.activeCount(threadId) + 1 > maxActiveNodes)
      throw new CanvasError(
        `A board holds at most ${maxActiveNodes} active nodes. Archive superseded nodes first.`,
      );

    const mime = mediaMime(bytes);
    const assetId = createHash("sha256").update(bytes).digest("hex");

    const result = this.database().transaction(() => {
      this.database()
        .prepare("INSERT OR IGNORE INTO assets(id, mime, content) VALUES (?, ?, ?)")
        .run(assetId, mime, bytes);

      const revision = this.bump(threadId);

      return {
        revision,
        id: this.insert(
          threadId,
          revision,
          { ...input, kind: mime.startsWith("video/") ? "video" : "image" },
          assetId,
        ),
      };
    })();

    return result;
  }

  private updateRaw(threadId: string, input: UpdateInput) {
    this.requireCanvas(threadId);

    const current = this.requireNode(threadId, input.id);
    const { id, ...fields } = input;

    const options = fields.options ?? z.array(z.string()).parse(JSON.parse(current.options_json));

    const recommended =
      fields.recommended ?? (fields.options === undefined ? current.recommended : null);

    if (recommended !== null && !options.includes(recommended))
      throw new CanvasError("The recommended answer must be one of the options");

    const revision = this.database().transaction(() => {
      const next = this.bump(threadId);
      const section = fields.section ?? current.section;
      const values = rawExtras(current);

      for (const key of nodeExtrasSchema.keyof().options)
        if (key in fields) {
          const value = fields[key];

          if (value === null || value === undefined) delete values[key];
          else values[key] = z.json().parse(value);
        }

      this.database()
        .prepare("UPDATE nodes SET extras_json = ? WHERE thread_id = ? AND id = ?")
        .run(JSON.stringify(values), threadId, id);

      this.ensureSection(threadId, section);
      this.database()
        .prepare(
          `UPDATE nodes SET title = ?, body = ?, section = ?, tone = ?, pinned = ?, wide = ?, href = ?, language = ?, html = ?, options_json = ?, recommended = ?, progress = ?, state = ?, x = ?, y = ?, updated_revision = ?, updated_at = ? WHERE thread_id = ? AND id = ?`,
        )
        .run(
          pick(fields, "title", current.title),
          pick(fields, "body", current.body),
          section,
          fields.tone ?? current.tone,
          fields.pinned === undefined ? current.pinned : fields.pinned ? 1 : 0,
          fields.wide === undefined ? current.wide : fields.wide ? 1 : 0,
          pick(fields, "href", current.href),
          pick(fields, "language", current.language),
          pick(fields, "html", current.html),
          JSON.stringify(options),
          recommended,
          pick(fields, "progress", current.progress),
          pick(fields, "state", current.state),
          fields.section !== undefined && fields.section !== current.section ? null : current.x,
          fields.section !== undefined && fields.section !== current.section ? null : current.y,
          next,
          Date.now(),
          threadId,
          id,
        );

      return next;
    })();

    return { revision, id };
  }

  private linkRaw(
    threadId: string,
    from: string,
    to: string,
    label: string | undefined,
    remove: boolean,
  ) {
    this.requireCanvas(threadId);

    if (from === to) throw new CanvasError("A node cannot link to itself");

    this.requireNode(threadId, from);
    this.requireNode(threadId, to);

    const revision = this.database().transaction(() => {
      const next = this.bump(threadId);

      if (remove)
        this.database()
          .prepare("DELETE FROM edges WHERE thread_id = ? AND from_id = ? AND to_id = ?")
          .run(threadId, from, to);
      else
        this.database()
          .prepare(
            "INSERT INTO edges(thread_id, from_id, to_id, label) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, from_id, to_id) DO UPDATE SET label = excluded.label",
          )
          .run(threadId, from, to, label ?? null);

      return next;
    })();

    return { revision };
  }

  private archiveRaw(threadId: string, ids: readonly string[]) {
    this.requireCanvas(threadId);

    for (const id of ids) this.requireNode(threadId, id);

    const revision = this.database().transaction(() => {
      const next = this.bump(threadId);

      for (const id of ids)
        this.database()
          .prepare(
            "UPDATE nodes SET archived = 1, updated_revision = ?, updated_at = ? WHERE thread_id = ? AND id = ?",
          )
          .run(next, Date.now(), threadId, id);

      return next;
    })();

    return { revision, archived: [...ids] };
  }

  private moveRaw(threadId: string, id: string, position: { x: number; y: number } | null) {
    this.requireCanvas(threadId);
    this.requireNode(threadId, id);

    const revision = this.database().transaction(() => {
      const next = this.bump(threadId);

      this.database()
        .prepare("UPDATE nodes SET x = ?, y = ? WHERE thread_id = ? AND id = ?")
        .run(position?.x ?? null, position?.y ?? null, threadId, id);

      return next;
    })();

    return { revision };
  }

  private pinRaw(threadId: string, id: string, pinned: boolean) {
    this.requireCanvas(threadId);
    this.requireNode(threadId, id);

    const revision = this.database().transaction(() => {
      const next = this.bump(threadId);

      this.database()
        .prepare("UPDATE nodes SET pinned = ? WHERE thread_id = ? AND id = ?")
        .run(pinned ? 1 : 0, threadId, id);

      return next;
    })();

    return { revision };
  }

  private composeRaw(
    threadId: string,
    input: { composition: Composition | null; resetPositions?: boolean; expectedRevision?: number },
  ) {
    const current = this.requireCanvas(threadId);

    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision)
      throw new CanvasError("Composition conflict: the board changed; inspect it again");

    const ids =
      input.composition === null ? [] : flowLeaves(input.composition.root).map((leaf) => leaf.node);

    const revision = this.database().transaction(() => {
      for (const id of ids) this.requireNode(threadId, id);
      const next = this.bump(threadId);
      this.writeLayout(threadId, decompose(input.composition));

      if (input.resetPositions === true)
        for (const id of ids)
          this.database()
            .prepare("UPDATE nodes SET x = NULL, y = NULL WHERE thread_id = ? AND id = ?")
            .run(threadId, id);

      return next;
    })();

    return { revision };
  }

  private authorState(threadId: string): AuthorState {
    const state = new Map<string, ReadonlyMap<string, JsonValue>>();

    const rows = z
      .array(nodeRowSchema)
      .parse(this.database().prepare("SELECT * FROM nodes WHERE thread_id = ?").all(threadId));

    for (const row of rows) {
      const node = toNode(row);

      const values = z.record(z.string(), z.json()).parse({
        kind: node.kind,
        order: node.order,
        section: node.section,
        title: node.title,
        body: node.body,
        tone: node.tone,
        pinned: node.pinned,
        wide: node.wide,
        href: node.href,
        language: node.language,
        html: node.html,
        options: node.options,
        recommended: node.recommended,
        progress: node.progress,
        state: node.state,
        assetId: node.assetId,
        position: node.position,
        width: node.width ?? null,
        views: node.views ?? null,
        binding: node.binding ?? null,
        evidence: node.evidence ?? null,
        archived: row.archived === 1,
        exists: true,
      });

      state.set(`node:${row.id}`, new Map(Object.entries(values)));
    }

    const edges = z
      .array(edgeRowSchema)
      .parse(this.database().prepare("SELECT * FROM edges WHERE thread_id = ?").all(threadId));

    for (const edge of edges)
      state.set(`edge:${edge.from_id}:${edge.to_id}`, new Map([["value", { label: edge.label }]]));
    const layout = this.layoutParts(threadId);
    state.set("board", new Map([["composition", layout.skeleton]]));

    for (const [id, island] of layout.islands)
      state.set(`island:${id}`, new Map([["layout", island]]));

    return state;
  }

  private writeAuthorField(
    threadId: string,
    target: string,
    field: string,
    value: JsonValue,
    missing: boolean,
  ): void {
    if (target === "board" && field === "composition") {
      this.database()
        .prepare("UPDATE canvas_threads SET layout_json = ? WHERE thread_id = ?")
        .run(JSON.stringify(value), threadId);

      return;
    }

    if (target.startsWith("island:") && field === "layout") {
      const islands = this.storedIslands(threadId);

      if (missing || value === null) islands.delete(target.slice(7));
      else islands.set(target.slice(7), value);
      this.database()
        .prepare("UPDATE canvas_threads SET islands_json = ? WHERE thread_id = ?")
        .run(JSON.stringify(Object.fromEntries(islands)), threadId);

      return;
    }

    if (target.startsWith("edge:")) {
      const [, from, to] = target.split(":");

      if (from === undefined || to === undefined)
        throw new CanvasError("Invalid edge history target");

      if (missing || value === null)
        this.database()
          .prepare("DELETE FROM edges WHERE thread_id = ? AND from_id = ? AND to_id = ?")
          .run(threadId, from, to);
      else {
        const edge = z.object({ label: z.string().nullable() }).parse(value);
        this.database()
          .prepare(
            "INSERT INTO edges(thread_id, from_id, to_id, label) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, from_id, to_id) DO UPDATE SET label = excluded.label",
          )
          .run(threadId, from, to, edge.label);
      }

      return;
    }

    if (!target.startsWith("node:")) throw new CanvasError("Invalid history target");
    const id = target.slice(5);

    if (field === "exists") {
      this.database()
        .prepare("UPDATE nodes SET archived = ? WHERE thread_id = ? AND id = ?")
        .run(missing || value !== true ? 1 : 0, threadId, id);

      return;
    }

    if (missing) return;

    if (field === "position") {
      const position = z.object({ x: z.number(), y: z.number() }).nullable().parse(value);
      this.database()
        .prepare("UPDATE nodes SET x = ?, y = ? WHERE thread_id = ? AND id = ?")
        .run(position?.x ?? null, position?.y ?? null, threadId, id);

      return;
    }

    if (field in nodeExtrasSchema.shape) {
      const row = nodeRowSchema.parse(
        this.database()
          .prepare("SELECT * FROM nodes WHERE thread_id = ? AND id = ?")
          .get(threadId, id),
      );

      const values = rawExtras(row);

      if (value === null) delete values[field];
      else values[field] = value;
      this.database()
        .prepare("UPDATE nodes SET extras_json = ? WHERE thread_id = ? AND id = ?")
        .run(JSON.stringify(values), threadId, id);

      return;
    }

    const columns = new Map([
      ["kind", "kind"],
      ["order", "ord"],
      ["section", "section"],
      ["title", "title"],
      ["body", "body"],
      ["tone", "tone"],
      ["pinned", "pinned"],
      ["wide", "wide"],
      ["href", "href"],
      ["language", "language"],
      ["html", "html"],
      ["options", "options_json"],
      ["recommended", "recommended"],
      ["progress", "progress"],
      ["state", "state"],
      ["assetId", "asset_id"],
      ["archived", "archived"],
    ]);

    const column = columns.get(field);

    if (column === undefined) throw new CanvasError(`Unknown authored field ${field}`);

    const sqlValue =
      field === "options"
        ? JSON.stringify(value)
        : value === true
          ? 1
          : value === false
            ? 0
            : z.union([z.string(), z.number(), z.null()]).parse(value);

    this.database()
      .prepare(`UPDATE nodes SET ${column} = ? WHERE thread_id = ? AND id = ?`)
      .run(sqlValue, threadId, id);
  }

  private finishHistory(threadId: string, targets: readonly string[], revision: number): void {
    if (this.activeCount(threadId) > maxActiveNodes)
      throw new CanvasError(`A board holds at most ${maxActiveNodes} active nodes`);

    const rows = z
      .array(nodeRowSchema)
      .parse(
        this.database()
          .prepare("SELECT * FROM nodes WHERE thread_id = ? AND archived = 0")
          .all(threadId),
      );

    for (const row of rows) {
      const options = z.array(z.string()).parse(JSON.parse(row.options_json));

      if (row.recommended !== null && !options.includes(row.recommended))
        throw new CanvasError("The recommended answer must be one of the options");
      this.ensureSection(threadId, row.section);
    }

    for (const target of targets)
      if (target.startsWith("node:"))
        this.database()
          .prepare(
            "UPDATE nodes SET updated_revision = ?, updated_at = ? WHERE thread_id = ? AND id = ?",
          )
          .run(revision, Date.now(), threadId, target.slice(5));
  }

  private mutate<Result extends { revision: number }>(
    threadId: string,
    label: string,
    actor: MutationActor,
    action: () => Result,
  ) {
    this.requireCanvas(threadId);
    this.assertWritable(threadId, actor);
    const result = this.journal.run(threadId, label, actor, action);

    if (result.changeId !== null) this.notify(threadId, result.revision);

    return result;
  }

  add(threadId: string, nodes: readonly NodeInput[], actor: MutationActor = "agent") {
    return this.mutate(
      threadId,
      `Add ${nodes.length} module${nodes.length === 1 ? "" : "s"}`,
      actor,
      () => this.addRaw(threadId, nodes),
    );
  }

  addMedia(
    threadId: string,
    bytes: Buffer,
    input: Pick<NodeInput, "id" | "title" | "body" | "section" | "wide" | "after">,
    actor: MutationActor = "agent",
  ) {
    return this.mutate(threadId, "Add media", actor, () =>
      this.addMediaRaw(threadId, bytes, input),
    );
  }

  private changedFields(threadId: string, current: NodeRow, fields: NodeFields): string[] {
    const values = this.authorState(threadId).get(`node:${current.id}`);

    const changed = Object.entries(fields)
      .filter(
        ([field, value]) =>
          value !== undefined && !isDeepStrictEqual(values?.get(field), z.json().parse(value)),
      )
      .map(([field]) => field);

    if (
      fields.options !== undefined &&
      fields.recommended === undefined &&
      current.recommended !== null
    )
      changed.push("recommended");

    if (changed.includes("section") && current.x !== null && current.y !== null)
      changed.push("position");

    return changed;
  }

  update(threadId: string, input: UpdateInput, actor: MutationActor = "agent") {
    return this.mutate(threadId, `Update ${input.id}`, actor, () => {
      const current = this.requireNode(threadId, input.id);
      const { id: _id, ...updates } = input;
      const fields = this.changedFields(threadId, current, updates);

      const human =
        actor === "agent" ? this.journal.humanFields(threadId, `node:${input.id}`, fields) : [];

      if (human.length > 0)
        throw new CanvasError(
          `Human edits conflict on ${human.join(", ")}; inspect the current node and use canvas_edit with field versions`,
        );

      return this.updateRaw(threadId, input);
    });
  }

  link(
    threadId: string,
    from: string,
    to: string,
    label: string | undefined,
    remove: boolean,
    actor: MutationActor = "agent",
    expectedRevision?: number,
  ) {
    return this.mutate(threadId, `${remove ? "Remove" : "Connect"} ${from} → ${to}`, actor, () => {
      const currentRevision = this.requireCanvas(threadId).revision;

      if (expectedRevision !== undefined && expectedRevision !== currentRevision)
        throw new CanvasError(
          "Link conflict: the board changed; inspect the current connections again",
        );
      const target = `edge:${from}:${to}`;
      const current = this.authorState(threadId).get(target)?.get("value") ?? null;
      const next = remove ? null : { label: label ?? null };

      if (
        actor === "agent" &&
        expectedRevision === undefined &&
        !isDeepStrictEqual(current, next) &&
        this.journal.humanFields(threadId, target, ["value"]).length > 0
      )
        throw new CanvasError(
          "Human edits protect this connection; inspect the current board and pass expectedRevision before replacing it",
        );

      return this.linkRaw(threadId, from, to, label, remove);
    });
  }

  archive(threadId: string, ids: readonly string[], actor: MutationActor = "agent") {
    return this.mutate(
      threadId,
      `Hide ${ids.length} module${ids.length === 1 ? "" : "s"}`,
      actor,
      () => this.archiveRaw(threadId, ids),
    );
  }

  move(
    threadId: string,
    id: string,
    position: { x: number; y: number } | null,
    actor: MutationActor = "agent",
  ) {
    return this.mutate(
      threadId,
      `${position === null ? "Reset position of" : "Move"} ${id}`,
      actor,
      () => this.moveRaw(threadId, id, position),
    );
  }

  pin(threadId: string, id: string, pinned: boolean, actor: MutationActor = "agent") {
    return this.mutate(threadId, `${pinned ? "Pin" : "Unpin"} ${id}`, actor, () =>
      this.pinRaw(threadId, id, pinned),
    );
  }

  compose(threadId: string, input: ComposeInput, actor: MutationActor = "agent") {
    if ((input.composition === undefined) === (input.island === undefined))
      throw new CanvasError("Supply either a composition or one island to arrange");

    if (input.after !== undefined && input.island === undefined)
      throw new CanvasError("after positions a new island; send it together with island");
    const current = this.composition(threadId);
    const notes: string[] = [];
    let target: Composition | null = input.composition ?? null;
    let label: string;

    if (input.island === undefined) label = composeLabel(current, target);
    else {
      const island = input.island;

      if (!isIsland(island)) throw new CanvasError("Supply one group with an id and island");
      const placement = canvasAttempt(() => placeIsland(current, island, input.after));
      target = canvasAttempt(() => compositionSchema.parse(placement.composition));
      label = `${placement.inserted ? "Add" : "Arrange"} ${island.island.title}`;

      for (const entry of placement.pulled)
        notes.push(`Moved ${entry.node} from ${entry.from} into “${island.island.title}”.`);

      for (const name of placement.dropped)
        notes.push(`Removed “${name}” because it became empty.`);
    }

    const result = this.mutate(threadId, label, actor, () => {
      if (actor === "agent" && input.expectedRevision === undefined) {
        const protectedFields: string[] = [];

        for (const [entry, field, name] of changedLayoutFields(
          this.layoutParts(threadId),
          decompose(target),
        ))
          if (this.journal.humanFields(threadId, entry, [field]).length > 0)
            protectedFields.push(name);

        if (input.resetPositions === true && target !== null)
          for (const leaf of flowLeaves(target.root)) {
            const node = this.requireNode(threadId, leaf.node);

            if (
              (node.x !== null || node.y !== null) &&
              this.journal.humanFields(threadId, `node:${leaf.node}`, ["position"]).length > 0
            )
              protectedFields.push(`position of ${leaf.node}`);
          }

        if (protectedFields.length > 0)
          throw new CanvasError(
            `Human edits protect ${protectedFields.join(", ")}; inspect the current board and pass expectedRevision before replacing them`,
          );
      }

      return this.composeRaw(threadId, {
        composition: target,
        resetPositions: input.resetPositions,
        expectedRevision: input.expectedRevision,
      });
    });

    return { ...result, notes: [...notes, ...(target === null ? [] : compositionNotes(target))] };
  }

  inspect(threadId: string, id: string): NodeInspection {
    const boardRevision = this.requireCanvas(threadId).revision;
    const node = toNode(this.requireNode(threadId, id));
    const versions = this.journal.versions(threadId, `node:${id}`);

    const fieldVersions = Object.fromEntries(
      nodeFieldsSchema.keyof().options.map((field) => [field, versions[field] ?? 0]),
    );

    return { node, boardRevision, fieldVersions: { ...fieldVersions, ...versions } };
  }

  edit(threadId: string, input: EditInput, actor: MutationActor = "agent") {
    return this.database().transaction(() => {
      this.requireCanvas(threadId);
      const current = this.requireNode(threadId, input.id);
      const versions = this.journal.versions(threadId, `node:${input.id}`);
      const fields = this.changedFields(threadId, current, input.fields);

      const conflicts = fields.filter(
        (field) => input.expectedVersions[field] !== (versions[field] ?? 0),
      );

      if (conflicts.length > 0)
        throw new CanvasError(
          `Edit conflict: inspect ${input.id} again before changing ${conflicts.join(", ")}`,
        );

      return this.mutate(threadId, input.label ?? `Edit ${input.id}`, actor, () =>
        this.updateRaw(threadId, { id: input.id, ...input.fields }),
      );
    })();
  }

  applyEdit(threadId: string, input: EditInput, actor: MutationActor = "agent") {
    return this.edit(threadId, input, actor);
  }

  historySummary(threadId: string, limit = 20, offset = 0) {
    this.requireCanvas(threadId);

    return this.journal.summary(threadId, limit, offset);
  }

  historyDetail(threadId: string, changeId: string) {
    this.requireCanvas(threadId);

    return this.journal.detail(threadId, changeId);
  }

  history(threadId: string) {
    this.requireCanvas(threadId);

    return this.journal.history(threadId);
  }

  undo(threadId: string, changeId?: string, actor: MutationActor = "agent") {
    this.requireCanvas(threadId);
    this.assertWritable(threadId, actor);
    const result = this.journal.apply(threadId, "undo", actor, changeId);
    this.notify(threadId, result.revision);

    return result;
  }

  redo(threadId: string, changeId?: string, actor: MutationActor = "agent") {
    this.requireCanvas(threadId);
    this.assertWritable(threadId, actor);
    const result = this.journal.apply(threadId, "redo", actor, changeId);
    this.notify(threadId, result.revision);

    return result;
  }

  duplicate(threadId: string, id: string, actor: MutationActor = "agent") {
    return this.mutate(threadId, `Duplicate ${id}`, actor, () => {
      const row = this.requireNode(threadId, id);

      if (this.activeCount(threadId) >= maxActiveNodes)
        throw new CanvasError(`A board holds at most ${maxActiveNodes} active nodes`);
      const node = toNode(row);

      const fields = nodeFieldsSchema.parse(
        Object.fromEntries(
          nodeFieldsSchema
            .keyof()
            .options.filter(
              (field) =>
                node[field] !== null &&
                node[field] !== undefined &&
                (field !== "options" || node.options.length > 0),
            )
            .map((field) => [field, node[field]]),
        ),
      );

      const revision = this.bump(threadId);

      const clone = this.insert(
        threadId,
        revision,
        { ...fields, id: this.freeId(threadId), kind: node.kind, after: id },
        row.asset_id,
      );

      this.database()
        .prepare("UPDATE nodes SET extras_json = ? WHERE thread_id = ? AND id = ?")
        .run(row.extras_json, threadId, clone);

      return { revision, id: clone };
    });
  }

  markSeen(threadId: string, revision: number) {
    const current = this.requireCanvas(threadId);
    const seen = Math.min(Math.max(current.seen_revision, revision), current.revision);

    this.database()
      .prepare("UPDATE canvas_threads SET seen_revision = ? WHERE thread_id = ?")
      .run(seen, threadId);

    if (seen !== current.seen_revision) this.notify(threadId, current.revision);

    return { seenRevision: seen };
  }

  board(threadId: string): Board | null {
    if (!this.isCanvas(threadId)) return null;

    const thread = this.requireCanvas(threadId);

    const nodes = z
      .array(nodeRowSchema)
      .parse(
        this.database()
          .prepare("SELECT * FROM nodes WHERE thread_id = ? AND archived = 0 ORDER BY ord")
          .all(threadId),
      )
      .map(toNode);

    const sections = z
      .array(sectionRowSchema)
      .parse(
        this.database()
          .prepare(
            "SELECT name FROM sections WHERE thread_id = ? AND name IN (SELECT section FROM nodes WHERE thread_id = ? AND archived = 0) ORDER BY ord",
          )
          .all(threadId, threadId),
      )
      .map((row) => row.name);

    const edges: CanvasEdge[] = z
      .array(edgeRowSchema)
      .parse(
        this.database()
          .prepare(
            "SELECT e.from_id, e.to_id, e.label FROM edges e JOIN nodes a ON a.thread_id = e.thread_id AND a.id = e.from_id AND a.archived = 0 JOIN nodes b ON b.thread_id = e.thread_id AND b.id = e.to_id AND b.archived = 0 WHERE e.thread_id = ?",
          )
          .all(threadId),
      )
      .map((row) => ({ from: row.from_id, to: row.to_id, label: row.label }));

    return {
      threadId,
      revision: thread.revision,
      seenRevision: thread.seen_revision,
      sections,
      nodes,
      edges,
      composition: this.composition(threadId),
    };
  }

  private layoutRow(threadId: string) {
    return z
      .object({
        composition_json: z.string().nullable(),
        layout_json: z.string().nullable(),
        islands_json: z.string().nullable(),
      })
      .parse(
        this.database()
          .prepare(
            "SELECT composition_json, layout_json, islands_json FROM canvas_threads WHERE thread_id = ?",
          )
          .get(threadId),
      );
  }

  private storedIslands(threadId: string): Map<string, JsonValue> {
    const row = this.layoutRow(threadId);

    return new Map(
      Object.entries(z.record(z.string(), z.json()).parse(JSON.parse(row.islands_json ?? "{}"))),
    );
  }

  private layoutParts(threadId: string): Decomposition {
    const row = this.layoutRow(threadId);

    if (row.layout_json === null)
      return decompose(
        row.composition_json === null
          ? null
          : compositionSchema.parse(JSON.parse(row.composition_json)),
      );

    const skeleton = z.json().parse(JSON.parse(row.layout_json));
    const referenced = placeholderIds(skeleton);

    return {
      skeleton,
      islands: new Map([...this.storedIslands(threadId)].filter(([id]) => referenced.has(id))),
    };
  }

  private writeLayout(threadId: string, layout: Decomposition): void {
    this.database()
      .prepare("UPDATE canvas_threads SET layout_json = ?, islands_json = ? WHERE thread_id = ?")
      .run(
        JSON.stringify(layout.skeleton),
        JSON.stringify(Object.fromEntries(layout.islands)),
        threadId,
      );
  }

  private composition(threadId: string): Composition | null {
    const parts = this.layoutParts(threadId);

    return assemble(parts.skeleton, parts.islands);
  }

  assetMetadata(id: string, width?: number) {
    const row =
      width === undefined
        ? this.database()
            .prepare("SELECT mime, length(content) AS byteLength FROM assets WHERE id = ?")
            .get(id)
        : this.database()
            .prepare(
              "SELECT 'image/webp' AS mime, length(content) AS byteLength FROM canvas_media_variants WHERE asset_id = ? AND width = ?",
            )
            .get(id, width);

    return row === undefined ? null : assetMetadataSchema.parse(row);
  }

  asset(id: string, range: { start: number; end: number } | null = null, width?: number) {
    const content = range === null ? "content" : "substr(content, ?, ?) AS content";

    const query =
      width === undefined
        ? `SELECT mime, ${content} FROM assets WHERE id = ?`
        : `SELECT 'image/webp' AS mime, ${content} FROM canvas_media_variants WHERE asset_id = ? AND width = ?`;

    const parameters: (string | number)[] = width === undefined ? [id] : [id, width];

    if (range !== null) parameters.unshift(range.start + 1, range.end - range.start + 1);

    const row = this.database()
      .prepare(query)
      .get(...parameters);

    return row === undefined ? null : assetRowSchema.parse(row);
  }

  remove(threadId: string): void {
    this.database().transaction(() => {
      const assets = z
        .array(z.object({ asset_id: z.string() }))
        .parse(
          this.database()
            .prepare(
              "SELECT DISTINCT asset_id FROM nodes WHERE thread_id=? AND asset_id IS NOT NULL",
            )
            .all(threadId),
        );

      for (const table of [
        "canvas_change_actors",
        "canvas_field_versions",
        "canvas_history",
        "nodes",
        "edges",
        "sections",
        "canvas_threads",
      ])
        this.database().prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(threadId);
      this.database()
        .prepare("UPDATE canvas_threads SET moved_to=NULL WHERE moved_to=?")
        .run(threadId);

      for (const { asset_id } of assets) {
        this.database()
          .prepare(
            "DELETE FROM assets WHERE id=? AND NOT EXISTS (SELECT 1 FROM nodes WHERE asset_id=?)",
          )
          .run(asset_id, asset_id);

        for (const table of ["canvas_media", "canvas_media_variants", "canvas_media_failures"])
          this.database()
            .prepare(
              `DELETE FROM ${table} WHERE asset_id=? AND NOT EXISTS (SELECT 1 FROM assets WHERE id=?)`,
            )
            .run(asset_id, asset_id);
      }
    })();
  }
}

function pick<Key extends keyof NodeFields>(
  fields: Omit<UpdateInput, "id">,
  key: Key,
  current: NodeFields[Key] | null,
): NodeFields[Key] | null {
  return key in fields ? (fields[key] ?? null) : current;
}
