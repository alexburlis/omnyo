import { z } from "zod";

const expansionSchema = z
  .object({ revision: z.number().int().positive(), open: z.boolean() })
  .passthrough();

type Expansion = z.infer<typeof expansionSchema>;

type ExpansionStorage = Pick<Storage, "getItem" | "setItem">;

export function readGlanceExpansion(
  storage: ExpansionStorage,
  pluginId: string,
  threadId: string,
): Expansion | null {
  const raw = storage.getItem(`omnyo:${pluginId}:expansion:${threadId}`);

  if (raw === null) return null;

  try {
    return expansionSchema.parse(z.json().parse(JSON.parse(raw)));
  } catch {
    throw new Error("Saved card preference is invalid.");
  }
}

export function writeGlanceExpansion(
  storage: ExpansionStorage,
  pluginId: string,
  threadId: string,
  next: Pick<Expansion, "revision" | "open">,
): Expansion {
  const previous = readGlanceExpansion(storage, pluginId, threadId);
  const selected = expansionSchema.parse({ ...previous, ...next });
  const raw = JSON.stringify(selected);
  const canonicalKey = `omnyo:${pluginId}:expansion:${threadId}`;
  storage.setItem(canonicalKey, raw);

  if (storage.getItem(canonicalKey) !== raw)
    throw new Error("Saved card preference could not be verified.");

  return selected;
}
