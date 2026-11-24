import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliOmnyoSdk } from "../client.js";
import { readCliUsageConsent, saveCliUsageConsent } from "../usage-consent.js";

describe("CLI usage consent", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnyo-client-consent-"));
    vi.stubEnv("OMNYO_DATA_DIR", directory);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });
  it("atomically preserves concurrent grant proofs and erases only the confirmed subject", async () => {
    const baseUrl = "http://127.0.0.1:1234";

    const a = "a".repeat(64),
      b = "b".repeat(64);

    await Promise.all([
      saveCliUsageConsent(baseUrl, { active: a, proofs: [a] }),
      saveCliUsageConsent(baseUrl, { active: b, proofs: [b] }),
    ]);
    expect(readCliUsageConsent(baseUrl).proofs.sort()).toEqual([a, b]);
    await saveCliUsageConsent(baseUrl, { active: null, proofs: [] }, [a]);
    expect(readCliUsageConsent(baseUrl).proofs).toEqual([b]);
    const [name] = await readdir(join(directory, "client-usage"));
    expect(
      (await stat(join(directory, "client-usage", name!))).mode & 0o777,
    ).toBe(0o600);
  });
  it("uses a saved proof only on permitted local endpoints and disables redirects for erasure", async () => {
    const baseUrl = "http://127.0.0.1:1234";
    const proof = "a".repeat(64);
    await saveCliUsageConsent(baseUrl, { active: proof, proofs: [proof] });

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({}),
    );

    vi.stubGlobal("fetch", fetchMock);
    const sdk = createCliOmnyoSdk(baseUrl);
    await sdk.system.experimental_usageStatus();
    await sdk.system.config();
    await sdk.system.experimental_eraseUsageAnalytics(proof);
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        "x-omnyo-analytics-consent",
      ),
    ).toBe(proof);
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has(
        "x-omnyo-analytics-consent",
      ),
    ).toBe(false);
    expect(fetchMock.mock.calls[2]?.[1]?.redirect).toBe("error");
    expect(String(fetchMock.mock.calls[2]?.[0])).not.toContain(proof);
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ proof }));
  });
});
