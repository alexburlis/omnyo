import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import type { DevServerRow, DevServerShelf } from "../contract.ts";

const activitySchema = z.array(
  z.object({
    preview_id: z.string(),
    last_online_at: z.number().nullable(),
    remembered_at: z.number(),
  }),
);

type Activity = z.infer<typeof activitySchema>[number];

type PreviewStatus = DevServerRow["status"];

function isActive(row: DevServerRow): boolean {
  return row.status.state === "online" || row.status.state === "starting";
}

function byRecency(
  left: DevServerRow,
  right: DevServerRow,
  activity: Map<string, Activity>,
): number {
  return (
    (right.lastObservedOnlineAt ?? 0) - (left.lastObservedOnlineAt ?? 0) ||
    (activity.get(right.preview.id)?.remembered_at ?? right.preview.createdAt) -
      (activity.get(left.preview.id)?.remembered_at ?? left.preview.createdAt) ||
    left.preview.id.localeCompare(right.preview.id)
  );
}

export class DevServersService {
  private readonly pending = new Map<string, Promise<DevServerShelf>>();
  private readonly deleted = new Set<string>();
  private disposed = false;

  constructor(private readonly api: PluginApi) {
    api.events.on("thread.deleted", ({ thread }) => {
      this.deleted.add(thread.id);
      this.pending.delete(thread.id);
    });
    api.onDispose(() => {
      this.disposed = true;
      this.pending.clear();
    });
  }

  private requireAvailable(threadId: string): void {
    if (this.disposed) throw new Error("Dev servers are reloading. Try again");

    if (this.deleted.has(threadId)) throw new Error("This chat was deleted");
  }

  read(threadId: string): Promise<DevServerShelf> {
    this.requireAvailable(threadId);
    const existing = this.pending.get(threadId);

    if (existing) return existing;

    const pending = this.snapshot(threadId).finally(() => {
      if (this.pending.get(threadId) === pending) this.pending.delete(threadId);
    });

    this.pending.set(threadId, pending);

    return pending;
  }

  private activity(threadId: string): Map<string, Activity> {
    return new Map(
      activitySchema
        .parse(
          this.api.storage
            .database()
            .prepare(
              "SELECT preview_id, last_online_at, remembered_at FROM dev_server_activity WHERE thread_id = ?",
            )
            .all(threadId),
        )
        .map((row) => [row.preview_id, row]),
    );
  }

  async remember(input: { threadId: string; previewId: string }): Promise<DevServerShelf> {
    this.requireAvailable(input.threadId);
    const { previews } = await this.api.sdk.previews.list({ threadId: input.threadId });
    this.requireAvailable(input.threadId);

    if (!previews.some((preview) => preview.id === input.previewId))
      throw new Error("This server does not belong to this chat's workspace");

    this.api.storage
      .database()
      .prepare(
        "INSERT INTO dev_server_activity(thread_id, preview_id, last_online_at, remembered_at) VALUES (?, ?, NULL, ?) ON CONFLICT(thread_id, preview_id) DO UPDATE SET remembered_at = MAX(remembered_at, excluded.remembered_at)",
      )
      .run(input.threadId, input.previewId, Date.now());
    this.pending.delete(input.threadId);

    return this.snapshot(input.threadId);
  }

  async restart(input: {
    threadId: string;
    previewId: string;
    requestId: string;
  }): Promise<DevServerShelf> {
    this.requireAvailable(input.threadId);
    const { previews } = await this.api.sdk.previews.list({ threadId: input.threadId });
    this.requireAvailable(input.threadId);

    const activity = this.activity(input.threadId);

    if (
      !previews.some(
        (preview) =>
          preview.id === input.previewId &&
          (preview.threadId === input.threadId || activity.has(preview.id)),
      )
    )
      throw new Error("This server does not belong to this chat");

    const status = await this.api.sdk.previews.restart({
      previewId: input.previewId,
      requestId: input.requestId,
    });

    this.pending.delete(input.threadId);

    return this.snapshot(input.threadId, { previewId: input.previewId, status });
  }

  private async snapshot(
    threadId: string,
    override?: { previewId: string; status: PreviewStatus },
  ): Promise<DevServerShelf> {
    const { previews } = await this.api.sdk.previews.list({ threadId });
    const observedAt = Date.now();
    const remembered = this.activity(threadId);

    const rows = await Promise.all(
      previews
        .filter((preview) => preview.threadId === threadId || remembered.has(preview.id))
        .map(async (preview): Promise<DevServerRow> => {
          let status: PreviewStatus;

          try {
            status =
              override?.previewId === preview.id
                ? override.status
                : await this.api.sdk.previews.status({ previewId: preview.id });
          } catch {
            status = {
              state: "unknown",
              checkedAt: Date.now(),
              detail: "Could not check this server",
              runId: null,
            };
          }

          if (
            status.state === "online" &&
            (Date.now() - status.checkedAt > 15000 || status.checkedAt > Date.now() + 5000)
          )
            status = {
              state: "unknown",
              checkedAt: Date.now(),
              detail: "Server status is out of date",
              runId: null,
            };

          return { preview, status, lastObservedOnlineAt: null };
        }),
    );

    this.requireAvailable(threadId);
    const database = this.api.storage.database();

    const save = database.prepare(
      "INSERT INTO dev_server_activity(thread_id, preview_id, last_online_at, remembered_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, preview_id) DO UPDATE SET last_online_at = MAX(COALESCE(last_online_at, 0), excluded.last_online_at)",
    );

    database.transaction(() => {
      for (const row of rows)
        if (row.status.state === "online")
          save.run(threadId, row.preview.id, observedAt, row.preview.createdAt);
    })();

    const activity = this.activity(threadId);

    for (const row of rows)
      row.lastObservedOnlineAt = activity.get(row.preview.id)?.last_online_at ?? null;
    rows.sort((left, right) => byRecency(left, right, activity));

    return { active: rows.filter(isActive), recent: rows.find((row) => !isActive(row)) ?? null };
  }
}
