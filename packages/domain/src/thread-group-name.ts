export const DEFAULT_THREAD_GROUP_NAME = "New group";

const THREAD_GROUP_NAME_MAX_LENGTH = 48;

const NAME_SEPARATORS = /[\s›>»·|:/–—-]+/u;

const FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function words(title: string): string[] {
  return title.split(NAME_SEPARATORS).filter((word) => word.length > 0);
}

function hasRun(haystack: readonly string[], run: readonly string[]): boolean {
  for (let start = 0; start + run.length <= haystack.length; start += 1) {
    if (run.every((word, offset) => haystack[start + offset] === word))
      return true;
  }

  return false;
}

export function suggestThreadGroupName(titles: readonly string[]): string {
  const [first, ...rest] = titles.map(words);

  if (first === undefined || first.length === 0) {
    return DEFAULT_THREAD_GROUP_NAME;
  }

  const folded = first.map((word) => word.toLocaleLowerCase());

  const others = rest.map((title) =>
    title.map((word) => word.toLocaleLowerCase()),
  );

  for (let length = first.length; length > 0; length -= 1) {
    for (let start = 0; start + length <= first.length; start += 1) {
      const run = folded.slice(start, start + length);

      if (run.every((word) => FILLER_WORDS.has(word))) continue;

      if (others.every((title) => hasRun(title, run))) {
        const name = first.slice(start, start + length).join(" ");

        return name.length > THREAD_GROUP_NAME_MAX_LENGTH
          ? name.slice(0, THREAD_GROUP_NAME_MAX_LENGTH).trimEnd()
          : name;
      }
    }
  }

  return DEFAULT_THREAD_GROUP_NAME;
}
