import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";

const eventSchema = z.object({
  action: z.string().min(1).max(80),
  data: z.object({
    issue: z.object({
      id: z.string().regex(/^\d+$/u),
      project: z.object({ id: z.union([z.string(), z.number()]).transform(String) }),
    }),
  }),
});

export class WorkflowWebhook {
  private db;
  private draining: Promise<void> | null = null;

  constructor(
    private api: PluginApi,
    private secret: () => Promise<string | undefined>,
    private scan: (projectIds: string[]) => Promise<void>,
  ) {
    this.db = api.storage.database();
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS workflow_webhooks(id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL, created_at INTEGER NOT NULL, processed_at INTEGER)",
    );
  }

  async receive(request: Request): Promise<Response> {
    const secret = await this.secret();

    if (!secret) return new Response("Webhook is not configured", { status: 503 });

    if (Number(request.headers.get("content-length") ?? 0) > 524288)
      return new Response("Too large", { status: 413 });
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    if (!reader) return new Response("Missing body", { status: 400 });

    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > 524288) {
        await reader.cancel();

        return new Response("Too large", { status: 413 });
      }

      chunks.push(chunk.value);
    }

    const bytes = Buffer.concat(chunks, size);
    const signature = request.headers.get("sentry-hook-signature") ?? "";
    const expected = createHmac("sha256", secret).update(bytes).digest();

    if (
      !/^[a-f0-9]{64}$/iu.test(signature) ||
      !timingSafeEqual(expected, Buffer.from(signature, "hex"))
    )
      return new Response("Invalid signature", { status: 401 });
    const requestId = request.headers.get("request-id");

    if (!requestId || requestId.length > 200)
      return new Response("Missing request identity", { status: 400 });
    let payload: unknown;

    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const parsed = eventSchema.safeParse(payload);

    if (!parsed.success) return new Response("Event has no issue", { status: 200 });
    this.db
      .prepare("INSERT OR IGNORE INTO workflow_webhooks VALUES(?,?,?,?,NULL)")
      .run(
        requestId,
        createHash("sha256").update(bytes).digest("hex"),
        parsed.data.data.issue.project.id,
        Date.now(),
      );
    void this.drain().catch(() =>
      this.api.log.warn("Sentry webhook intake failed; the event remains queued"),
    );

    return new Response("Accepted", { status: 202 });
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const work = this.process();
    this.draining = work;

    const clear = () => {
      if (this.draining === work) this.draining = null;
    };

    void work.then(clear, clear);

    return work;
  }

  private async process() {
    const rows = z
      .array(z.object({ id: z.string(), project_id: z.string() }))
      .parse(
        this.db
          .prepare(
            "SELECT id,project_id FROM workflow_webhooks WHERE processed_at IS NULL ORDER BY created_at LIMIT 100",
          )
          .all(),
      );

    if (!rows.length) return;
    await this.scan([...new Set(rows.map((row) => row.project_id))]);
    const finish = this.db.prepare("UPDATE workflow_webhooks SET processed_at=? WHERE id=?");
    this.db.transaction(() => {
      for (const row of rows) finish.run(Date.now(), row.id);
    })();
    this.db
      .prepare("DELETE FROM workflow_webhooks WHERE processed_at IS NOT NULL AND created_at<?")
      .run(Date.now() - 7 * 86400000);
  }
}
