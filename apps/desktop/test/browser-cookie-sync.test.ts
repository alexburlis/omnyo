import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserImportService } from "../src/browser-import/browser-import.js";
import type { ImportedCookie } from "../src/browser-import/cookie-database.js";
import { createBrowserCookieSync } from "../src/browser-import/cookie-sync.js";
import { deferred } from "./fixtures/deferred.js";

const DIA = { sourceId: "dia" as const, sourceProfileDirectory: "Profile 7" };

function cookie(
  host: string,
  name: string,
  overrides: Partial<ImportedCookie> = {},
): ImportedCookie {
  return {
    url: `https://${host.replace(/^\./u, "")}/`,
    name,
    value: `${name}-value`,
    domain: host.startsWith(".") ? host : undefined,
    path: "/",
    secure: true,
    httpOnly: true,
    expirationDate: undefined,
    sameSite: "lax",
    ...overrides,
  };
}

function createJar() {
  const set = vi.fn(
    async (_details: { url: string; name: string }) => undefined,
  );

  const remove = vi.fn(async (_url: string, _name: string) => undefined);
  const flushStore = vi.fn(async () => undefined);

  return { cookies: { set, remove, flushStore } };
}

type ReadCookies = BrowserImportService["readCookies"];

function sourceReturning(...reads: ImportedCookie[][]) {
  let index = 0;

  return vi.fn<ReadCookies>(async () => {
    const cookies = reads[Math.min(index, reads.length - 1)];
    index += 1;

    return {
      ok: true,
      read: { cookies, undecryptable: 0, undecryptableHosts: [] },
    };
  });
}

let directory: string;

let statePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnyo-cookie-sync-"));
  statePath = join(directory, "browser-cookie-sync.json");
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe("browser cookie sync", () => {
  it("imports, then removes only previously synced cookies the source dropped", async () => {
    const jar = createJar();

    const readCookies = sourceReturning(
      [cookie(".example.test", "sid"), cookie("app.example.test", "csrf")],
      [cookie("app.example.test", "csrf")],
    );

    const sync = createBrowserCookieSync({
      browserImport: { readCookies },
      session: () => jar,
      statePath,
      now: () => 1_000,
    });

    const first = await sync.configure(DIA);
    expect(first.lastRun).toEqual({
      ok: true,
      at: 1_000,
      imported: 2,
      removed: 0,
      skipped: 0,
    });
    expect(jar.cookies.set).toHaveBeenCalledTimes(2);
    expect(jar.cookies.remove).not.toHaveBeenCalled();

    const second = await sync.run();
    expect(second.lastRun).toMatchObject({ ok: true, imported: 1, removed: 1 });
    expect(jar.cookies.remove).toHaveBeenCalledTimes(1);
    expect(jar.cookies.remove).toHaveBeenCalledWith(
      "https://example.test/",
      "sid",
    );

    const third = await sync.run();
    expect(third.lastRun).toMatchObject({ ok: true, removed: 0 });
    expect(jar.cookies.remove).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    expect(persisted).toEqual({
      version: 1,
      source: DIA,
      syncedCookieKeys: [JSON.stringify(["app.example.test", "/", "csrf"])],
    });
    expect(JSON.stringify(persisted)).not.toContain("csrf-value");
    expect(JSON.stringify(third)).not.toMatch(/example\.test|csrf|sid/u);
    sync.stop();
  });

  it("treats expired source cookies as absent and keeps unreadable hosts", async () => {
    const jar = createJar();

    const readCookies = vi
      .fn<ReadCookies>()
      .mockResolvedValueOnce({
        ok: true,
        read: {
          cookies: [cookie("a.test", "one"), cookie("b.test", "two")],
          undecryptable: 0,
          undecryptableHosts: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        read: {
          cookies: [cookie("a.test", "one", { expirationDate: 1 })],
          undecryptable: 1,
          undecryptableHosts: ["b.test"],
        },
      });

    const sync = createBrowserCookieSync({
      browserImport: { readCookies },
      session: () => jar,
      statePath,
      now: () => 10_000,
    });

    await sync.configure(DIA);
    const status = await sync.run();

    expect(status.lastRun).toEqual({
      ok: true,
      at: 10_000,
      imported: 0,
      removed: 1,
      skipped: 2,
    });
    expect(jar.cookies.remove).toHaveBeenCalledWith("https://a.test/", "one");
    expect(jar.cookies.remove).not.toHaveBeenCalledWith(
      "https://b.test/",
      "two",
    );
    sync.stop();
  });

  it("shares one in-flight run between concurrent triggers", async () => {
    const jar = createJar();
    const gate = deferred();

    const readCookies = vi.fn<ReadCookies>(async () => {
      await gate.promise;

      return {
        ok: true,
        read: { cookies: [], undecryptable: 0, undecryptableHosts: [] },
      };
    });

    await writeFile(
      statePath,
      JSON.stringify({ version: 1, source: DIA, syncedCookieKeys: [] }),
    );

    const sync = createBrowserCookieSync({
      browserImport: { readCookies },
      session: () => jar,
      statePath,
    });

    const runs = [sync.run(), sync.run()];
    sync.noteBrowserActivity();
    await expect(sync.status()).resolves.toMatchObject({ running: true });
    gate.resolve();
    await Promise.all(runs);

    expect(readCookies).toHaveBeenCalledTimes(1);
    await expect(sync.status()).resolves.toMatchObject({ running: false });
    sync.stop();
  });

  it("reports failures without cookie data and stops scheduling when turned off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const jar = createJar();

    const readCookies = vi.fn<ReadCookies>(async () => ({
      ok: false,
      reason: "needsKeychainApproval",
    }));

    let clock = 5_000;

    const sync = createBrowserCookieSync({
      browserImport: { readCookies },
      session: () => jar,
      statePath,
      now: () => clock,
    });

    const failed = await sync.configure(DIA);
    expect(failed).toEqual({
      source: DIA,
      running: false,
      lastRun: { ok: false, at: 5_000, reason: "needsKeychainApproval" },
      nextRunAt: 5_000 + 15 * 60 * 1000,
    });

    clock += 15 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(readCookies).toHaveBeenCalledTimes(2);

    const off = await sync.configure(null);
    expect(off).toMatchObject({ source: null, nextRunAt: null });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    sync.noteBrowserActivity();
    await expect(sync.run()).rejects.toThrow(/off/u);
    expect(readCookies).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it("resumes on start and refreshes stale logins when a browser window registers", async () => {
    const jar = createJar();
    const readCookies = sourceReturning([cookie("a.test", "one")]);
    let clock = 1_000;

    await writeFile(
      statePath,
      JSON.stringify({ version: 1, source: DIA, syncedCookieKeys: [] }),
    );

    const sync = createBrowserCookieSync({
      browserImport: { readCookies },
      session: () => jar,
      statePath,
      now: () => clock,
    });

    await vi.waitFor(async () =>
      expect((await sync.status()).lastRun).toMatchObject({ ok: true }),
    );

    sync.noteBrowserActivity();
    await sync.status();
    expect(readCookies).toHaveBeenCalledTimes(1);

    clock += 3 * 60 * 1000;
    sync.noteBrowserActivity();
    await vi.waitFor(() => expect(readCookies).toHaveBeenCalledTimes(2));
    sync.stop();
  });
});
