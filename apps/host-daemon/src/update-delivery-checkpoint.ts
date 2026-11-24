import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { threadEventSchema } from "@omnyo/domain";
import { hostDaemonInteractiveInterruptInputSchema } from "@omnyo/host-daemon-contract";

export const UPDATE_DELIVERY_CHECKPOINT_FILE = "worker-update-checkpoint.json";

const interruptSchema = hostDaemonInteractiveInterruptInputSchema.safeExtend({
  deliveryId: z.string().uuid(),
});

export type PendingInteractiveInterruptRequest = z.infer<
  typeof interruptSchema
>;

const checkpointSchema = z
  .object({
    version: z.literal(1),
    hostId: z.string().min(1),
    events: z.array(
      z
        .object({
          instanceId: z.string().min(1),
          index: z.number().int().positive(),
          envelope: z
            .object({
              threadId: z.string().min(1),
              event: threadEventSchema,
            })
            .strict(),
          blockedReason: z
            .enum(["invalid_request", "thread_not_owned_by_host"])
            .nullable(),
        })
        .strict(),
    ),
    interrupts: z.array(interruptSchema),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const keys = new Set<string>();

    for (const [index, event] of checkpoint.events.entries()) {
      const key = eventKey(event);

      if (keys.has(key))
        context.addIssue({
          code: "custom",
          message: "Duplicate retained event identity",
          path: ["events", index],
        });
      keys.add(key);
    }
  });

type Checkpoint = z.infer<typeof checkpointSchema>;

export type PendingDeliveryEvent = Checkpoint["events"][number];

function eventKey(event: { instanceId: string; index: number }): string {
  return JSON.stringify([event.instanceId, event.index]);
}

export class UpdateDeliveryCheckpoint {
  private checkpoint: Checkpoint;
  private active = false;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly hostId: string,
  ) {
    this.path = join(dataDir, UPDATE_DELIVERY_CHECKPOINT_FILE);
    this.checkpoint = { version: 1, hostId, events: [], interrupts: [] };
  }

  async load(): Promise<void> {
    let contents: string;

    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }

    let input: unknown;

    try {
      input = JSON.parse(contents);
    } catch {
      throw new Error(
        "Worker update checkpoint is invalid JSON; retained for recovery",
      );
    }

    const checkpoint = checkpointSchema.parse(input);

    if (checkpoint.hostId !== this.hostId)
      throw new Error("Worker update checkpoint belongs to another host");
    this.checkpoint = checkpoint;
    this.active = true;
  }

  get events(): PendingDeliveryEvent[] {
    return this.checkpoint.events.map((event) => ({ ...event }));
  }

  get interrupts(): PendingInteractiveInterruptRequest[] {
    return this.checkpoint.interrupts.map((interrupt) => ({ ...interrupt }));
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const pending = this.writeTail.then(write, write);
    this.writeTail = pending.catch(() => undefined);

    return pending;
  }

  private async save(checkpoint: Checkpoint): Promise<void> {
    if (checkpoint.events.length === 0 && checkpoint.interrupts.length === 0) {
      await rm(this.path, { force: true });
      this.active = false;
      this.checkpoint = checkpoint;

      return;
    }

    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);

    try {
      try {
        await file.writeFile(`${JSON.stringify(checkpoint)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }

      await rename(temporary, this.path);
      this.checkpoint = checkpoint;
      this.active = true;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  capture(args: {
    events: readonly PendingDeliveryEvent[];
    interrupts: readonly PendingInteractiveInterruptRequest[];
    signal: AbortSignal;
  }): Promise<void> {
    return this.enqueue(async () => {
      args.signal.throwIfAborted();

      const events = new Map(
        this.checkpoint.events.map((event) => [eventKey(event), event]),
      );

      for (const event of args.events) {
        const key = eventKey(event);
        const existing = events.get(key);
        events.set(
          key,
          existing === undefined
            ? event
            : {
                ...existing,
                blockedReason: existing.blockedReason ?? event.blockedReason,
              },
        );
      }

      const interrupts = new Map(
        this.checkpoint.interrupts.map((interrupt) => [
          interrupt.deliveryId,
          interrupt,
        ]),
      );

      for (const interrupt of args.interrupts)
        interrupts.set(interrupt.deliveryId, interrupt);
      await this.save({
        version: 1,
        hostId: this.hostId,
        events: [...events.values()],
        interrupts: [...interrupts.values()],
      });
      args.signal.throwIfAborted();
    });
  }

  acknowledgeEvents(
    events: readonly Pick<PendingDeliveryEvent, "instanceId" | "index">[],
  ): Promise<void> {
    return this.enqueue(async () => {
      const acknowledged = new Set(events.map(eventKey));

      if (
        !this.active ||
        !this.checkpoint.events.some((event) =>
          acknowledged.has(eventKey(event)),
        )
      )
        return;
      await this.save({
        ...this.checkpoint,
        events: this.checkpoint.events.filter(
          (event) => !acknowledged.has(eventKey(event)),
        ),
      });
    });
  }

  async recordRejectedEvents(
    events: readonly PendingDeliveryEvent[],
  ): Promise<readonly PendingDeliveryEvent[]> {
    let retained: PendingDeliveryEvent[] = [];
    await this.enqueue(async () => {
      if (!this.active) return;
      const pending = new Set(this.checkpoint.events.map(eventKey));
      retained = events.filter((event) => pending.has(eventKey(event)));

      if (retained.length === 0) return;

      const rejected = new Map(
        retained.map((event) => [eventKey(event), event.blockedReason]),
      );

      await this.save({
        ...this.checkpoint,
        events: this.checkpoint.events.map((event) => ({
          ...event,
          blockedReason: rejected.get(eventKey(event)) ?? event.blockedReason,
        })),
      });
    });

    return retained;
  }

  acknowledgeInterrupt(deliveryId: string): Promise<void> {
    return this.enqueue(async () => {
      if (
        !this.active ||
        !this.checkpoint.interrupts.some(
          (interrupt) => interrupt.deliveryId === deliveryId,
        )
      )
        return;
      await this.save({
        ...this.checkpoint,
        interrupts: this.checkpoint.interrupts.filter(
          (interrupt) => interrupt.deliveryId !== deliveryId,
        ),
      });
    });
  }
}

export async function waitForUpdateCheckpoint(
  pending: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
