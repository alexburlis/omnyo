import { CanvasError } from "./errors.ts";
import { ownedBoardTables } from "./storage.ts";
import { createHash, randomUUID } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  projectAdoptSchema,
  projectCanvasSchema,
  projectChatPutSchema,
  projectChatSchema,
  projectSectionActionSchema,
  projectSectionCreateSchema,
  projectSectionSchema,
  projectSectionUpdateSchema,
  projectViewPutSchema,
  projectViewSchema,
  projectRealtimeChannel,
  type BoardKey,
  type BoardReference,
  type ProjectMutation,
  type ProjectCanvas,
  type ProjectSection,
  type ProjectChat,
  type ProjectView,
} from "../project-contract.ts";
import { type CanvasService } from "./service.ts";
import { realtimeChannel } from "../contract.ts";
import type { SourceService } from "./sources.ts";
import { layoutBoard, type Rect } from "./layout.ts";
import { islandGroups } from "./composition.ts";

const sectionColumns =
  "id,project_id AS projectId,title,question,x,y,ord AS 'order',locked,archived_at AS archivedAt,origin_thread_id AS originThreadId,created_by AS createdBy,created_at AS createdAt";

const sectionRow = projectSectionSchema.extend({
  locked: z.number().transform((value) => value === 1),
});

const viewColumns =
  "id,project_id AS projectId,title,ord AS 'order',anchor_kind AS anchorKind,region_id AS regionId,anchor_id AS anchorId,rect_json AS rect,created_by AS createdBy,created_at AS createdAt";

const viewRow = projectViewSchema.extend({
  rect: z
    .string()
    .transform((value) => JSON.parse(value))
    .pipe(projectViewSchema.shape.rect),
});

const chatColumns =
  "thread_id AS threadId,project_id AS projectId,region_id AS regionId,anchor_kind AS anchorKind,anchor_id AS anchorId,x,y,role,state,created_at AS createdAt";

const projectRow = z.object({
  revision: z.number(),
  home_view_id: z.string().nullable(),
  archived_at: z.number().nullable(),
});

const journalRow = z.object({
  id: z.string(),
  actor: z.string(),
  label: z.string(),
  before_json: z.string(),
  after_json: z.string(),
  created_at: z.number(),
  state: z.enum(["applied", "undone"]),
});

const ownershipModeSchema = z.object({
  created_at: z.number(),
  enabled: z.number(),
  started_by: z.enum(["user", "agent"]),
  moved_to: z.string().nullable(),
  carried_from: z.string().nullable(),
});

const boardEvidenceSchema = z.object({
  key: z.string(),
  mode: ownershipModeSchema.nullable(),
  revision: z.number().nullable(),
  digest: z.string(),
});

const ownershipSchema = z.object({
  keys: z.array(z.string()),
  boards: z.array(boardEvidenceSchema),
  aliases: z.array(z.object({ old_key: z.string(), board_key: z.string() })),
});

const historySnapshotSchema = projectCanvasSchema.extend({
  ownership: ownershipSchema.optional(),
  journalRevision: z.number().optional(),
  historyActivityRevision: z.number().optional(),
});

type HistorySnapshot = z.infer<typeof historySnapshotSchema>;

const aliasRow = z.object({ old_key: z.string(), board_key: z.string() });

const maxSections = 200;

const maxViews = 300;

const maxOpenChats = 200;

function overview(projectId: string): ProjectView {
  return {
    id: `view_overview_${projectId}`,
    projectId,
    title: "Overview",
    order: 0,
    anchorKind: "free",
    regionId: null,
    anchorId: null,
    rect: { x: 0, y: 0, width: 1200, height: 800 },
    createdBy: "system",
    createdAt: 0,
  };
}

export class ProjectService {
  constructor(
    private readonly api: PluginApi,
    private readonly service: CanvasService,
    private readonly sources: SourceService,
  ) {}

  private database() {
    return this.api.storage.database();
  }

  get(projectId: string): ProjectCanvas {
    const value = this.database()
      .prepare("SELECT revision,home_view_id,archived_at FROM canvas_projects WHERE project_id=?")
      .get(projectId);

    const row = value === undefined ? null : projectRow.parse(value);

    const views = z
      .array(viewRow)
      .parse(
        this.database()
          .prepare(`SELECT ${viewColumns} FROM canvas_views WHERE project_id=? ORDER BY ord,id`)
          .all(projectId),
      );

    return {
      projectId,
      revision: row?.revision ?? 0,
      homeViewId: row?.home_view_id ?? overview(projectId).id,
      archivedAt: row?.archived_at ?? null,
      sections: z
        .array(sectionRow)
        .parse(
          this.database()
            .prepare(
              `SELECT ${sectionColumns} FROM canvas_regions WHERE project_id=? ORDER BY ord,id`,
            )
            .all(projectId),
        ),
      views: views.length === 0 && row === null ? [overview(projectId)] : views,
      chats: z
        .array(projectChatSchema)
        .parse(
          this.database()
            .prepare(
              `SELECT ${chatColumns} FROM canvas_chats WHERE project_id=? ORDER BY created_at,thread_id`,
            )
            .all(projectId),
        ),
    };
  }

  getSection(id: string): ProjectSection | null {
    const row = this.database()
      .prepare(`SELECT ${sectionColumns} FROM canvas_regions WHERE id=?`)
      .get(id);

    return row === undefined ? null : sectionRow.parse(row);
  }

  boardProject(board: BoardKey): string | null {
    return this.getSection(this.resolveBoard(board))?.projectId ?? null;
  }

  link(threadId: string): ProjectChat | null {
    const row = this.database()
      .prepare(`SELECT ${chatColumns} FROM canvas_chats WHERE thread_id=?`)
      .get(threadId);

    return row === undefined ? null : projectChatSchema.parse(row);
  }

  aliases(projectId: string) {
    return z
      .array(aliasRow)
      .parse(
        this.database()
          .prepare(
            "SELECT a.old_key,a.board_key FROM canvas_board_aliases a JOIN canvas_regions r ON r.id=a.board_key WHERE r.project_id=?",
          )
          .all(projectId),
      );
  }

  resolveBoard(board: BoardKey | BoardReference): BoardKey {
    return this.service.resolveBoard(board);
  }

  assertWritable(board: BoardKey, actor: "human" | "agent" | "system"): void {
    const key = this.resolveBoard(board);
    this.service.assertWritable(key, actor);
    const section = this.getSection(key);

    if (section !== null && this.get(section.projectId).archivedAt !== null)
      throw new CanvasError("This project canvas is archived");
  }

