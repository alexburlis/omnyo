import { createHash, randomUUID } from "node:crypto";
import type {
  PluginRpcHandlers,
  ExperimentalPluginRpcHandlersWithContext,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import type { Db } from "./data.js";
import {
  openSeoConnection,
  openSeoKeyword,
  openSeoRpcContract,
  type workflowSourceSelection,
  type workflowSourceSnapshot,
} from "./openseo-contract.js";
import { OpenSeoRequestError, openSeoRead } from "./openseo-transport.js";

export const OPEN_SEO_KEY_SETTING = "openSeoWorkspaceApiKey";

export const openSeoMigration = `ALTER TABLE workflow_imports ADD COLUMN approved_source TEXT;
CREATE TABLE workflow_openseo_connections (
  import_id TEXT PRIMARY KEY REFERENCES workflow_imports(import_id) ON DELETE CASCADE,
  site TEXT NOT NULL,
  provider_project TEXT NOT NULL,
  key_digest TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  expired INTEGER NOT NULL DEFAULT 0
);`;

type Target = { projectId: string; importId: string };

type Connection = z.infer<typeof openSeoConnection>;

type Selection = Extract<
  z.infer<typeof workflowSourceSelection>,
  { kind: "openseo" }
>;

type Snapshot = Extract<
  z.infer<typeof workflowSourceSnapshot>,
  { kind: "openseo" }
>;

type Handlers = PluginRpcHandlers<typeof openSeoRpcContract>;

type Reader = Awaited<ReturnType<typeof openSeoRead>>;

const openSeoKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(512)
  .regex(/^oseo_[A-Za-z0-9._-]+$/u);

const connectionRecord = openSeoConnection.extend({
  digest: z.string(),
  id: z.uuid(),
  expired: z.int(),
});

export function createOpenSeo(args: {
  db: Db;
  readKey(): Promise<string | undefined>;
  copyRevision(target: Target): Promise<number>;
}) {
  const { db, readKey, copyRevision } = args;

  const reads = new Map<
    string,
    {
      readId: string;
      projectId: string;
      revision: number;
      connectionId: string;
      expiresAt: number;
      evidence: Snapshot;
    }
  >();

  const busy = new Set<string>();

  function connection(importId: string) {
    return connectionRecord.optional().parse(
      db
        .prepare(`SELECT site, provider_project AS openSeoProjectId,
      key_digest AS digest, connection_id AS id, expired FROM workflow_openseo_connections WHERE import_id = ?`)
        .get(importId),
    );
  }

  async function key() {
    const raw = await readKey();

    return raw?.trim() || undefined;
  }

  function digest(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  function matches(saved: Connection, input: Connection) {
    return (
      saved.site === input.site &&
      saved.openSeoProjectId === input.openSeoProjectId
    );
  }

  async function status({
    importId,
  }: Target): Promise<
    Awaited<ReturnType<Handlers["workflow_openseo_status"]>>
  > {
    const configured = await key();
    const saved = connection(importId);

    return {
      kind:
        !saved || !configured
          ? "disconnected"
          : saved.expired || saved.digest !== digest(configured)
            ? "expired"
            : "connected",
      keyConfigured: configured !== undefined,
      connection: saved
        ? { site: saved.site, openSeoProjectId: saved.openSeoProjectId }
        : null,
    };
  }

  async function remote<Result>(
    input: Target,
    signal: AbortSignal,
    perform: (
      reader: () => Promise<Reader>,
      fingerprint: string,
      revision: number,
    ) => Promise<Result>,
  ): Promise<
    Result | { kind: "disconnected" | "expired" | "failed" | "budget-blocked" }
  > {
    const revision = await copyRevision(input);

    if (busy.has(input.importId)) return { kind: "failed" };
    busy.add(input.importId);

    try {
      const raw = await key();

      if (!raw) return { kind: "disconnected" };
      const parsed = openSeoKeySchema.safeParse(raw);

      if (!parsed.success) return { kind: "expired" };

      const fingerprint = digest(parsed.data);

      try {
        return await perform(
          () => openSeoRead(parsed.data, signal),
          fingerprint,
          revision,
        );
      } catch (error) {
        const kind =
          error instanceof OpenSeoRequestError ? error.kind : "failed";

        if (kind === "expired") {
          db.prepare(`UPDATE workflow_openseo_connections SET expired = 1
            WHERE import_id = ? AND key_digest = ?`).run(
            input.importId,
            fingerprint,
          );
          reads.delete(input.importId);
        }

        return { kind };
      }
    } finally {
      busy.delete(input.importId);
    }
  }

  async function assertCurrent(
    input: Target,
    fingerprint: string,
    revision: number,
  ) {
    const [currentKey, currentRevision] = await Promise.all([
      key(),
      copyRevision(input),
    ]);

    if (!currentKey || digest(currentKey) !== fingerprint)
      throw new OpenSeoRequestError("expired");

    if (currentRevision !== revision) throw new OpenSeoRequestError("failed");
  }

  const handlers = {
    async workflow_openseo_status(input) {
      await copyRevision(input);

      return status(input);
    },
    async workflow_openseo_disconnect(input) {
      await copyRevision(input);

      if (busy.has(input.importId))
        throw new Error("Wait for the OpenSEO request to finish.");
      db.prepare(
        "DELETE FROM workflow_openseo_connections WHERE import_id = ?",
      ).run(input.importId);
      reads.delete(input.importId);

      return status(input);
    },
    workflow_openseo_projects(input, context) {
      return remote(
        input,
        context.experimental_signal,
        async (reader, fingerprint, revision) => {
          const projects = await (await reader()).projects(input.site);
          await assertCurrent(input, fingerprint, revision);

          return projects.length
            ? ({ kind: "ready", projects } as const)
            : ({ kind: "empty" } as const);
        },
      );
    },
    workflow_openseo_connect(input, context) {
      return remote(
        input,
        context.experimental_signal,
        async (reader, fingerprint, revision) => {
          const projects = await (await reader()).projects(input.site);
          await assertCurrent(input, fingerprint, revision);

          if (!projects.some(({ id }) => id === input.openSeoProjectId))
            return { kind: "failed" } as const;

          db.prepare(`INSERT INTO workflow_openseo_connections
          (import_id, site, provider_project, key_digest, connection_id, expired) VALUES (?, ?, ?, ?, ?, 0)
          ON CONFLICT(import_id) DO UPDATE SET site=excluded.site, provider_project=excluded.provider_project,
          key_digest=excluded.key_digest, connection_id=excluded.connection_id, expired=0`).run(
            input.importId,
            input.site,
            input.openSeoProjectId,
            fingerprint,
            randomUUID(),
          );
          reads.delete(input.importId);

          return { kind: "connected" } as const;
        },
      );
    },
    workflow_openseo_keywords(input, context) {
      return remote(
        input,
        context.experimental_signal,
        async (reader, fingerprint, revision) => {
          const saved = connection(input.importId);

          if (!saved || !matches(saved, input))
            return { kind: "disconnected" } as const;

          if (saved.digest !== fingerprint || saved.expired)
            return { kind: "expired" } as const;

          const client = await reader();
          const projects = await client.projects(input.site);

          if (!projects.some(({ id }) => id === input.openSeoProjectId))
            throw new OpenSeoRequestError("expired");
          await assertCurrent(input, fingerprint, revision);
          const keywords = await client.keywords(input.openSeoProjectId);
          await assertCurrent(input, fingerprint, revision);

          if (!keywords.length) return { kind: "empty" } as const;

          if (new Set(keywords.map(({ id }) => id)).size !== keywords.length)
            throw new OpenSeoRequestError("failed");

          const now = Date.now();

          for (const [id, prior] of reads)
            if (prior.expiresAt <= now) reads.delete(id);

          if (reads.size >= 128 && !reads.has(input.importId))
            throw new OpenSeoRequestError("failed");

          const readId = randomUUID();
          const retrievedAt = new Date(now).toISOString();
          reads.set(input.importId, {
            readId,
            projectId: input.projectId,
            revision,
            connectionId: saved.id,
            expiresAt: now + 15 * 60_000,
            evidence: {
              kind: "openseo",
              site: input.site,
              retrievedAt,
              keywords,
            },
          });

          return { kind: "ready", readId, retrievedAt, keywords } as const;
        },
      );
    },
  } satisfies ExperimentalPluginRpcHandlersWithContext<
    typeof openSeoRpcContract
  >;

  async function select(
    input: Target & { expectedRevision: number },
    selection: Selection,
  ): Promise<Snapshot> {
    const configured = await key();
    const result = reads.get(input.importId);
    const saved = connection(input.importId);

    if (
      !configured ||
      !saved ||
      saved.expired ||
      saved.digest !== digest(configured) ||
      !result ||
      result.readId !== selection.readId ||
      result.projectId !== input.projectId ||
      result.revision !== input.expectedRevision ||
      result.connectionId !== saved.id ||
      result.expiresAt <= Date.now()
    )
      throw new Error(
        "Read saved OpenSEO keywords again before selecting evidence.",
      );

    const keywordIds = new Set(selection.keywordIds);

    const keywords = result.evidence.keywords.filter(({ id }) =>
      keywordIds.has(id),
    );

    if (keywords.length !== keywordIds.size)
      throw new Error("Select only keywords from this OpenSEO read.");

    const evidence = {
      ...result.evidence,
      keywords: z.array(openSeoKeyword).parse(keywords),
    };

    if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > 16 * 1024)
      throw new Error(
        "Select fewer keywords to keep the research brief below 16 KiB.",
      );

    return evidence;
  }

  function invalidate() {
    db.prepare("UPDATE workflow_openseo_connections SET expired = 1").run();
    reads.clear();
  }

  return { handlers, select, invalidate };
}
