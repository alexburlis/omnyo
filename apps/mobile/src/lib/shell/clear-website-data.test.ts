import { describe, expect, it, vi } from "vitest";
import { clearWebsiteData } from "./clear-website-data";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

describe("clearWebsiteData", () => {
  it("re-mints a relay session only after both cookie stores and the cached session are gone", async () => {
    const native = deferred();
    const webKit = deferred();
    const cache = deferred();
    const events: string[] = [];

    const renewSession = vi.fn(async (profileId: string) => {
      events.push(`renew ${profileId}`);
    });

    const done = clearWebsiteData("relay", {
      clearCookies: (useWebKit) =>
        (useWebKit ? webKit : native).promise.then(() =>
          events.push(useWebKit ? "webkit" : "native"),
        ),
      clearSessionCache: () =>
        cache.promise.then(() => void events.push("cache")),
      renewSession,
    });

    native.resolve();
    cache.resolve();
    await Promise.resolve();
    expect(renewSession).not.toHaveBeenCalled();
    webKit.resolve();
    await done;
    expect(events).toEqual(["native", "cache", "webkit", "renew relay"]);
  });

  it("fails without re-minting when a store cannot be cleared", async () => {
    const renewSession = vi.fn(async () => {});

    await expect(
      clearWebsiteData("relay", {
        clearCookies: async (useWebKit) => {
          if (useWebKit) throw new Error("WebKit store unavailable");
        },
        clearSessionCache: async () => {},
        renewSession,
      }),
    ).rejects.toThrow("WebKit store unavailable");
    expect(renewSession).not.toHaveBeenCalled();
  });

  it("clears only cookies for a direct server", async () => {
    const clearSessionCache = vi.fn(async () => {});
    const renewSession = vi.fn(async () => {});
    const clearCookies = vi.fn(async () => true);

    await clearWebsiteData(null, {
      clearCookies,
      clearSessionCache,
      renewSession,
    });
    expect(clearCookies.mock.calls).toEqual([[false], [true]]);
    expect(clearSessionCache).not.toHaveBeenCalled();
    expect(renewSession).not.toHaveBeenCalled();
  });
});
