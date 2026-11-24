import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Session } from "electron";
import { z } from "zod";
import {
  DESKTOP_BROWSER_COOKIE_SYNC_INTERVAL_MS,
  desktopBrowserCookieSyncSourceSchema,
  type DesktopBrowserCookieSyncRun,
  type DesktopBrowserCookieSyncSource,
  type DesktopBrowserCookieSyncStatus,
} from "@omnyo/host-daemon-contract";
import {
  isLiveCookie,
  storeCookies,
  type BrowserImportService,
} from "./browser-import.js";
import { bareHost, type ImportedCookie } from "./cookie-database.js";

export const COOKIE_SYNC_STATE_FILE = "browser-cookie-sync.json";

const ACTIVITY_REFRESH_AFTER_MS = 2 * 60 * 1000;

const cookieKeySchema = z.tuple([z.string(), z.string(), z.string()]);

const stateSchema = z
  .object({
    version: z.literal(1),
    source: desktopBrowserCookieSyncSourceSchema.nullable(),
    syncedCookieKeys: z.array(z.string()),
  })
  .strict();

type CookieSyncState = z.infer<typeof stateSchema>;

export type CookieSyncSession = {
  cookies: Pick<Session["cookies"], "set" | "flushStore" | "remove">;
};

export interface BrowserCookieSync {
  status(): Promise<DesktopBrowserCookieSyncStatus>;
  configure(
    source: DesktopBrowserCookieSyncSource | null,
  ): Promise<DesktopBrowserCookieSyncStatus>;
  run(): Promise<DesktopBrowserCookieSyncStatus>;
  noteBrowserActivity(): void;
  stop(): void;
}

