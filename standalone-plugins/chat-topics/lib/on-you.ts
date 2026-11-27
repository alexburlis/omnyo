import type { InboxSnapshot } from "./inbox.ts";

export interface OnYouCandidate {
  threadId: string;
  title: string;
  event: string;
  waitId: string;
}

const MIN_WORD_LENGTH = 4;

const COMMON_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "been",
  "before",
  "could",
  "does",
  "done",
  "from",
  "have",
  "into",
  "just",
  "make",
  "need",
  "only",
  "please",
  "should",
  "some",
  "still",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "what",
  "when",
  "which",
  "while",
  "will",
  "with",
  "would",
  "your",
]);

export function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= MIN_WORD_LENGTH && !COMMON_WORDS.has(word)),
  );
}

export function onYouCandidates(snapshot: InboxSnapshot): OnYouCandidate[] {
  return snapshot.waiting.flatMap((entry) =>
    entry.waiting?.group === "on-you" && entry.waiting.waitId !== null
      ? [
          {
            threadId: entry.threadId,
            title: entry.title,
            event: entry.waiting.reason,
            waitId: entry.waiting.waitId,
          },
        ]
      : [],
  );
}

export function matchOnYou(
  draft: string,
  candidates: readonly OnYouCandidate[],
  dismissed: ReadonlySet<string>,
): OnYouCandidate | null {
  const words = significantWords(draft);

  if (words.size === 0) return null;

  for (const candidate of candidates) {
    if (dismissed.has(candidate.waitId)) continue;
    const theirs = significantWords(`${candidate.event} ${candidate.title}`);

    for (const word of words) if (theirs.has(word)) return candidate;
  }

  return null;
}