  private requireSection(projectId: string, sectionId: string, active = true): ProjectSection {
    const section = this.getSection(sectionId);

    if (section === null || section.projectId !== projectId)
      throw new CanvasError("Canvas section not found in this project");

    if (active && section.archivedAt !== null)
      throw new CanvasError("This Canvas section is archived; restore it first");

    return section;
  }

  private actor(input: ProjectMutation): string {
    return input.actor === "human" ? "human" : (input.actingThreadId ?? input.actor ?? "agent");
  }

  private requireObserved(input: ProjectMutation): void {
    if ((input.actor ?? "agent") === "agent" && input.expectedRevision === undefined)
      throw new CanvasError(
        "Inspect the project canvas and pass expectedRevision before changing its structure",
      );
  }

  private ensure(projectId: string): void {
    const inserted = this.database()
      .prepare(
        "INSERT OR IGNORE INTO canvas_projects(project_id,created_at,home_view_id) VALUES(?,?,?)",
      )
      .run(projectId, Date.now(), overview(projectId).id);

    if (inserted.changes !== 0) this.writeView(overview(projectId));
  }

  private evidence(key: string) {
    const stored = this.database()
      .prepare("SELECT * FROM canvas_threads WHERE thread_id=?")
      .get(key);

    const mode = stored === undefined ? null : ownershipModeSchema.parse(stored);

    const revision =
      stored === undefined ? null : z.object({ revision: z.number() }).parse(stored).revision;

    const content =
      stored === undefined
        ? null
        : z
            .object({
              composition_json: z.string().nullable(),
              layout_json: z.string().nullable(),
              islands_json: z.string().nullable(),
            })
            .parse(stored);

    const tables = ownedBoardTables.map((table) => {
      const rows = z
        .array(z.record(z.string(), z.json()))
        .parse(this.database().prepare(`SELECT * FROM ${table} WHERE thread_id=?`).all(key));

      return [
        table,
        rows
          .map((row) =>
            JSON.stringify(
              Object.fromEntries(
                Object.entries(row)
                  .filter(
                    ([field]) =>
                      field !== "thread_id" &&
                      !(
                        table === "canvas_sources" && ["generation", "lease_until"].includes(field)
                      ),
                  )
                  .sort(([a], [b]) => a.localeCompare(b)),
              ),
            ),
          )
          .sort(),
      ];
    });

    return {
      key,
      mode,
      revision,
      digest: createHash("sha256").update(JSON.stringify({ content, tables })).digest("hex"),
    };
  }

  private ownership(keys: ReadonlySet<string>) {
    const ordered = [...keys].sort();

    return {
      keys: ordered,
      boards: ordered.map((key) => this.evidence(key)),
      aliases: z.array(aliasRow).parse(
        this.database()
          .prepare(
            `SELECT old_key,board_key FROM canvas_board_aliases WHERE old_key IN (${ordered.map(() => "?").join(",")}) OR board_key IN (${ordered.map(() => "?").join(",")}) ORDER BY old_key`,
          )
          .all(...ordered, ...ordered),
      ),
    };
  }

  private transferKeys(key: string): Set<string> {
    const related = z
      .array(z.object({ key: z.string() }))
      .parse(
        this.database()
          .prepare(
            "SELECT thread_id AS key FROM canvas_threads WHERE moved_to=? UNION SELECT old_key AS key FROM canvas_board_aliases WHERE board_key=? UNION SELECT thread_id AS key FROM canvas_chats WHERE region_id=?",
          )
          .all(key, key, key),
      );

    return new Set([key, ...related.map((entry) => entry.key)]);
  }

  private snapshot(projectId: string, keys?: ReadonlySet<string>): HistorySnapshot {
    const canvas: HistorySnapshot = this.get(projectId);

    if (keys !== undefined) canvas.ownership = this.ownership(keys);

    return canvas;
  }

  private mutate<T>(
    input: ProjectMutation,
    label: string,
    action: () => T,
    journal = true,
    ownershipKeys?: Set<string>,
  ): T {
    const result = this.database().transaction(() => {
      const current = this.get(input.projectId);

      if (current.archivedAt !== null) throw new CanvasError("This project canvas is archived");

      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision)
        throw new CanvasError("Project canvas changed; read it again before editing");
      this.ensure(input.projectId);
      const before = this.snapshot(input.projectId, ownershipKeys);
      const value = action();
      this.database()
        .prepare("UPDATE canvas_projects SET revision=revision+1 WHERE project_id=?")
        .run(input.projectId);
      const after = this.snapshot(input.projectId, ownershipKeys);

      if (before.ownership !== undefined && after.ownership !== undefined) {
        for (const board of after.ownership.boards) {
          if (before.ownership.keys.includes(board.key)) continue;
          before.ownership.boards.push({
            key: board.key,
            mode: null,
            revision: null,
            digest: createHash("sha256")
              .update(
                JSON.stringify({
                  content: null,
                  tables: ownedBoardTables.map((table) => [table, []]),
                }),
              )
              .digest("hex"),
          });
        }

        before.ownership.keys = after.ownership.keys;
      }

      if (journal) {
        after.journalRevision = after.revision;
        after.historyActivityRevision = after.revision;
        this.database()
          .prepare(
            "INSERT INTO canvas_project_journal(project_id,id,actor,label,before_json,after_json,created_at,state) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            input.projectId,
            `pcj_${randomUUID()}`,
            this.actor(input),
            label,
            JSON.stringify(before),
            JSON.stringify(after),
            Date.now(),
            "applied",
          );
      }

      return value;
    })();

    this.api.realtime.publish(projectRealtimeChannel, {
      projectId: input.projectId,
      revision: this.get(input.projectId).revision,
    });

