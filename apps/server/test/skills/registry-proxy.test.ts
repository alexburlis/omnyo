import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistrySearch } from "../../src/services/skills/registry-proxy.js";

const skill = {
  id: "owner/repo/test-skill",
  slug: "test-skill",
  name: "Test Skill",
  source: "owner/repo",
  installs: 12,
  installUrl: "https://github.com/owner/repo",
  url: "https://www.skills.sh/owner/repo/test-skill",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("registry search coverage and cache", () => {
  it("coalesces equivalent requests and expires results at the provider's shorter age", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "fixture-credential");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const fetch = vi.fn(async () =>
      Response.json(
        { data: [skill], searchType: "semantic" },
        {
          headers: { "cache-control": "public, max-age=2", age: "1" },
        },
      ),
    );

    vi.stubGlobal("fetch", fetch);
    const search = createRegistrySearch();

    const [first, second] = await Promise.all([
      search("Find a skill", 0, 8),
      search("  FIND a skill  ", 0, 8),
    ]);

    expect(first).toBe(second);
    expect(first).toMatchObject({
      coverage: "semantic",
      skills: [{ id: skill.id }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_001);
    await search("Find a skill", 0, 8);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("distinguishes catalog names and unauthenticated leaderboard names", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "fixture-credential");

    const fetch = vi.fn(async (input: string | URL) =>
      String(input).includes("/api/v1/")
        ? Response.json({ data: [skill], searchType: "fuzzy" })
        : new Response(
            String.raw`\"source\":\"owner/repo\",\"skillId\":\"test-skill\",\"name\":\"Test Skill\",\"installs\":12`,
          ),
    );

    vi.stubGlobal("fetch", fetch);
    const search = createRegistrySearch();

    await expect(search("test", 0, 8)).resolves.toMatchObject({
      coverage: "catalog-names",
    });
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    await expect(
      search("test", 0, 8, { publicApi: false }),
    ).resolves.toMatchObject({
      coverage: "leaderboard-names",
      skills: [{ id: skill.id }],
    });
  });

  it("uses the pinned CLI's public route without credentials and keeps provider ranking", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");

    const fetch = vi.fn(async () =>
      Response.json(
        {
          searchType: "semantic",
          skills: [
            {
              id: "owner/repo/second",
              source: "owner/repo",
              name: "Second",
              skillId: "second",
              installs: 2,
            },
            {
              id: skill.id,
              source: skill.source,
              name: skill.name,
              skillId: skill.slug,
              installs: 12,
            },
          ],
        },
        { headers: { "cache-control": "public, max-age=0, must-revalidate" } },
      ),
    );

    vi.stubGlobal("fetch", fetch);
    const search = createRegistrySearch();

    await expect(search("review a change", 0, 8)).resolves.toMatchObject({
      coverage: "semantic",
      skills: [{ id: "owner/repo/second" }, { id: skill.id }],
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://skills.sh/api/search?q=review+a+change&limit=10"),
      { signal: expect.any(AbortSignal) },
    );
    await search("review a change", 0, 8);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps one-character browse searches available", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "fixture-credential");

    const fetch = vi.fn(
      async () =>
        new Response(
          String.raw`\"source\":\"owner/repo\",\"skillId\":\"test-skill\",\"name\":\"Test Skill\",\"installs\":12`,
        ),
    );

    vi.stubGlobal("fetch", fetch);

    await expect(createRegistrySearch()("t", 0, 8)).resolves.toMatchObject({
      coverage: "leaderboard-names",
      skills: [{ id: skill.id }],
    });
    expect(fetch).toHaveBeenCalledWith("https://www.skills.sh/", {
      signal: expect.any(AbortSignal),
    });
  });

  it("honors Retry-After across queries without attempting a fallback", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "fixture-credential");
    vi.useFakeTimers({ toFake: ["Date"] });

    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "5" },
        }),
    );

    vi.stubGlobal("fetch", fetch);
    const search = createRegistrySearch();

    await expect(search("first task", 0, 8)).rejects.toMatchObject({
      status: 429,
      body: {
        code: "skills_registry_rate_limited",
        details: { retryAfterSeconds: 5 },
      },
    });
    await expect(search("second task", 0, 8)).rejects.toMatchObject({
      status: 429,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_001);
    await expect(search("second task", 0, 8)).rejects.toMatchObject({
      status: 429,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps credential rejection and timeout distinct with sanitized messages", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "fixture-credential");

    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValueOnce(
        new DOMException("sentinel query", "TimeoutError"),
      );

    vi.stubGlobal("fetch", fetch);
    const search = createRegistrySearch();

    await expect(search("first task", 0, 8)).rejects.toMatchObject({
      body: { code: "skills_registry_auth_rejected" },
    });
    await expect(search("sentinel query", 0, 8)).rejects.toMatchObject({
      body: {
        code: "skills_registry_timeout",
        message: "skills.sh did not respond in time",
      },
    });
  });
});
