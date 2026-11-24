import { z } from "zod";

const historySnapshotSchema = z.object({
  version: z.literal(5),
  threadId: z.string().min(1),
  maxSeq: z.number().int().nonnegative(),
  status: z.string().min(1),
  surface: z.string(),
  historyEpoch: z.string().regex(/^[0-9a-f]{32}$/),
});

export type TimelineHistoryIdentity = Pick<
  z.infer<typeof historySnapshotSchema>,
  "threadId" | "surface" | "historyEpoch"
>;

export function readTimelineHistoryIdentity(
  snapshot: string | undefined,
): TimelineHistoryIdentity | null {
  if (!snapshot || snapshot.length > 4096) return null;

  try {
    const parsed = historySnapshotSchema.safeParse(JSON.parse(snapshot));

    return parsed.success
      ? {
          threadId: parsed.data.threadId,
          surface: parsed.data.surface,
          historyEpoch: parsed.data.historyEpoch,
        }
      : null;
  } catch {
    return null;
  }
}

export function areTimelineHistorySnapshotsCompatible(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const previous = readTimelineHistoryIdentity(left);
  const next = readTimelineHistoryIdentity(right);

  if (previous === null || next === null) return previous === next;

  return (
    previous.threadId === next.threadId &&
    previous.surface === next.surface &&
    previous.historyEpoch === next.historyEpoch
  );
}