    return result;
  }

  private size(section: ProjectSection) {
    const board = this.service.board(section.id);

    return board === null ? { width: 1400, height: 600 } : layoutBoard(board, new Map()).bounds;
  }

  private position(projectId: string) {
    const sections = this.get(projectId).sections.filter((section) => section.archivedAt === null);
    const last = sections.at(-1);

    if (last === undefined) return { x: 0, y: 0 };
    const next = last.x + this.size(last).width + 400;

    if (next + 1400 <= 12000) return { x: next, y: last.y };

    return {
      x: 0,
      y: Math.max(...sections.map((section) => section.y + this.size(section).height)) + 400,
    };
  }

  private movePosition(section: ProjectSection, requested: Pick<ProjectSection, "x" | "y">) {
    const frame = (entry: ProjectSection): Rect => {
      const board = this.service.board(entry.id);

      const bounds =
        board === null
          ? { x: 0, y: 0, width: 1400, height: 800 }
          : layoutBoard(board, new Map()).bounds;

      return {
        x: bounds.x - 24,
        y: bounds.y - 72,
        width: bounds.width + 48,
        height: bounds.height + 96,
      };
    };

    const local = frame(section);

    const obstacles = this.get(section.projectId).sections.flatMap((entry) => {
      if (entry.id === section.id || entry.archivedAt !== null) return [];
      const bounds = frame(entry);

      return [{ ...bounds, x: bounds.x + entry.x, y: bounds.y + entry.y }];
    });

    const lowerX = Math.ceil((-1000000 - local.x) / 40) * 40;
    const upperX = Math.floor((1000000 - local.x - local.width) / 40) * 40;
    const lowerY = Math.ceil((-1000000 - local.y) / 40) * 40;
    const upperY = Math.floor((1000000 - local.y - local.height) / 40) * 40;

    if (lowerX > upperX || lowerY > upperY)
      throw new CanvasError("This section is too large for the project canvas coordinate bounds");

    const target = {
      x: Math.max(lowerX, Math.min(upperX, Math.round(requested.x / 40) * 40)),
      y: Math.max(lowerY, Math.min(upperY, Math.round(requested.y / 40) * 40)),
    };

    const xs = new Set([target.x, lowerX, upperX]);
    const ys = new Set([target.y, lowerY, upperY]);

    for (const obstacle of obstacles) {
      xs.add(Math.floor((obstacle.x - 120 - local.width - local.x) / 40) * 40);
      xs.add(Math.ceil((obstacle.x + obstacle.width + 120 - local.x) / 40) * 40);
      ys.add(Math.floor((obstacle.y - 120 - local.height - local.y) / 40) * 40);
      ys.add(Math.ceil((obstacle.y + obstacle.height + 120 - local.y) / 40) * 40);
    }

    const sortedX = [...xs]
      .filter((x) => x >= lowerX && x <= upperX)
      .sort((a, b) => Math.abs(a - requested.x) - Math.abs(b - requested.x) || a - b);

    const sortedY = [...ys]
      .filter((y) => y >= lowerY && y <= upperY)
      .sort((a, b) => Math.abs(a - requested.y) - Math.abs(b - requested.y) || a - b);

    let nearest: Pick<ProjectSection, "x" | "y"> | null = null;
    let distance = Infinity;

    for (const x of sortedX) {
      if ((x - requested.x) ** 2 > distance) break;

      for (const y of sortedY) {
        const nextDistance = (x - requested.x) ** 2 + (y - requested.y) ** 2;

        if (nextDistance >= distance) break;
        const rect = { ...local, x: x + local.x, y: y + local.y };

        if (
          obstacles.some(
            (obstacle) =>
              rect.x < obstacle.x + obstacle.width + 120 &&
              rect.x + rect.width + 120 > obstacle.x &&
              rect.y < obstacle.y + obstacle.height + 120 &&
              rect.y + rect.height + 120 > obstacle.y,
          )
        )
          continue;
        nearest = { x, y };
        distance = nextDistance;
      }
    }

    if (nearest === null)
      throw new CanvasError(
        "No collision-free section position fits within the project canvas bounds",
      );

    return nearest;
  }

  private writeSection(section: ProjectSection): void {
    this.database()
      .prepare(
        "INSERT INTO canvas_regions(id,project_id,title,question,x,y,ord,locked,archived_at,origin_thread_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,question=excluded.question,x=excluded.x,y=excluded.y,ord=excluded.ord,locked=excluded.locked,archived_at=excluded.archived_at",
      )
      .run(
        section.id,
        section.projectId,
        section.title,
        section.question,
        section.x,
        section.y,
        section.order,
        Number(section.locked),
        section.archivedAt,
        section.originThreadId,
        section.createdBy,
        section.createdAt,
      );
  }

  private newSection(
    input: z.infer<typeof projectSectionCreateSchema>,
    originThreadId: string | null,
  ): ProjectSection {
    const sections = this.get(input.projectId).sections;

    if (sections.length >= maxSections)
      throw new CanvasError("A project canvas holds at most 200 sections");
    const position = this.position(input.projectId);

    const section = projectSectionSchema.parse({
      id: `sec_${randomUUID()}`,
      projectId: input.projectId,
      title: input.title,
      question: input.question ?? null,
      x: input.x ?? position.x,
      y: input.y ?? position.y,
      order: Math.max(0, ...sections.map((entry) => entry.order)) + 1,
      locked: false,
      archivedAt: null,
      originThreadId,
      createdBy: input.actor === "human" ? "human" : this.actor(input),
      createdAt: Date.now(),
    });

    this.writeSection(section);

    return section;
  }

  createSection(raw: z.infer<typeof projectSectionCreateSchema>): ProjectSection {
    const input = projectSectionCreateSchema.parse(raw);

    return this.mutate(input, `Create ${input.title}`, () => {
      const section = this.newSection(input, null);
      this.service.enable(section.id, input.actor === "human" ? "user" : "agent");

      return section;
    });
  }

  updateSection(raw: z.infer<typeof projectSectionUpdateSchema>): ProjectSection {
    const input = projectSectionUpdateSchema.parse(raw);

    return this.mutate(input, "Update section", () => {
      const current = this.requireSection(input.projectId, input.sectionId);

      if ((input.actor ?? "agent") === "agent") {
        this.assertWritable(current.id, "agent");

        if (input.locked !== undefined)
          throw new CanvasError("Only the owner can change a section's agent lock");

        this.requireObserved(input);
      }

      const section = projectSectionSchema.parse({
        ...current,
        ...Object.fromEntries(
          Object.entries(input).filter(
            ([key, value]) =>
              value !== undefined &&
              ["title", "question", "x", "y", "locked", "order"].includes(key),
          ),
        ),
      });

      if (input.x !== undefined || input.y !== undefined)
        Object.assign(section, this.movePosition(section, section));
      this.writeSection(section);

      return section;
    });
  }

  archiveSection(raw: z.infer<typeof projectSectionActionSchema>): ProjectSection {
    return this.archive(raw, true);
  }
  restoreSection(raw: z.infer<typeof projectSectionActionSchema>): ProjectSection {
    return this.archive(raw, false);
  }
  private archive(
    raw: z.infer<typeof projectSectionActionSchema>,
    archived: boolean,
  ): ProjectSection {
    const input = projectSectionActionSchema.parse(raw);

    return this.mutate(input, archived ? "Archive section" : "Restore section", () => {
      const current = this.requireSection(input.projectId, input.sectionId, false);

      if ((input.actor ?? "agent") === "agent" && current.locked)
        throw new CanvasError("This Canvas section is locked for agents");

      this.requireObserved(input);
      const section = { ...current, archivedAt: archived ? Date.now() : null };
      this.writeSection(section);
      this.sources.invalidate(section.id);

      return section;
    });
  }

  adopt(raw: z.infer<typeof projectAdoptSchema>): ProjectSection {
    const input = projectAdoptSchema.parse(raw);
    const linked = this.link(input.threadId);

    if (linked?.regionId) {
      if (linked.projectId !== input.projectId)
        throw new CanvasError("This board belongs to another project canvas");

      return this.requireSection(input.projectId, linked.regionId, false);
    }

    if (this.resolveBoard(input.threadId) !== input.threadId)
      throw new CanvasError("This board is already linked to a section");

    const ownership = this.transferKeys(input.threadId);

    return this.mutate(
      input,
      `Add ${input.title}`,
      () => {
        const canvas = this.get(input.projectId);

        if (canvas.views.length >= maxViews)
          throw new CanvasError("A project canvas holds at most 300 views");

        if (canvas.chats.filter((chat) => chat.state === "open").length >= maxOpenChats)
          throw new CanvasError("A project canvas holds at most 200 open chat cards");
        const enabled = this.service.isCanvas(input.threadId);
        const section = this.newSection(input, input.threadId);
        ownership.add(section.id);
        this.service.moveBoard(input.threadId, section.id, () =>
          this.sources.move(input.threadId, section.id),
        );
        this.database()
          .prepare(
            "UPDATE canvas_threads SET enabled=?,moved_to=NULL,carried_from=NULL WHERE thread_id=?",
          )
          .run(Number(enabled), input.threadId);
        this.database()
          .prepare("INSERT INTO canvas_board_aliases(old_key,board_key) VALUES(?,?)")
          .run(input.threadId, section.id);
        this.database()
          .prepare(
            "INSERT INTO canvas_board_aliases(old_key,board_key) SELECT thread_id,? FROM canvas_threads WHERE moved_to=? AND thread_id NOT IN (?,?)",
          )
          .run(section.id, section.id, section.id, input.threadId);
        this.writeChat({
          threadId: input.threadId,
          projectId: input.projectId,
          regionId: section.id,
          anchorKind: "section",
          anchorId: section.id,
          x: 0,
          y: 0,
          role: "origin",
          state: "open",
          createdAt: Date.now(),
        });
        this.writeView({
          id: `view_${randomUUID()}`,
          projectId: input.projectId,
          title: input.title,
          order: this.get(input.projectId).views.length,
          anchorKind: "section",
          regionId: section.id,
          anchorId: section.id,
          rect: { x: 0, y: 0, width: this.size(section).width, height: this.size(section).height },
          createdBy: input.actor === "human" ? "human" : this.actor(input),
          createdAt: Date.now(),
        });

        return section;
      },
      true,
      ownership,
    );
  }

  return(raw: z.infer<typeof projectSectionActionSchema>): {
    threadId: string;
    sectionId: string;
    removedViews: string[];
  } {
    const input = projectSectionActionSchema.parse(raw);

    const affected = new Set<string>();
    const ownership = this.transferKeys(input.sectionId);
    const origin = this.getSection(input.sectionId)?.originThreadId;

    if (origin !== null && origin !== undefined) ownership.add(origin);

    const result = this.mutate(
      input,
      "Return section to chat",
      () => {
        const section = this.requireSection(input.projectId, input.sectionId, false);

        if (section.originThreadId === null)
          throw new CanvasError("This section has no original chat");

        if ((input.actor ?? "agent") === "agent" && section.locked)
          throw new CanvasError("This Canvas section is locked for agents");

        this.requireObserved(input);

        const chats = z
          .array(projectChatSchema)
          .parse(
            this.database()
              .prepare(`SELECT ${chatColumns} FROM canvas_chats WHERE region_id=?`)
              .all(section.id),
          );

        const keys = z
          .array(z.object({ threadId: z.string() }))
          .parse(
            this.database()
              .prepare(
                "SELECT old_key AS threadId FROM canvas_board_aliases WHERE board_key=? UNION SELECT thread_id AS threadId FROM canvas_chats WHERE region_id=? UNION SELECT thread_id AS threadId FROM canvas_threads WHERE moved_to=?",
              )
              .all(section.id, section.id, section.id),
          );

        for (const { threadId } of keys) if (threadId !== section.id) affected.add(threadId);
        affected.add(section.originThreadId);
        this.service.returnBoard(section.id, section.originThreadId, () =>
          this.sources.move(section.id, section.originThreadId ?? ""),
        );
        this.database()
          .prepare("DELETE FROM canvas_board_aliases WHERE board_key=?")
          .run(section.id);

        for (const chat of chats) {
          if (chat.threadId === section.originThreadId) continue;
          this.writeChat({
            ...chat,
            regionId: null,
            anchorKind: "free",
            anchorId: null,
            x: Math.max(-1000000, Math.min(1000000, section.x + chat.x)),
            y: Math.max(-1000000, Math.min(1000000, section.y + chat.y)),
          });
        }

        this.database()
          .prepare("DELETE FROM canvas_chats WHERE region_id=? AND thread_id=?")
          .run(section.id, section.originThreadId);

        const removedViews = this.get(input.projectId)
          .views.filter((view) => view.regionId === section.id)
          .map((view) => view.id);

        this.database().prepare("DELETE FROM canvas_views WHERE region_id=?").run(section.id);
        this.database().prepare("DELETE FROM canvas_regions WHERE id=?").run(section.id);
        this.database().prepare("DELETE FROM canvas_threads WHERE thread_id=?").run(section.id);
        this.database()
          .prepare(
            "UPDATE canvas_projects SET home_view_id=? WHERE project_id=? AND home_view_id NOT IN (SELECT id FROM canvas_views WHERE project_id=?)",
          )
          .run(overview(input.projectId).id, input.projectId, input.projectId);

        return { threadId: section.originThreadId, sectionId: section.id, removedViews };
      },
      true,
      ownership,
    );

    for (const threadId of affected) {
      const row = this.database()
        .prepare("SELECT revision FROM canvas_threads WHERE thread_id=?")
        .get(threadId);

      const revision =
        row === undefined ? 0 : z.object({ revision: z.number() }).parse(row).revision;

      this.api.realtime.publish(realtimeChannel, { threadId, revision });
    }

    return result;
  }

  private validateAnchor(
    projectId: string,
    kind: ProjectView["anchorKind"],
    regionId: string | null,
    anchorId: string | null,
    allowArchived = false,
  ): void {
    if (kind === "free") {
      if (regionId !== null || anchorId !== null)
        throw new CanvasError("A free anchor has no section or object");

      return;
    }

    if (kind === "chat") {
      const chat = anchorId === null ? null : this.link(anchorId);

      if (chat === null || chat.projectId !== projectId || chat.regionId !== regionId)
        throw new CanvasError("Canvas chat anchor not found in this project");

      return;
    }

    if (regionId === null) throw new CanvasError("This anchor needs a section");
    this.requireSection(projectId, regionId, !allowArchived);

    if (kind === "section") {
      if (anchorId !== null && anchorId !== regionId)
        throw new CanvasError("Section anchor does not match its section");
    } else {
      const board = this.service.board(regionId);

      if (kind === "node" && !board?.nodes.some((node) => node.id === anchorId))
        throw new CanvasError("Module anchor not found in this section");

      if (
        kind === "island" &&
        !(
          board?.composition &&
          islandGroups(board.composition.root).some((island) => island.id === anchorId)
        )
      )
        throw new CanvasError("Island anchor not found in this section");
    }
  }

  private writeView(view: ProjectView): void {
    this.database()
      .prepare(
        "INSERT INTO canvas_views(id,project_id,title,ord,anchor_kind,region_id,anchor_id,rect_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,ord=excluded.ord,anchor_kind=excluded.anchor_kind,region_id=excluded.region_id,anchor_id=excluded.anchor_id,rect_json=excluded.rect_json,created_by=excluded.created_by",
      )
      .run(
        view.id,
        view.projectId,
        view.title,
        view.order,
        view.anchorKind,
        view.regionId,
        view.anchorId,
        JSON.stringify(view.rect),
        view.createdBy,
        view.createdAt,
      );
  }

  putView(raw: z.infer<typeof projectViewPutSchema>): ProjectView {
    const input = projectViewPutSchema.parse(raw);

    return this.mutate(input, `Save ${input.title}`, () => {
      const views = this.get(input.projectId).views;

      const current =
        input.id === undefined ? undefined : views.find((view) => view.id === input.id);

      if (input.id !== undefined && current === undefined)
        throw new CanvasError("View not found in this project");

      if (current === undefined && views.length >= maxViews)
        throw new CanvasError("A project canvas holds at most 300 views");

      if (current !== undefined) this.requireObserved(input);
      this.validateAnchor(
        input.projectId,
        input.anchorKind,
        input.regionId ?? null,
        input.anchorId ?? null,
      );

      const view = projectViewSchema.parse({
        ...input,
        id: current?.id ?? `view_${randomUUID()}`,
        order: current?.order ?? views.length,
        regionId: input.regionId ?? null,
        anchorId: input.anchorId ?? null,
        createdBy: input.actor === "human" ? "human" : (current?.createdBy ?? this.actor(input)),
        createdAt: current?.createdAt ?? Date.now(),
      });

      this.writeView(view);

      return view;
    });
  }

  removeView(input: ProjectMutation & { id: string }): void {
    this.mutate(input, "Remove view", () => {
      this.requireObserved(input);

      if (input.id === overview(input.projectId).id)
        throw new CanvasError("Overview cannot be removed");

      if (!this.get(input.projectId).views.some((view) => view.id === input.id))
        throw new CanvasError("View not found in this project");
      this.database()
        .prepare("DELETE FROM canvas_views WHERE project_id=? AND id=?")
        .run(input.projectId, input.id);
      this.database()
        .prepare("UPDATE canvas_projects SET home_view_id=? WHERE project_id=? AND home_view_id=?")
        .run(overview(input.projectId).id, input.projectId, input.id);
    });
  }

  reorderViews(input: ProjectMutation & { ids: string[] }): void {
    this.mutate(input, "Reorder views", () => {
      this.requireObserved(input);
      const current = this.get(input.projectId).views;

      if (
        input.ids.length !== current.length ||
        new Set(input.ids).size !== input.ids.length ||
        current.some((view) => !input.ids.includes(view.id))
      )
        throw new CanvasError("List every project view exactly once");
      input.ids.forEach((id, index) =>
        this.database()
          .prepare("UPDATE canvas_views SET ord=? WHERE project_id=? AND id=?")
          .run(index, input.projectId, id),
      );
    });
  }

  setHome(input: ProjectMutation & { id: string }): void {
    this.mutate(input, "Set home view", () => {
      this.requireObserved(input);

      if (!this.get(input.projectId).views.some((view) => view.id === input.id))
        throw new CanvasError("View not found in this project");
      this.database()
        .prepare("UPDATE canvas_projects SET home_view_id=? WHERE project_id=?")
        .run(input.id, input.projectId);
    });
  }

  private writeChat(chat: ProjectChat): void {
    this.database()
      .prepare(
        "INSERT INTO canvas_chats(thread_id,project_id,region_id,anchor_kind,anchor_id,x,y,role,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET region_id=excluded.region_id,anchor_kind=excluded.anchor_kind,anchor_id=excluded.anchor_id,x=excluded.x,y=excluded.y,role=excluded.role,state=excluded.state",
      )
      .run(
        chat.threadId,
        chat.projectId,
        chat.regionId,
        chat.anchorKind,
        chat.anchorId,
        chat.x,
        chat.y,
        chat.role,
        chat.state,
        chat.createdAt,
      );
    this.database()
      .prepare(
        "UPDATE canvas_views SET region_id=? WHERE project_id=? AND anchor_kind='chat' AND anchor_id=? AND region_id IS NOT ?",
      )
      .run(chat.regionId, chat.projectId, chat.threadId, chat.regionId);
  }

  putChat(raw: z.infer<typeof projectChatPutSchema>): ProjectChat {
    const input = projectChatPutSchema.parse(raw);

    return this.mutate(input, "Place canvas chat", () => {
      const current = this.link(input.threadId);

      if (
        current?.role === "origin" &&
        (current.regionId !== (input.regionId ?? null) ||
          (input.role !== undefined && input.role !== "origin"))
      )
        throw new CanvasError("The original chat keeps its adopted section link");

      if (current !== null) this.requireObserved(input);

      if (current !== null && current.projectId !== input.projectId)
        throw new CanvasError("Canvas chat belongs to another project");

      if (
        input.state !== "resolved" &&
        current?.state !== "open" &&
        this.get(input.projectId).chats.filter((chat) => chat.state === "open").length >=
          maxOpenChats
      )
        throw new CanvasError("A project canvas holds at most 200 open chat cards");
      this.validateAnchor(
        input.projectId,
        input.anchorKind,
        input.regionId ?? null,
        input.anchorId ?? null,
      );

      const chat = projectChatSchema.parse({
        ...input,
        regionId: input.regionId ?? null,
        anchorId: input.anchorId ?? null,
        role: input.role ?? current?.role ?? "spawned",
        state: input.state ?? current?.state ?? "open",
        createdAt: current?.createdAt ?? Date.now(),
      });

      this.writeChat(chat);

      return chat;
    });
  }

  moveChat(
    input: ProjectMutation & {
      threadId: string;
      regionId: string | null;
      anchorKind: ProjectChat["anchorKind"];
      anchorId?: string | null;
      x: number;
      y: number;
    },
  ): ProjectChat {
    const current = this.link(input.threadId);

    if (current === null || current.projectId !== input.projectId)
      throw new CanvasError("Canvas chat not found");

    return this.putChat({ ...current, ...input });
  }

  resolveChat(input: ProjectMutation & { threadId: string; resolved?: boolean }): ProjectChat {
    const current = this.link(input.threadId);

    if (current === null || current.projectId !== input.projectId)
      throw new CanvasError("Canvas chat not found");

    return this.putChat({
      ...current,
      ...input,
      state: input.resolved === false ? "open" : "resolved",
    });
  }

  join(input: ProjectMutation & { threadId: string; sectionId?: string }): ProjectChat {
    const current = this.link(input.threadId);

    if (
      current !== null &&
      current.projectId === input.projectId &&
      current.regionId === (input.sectionId ?? current.regionId)
    )
      return current;

    if (current?.role === "origin" && current.regionId !== input.sectionId)
      throw new CanvasError("The original chat keeps its adopted section link");

    return this.putChat({
      ...input,
      regionId: input.sectionId ?? null,
      anchorKind: input.sectionId === undefined ? "free" : "section",
      anchorId: input.sectionId ?? null,
      x: 0,
      y: 0,
      role: current?.role ?? "joined",
    });
  }

  inheritLink(from: string, to: string): ProjectChat | null {
    const current = this.link(from);

    if (current === null) return null;

    if (current.regionId === null) return this.join({ projectId: current.projectId, threadId: to });

    return this.join({ projectId: current.projectId, threadId: to, sectionId: current.regionId });
  }

  removeThread(threadId: string): boolean {
    const linked = this.link(threadId) !== null || this.resolveBoard(threadId) !== threadId;

    const projects = z
      .array(z.object({ project_id: z.string() }))
      .parse(
        this.database()
          .prepare("SELECT project_id FROM canvas_chats WHERE thread_id=?")
          .all(threadId),
      );

    this.database().transaction(() => {
      this.database().prepare("DELETE FROM canvas_chats WHERE thread_id=?").run(threadId);
      this.database().prepare("DELETE FROM canvas_board_aliases WHERE old_key=?").run(threadId);
      this.database()
        .prepare("UPDATE canvas_regions SET origin_thread_id=NULL WHERE origin_thread_id=?")
        .run(threadId);

      for (const { project_id } of projects)
        this.database()
          .prepare("UPDATE canvas_projects SET revision=revision+1 WHERE project_id=?")
          .run(project_id);
    })();

    for (const { project_id } of projects)
      this.api.realtime.publish(projectRealtimeChannel, {
        projectId: project_id,
        revision: this.get(project_id).revision,
      });

    return linked;
  }

  recordChange(
    boardKey: BoardKey,
    changeId: string | null | undefined,
    actingThreadId: string,
  ): void {
    if (changeId === null || changeId === undefined) return;
    const key = this.resolveBoard(boardKey);
    const section = this.getSection(key);

    if (section !== null && this.link(actingThreadId)?.projectId !== section.projectId)
      throw new CanvasError(
        "The acting chat must join this project canvas before recording a change",
      );
    this.database().transaction(() => {
      const history = this.database()
        .prepare("SELECT id FROM canvas_history WHERE thread_id=? AND id=?")
        .get(key, changeId);

      if (history === undefined)
        throw new CanvasError("Only a retained Canvas history change can be attributed to a chat");
      this.database()
        .prepare(
          "INSERT OR IGNORE INTO canvas_change_actors(thread_id,change_id,actor_thread_id) VALUES(?,?,?)",
        )
        .run(key, changeId, actingThreadId);
      this.database()
        .prepare(
          "DELETE FROM canvas_change_actors WHERE thread_id=? AND change_id NOT IN (SELECT id FROM canvas_history WHERE thread_id=?)",
        )
        .run(key, key);
    })();
  }

  changesByChat(projectId: string, threadId: string) {
    const row = z.object({ sectionId: z.string(), nodeId: z.string(), changeId: z.string() });

    return z.array(row).parse(
      this.database()
        .prepare(`
      SELECT DISTINCT r.id AS sectionId,n.id AS nodeId,h.id AS changeId
      FROM canvas_regions r
      JOIN canvas_change_actors a ON a.thread_id=r.id
      JOIN canvas_history h ON h.thread_id=a.thread_id AND h.id=a.change_id
      JOIN json_each(h.fields_json) f
      JOIN nodes n ON n.thread_id=r.id AND n.id=substr(json_extract(f.value,'$.target'),6)
      WHERE r.project_id=? AND a.actor_thread_id=? AND r.archived_at IS NULL
        AND n.archived=0 AND json_extract(f.value,'$.target') LIKE 'node:%'
      ORDER BY h.revision DESC,r.id,n.id
    `)
        .all(projectId, threadId),
    );
  }

  journal(projectId: string, revisions?: readonly number[]) {
    return z
      .array(journalRow)
      .parse(
        this.database()
          .prepare(
            `SELECT id,actor,label,before_json,after_json,created_at,state FROM canvas_project_journal WHERE project_id=?${revisions === undefined ? "" : ` AND COALESCE(json_extract(after_json,'$.journalRevision'),json_extract(after_json,'$.revision')) IN (${revisions.map(() => "?").join(",")})`} ORDER BY created_at DESC,rowid DESC LIMIT ${revisions === undefined ? 100 : 201}`,
          )
          .all(projectId, ...(revisions ?? [])),
      )
      .map((entry) => ({
        id: entry.id,
        actor: entry.actor,
        label: entry.label,
        createdAt: entry.created_at,
        state: entry.state,
        revision: (() => {
          const snapshot = historySnapshotSchema.parse(JSON.parse(entry.after_json));

          return snapshot.journalRevision ?? snapshot.revision;
        })(),
      }));
  }

  undo(input: ProjectMutation & { changeId?: string }): ProjectCanvas {
    return this.applyHistory(input, "undo");
  }

  redo(input: ProjectMutation & { changeId?: string }): ProjectCanvas {
    return this.applyHistory(input, "redo");
  }

  private historyEntry(projectId: string, action: "undo" | "redo", changeId?: string) {
    const state = action === "undo" ? "applied" : "undone";

    const value =
      changeId === undefined
        ? this.database()
            .prepare(
              "SELECT * FROM canvas_project_journal WHERE project_id=? AND state=? ORDER BY COALESCE(json_extract(after_json,'$.historyActivityRevision'),json_extract(after_json,'$.revision')) DESC,rowid DESC LIMIT 1",
            )
            .get(projectId, state)
        : this.database()
            .prepare("SELECT * FROM canvas_project_journal WHERE project_id=? AND id=? AND state=?")
            .get(projectId, changeId, state);

    if (value === undefined) throw new CanvasError(`No project change to ${action}`);

    return journalRow.parse(value);
  }

  historyOrigins(projectId: string, action: "undo" | "redo", changeId?: string): string[] {
    const entry = this.historyEntry(projectId, action, changeId);
    const before = historySnapshotSchema.parse(JSON.parse(entry.before_json));
    const after = historySnapshotSchema.parse(JSON.parse(entry.after_json));

    const threads = new Set(
      [...before.sections, ...after.sections].flatMap((section) =>
        section.originThreadId !== null &&
        before.sections.some((item) => item.id === section.id) !==
          after.sections.some((item) => item.id === section.id)
          ? [section.originThreadId]
          : [],
      ),
    );

    for (const snapshot of [before, after]) {
      for (const key of snapshot.ownership?.keys ?? [])
        if (!key.startsWith("sec_")) threads.add(key);

      for (const chat of snapshot.chats) threads.add(chat.threadId);
    }

    return [...threads];
  }

  private sameCanvas(current: ProjectCanvas, expected: ProjectCanvas): boolean {
    const normalize = (canvas: ProjectCanvas) => ({
      ...projectCanvasSchema.parse(canvas),
      revision: 0,
      sections: canvas.sections.filter(
        (section) =>
          expected.sections.some((entry) => entry.id === section.id) || section.archivedAt === null,
      ),
    });

    return JSON.stringify(normalize(current)) === JSON.stringify(normalize(expected));
  }

  private assertOwnership(expected: z.infer<typeof ownershipSchema>): void {
    const current = this.ownership(new Set(expected.keys));

    if (JSON.stringify(current.aliases) !== JSON.stringify(expected.aliases))
      throw new CanvasError("Board ownership links changed; the project change cannot be replayed");

    for (const board of expected.boards) {
      const actual = current.boards.find((entry) => entry.key === board.key);

      if (
        actual === undefined ||
        actual.digest !== board.digest ||
        JSON.stringify(actual.mode) !== JSON.stringify(board.mode)
      )
        throw new CanvasError(
          "Board ownership or content changed; inspect the current board before undo or redo",
        );
    }
  }

  private restoreOwnership(snapshot: z.infer<typeof ownershipSchema>): void {
    for (const key of snapshot.keys) {
      this.database()
        .prepare("DELETE FROM canvas_board_aliases WHERE old_key=? OR board_key=?")
        .run(key, key);
    }

    for (const alias of snapshot.aliases)
      this.database()
        .prepare("INSERT INTO canvas_board_aliases(old_key,board_key) VALUES(?,?)")
        .run(alias.old_key, alias.board_key);

    for (const board of snapshot.boards) {
      if (board.mode === null) {
        if (board.key.startsWith("sec_"))
          this.database().prepare("DELETE FROM canvas_threads WHERE thread_id=?").run(board.key);
        continue;
      }

      const mode = board.mode;

      const updated = this.database()
        .prepare(
          "UPDATE canvas_threads SET created_at=?,enabled=?,started_by=?,moved_to=?,carried_from=? WHERE thread_id=?",
        )
        .run(
          mode.created_at,
          mode.enabled,
          mode.started_by,
          mode.moved_to,
          mode.carried_from,
          board.key,
        );

      if (updated.changes !== 1) throw new CanvasError("The original Canvas chat no longer exists");
    }
  }

  private applyHistory(
    input: ProjectMutation & { changeId?: string },
    action: "undo" | "redo",
  ): ProjectCanvas {
    const affected = new Set<string>();
    this.mutate(
      input,
      `${action === "undo" ? "Undo" : "Redo"} project change`,
      () => {
        this.requireObserved(input);
        const entry = this.historyEntry(input.projectId, action, input.changeId);
        const before = historySnapshotSchema.parse(JSON.parse(entry.before_json));
        const after = historySnapshotSchema.parse(JSON.parse(entry.after_json));
        const expected = action === "undo" ? after : before;
        const target = action === "undo" ? before : after;
        const current = this.get(input.projectId);

        if (!this.sameCanvas(current, expected))
          throw new CanvasError("Project changed after this entry; undo the newer change first");

        const transition = [...expected.sections, ...target.sections].some(
          (section) =>
            section.originThreadId !== null &&
            expected.sections.some((candidate) => candidate.id === section.id) !==
              target.sections.some((candidate) => candidate.id === section.id),
        );

        if (transition && (expected.ownership === undefined || target.ownership === undefined))
          throw new CanvasError("This older ownership change has no safe replay evidence");

        if (expected.ownership !== undefined) this.assertOwnership(expected.ownership);

        for (const chat of target.chats) {
          const existing = this.link(chat.threadId);

          if (existing !== null && existing.projectId !== input.projectId)
            throw new CanvasError("This chat now belongs to another project canvas");
        }

        for (const view of target.views) {
          const existing = this.database()
            .prepare("SELECT project_id FROM canvas_views WHERE id=?")
            .get(view.id);

          if (
            existing !== undefined &&
            z.object({ project_id: z.string() }).parse(existing).project_id !== input.projectId
          )
            throw new CanvasError("This saved view now belongs to another project canvas");
        }

        for (const section of current.sections) {
          if (!expected.sections.some((entry) => entry.id === section.id)) continue;
          const desired = target.sections.find((entry) => entry.id === section.id);

          if (
            JSON.stringify(section) !== JSON.stringify(desired) &&
            (input.actor ?? "agent") === "agent" &&
            (section.locked || (desired !== undefined && section.locked !== desired.locked))
          )
            throw new CanvasError("This Canvas section is locked for agents");

          if (desired === undefined && section.originThreadId !== null) {
            const origin = section.originThreadId;
            this.service.returnBoard(section.id, origin, () =>
              this.sources.move(section.id, origin),
            );
            this.database().prepare("DELETE FROM canvas_regions WHERE id=?").run(section.id);
            this.database().prepare("DELETE FROM canvas_threads WHERE thread_id=?").run(section.id);
          } else if (desired === undefined) {
            this.writeSection({ ...section, archivedAt: Date.now() });
            this.sources.invalidate(section.id);
          }
        }

        for (const section of target.sections) {
          const existing = this.getSection(section.id);

          if (existing !== null && existing.projectId !== input.projectId)
            throw new CanvasError("This section now belongs to another project canvas");

          if (existing === null && section.locked && (input.actor ?? "agent") === "agent")
            throw new CanvasError("This Canvas section is locked for agents");

          if (existing === null && section.originThreadId !== null) {
            const origin = section.originThreadId;
            this.service.moveBoard(origin, section.id, () => this.sources.move(origin, section.id));
          } else if (existing === null) {
            throw new CanvasError(
              "The retained section board is missing; this change cannot be replayed",
            );
          }

          this.writeSection(section);

          if (existing !== null && existing.archivedAt !== section.archivedAt)
            this.sources.invalidate(section.id);
        }

        if (target.ownership !== undefined) {
          this.restoreOwnership(target.ownership);

          for (const key of target.ownership.keys) affected.add(key);
        }

        this.database().prepare("DELETE FROM canvas_views WHERE project_id=?").run(input.projectId);

        this.database().prepare("DELETE FROM canvas_chats WHERE project_id=?").run(input.projectId);

        for (const chat of target.chats) this.writeChat(chat);

        for (const chat of target.chats)
          this.validateAnchor(input.projectId, chat.anchorKind, chat.regionId, chat.anchorId, true);

        for (const view of target.views) {
          this.validateAnchor(input.projectId, view.anchorKind, view.regionId, view.anchorId, true);
          this.writeView(view);
        }

        this.database()
          .prepare("UPDATE canvas_projects SET home_view_id=? WHERE project_id=?")
          .run(target.homeViewId, input.projectId);
        const keys = target.ownership === undefined ? undefined : new Set(target.ownership.keys);
        const actual = this.snapshot(input.projectId, keys);
        actual.revision = current.revision + 1;
        const originalRevision = after.journalRevision ?? after.revision;
        const nextBefore = action === "undo" ? actual : before;
        const nextAfter = action === "redo" ? actual : after;
        nextAfter.journalRevision = originalRevision;
        nextAfter.historyActivityRevision = actual.revision;
        this.database()
          .prepare(
            "UPDATE canvas_project_journal SET state=?,before_json=?,after_json=? WHERE id=?",
          )
          .run(
            action === "undo" ? "undone" : "applied",
            JSON.stringify(nextBefore),
            JSON.stringify(nextAfter),
            entry.id,
          );
      },
      false,
    );

    for (const threadId of affected) {
      const row = this.database()
        .prepare("SELECT revision FROM canvas_threads WHERE thread_id=?")
        .get(threadId);

      const revision =
        row === undefined ? 0 : z.object({ revision: z.number() }).parse(row).revision;

      this.api.realtime.publish(realtimeChannel, { threadId, revision });
    }

    return this.get(input.projectId);
  }

  reconcile(projectIds: readonly string[], now = Date.now()): string[] {
    const present = new Set(z.array(z.string().min(1)).parse(projectIds));
    z.number().int().nonnegative().safe().parse(now);

    const rows = z
      .array(
        z.object({
          project_id: z.string(),
          archived_at: z.number().nullable(),
          revision: z.number(),
        }),
      )
      .parse(
        this.database()
          .prepare("SELECT project_id,archived_at,revision FROM canvas_projects")
          .all(),
      );

    const changed: string[] = [];
    const retention = 30 * 24 * 60 * 60 * 1000;

    for (const row of rows) {
      if (present.has(row.project_id) && row.archived_at === null) continue;

      if (
        !present.has(row.project_id) &&
        row.archived_at !== null &&
        now - row.archived_at < retention
      )
        continue;
      this.database().transaction(() => {
        if (present.has(row.project_id)) {
          this.database()
            .prepare(
              "UPDATE canvas_projects SET archived_at=NULL,revision=revision+1 WHERE project_id=?",
            )
            .run(row.project_id);
        } else if (row.archived_at === null) {
          for (const section of this.get(row.project_id).sections)
            this.sources.invalidate(section.id);
          this.database()
            .prepare(
              "UPDATE canvas_projects SET archived_at=?,revision=revision+1 WHERE project_id=?",
            )
            .run(now, row.project_id);
        } else {
          for (const section of this.get(row.project_id).sections) {
            this.sources.remove(section.id);
            this.service.remove(section.id);
          }

          this.database()
            .prepare(
              "DELETE FROM canvas_board_aliases WHERE board_key IN (SELECT id FROM canvas_regions WHERE project_id=?)",
            )
            .run(row.project_id);

          for (const table of [
            "canvas_views",
            "canvas_chats",
            "canvas_project_journal",
            "canvas_regions",
            "canvas_projects",
          ])
            this.database().prepare(`DELETE FROM ${table} WHERE project_id=?`).run(row.project_id);
        }
      })();
      changed.push(row.project_id);
      this.api.realtime.publish(projectRealtimeChannel, {
        projectId: row.project_id,
        revision: row.revision + 1,
      });
    }

    return changed;
  }
}
