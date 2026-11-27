import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { packConfirmInput, packConfirmResult, packDigestSchema, packReviewResult } from "./pack.ts";

export const curatedMentionProviderId = "curated-skill";

export const curatedEntrySchema = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().min(1).max(120),
    publisher: z.string().min(1).max(120),
    description: z.string().min(1).max(2048),
    sourceUrl: z.url(),
    license: z.string().min(1).max(120),
    useOnce: z.boolean(),
  })
  .strict();

export type CuratedEntry = z.infer<typeof curatedEntrySchema>;

export const catalogSelection = z
  .object({
    id: curatedEntrySchema.shape.id,
    generation: packDigestSchema,
  })
  .strict();

export const catalogReviewInput = catalogSelection.extend({
  projectId: z.string().min(1).max(128),
  environmentId: z.string().min(1).max(128).nullable(),
});

export const curatedRpc = defineRpcContract({
  catalogGet: {
    input: z.object({}).strict(),
    output: z.object({
      generation: packDigestSchema,
      entries: z.array(curatedEntrySchema).max(200),
    }),
  },
  catalogPrepare: {
    input: catalogSelection,
    output: z.object({ reference: z.uuid() }),
  },
  catalogReview: {
    input: catalogReviewInput,
    output: packReviewResult.extend({
      workspacePath: z.string().min(1).max(4096),
      useOnceReference: z.uuid().nullable(),
    }),
  },
  catalogConfirm: {
    input: packConfirmInput,
    output: packConfirmResult.omit({ collectionId: true }),
  },
});

const commonSearchWords = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "how",
  "i",
  "in",
  "me",
  "my",
  "of",
  "on",
  "skill",
  "skills",
  "the",
  "to",
  "up",
  "using",
  "with",
]);

function searchWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function similarWord(query: string, word: string) {
  const extra = word.length - query.length;

  if (query.length < 4 || extra < -1 || extra > (query.length >= 7 ? 2 : 1)) return false;

  const mismatch = [...query].findIndex((character, index) => character !== word[index]);

  if (mismatch === -1) return true;

  const tail = query.slice(mismatch);
  const candidate = word.slice(mismatch);

  if (extra > 0) return tail === candidate.slice(extra);

  if (extra < 0) return tail.slice(1) === candidate;

  return (
    tail.slice(1) === candidate.slice(1) ||
    (tail[0] === candidate[1] && tail[1] === candidate[0] && tail.slice(2) === candidate.slice(2))
  );
}

export function searchCurated(
  entries: readonly CuratedEntry[],
  query: string,
  limit = 30,
): CuratedEntry[] {
  const text = query.trim().toLowerCase().slice(0, 256);
  const words = [...new Set(searchWords(text).filter((word) => !commonSearchWords.has(word)))];
  const exactSource = /^(?:https?:\/\/\S+|[\w.-]+(?:\/[\w.-]+)+)$/u.test(text);
  const matches: { entry: CuratedEntry; score: number; index: number }[] = [];

  for (const [index, entry] of entries.entries()) {
    const id = entry.id.toLowerCase();
    const name = entry.name.toLowerCase();

    if (id === text || name === text || entry.sourceUrl.toLowerCase() === text) {
      matches.push({ entry, score: 1000, index });
      continue;
    }

    if (exactSource) continue;

    const nameWords = searchWords(name);
    const details = searchWords(`${entry.publisher} ${entry.description}`);

    const scores = words.map<number>((word) => {
      if (nameWords.includes(word)) return 8;

      if (nameWords.some((part) => part.startsWith(word))) return 6;

      if (details.includes(word)) return 4;

      if (nameWords.some((part) => similarWord(word, part))) return 3;

      if (word.length >= 4 && details.some((part) => part.startsWith(word))) return 2;

      if (details.some((part) => similarWord(word, part))) return 1;

      return 0;
    });

    const matched = scores.filter((score) => score > 0).length;

    if (matched < Math.ceil(words.length / 2) && !scores.includes(8)) continue;

    matches.push({
      entry,
      score: 10 * matched + scores.reduce((total, score) => total + score, 0),
      index,
    });
  }

  matches.sort((left, right) => right.score - left.score || left.index - right.index);

  return matches
    .slice(0, Math.max(0, Math.min(200, Math.floor(limit))))
    .map((match) => match.entry);
}
