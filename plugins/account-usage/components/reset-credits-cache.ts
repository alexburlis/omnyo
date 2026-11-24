import type { CodexResetCredits } from "../lib/codex-reset-contract.ts";

const CACHE_MS = 3 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 80_000;

type CacheEntry = {
  credits: CodexResetCredits | null;
  expiresAt: number;
  request: Promise<CodexResetCredits> | null;
};

const entries = new Map<string, CacheEntry>();

export function cachedResetCredits(
  accountId: string,
): CodexResetCredits | null {
  return entries.get(accountId)?.credits ?? null;
}

export function resetCreditsExpiry(accountId: string): number | null {
  const entry = entries.get(accountId);

  return entry?.credits === null ? null : (entry?.expiresAt ?? null);
}

export function invalidateResetCredits(accountId?: string): void {
  if (accountId === undefined) entries.clear();
  else entries.delete(accountId);
}

export function loadResetCredits(
  accountId: string,
  fetchCredits: () => Promise<CodexResetCredits>,
): Promise<CodexResetCredits> {
  const entry = entries.get(accountId) ?? {
    credits: null,
    expiresAt: 0,
    request: null,
  };

  if (entry.request !== null) return entry.request;

  if (entry.credits !== null && entry.expiresAt > Date.now())
    return Promise.resolve(entry.credits);

  entries.set(accountId, entry);
  let timer: ReturnType<typeof setTimeout>;

  const request = new Promise<CodexResetCredits>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Reset credits check timed out. Try again.")),
      REQUEST_TIMEOUT_MS,
    );
    Promise.resolve().then(fetchCredits).then(resolve, reject);
  })
    .then((credits) => {
      if (entries.get(accountId) === entry) {
        entry.credits = credits;
        entry.expiresAt = Date.now() + CACHE_MS;
      }

      return credits;
    })
    .finally(() => {
      clearTimeout(timer);
      entry.request = null;
    });

  entry.request = request;

  return request;
}
