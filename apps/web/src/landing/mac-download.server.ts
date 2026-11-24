import { MACOS_DOWNLOAD_URL, type PublicMacDownload } from "./site";

const feedUrl = new URL("public-beta-mac.yml", MACOS_DOWNLOAD_URL);

const feedLifetimeMs = 120_000;

let cached: {
  expiresAt: number;
  result: Promise<PublicMacDownload | null>;
} | null = null;

export function parsePublicMacDownload(feed: string): PublicMacDownload | null {
  const version = /^version: (\d+\.\d+\.\d+(?:\+private\.\d+)?)\r?$/mu.exec(
    feed,
  )?.[1];

  if (!version) return null;

  const filename = `omnyo-${version}-arm64.zip`;

  if (
    !feed.split(/\r?\n/u).some((line) => line.trim() === `- url: ${filename}`)
  )
    return null;

  return { version, url: new URL(encodeURIComponent(filename), feedUrl).href };
}

async function readPublicMacDownload(): Promise<PublicMacDownload | null> {
  try {
    const response = await fetch(feedUrl, {
      signal: AbortSignal.timeout(1_500),
    });

    if (!response.ok) return null;

    return parsePublicMacDownload(await response.text());
  } catch {
    return null;
  }
}

export function publicMacDownload(): Promise<PublicMacDownload | null> {
  const now = Date.now();

  if (cached === null || cached.expiresAt <= now)
    cached = {
      expiresAt: now + feedLifetimeMs,
      result: readPublicMacDownload(),
    };

  return cached.result;
}
