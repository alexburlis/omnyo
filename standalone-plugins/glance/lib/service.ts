import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  cardSchema,
  proofLinkSchema,
  realtimeChannel,
  type Card,
  type CardDiff,
  type CardIndexEntry,
  type CardView,
} from "../contract.ts";
import { compareCards } from "./diff.ts";
import { linkProof, listEvents } from "./proof.ts";

const storedCardSchema = z.object({
  thread_id: z.string(),
  revision: z.number(),
  card_json: z.string(),
  updated_at: z.number(),
  source: z.enum(["tool", "cli"]),
  stale_since: z.number().nullable(),
});

const seenSchema = z.object({ revision: z.number(), conversation_seq: z.number() });

const storedProofSchema = z.object({ proof_json: z.string() });

const revisionSchema = z.object({ card_json: z.string() });

const storedPayloadSchema = cardSchema
  .safeExtend({ ask: z.unknown().optional() })
  .transform(({ ask: _ask, ...card }) => card);

export class GlanceService {
  private readonly deleted = new Set<string>();
  private readonly pending = new Map<string, number>();
  private readonly reads = new Map<string, Promise<number>>();
  private signalTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly api: PluginApi) {
    api.storage.migrate(api.storage.database(), [
      `CREATE TABLE cards(thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, card_json TEXT NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, stale_since INTEGER)`,
      `CREATE TABLE card_revisions(thread_id TEXT NOT NULL, revision INTEGER NOT NULL, card_json TEXT NOT NULL, created_at INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY(thread_id, revision))`,
      `CREATE TABLE proofs(thread_id TEXT NOT NULL, revision INTEGER NOT NULL, idx INTEGER NOT NULL, proof_json TEXT NOT NULL, PRIMARY KEY(thread_id, revision, idx))`,
      `CREATE TABLE seen(thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, conversation_seq INTEGER NOT NULL, seen_at INTEGER NOT NULL)`,
      `CREATE TABLE card_captures(thread_id TEXT NOT NULL, revision INTEGER NOT NULL, conversation_seq INTEGER NOT NULL, PRIMARY KEY(thread_id, revision, conversation_seq))`,
      `CREATE TABLE dev_server_activity(thread_id TEXT NOT NULL, preview_id TEXT NOT NULL, last_online_at INTEGER, remembered_at INTEGER NOT NULL, PRIMARY KEY(thread_id, preview_id))`,
    ]);
    api.events.on("thread.active", ({ thread }) => this.activated(thread.id, thread.updatedAt));
    api.onDispose(() => {
      if (this.signalTimer !== undefined) clearTimeout(this.signalTimer);
      this.pending.clear();
      this.reads.clear();
    });
  }

  private database() {
    return this.api.storage.database();
  }

  private notify(threadId: string, revision: number): void {
    this.reads.delete(threadId);
    this.pending.set(threadId, revision);

    if (this.signalTimer !== undefined) return;
    this.signalTimer = setTimeout(() => {
      this.signalTimer = undefined;

      for (const [id, value] of this.pending)
        this.api.realtime.publish(realtimeChannel, {
          threadId: id,
          revision: value,
          entry: this.entry(id),
        });
      this.pending.clear();
    }, 50);
  }

  private current(threadId: string) {
    const row = this.database().prepare("SELECT * FROM cards WHERE thread_id = ?").get(threadId);

    return row === undefined ? null : storedCardSchema.parse(row);
  }

  private readSeen(threadId: string) {
    const row = this.database()
      .prepare("SELECT revision, conversation_seq FROM seen WHERE thread_id = ?")
      .get(threadId);

    return row === undefined ? null : seenSchema.parse(row);
  }

  private prune(threadId: string): void {
    this.database()
      .prepare(
        `DELETE FROM card_revisions WHERE thread_id = ? AND revision NOT IN (SELECT revision FROM card_revisions WHERE thread_id = ? ORDER BY revision DESC LIMIT 50) AND revision != COALESCE((SELECT revision FROM seen WHERE thread_id = ?), -1)`,
      )
      .run(threadId, threadId, threadId);
    this.database()
      .prepare(
        `DELETE FROM proofs WHERE thread_id = ? AND revision NOT IN (SELECT revision FROM card_revisions WHERE thread_id = ?)`,
      )
      .run(threadId, threadId);
  }

  private async requireThread(threadId: string): Promise<void> {
    if (this.deleted.has(threadId)) throw new Error("This chat was deleted");
    const thread = await this.api.sdk.threads.get({ threadId });

    if (thread.id !== threadId || this.deleted.has(threadId)) throw new Error("Chat not found");
  }

  private view(threadId: string): CardView | null {
    const current = this.current(threadId);

    if (!current) return null;

    const proofs = z
      .array(storedProofSchema)
      .parse(
        this.database()
          .prepare(
            "SELECT proof_json FROM proofs WHERE thread_id = ? AND revision = ? ORDER BY idx",
          )
          .all(threadId, current.revision),
      );

    return {
      threadId,
      card: storedPayloadSchema.parse(JSON.parse(current.card_json)),
      revision: current.revision,
      updatedAt: current.updated_at,
      source: current.source,
      staleSince: current.stale_since,
      proofs: proofs.map((row) => proofLinkSchema.parse(JSON.parse(row.proof_json))),
    };
  }

  private capture(threadId: string, revision: number | null, conversationSeq: number): void {
    if (revision === null) return;
    this.database().transaction(() => {
      this.database()
        .prepare(
          "INSERT INTO card_captures(thread_id, revision, conversation_seq) VALUES(?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(threadId, revision, conversationSeq);
      this.database()
        .prepare(
          "DELETE FROM card_captures WHERE thread_id = ? AND rowid NOT IN (SELECT rowid FROM card_captures WHERE thread_id = ? ORDER BY rowid DESC LIMIT 64)",
        )
        .run(threadId, threadId);
    })();
  }

  async save(threadId: string, card: Card, source: "tool" | "cli", signal?: AbortSignal) {
    if (this.deleted.has(threadId)) throw new Error("This chat was deleted");
    signal?.throwIfAborted();
    const previews = new Map<string, Set<string>>();

    for (const { preview } of card.deliverables) {
      if (preview === undefined) continue;
      let paths = previews.get(preview.projectId);

      if (paths === undefined) {
        paths = new Set();
        previews.set(preview.projectId, paths);
      }

      paths.add(preview.path);
    }

    for (const [projectId, paths] of previews)
      await this.api.sdk.projects.attachments.experimental_retain({
        projectId,
        threadId,
        paths: [...paths],
      });

    const proofs = await linkProof(this.api, threadId, card, signal);

    if (this.deleted.has(threadId)) throw new Error("This chat was deleted");
    signal?.throwIfAborted();

    const revision = this.database().transaction(() => {
      const previous = this.current(threadId);
      const revision = (previous?.revision ?? 0) + 1;
      const now = Date.now();

      const goal =
        card.goal ??
        (previous === null
          ? undefined
          : storedPayloadSchema.parse(JSON.parse(previous.card_json)).goal);

      const serialized = JSON.stringify(goal === undefined ? card : { ...card, goal });

      this.database()
        .prepare(
          "INSERT INTO card_revisions(thread_id, revision, card_json, created_at, source) VALUES(?, ?, ?, ?, ?)",
        )
        .run(threadId, revision, serialized, now, source);
      this.database()
        .prepare(
          "INSERT INTO cards(thread_id, revision, card_json, updated_at, source, stale_since) VALUES(?, ?, ?, ?, ?, NULL) ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, card_json = excluded.card_json, updated_at = excluded.updated_at, source = excluded.source, stale_since = NULL",
        )
        .run(threadId, revision, serialized, now, source);

      for (const proof of proofs)
        this.database()
          .prepare("INSERT INTO proofs(thread_id, revision, idx, proof_json) VALUES(?, ?, ?, ?)")
          .run(threadId, revision, proof.index, JSON.stringify(proof));
      this.prune(threadId);

      return revision;
    })();

    this.notify(threadId, revision);

    return {
      view: this.view(threadId),
      proofLinks: proofs.map((proof) => ({
        index: proof.index,
        linked: proof.linked,
        eventSeq: proof.eventSeq,
      })),
    };
  }

  private async latestCursor(threadId: string): Promise<number> {
    const rows = await listEvents(this.api, { threadId, order: "desc", limit: "1" });

    return rows[0]?.seq ?? 0;
  }

  private readCursor(threadId: string): Promise<number> {
    if (this.deleted.has(threadId)) return Promise.reject(new Error("This chat was deleted"));
    const existing = this.reads.get(threadId);

    if (existing) return existing;

    const validation = this.requireThread(threadId);

    const cursor = this.latestCursor(threadId).then(
      (seq) => ({ ok: true as const, seq }),
      (error) => ({ ok: false as const, error }),
    );

    const read: Promise<number> = validation
      .then(async () => {
        const outcome = await cursor;

        if (!outcome.ok) throw outcome.error;

        if (this.deleted.has(threadId)) throw new Error("This chat was deleted");

        return outcome.seq;
      })
      .finally(() => {
        if (this.reads.get(threadId) === read) this.reads.delete(threadId);
      });

    this.reads.set(threadId, read);

    return read;
  }

  private async repliesSince(threadId: string, afterSeq: number, throughSeq: number) {
    let cursor = afterSeq;
    const replies = new Set<string>();

    for (let page = 0; page < 5; page += 1) {
      const rows = await listEvents(this.api, {
        threadId,
        order: "asc",
        limit: "100",
        afterSeq: String(cursor),
        beforeSeq: String(throughSeq + 1),
        types: ["item/completed"],
      });

      if (rows.length === 0) return { newReplies: replies.size, moreActivity: false };

      for (const row of rows) {
        if (
          row.type === "item/completed" &&
          row.data.item.type === "agentMessage" &&
          row.data.item.text.trim().length > 0
        )
          replies.add(row.data.item.id);

        if (replies.size > 100) return { newReplies: 100, moreActivity: true };
      }

      cursor = rows.at(-1)?.seq ?? cursor;
    }

    const remaining = await listEvents(this.api, {
      threadId,
      order: "asc",
      limit: "1",
      afterSeq: String(cursor),
      beforeSeq: String(throughSeq + 1),
      types: ["item/completed"],
    });

    return { newReplies: replies.size, moreActivity: remaining.length > 0 };
  }

  read(threadId: string) {
    if (this.deleted.has(threadId)) throw new Error("This chat was deleted");

    return { view: this.view(threadId) };
  }

  async get(threadId: string) {
    const conversationSeq = await this.readCursor(threadId);
    const view = this.view(threadId);

    this.capture(threadId, view?.revision ?? null, conversationSeq);

    return { view, conversationSeq };
  }

  async diff(threadId: string): Promise<CardDiff> {
    const conversationSeq = await this.readCursor(threadId);
    const current = this.current(threadId);
    const seen = this.readSeen(threadId);

    let changes: CardDiff["changes"] = [];

    if (seen && current && seen.revision !== current.revision) {
      const previous = this.database()
        .prepare("SELECT card_json FROM card_revisions WHERE thread_id = ? AND revision = ?")
        .get(threadId, seen.revision);

      if (!previous) throw new Error("The last seen card revision is unavailable");
      changes = compareCards(
        storedPayloadSchema.parse(JSON.parse(revisionSchema.parse(previous).card_json)),
        storedPayloadSchema.parse(JSON.parse(current.card_json)),
      );
    }

    const activity = seen
      ? await this.repliesSince(threadId, seen.conversation_seq, conversationSeq)
      : { newReplies: 0, moreActivity: false };

    const result: CardDiff = {
      seenRevision: seen?.revision ?? null,
      revision: current?.revision ?? null,
      conversationSeq,
      changes,
      ...activity,
    };

    this.capture(threadId, current?.revision ?? null, conversationSeq);

    return result;
  }

  markSeen(threadId: string, revision: number, conversationSeq: number) {
    if (
      !this.database()
        .prepare(
          "SELECT 1 FROM card_captures WHERE thread_id = ? AND revision = ? AND conversation_seq = ?",
        )
        .get(threadId, revision, conversationSeq)
    )
      throw new Error("Refresh the displayed card before marking it seen");

    this.database().transaction(() => {
      const current = this.current(threadId);
      const seen = this.readSeen(threadId);

      const revisionExists = this.database()
        .prepare("SELECT 1 FROM card_revisions WHERE thread_id = ? AND revision = ?")
        .get(threadId, revision);

      if (!current || !revisionExists || revision > current.revision)
        throw new Error("The displayed card revision is unavailable");

      if (seen && (revision < seen.revision || conversationSeq < seen.conversation_seq)) return;
      this.database()
        .prepare(
          "INSERT INTO seen(thread_id, revision, conversation_seq, seen_at) VALUES(?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, conversation_seq = excluded.conversation_seq, seen_at = excluded.seen_at",
        )
        .run(threadId, revision, conversationSeq, Date.now());
      this.prune(threadId);
    })();
    this.notify(threadId, this.current(threadId)?.revision ?? revision);

    return { ok: true as const };
  }

  index() {
    const rows = z
      .array(storedCardSchema)
      .parse(
        this.database().prepare("SELECT * FROM cards ORDER BY updated_at DESC, thread_id").all(),
      );

    return { cards: rows.map((row) => this.entryOf(row)) };
  }

  entry(threadId: string): CardIndexEntry | null {
    const row = this.current(threadId);

    return row === null ? null : this.entryOf(row);
  }

  private entryOf(row: z.infer<typeof storedCardSchema>): CardIndexEntry {
    const card = storedPayloadSchema.parse(JSON.parse(row.card_json));

    return {
      threadId: row.thread_id,
      revision: row.revision,
      status: card.status,
      phase: card.phase,
      goal: card.goal ?? null,
      headline: card.headline,
      sidebarSummary: card.sidebarSummary ?? null,
      blocker: card.blocker ?? null,
      next: card.next ?? null,
      facts: card.facts,
      visuals: card.deliverables
        .flatMap((deliverable) =>
          deliverable.preview === undefined
            ? []
            : [{ title: deliverable.title, preview: deliverable.preview }],
        )
        .slice(0, 2),
      stale: row.stale_since !== null,
      unseen: row.revision > (this.readSeen(row.thread_id)?.revision ?? 0),
      updatedAt: row.updated_at,
    };
  }

  async idle(threadId: string): Promise<void> {
    const card = this.current(threadId);

    if (!card || card.stale_since !== null) return;

    const turns = await listEvents(this.api, {
      threadId,
      types: ["turn/started"],
      order: "desc",
      limit: "1",
    });

    const latest = turns[0];

    if (latest) this.retire(threadId, card.revision, latest.createdAt);
  }

  activated(threadId: string, activeAt: number): void {
    const card = this.current(threadId);

    if (card) this.retire(threadId, card.revision, activeAt);
  }

  private retire(threadId: string, revision: number, since: number): void {
    const result = this.database()
      .prepare(
        "UPDATE cards SET stale_since = ? WHERE thread_id = ? AND revision = ? AND updated_at < ? AND stale_since IS NULL",
      )
      .run(since, threadId, revision, since);

    if (result.changes > 0) this.notify(threadId, revision);
  }

  remove(threadId: string): void {
    this.deleted.add(threadId);
    this.database().transaction(() => {
      for (const table of [
        "dev_server_activity",
        "card_captures",
        "proofs",
        "card_revisions",
        "seen",
        "cards",
      ])
        this.database().prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
    })();
    this.notify(threadId, 0);
  }
}
