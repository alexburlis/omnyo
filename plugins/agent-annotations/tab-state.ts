import { z } from "zod";
import { pageAnnotationSchema } from "./annotations.js";

const referenceSchema = z
  .object({
    id: z.string().min(1).max(64),
    revisionId: z.string().min(1).max(64),
    pageRevision: z.number().int().nonnegative(),
  })
  .strict();

const tabReferencesSchema = z
  .object({
    notes: z.array(referenceSchema),
    reviews: z
      .array(
        z
          .object({
            revisionId: z.string().min(1).max(64),
            id: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(24),
    pending: z.array(pageAnnotationSchema),
    reviewId: z.string().nullable(),
    designMode: z.boolean(),
  })
  .strict();

export type TabReferences = z.infer<typeof tabReferencesSchema>;

interface TabQueue {
  current: Promise<void>;
  users: number;
}

const queues = new Map<string, TabQueue>();

export function tabStateKey(
  pluginId: string,
  threadId: string,
  tabId: string,
): string {
  return `agent-annotations:${JSON.stringify([pluginId, threadId, tabId])}`;
}

export function tabQueue(key: string): TabQueue {
  let owner = queues.get(key);

  if (owner === undefined) {
    owner = { current: Promise.resolve(), users: 0 };
    queues.set(key, owner);
  }

  return owner;
}

export function retainTabQueue(key: string, owner: TabQueue): () => void {
  owner.users += 1;

  return () => {
    owner.users -= 1;
    const pending = owner.current;

    const remove = () => {
      if (
        owner.users === 0 &&
        owner.current === pending &&
        queues.get(key) === owner
      )
        queues.delete(key);
    };

    void pending.then(remove, remove);
  };
}

export function readTabReferences(key: string): TabReferences | null {
  const raw = sessionStorage.getItem(key);

  if (raw === null) return null;

  if (raw.length > 65_536)
    throw new Error("The saved annotation batch exceeds its recovery limit.");

  return tabReferencesSchema.parse(JSON.parse(raw));
}

export function writeTabReferences(key: string, value: TabReferences): void {
  const raw = JSON.stringify(tabReferencesSchema.parse(value));

  if (raw.length > 65_536)
    throw new Error(
      "The annotation batch exceeds its recovery limit. Send or remove notes before adding more.",
    );
  sessionStorage.setItem(key, raw);
}
