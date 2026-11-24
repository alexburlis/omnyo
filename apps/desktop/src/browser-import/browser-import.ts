import { basename } from "node:path";
import type { Session } from "electron";
import type { OmnyoDesktopBrowserImportSourcesResult } from "@omnyo/desktop-contract";
import type {
  DesktopBrowserImportFailureReason,
  DesktopBrowserImportOutcome,
  DesktopBrowserImportSelection,
  DesktopBrowserImportSource,
  DesktopBrowserImportSourceProfile,
  DesktopBrowserImportUnavailableReason,
} from "@omnyo/host-daemon-contract";
import { readChromiumCookies } from "./chromium-cookies.js";
import { runSecretCommand, type SecretCommandRunner } from "./chromium-keys.js";
import {
  BrowserImportError,
  type CookieReadResult,
  type ImportedCookie,
} from "./cookie-database.js";
import { readFirefoxCookies } from "./firefox-cookies.js";
import { discoverBrowserImportSources } from "./discovery.js";
import type { listBrowserStorageNames } from "./browser-applications.js";
import { readSafariCookies, safariAccessDenied } from "./safari-cookies.js";
import {
  findBrowserImportSource,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  readPreferredProfileDirectory,
  resolveCookieDatabase,
  resolveInstalledAppPath,
  BROWSER_IMPORT_SOURCES,
  type BrowserImportPathContext,
  type BrowserImportSourceDefinition,
} from "./sources.js";

const MAX_SKIPPED_DOMAINS = 20;

export type CookieWriteSession = {
  cookies: Pick<Session["cookies"], "set" | "flushStore">;
};

export type CookieReadOutcome =
  | { ok: true; read: CookieReadResult }
  | { ok: false; reason: DesktopBrowserImportFailureReason };

export interface CookieStoreReport {
  written: ImportedCookie[];
  expired: number;
  rejected: Array<{ cookie: ImportedCookie; error: string }>;
}

interface SourceEntry {
  definition: BrowserImportSourceDefinition;
  source: DesktopBrowserImportSource;
}

export interface BrowserImportService {
  listSources(): Promise<DesktopBrowserImportSource[]>;
  listImportSources(): Promise<OmnyoDesktopBrowserImportSourcesResult>;
  readCookies(
    selection: DesktopBrowserImportSelection,
  ): Promise<CookieReadOutcome>;
  importCookies(
    selection: DesktopBrowserImportSelection,
    session: CookieWriteSession,
  ): Promise<DesktopBrowserImportOutcome>;
}

