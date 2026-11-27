import { z } from "zod";
import type { InboxEntry, InboxSnapshot } from "./inbox.ts";

export type InboxLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; snapshot: InboxSnapshot; failed: boolean };

export type InboxOutcome =
  | { kind: "done"; moveId: string | null; entry: InboxEntry | null }
  | { kind: "updated" }
  | { kind: "refused"; message: string }
  | { kind: "failed" };

const httpErrorSchema = z.object({
  status: z.number(),
  code: z.string().nullable(),
  body: z
    .object({ message: z.string().min(1) })
    .nullish()
    .catch(null),
});

const FAILED: InboxOutcome = { kind: "failed" };

export interface SharedInboxSnapshot {
  snapshot: InboxSnapshot | null;
  status: "error" | "loading" | "ready";
  stale: boolean;
}

export function inboxLoad(shared: SharedInboxSnapshot): InboxLoad {
  if (shared.snapshot === null) return { status: shared.status === "error" ? "error" : "loading" };

  return { status: "ready", snapshot: shared.snapshot, failed: shared.stale };
}

export type InboxFlight = Promise<InboxOutcome | null>;

export function createInboxFlights(onIdle: (threadId: string) => void) {
  const flights = new Map<string, InboxFlight>();

  return {
    has: (threadId: string) => flights.has(threadId),
    start(threadId: string, run: () => Promise<InboxOutcome>, chained: boolean): InboxFlight {
      const before = flights.get(threadId);

      const flight: InboxFlight =
        before === undefined || !chained
          ? run()
          : before.then((outcome) => (outcome?.kind === "done" ? run() : null));

      flights.set(threadId, flight);
      void flight.then(() => {
        if (flights.get(threadId) !== flight) return;
        flights.delete(threadId);
        onIdle(threadId);
      });

      return flight;
    },
  };
}

export async function undoAfter(
  move: InboxFlight,
  undo: (moveId: string) => Promise<InboxOutcome>,
): InboxFlight {
  const acted = await move;

  if (acted?.kind !== "done" || acted.moveId === null) return null;

  return undo(acted.moveId);
}

type MoveResult = { moveId: string | null; entry: InboxEntry | null };

export async function inboxOutcome(
  run: () => Promise<MoveResult>,
  refresh: () => void,
): Promise<InboxOutcome> {
  try {
    const result = await run();

    return { kind: "done", moveId: result.moveId, entry: result.entry };
  } catch (error) {
    refresh();
    const parsed = httpErrorSchema.safeParse(error);

    if (!parsed.success) return FAILED;

    if (parsed.data.code === "inbox_updated") return { kind: "updated" };
    const message = parsed.data.body?.message;

    return parsed.data.status >= 400 && parsed.data.status < 500 && message !== undefined
      ? { kind: "refused", message }
      : FAILED;
  }
}
