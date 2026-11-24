import type { PresenceReport } from "./contract.js";

export const DEFAULT_PRESENCE_IDLE_MS = 2 * 60 * 1_000;

export const DEFAULT_PRESENCE_STALE_MS = 90 * 1_000;

const PRESENCE_CLIENTS_MAX = 32;

interface StoredReport {
  idleSeconds: number;
  locked: boolean;
  reportedAt: number;
}

export interface Presence {
  activeUntil(): number | null;
  report(input: PresenceReport): void;
}

export function createPresence(args: {
  idleMs?: number;
  now: () => number;
  staleMs?: number;
}): Presence {
  const {
    idleMs = DEFAULT_PRESENCE_IDLE_MS,
    now,
    staleMs = DEFAULT_PRESENCE_STALE_MS,
  } = args;

  const clients = new Map<string, StoredReport>();

  function clientActiveUntil(report: StoredReport): number | null {
    if (report.locked) return null;

    const until = Math.min(
      report.reportedAt + staleMs,
      report.reportedAt - report.idleSeconds * 1_000 + idleMs,
    );

    return until > now() ? until : null;
  }

  return {
    activeUntil() {
      let latest: number | null = null;

      for (const [clientId, report] of clients) {
        const until = clientActiveUntil(report);

        if (until === null) {
          if (now() - report.reportedAt >= staleMs) clients.delete(clientId);
          continue;
        }

        latest = latest === null ? until : Math.max(latest, until);
      }

      return latest;
    },
    report({ clientId, idleSeconds, locked }) {
      clients.delete(clientId);
      clients.set(clientId, { idleSeconds, locked, reportedAt: now() });

      for (const oldest of clients.keys()) {
        if (clients.size <= PRESENCE_CLIENTS_MAX) break;
        clients.delete(oldest);
      }
    },
  };
}