export interface CreateBrowserImportServiceArgs {
  context: BrowserImportPathContext;
  shellPathReady: Promise<void>;
  listBrowserStorageNames?: typeof listBrowserStorageNames;
  runSecretCommand?: SecretCommandRunner;
  resolveIcon?: (appPath: string) => Promise<string | undefined>;
  resolveDefaultBrowserApp?: () => Promise<string | undefined>;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

export function importBlockedWhileRunning(
  definition: Pick<BrowserImportSourceDefinition, "engine">,
  platform: NodeJS.Platform,
): boolean {
  return definition.engine !== "chromium" || platform !== "darwin";
}

async function unavailableReason(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Promise<DesktopBrowserImportUnavailableReason | undefined> {
  if (!definition.platforms.includes(context.platform))
    return "unsupportedPlatform";

  if (!(await isSourceInstalled(definition, context))) return "notInstalled";

  if (
    importBlockedWhileRunning(definition, context.platform) &&
    (await isSourceRunning(definition, context))
  )
    return "browserRunning";

  if (definition.engine === "safari") {
    const jar = await resolveCookieDatabase(definition, context, ".");

    if (jar !== undefined && (await safariAccessDenied(jar)))
      return "needsFullDiskAccess";
  }

  return undefined;
}

function cookieHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function isLiveCookie(
  cookie: Pick<ImportedCookie, "expirationDate">,
  nowSeconds: number,
): boolean {
  return (
    cookie.expirationDate === undefined || cookie.expirationDate > nowSeconds
  );
}

export async function storeCookies(
  session: CookieWriteSession,
  cookies: readonly ImportedCookie[],
  log?: CreateBrowserImportServiceArgs["log"],
): Promise<CookieStoreReport> {
  const report: CookieStoreReport = { written: [], expired: 0, rejected: [] };
  const nowSeconds = Date.now() / 1000;

  for (const cookie of cookies) {
    if (!isLiveCookie(cookie, nowSeconds)) {
      report.expired += 1;
      continue;
    }

    try {
      await session.cookies.set({
        url: cookie.url,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        ...(cookie.expirationDate === undefined
          ? {}
          : { expirationDate: cookie.expirationDate }),
      });
      report.written.push(cookie);
    } catch (error) {
      report.rejected.push({
        cookie,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (report.written.length > 0) {
    try {
      await session.cookies.flushStore();
    } catch (error) {
      log?.("Imported cookies could not be flushed to disk", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

export async function writeCookies(
  session: CookieWriteSession,
  read: CookieReadResult,
  log?: CreateBrowserImportServiceArgs["log"],
): Promise<DesktopBrowserImportOutcome> {
  const report = await storeCookies(session, read.cookies, log);
  const skippedDomains = new Set(read.undecryptableHosts);

  for (const { cookie, error } of report.rejected) {
    skippedDomains.add(cookieHost(cookie.url));
    log?.("Imported cookie was rejected", {
      url: cookie.url,
      name: cookie.name,
      error,
    });
  }

  return {
    ok: true,
    imported: report.written.length,
    skipped: read.undecryptable + report.expired + report.rejected.length,
    skippedDomains: [...skippedDomains].slice(0, MAX_SKIPPED_DOMAINS),
  };
}

export function createBrowserImportService(
  args: CreateBrowserImportServiceArgs,
): BrowserImportService {
  const { context } = args;
  const run = args.runSecretCommand ?? runSecretCommand;

  const iconCache = new Map<string, Promise<string | undefined>>();

  async function iconFor(
    definition: BrowserImportSourceDefinition,
  ): Promise<string | undefined> {
    if (!args.resolveIcon) return undefined;
    const appPath = await resolveInstalledAppPath(definition, context);

    if (appPath === undefined) return undefined;
    let pending = iconCache.get(appPath);

    if (pending === undefined) {
      pending = args.resolveIcon(appPath).catch(() => undefined);
      iconCache.set(appPath, pending);
    }

    return pending;
  }

  async function listSources(): Promise<DesktopBrowserImportSource[]> {
    return (await listSourceEntries()).map((entry) => entry.source);
  }

  async function defaultBrowserApp(): Promise<string | undefined> {
    if (!args.resolveDefaultBrowserApp) return undefined;

    try {
      return await args.resolveDefaultBrowserApp();
    } catch (error) {
      args.log?.("Could not read the default browser", {
        error: error instanceof Error ? error.message : String(error),
      });

      return undefined;
    }
  }

  async function recommendedSelection(
    entries: readonly SourceEntry[],
    appPath: string,
  ): Promise<DesktopBrowserImportSelection | undefined> {
    const appName = basename(appPath).toLowerCase();

    const entry = entries.find(
      ({ definition, source }) =>
        source.unavailable === undefined &&
        (definition.macAppNames ?? []).some(
          (name) => name.toLowerCase() === appName,
        ),
    );

    if (entry === undefined) return undefined;

    const preferred = await readPreferredProfileDirectory(
      entry.definition,
      context,
    );

    const profile =
      entry.source.profiles.find(
        (candidate) => candidate.directory === preferred,
      ) ??
      entry.source.profiles.reduce<DesktopBrowserImportSourceProfile | null>(
        (best, candidate) =>
          best === null ||
          (candidate.cookieCount ?? -1) > (best.cookieCount ?? -1)
            ? candidate
            : best,
        null,
      );

    return profile === null
      ? undefined
      : {
          sourceId: entry.source.id,
          sourceProfileDirectory: profile.directory,
        };
  }

  async function listImportSources(): Promise<OmnyoDesktopBrowserImportSourcesResult> {
    const [entries, appPath] = await Promise.all([
      listSourceEntries(),
      defaultBrowserApp(),
    ]);

    const sources = entries.map((entry) => entry.source);

    const recommended =
      appPath === undefined
        ? undefined
        : await recommendedSelection(entries, appPath);

    return recommended === undefined ? { sources } : { sources, recommended };
  }

  async function listSourceEntries(): Promise<SourceEntry[]> {
    await args.shellPathReady;
    const entries: SourceEntry[] = [];

    const definitions = [
      ...BROWSER_IMPORT_SOURCES,
      ...(await discoverBrowserImportSources(
        context,
        args.listBrowserStorageNames,
      )),
    ];

    for (const definition of definitions) {
      const unavailable = await unavailableReason(definition, context);

      const icon =
        unavailable === "notInstalled" || unavailable === "unsupportedPlatform"
          ? undefined
          : await iconFor(definition);

      entries.push({
        definition,
        source: {
          id: definition.id,
          name: definition.name,
          profiles:
            unavailable === undefined
              ? await listSourceProfiles(definition, context)
              : [],
          ...(unavailable === undefined ? {} : { unavailable }),
          ...(icon === undefined ? {} : { icon }),
        },
      });
    }

    return entries;
  }

  async function readSelection(
    selection: DesktopBrowserImportSelection,
  ): Promise<CookieReadResult> {
    const definition =
      findBrowserImportSource(selection.sourceId) ??
      (
        await discoverBrowserImportSources(
          context,
          args.listBrowserStorageNames,
        )
      ).find((source) => source.id === selection.sourceId);

    if (!definition) throw new BrowserImportError("unknownSource");
    const blocked = await unavailableReason(definition, context);

    if (blocked !== undefined) throw new BrowserImportError(blocked);
    const profiles = await listSourceProfiles(definition, context);

    const requested = profiles.find(
      (profile) => profile.directory === selection.sourceProfileDirectory,
    );

    if (requested === undefined)
      throw new BrowserImportError("unknownSourceProfile");

    const databasePath = await resolveCookieDatabase(
      definition,
      context,
      requested.directory,
    );

    if (databasePath === undefined) throw new BrowserImportError("readFailed");

    if (definition.engine === "safari") {
      return {
        cookies: await readSafariCookies(databasePath),
        undecryptable: 0,
        undecryptableHosts: [],
      };
    }

    if (definition.engine === "firefox") {
      return {
        cookies: await readFirefoxCookies(databasePath),
        undecryptable: 0,
        undecryptableHosts: [],
      };
    }

    return readChromiumCookies(
      {
        cookieDatabasePath: databasePath,
        keychainService: definition.keychainService,
        keychainAccount: definition.keychainAccount,
        linuxSecretApplication: definition.linuxSecretApplication,
        platform: context.platform,
      },
      run,
    );
  }

  async function readCookies(
    selection: DesktopBrowserImportSelection,
  ): Promise<CookieReadOutcome> {
    await args.shellPathReady;

    try {
      return { ok: true, read: await readSelection(selection) };
    } catch (error) {
      const reason =
        error instanceof BrowserImportError ? error.reason : "readFailed";

      args.log?.("Browser cookie import failed", {
        sourceId: selection.sourceId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });

      return { ok: false, reason };
    }
  }

  return {
    listSources,
    listImportSources,
    readCookies,
    async importCookies(selection, session) {
      const outcome = await readCookies(selection);

      if (!outcome.ok) return outcome;

      return writeCookies(session, outcome.read, args.log);
    },
  };
}
