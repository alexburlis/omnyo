import type { CuratedEntry } from "./curated-sources.ts";
import {
  marketplaceCatalogSchema,
  marketplaceMaxBytes,
  marketplaceOrigin,
  type MarketplaceCatalog,
} from "./marketplace-contract.ts";

export function matchReviewedSkills(catalog: MarketplaceCatalog, curated: CuratedEntry[]) {
  const reviewedSkills: Record<string, string> = {};

  for (const entry of curated) {
    if (entry.artifact.kind !== "github-files") continue;
    const file = entry.artifact.files.find((candidate) => candidate.path === "SKILL.md");

    if (!file) continue;
    const url = new URL(file.url);

    if (url.origin !== "https://raw.githubusercontent.com") continue;
    const [owner, repository, revision, ...path] = url.pathname.slice(1).split("/");
    const canonical = `https://github.com/${owner}/${repository}/blob/${revision}/${path.join("/")}`;

    for (const item of catalog.items) {
      if (
        item.kind === "skill" &&
        item.setupUrl === undefined &&
        item.source === "github" &&
        item.sourceUrl === canonical &&
        item.revision === entry.pin &&
        item.sha256 === file.sha256
      )
        reviewedSkills[item.slug] = entry.id;
    }
  }

  return reviewedSkills;
}

export async function readMarketplace(fetcher: typeof fetch = fetch): Promise<MarketplaceCatalog> {
  const response = await fetcher(`${marketplaceOrigin}/explore/marketplace.json?provider-setup=1`, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(12000),
    headers: { Accept: "application/json" },
  });

  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("The marketplace could not load. Try again.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      length += chunk.value.byteLength;

      if (length > marketplaceMaxBytes) throw new Error("The marketplace response is too large.");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return marketplaceCatalogSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

export function marketplaceMarkdownUrl(
  item: Extract<MarketplaceCatalog["items"][number], { kind: "skill" }>,
) {
  if (item.source === "omnyo") {
    const expected = `${marketplaceOrigin}/skills/omnyo/${item.slug}/${item.revision}/SKILL.md`;

    if (item.sourceUrl === expected && /^\d+\.\d+\.\d+$/u.test(item.revision))
      return new URL(expected);
  } else {
    const url = new URL(item.sourceUrl);
    const [owner, repository, blob, commit, ...path] = url.pathname.slice(1).split("/");

    if (
      url.origin === "https://github.com" &&
      !url.search &&
      !url.hash &&
      /^[\w-]+$/u.test(owner) &&
      /^[\w.-]+$/u.test(repository) &&
      blob === "blob" &&
      commit === item.revision &&
      /^[a-f0-9]{40}$/u.test(commit) &&
      path.length > 1 &&
      path.at(-1) === "SKILL.md" &&
      path.every((part) => /^[\w.-]+$/u.test(part) && part !== "." && part !== "..")
    )
      return new URL(
        `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${path.join("/")}`,
      );
  }

  throw new Error("The marketplace listing has an unsupported Markdown source.");
}