export interface CreateBrowserCookieSyncArgs {
  browserImport: Pick<BrowserImportService, "readCookies">;
  session: () => CookieSyncSession;
  statePath: string;
  now?: () => number;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

function cookieHost(cookie: ImportedCookie): string {
  if (cookie.domain !== undefined) return cookie.domain;

  try {
    return new URL(cookie.url).hostname;
  } catch {
    return cookie.url;
  }
}

function cookieKey(cookie: ImportedCookie): string {
  return JSON.stringify([cookieHost(cookie), cookie.path, cookie.name]);
}

function parseCookieKey(key: string) {
  let value: unknown;

  try {
    value = JSON.parse(key);
  } catch {
    return null;
  }

  const parsed = cookieKeySchema.safeParse(value);

  if (!parsed.success) return null;
  const [domain, path, name] = parsed.data;
  const host = bareHost(domain);

  return { host, url: `https://${host}${path}`, name };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readState(
  path: string,
  log: CreateBrowserCookieSyncArgs["log"],
): Promise<CookieSyncState> {
  const empty: CookieSyncState = {
    version: 1,
    source: null,
    syncedCookieKeys: [],
  };

  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return empty;
    throw error;
  }

  try {
    return stateSchema.parse(JSON.parse(text));
  } catch {
    log?.("Browser cookie sync state was unreadable; sync is off");

    return empty;
  }
}

async function writeState(path: string, state: CookieSyncState) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFile(temporaryPath, JSON.stringify(state), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export function createBrowserCookieSync(
  args: CreateBrowserCookieSyncArgs,
): BrowserCookieSync {
  const now = args.now ?? Date.now;

  let state: CookieSyncState = {
    version: 1,
    source: null,
    syncedCookieKeys: [],
  };

  let lastRun: DesktopBrowserCookieSyncRun | null = null;
  let inFlight: Promise<DesktopBrowserCookieSyncRun> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextRunAt: number | null = null;
  let stopped = false;

  function unschedule() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    nextRunAt = null;
  }

  function schedule() {
    unschedule();

    if (stopped || state.source === null) return;
    nextRunAt = now() + DESKTOP_BROWSER_COOKIE_SYNC_INTERVAL_MS;
    timer = setTimeout(() => {
      timer = null;
      void trigger();
    }, DESKTOP_BROWSER_COOKIE_SYNC_INTERVAL_MS);
    timer.unref?.();
  }

  function snapshot(): DesktopBrowserCookieSyncStatus {
    return {
      source: state.source,
      running: inFlight !== null,
      lastRun,
      nextRunAt,
    };
  }

  async function sync(
    source: DesktopBrowserCookieSyncSource,
  ): Promise<DesktopBrowserCookieSyncRun> {
    const at = now();
    const outcome = await args.browserImport.readCookies(source);

    if (!outcome.ok) return { ok: false, at, reason: outcome.reason };

    const session = args.session();
    const nowSeconds = at / 1000;

    const live = outcome.read.cookies.filter((cookie) =>
      isLiveCookie(cookie, nowSeconds),
    );

    const report = await storeCookies(session, live, args.log);
    const liveKeys = new Set(live.map(cookieKey));
    const unreadableHosts = new Set(outcome.read.undecryptableHosts);
    const nextKeys = new Set(report.written.map(cookieKey));
    let removed = 0;
    let removalFailures = 0;

    for (const key of state.syncedCookieKeys) {
      if (nextKeys.has(key)) continue;
      const target = parseCookieKey(key);

      if (target === null) continue;

      if (liveKeys.has(key) || unreadableHosts.has(target.host)) {
        nextKeys.add(key);
        continue;
      }

      try {
        await session.cookies.remove(target.url, target.name);
        removed += 1;
      } catch {
        removalFailures += 1;
        nextKeys.add(key);
      }
    }

    if (removed > 0) {
      try {
        await session.cookies.flushStore();
      } catch {
        args.log?.("Synced cookie removals could not be flushed to disk");
      }
    }

    state = { ...state, syncedCookieKeys: [...nextKeys] };
    await writeState(args.statePath, state);

    const skipped =
      outcome.read.undecryptable +
      (outcome.read.cookies.length - live.length) +
      report.rejected.length;

    args.log?.("Browser cookie sync finished", {
      sourceId: source.sourceId,
      imported: report.written.length,
      removed,
      skipped,
      rejected: report.rejected.length,
      removalFailures,
    });

    return { ok: true, at, imported: report.written.length, removed, skipped };
  }

  function trigger(): Promise<DesktopBrowserCookieSyncRun> | null {
    if (inFlight !== null) return inFlight;
    const source = state.source;

    if (source === null || stopped) return null;

    const current = sync(source)
      .catch((error: unknown): DesktopBrowserCookieSyncRun => {
        args.log?.("Browser cookie sync could not finish", {
          sourceId: source.sourceId,
          error: error instanceof Error ? error.message : String(error),
        });

        return { ok: false, at: now(), reason: "readFailed" };
      })
      .then((run) => {
        lastRun = run;

        if (!run.ok)
          args.log?.("Browser cookie sync failed", {
            sourceId: source.sourceId,
            reason: run.reason,
          });

        return run;
      })
      .finally(() => {
        inFlight = null;
        schedule();
      });

    inFlight = current;

    return current;
  }

  const loaded = readState(args.statePath, args.log)
    .then((value) => {
      state = value;
      void trigger();
    })
    .catch(() => {
      args.log?.("Browser cookie sync state could not be read; sync is off");
    });

  return {
    async status() {
      await loaded;

      return snapshot();
    },
    async configure(source) {
      await loaded;
      await inFlight;
      state = { ...state, source };
      await writeState(args.statePath, state);

      if (source === null) {
        unschedule();

        return snapshot();
      }

      await trigger();

      return snapshot();
    },
    async run() {
      await loaded;

      if (state.source === null)
        throw new Error("Browser cookie sync is off; enable it first");
      await trigger();

      return snapshot();
    },
    noteBrowserActivity() {
      void loaded.then(() => {
        if (
          state.source !== null &&
          (lastRun === null || now() - lastRun.at > ACTIVITY_REFRESH_AFTER_MS)
        )
          void trigger();
      });
    },
    stop() {
      stopped = true;
      unschedule();
    },
  };
}
