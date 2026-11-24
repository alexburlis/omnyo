import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPools,
  HOUR,
  ROUTE,
  SOL,
  LUNA,
  ASTRA,
  CLIENT_VERSION,
  WEEK,
  type PoolAccount,
  catalogEtag,
  success,
  createPool,
} from "./fixtures/codex-model-pool.js";

afterEach(cleanupPools);

describe("Codex model catalogs per plan", () => {
  const accounts = (exhaustedFor?: number): PoolAccount[] => [
    {
      name: "free-account",
      plan: "free",
      unsupported: [ASTRA],
      catalog: [LUNA],
    },
    {
      name: "promax-account",
      plan: "promax",
      unsupported: [],
      catalog: [LUNA, ASTRA],
      ...(exhaustedFor === undefined ? {} : { exhaustedFor }),
    },
  ];

  it("lists every enabled plan's models and routes a plan-only model straight to its plan", async () => {
    const pool = await createPool("event-stream", accounts());

    const listed = await pool.listModels();

    expect(listed.status).toBe(200);
    expect(listed.models.map(({ slug }) => slug)).toEqual([
      "gpt-reserve",
      LUNA,
      ASTRA,
    ]);
    expect(listed.models.find(({ slug }) => slug === LUNA)?.display_name).toBe(
      `free-account ${LUNA}`,
    );
    expect(listed.models.find(({ slug }) => slug === ASTRA)?.priority).toBe(3);
    expect(listed.etag).toMatch(/^W\/"omnyo-[0-9a-f]{32}"$/u);
    expect(pool.attempts).toEqual([
      "free-account:/models",
      "promax-account:/models",
    ]);
    expect(await pool.modelCatalog("promax-account")).toEqual({
      plan: "promax",
      clientVersion: CLIENT_VERSION,
      fetchedAt: pool.now(),
      models: [LUNA, ASTRA],
    });

    expect((await pool.request(ASTRA)).status).toBe(200);
    expect(pool.attempts).toEqual([`promax-account:${ASTRA}`]);
    expect(await pool.incompatibleModels("free-account")).toEqual([]);

    expect(pool.hub().activeAccountId("codex")).toBe(pool.id("free-account"));

    await pool.listModels();
    expect(pool.attempts).toEqual(["free-account:/models"]);
  });

  it("answers with the reset of the only plan that offers the model instead of trying other plans", async () => {
    const pool = await createPool("event-stream", accounts(3 * HOUR));
    const resetAt = pool.now() + 3 * HOUR;

    expect((await pool.listModels()).models.map(({ slug }) => slug)).toContain(
      ASTRA,
    );

    const response = await pool.request(ASTRA);

    expect(pool.attempts).toEqual([]);
    expect(response.status).toBe(429);
    expect(response.retryAfter).toBe(String(3 * 60 * 60));
    expect(await pool.hub().retryAvailability("codex", "other", ASTRA)).toEqual(
      { kind: "blocked", retryAt: resetAt },
    );
    expect(await pool.hub().retryAvailability("codex", "other", LUNA)).toEqual({
      kind: "ready",
    });
  });

  it("probes again after a plan change, a new sign-in or seven days", async () => {
    const pool = await createPool("event-stream", accounts());

    await pool.listModels();
    pool.setCatalog("promax-account", [LUNA, ASTRA, SOL]);

    await pool.listModels();
    expect(pool.attempts).toEqual(["free-account:/models"]);

    pool.setPlan("promax-account", "pro");
    await pool.refresh("promax-account");
    expect(await pool.modelCatalog("promax-account")).toBeNull();
    expect((await pool.listModels()).models.map(({ slug }) => slug)).toContain(
      SOL,
    );
    expect(pool.attempts).toEqual([
      "free-account:/models",
      "promax-account:/models",
    ]);

    await pool.signInAgain("promax-account");
    expect(await pool.modelCatalog("promax-account")).toBeNull();
    await pool.listModels();
    expect(pool.attempts).toContain("promax-account:/models");

    pool.advance(WEEK);
    expect(await pool.modelCatalog("promax-account")).toBeNull();
    await pool.listModels();
    expect(pool.attempts).toContain("promax-account:/models");
  });

  it("keeps routing reactively when no fresh catalog lists the model", async () => {
    const pool = await createPool("event-stream", accounts());

    await pool.listModels();
    const response = await pool.request(SOL);

    expect(response.status).toBe(200);
    expect(pool.attempts).toEqual([`free-account:${SOL}`]);
  });

  it("rewrites a routed turn's models etag to the merged list's etag", async () => {
    const pool = await createPool(
      "event-stream",
      accounts(),
      ({ account, model }) => {
        const response = success(account, model);
        response.headers.set("x-models-etag", catalogEtag(account));

        return response;
      },
    );

    const listed = await pool.listModels();

    const turn = await pool.hub().handle(
      new Request(`https://hub.invalid${ROUTE}/v1/responses`, {
        method: "POST",
        headers: pool.turnHeaders(),
        body: JSON.stringify({ model: ASTRA, input: "ok", stream: true }),
      }),
      "codex",
      "/v1/responses",
    );

    expect(turn.headers.get("x-models-etag")).toBe(listed.etag);
    await turn.text();
  });

  it("drops the merged etag rewrite once the list is answered unmerged", async () => {
    const pool = await createPool(
      "event-stream",
      accounts(),
      ({ account, model }) => {
        const response = success(account, model);
        response.headers.set("x-models-etag", catalogEtag(account));

        return response;
      },
    );

    expect((await pool.listModels()).etag).not.toBe(
      catalogEtag("free-account"),
    );
    await pool.disable("promax-account");

    const listed = await pool.listModels();
    expect(listed.etag).toBe(catalogEtag("free-account"));

    const turn = await pool.hub().handle(
      new Request(`https://hub.invalid${ROUTE}/v1/responses`, {
        method: "POST",
        headers: pool.turnHeaders(),
        body: JSON.stringify({ model: LUNA, input: "ok", stream: true }),
      }),
      "codex",
      "/v1/responses",
    );

    expect(turn.headers.get("x-models-etag")).toBe(catalogEtag("free-account"));
    await turn.text();
  });

  it("probes the other accounts again when the routing account's list changes", async () => {
    const pool = await createPool("event-stream", [
      { name: "plus-a", plan: "plus", unsupported: [], catalog: [LUNA] },
      { name: "plus-b", plan: "plus", unsupported: [], catalog: [LUNA] },
    ]);

    await pool.listModels();
    pool.setCatalog("plus-a", [LUNA, SOL]);
    pool.setCatalog("plus-b", [LUNA, SOL]);

    await pool.listModels();
    expect(pool.attempts).toEqual(["plus-a:/models", "plus-b:/models"]);
    expect((await pool.modelCatalog("plus-b"))?.models).toEqual([LUNA, SOL]);

    await pool.listModels();
    expect(pool.attempts).toEqual(["plus-a:/models"]);
  });

  it("probes again for a different Codex client version", async () => {
    const pool = await createPool("event-stream", accounts());

    await pool.listModels();
    pool.advance(60_000);
    await pool.listModels("0.168.0");

    expect(pool.attempts).toEqual([
      "free-account:/models",
      "promax-account:/models",
    ]);
    expect((await pool.modelCatalog("promax-account"))?.clientVersion).toBe(
      "0.168.0",
    );
  });

  it("ignores the stored list of an account in error", async () => {
    const pool = await createPool("event-stream", accounts());

    await pool.listModels();
    pool.markError("promax-account");

    expect(
      (await pool.listModels()).models.map(({ slug }) => slug),
    ).not.toContain(ASTRA);

    await pool.request(ASTRA);
    expect(pool.attempts[0]).toBe(`free-account:${ASTRA}`);
  });

  it("waits before probing an account whose list failed again", async () => {
    const pool = await createPool("event-stream", [
      ...accounts(),
      { name: "plus-account", plan: "plus", unsupported: [] },
    ]);

    await pool.listModels();
    expect(pool.attempts).toContain("plus-account:/models");

    await pool.listModels();
    expect(pool.attempts).toEqual(["free-account:/models"]);

    pool.advance(5 * 60_000);
    await pool.listModels();
    expect(pool.attempts).toContain("plus-account:/models");

    await pool.listModels();
    expect(pool.attempts).toEqual(["free-account:/models"]);
    await pool.signInAgain("plus-account");
    await pool.listModels();
    expect(pool.attempts).toContain("plus-account:/models");
  });

  it("refetches another account's list once its turns report a new models etag", async () => {
    const pool = await createPool("event-stream", [
      {
        name: "free-account",
        plan: "free",
        unsupported: [SOL, ASTRA],
        catalog: [LUNA],
      },
      {
        name: "plus-account",
        plan: "plus",
        unsupported: [],
        catalog: [LUNA, SOL],
      },
    ]);

    await pool.listModels();
    pool.setCatalog("plus-account", [LUNA, SOL, ASTRA]);

    expect((await pool.request(SOL)).status).toBe(200);
    expect(pool.attempts).toEqual([`plus-account:${SOL}`]);
    expect(await pool.modelCatalog("plus-account")).toBeNull();

    const listed = await pool.listModels();
    expect(pool.attempts).toEqual([
      "free-account:/models",
      "plus-account:/models",
    ]);
    expect(listed.models.map(({ slug }) => slug)).toContain(ASTRA);

    expect((await pool.request(ASTRA)).status).toBe(200);
    expect(pool.attempts).toEqual([`plus-account:${ASTRA}`]);
  });

  it("compares and merges only lists fetched for the same Codex client version", async () => {
    const pool = await createPool("event-stream", accounts());

    await pool.listModels("0.167.0");
    await pool.signInAgain("free-account");
    pool.failCatalog("promax-account", true);

    const listed = await pool.listModels("0.168.0");
    expect(listed.models.map(({ slug }) => slug)).not.toContain(ASTRA);
    expect(listed.etag).toBe(catalogEtag("free-account"));

    expect((await pool.request(ASTRA)).status).toBe(200);
    expect(pool.attempts).toEqual([
      `free-account:${ASTRA}`,
      `promax-account:${ASTRA}`,
    ]);
  });

  it("answers the list without waiting for a slow account and adds its models later", async () => {
    const pool = await createPool("event-stream", accounts());
    const release = pool.holdCatalog("promax-account");
    const started = Date.now();

    const first = await pool.listModels();
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(first.models.map(({ slug }) => slug)).not.toContain(ASTRA);

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await pool.listModels();
    expect(second.models.map(({ slug }) => slug)).toContain(ASTRA);
    expect(pool.attempts).toEqual(["free-account:/models"]);
  });

  it("keeps spending a narrower plan's credits first when lists show the narrower plan", async () => {
    const pool = await createPool("event-stream", [
      {
        name: "free-account",
        plan: "free",
        unsupported: [SOL],
        exhaustedFor: 30 * 24 * HOUR,
        credits: true,
        catalog: [LUNA],
      },
      {
        name: "plus-account",
        plan: "plus",
        unsupported: [],
        exhaustedFor: 30 * 24 * HOUR,
        credits: true,
        catalog: [LUNA, SOL],
      },
    ]);

    await pool.listModels();
    expect((await pool.request(SOL)).status).toBe(200);
    expect(pool.attempts).toEqual([`plus-account:${SOL}`]);

    await pool.disable("free-account");
    expect((await pool.request(LUNA)).status).toBe(200);
    expect(pool.attempts).toEqual([`plus-account:${LUNA}`]);
    await pool.enable("free-account");

    expect((await pool.request(LUNA)).status).toBe(200);
    expect(pool.attempts).toEqual([`free-account:${LUNA}`]);
  });

  it("keeps the provider cursor on a narrower credit account that a list skips", async () => {
    const pool = await createPool("event-stream", [
      {
        name: "free-account",
        plan: "free",
        unsupported: [SOL, ASTRA],
        exhaustedFor: 30 * 24 * HOUR,
        credits: true,
        catalog: [LUNA],
      },
      {
        name: "go-account",
        plan: "go",
        unsupported: [SOL],
        exhaustedFor: 30 * 24 * HOUR,
        credits: true,
        catalog: [LUNA, ASTRA],
      },
      {
        name: "plus-account",
        plan: "plus",
        unsupported: [],
        exhaustedFor: 30 * 24 * HOUR,
        credits: true,
        catalog: [LUNA, SOL, ASTRA],
      },
    ]);

    await pool.listModels();
    expect((await pool.request(LUNA)).status).toBe(200);
    expect(pool.hub().activeAccountId("codex")).toBe(pool.id("free-account"));

    expect((await pool.request(ASTRA)).status).toBe(200);
    expect(pool.attempts).toEqual([`go-account:${ASTRA}`]);
    expect(pool.hub().activeAccountId("codex")).toBe(pool.id("free-account"));
  });
});

describe("Codex service tier routing", () => {
  function tierAccounts(exhaustedFor?: number): PoolAccount[] {
    return [
      {
        name: "primary",
        plan: "plus",
        unsupported: [],
        catalog: [SOL],
        legacySpeedTiers: { [SOL]: ["fast"] },
      },
      {
        name: "entitled",
        plan: "new-provider-plan",
        unsupported: [],
        catalog: [SOL, ASTRA],
        serviceTiers: {
          [SOL]: ["priority", "ultrafast"],
          [ASTRA]: ["other-tier"],
        },
        ...(exhaustedFor === undefined ? {} : { exhaustedFor }),
      },
      {
        name: "unentitled",
        plan: "promax",
        unsupported: [],
        catalog: [SOL],
        serviceTiers: { [SOL]: [] },
      },
    ];
  }

  it("advertises the union of tiers for a shared model and preserves the base entry", async () => {
    const pool = await createPool(
      "event-stream",
      tierAccounts().map((account) => ({ ...account, catalog: [SOL] })),
    );

    const listed = await pool.listModels();

    expect(listed.models.find(({ slug }) => slug === SOL)).toMatchObject({
      display_name: `primary ${SOL}`,
      service_tiers: [{ id: "priority" }, { id: "ultrafast" }],
      additional_speed_tiers: ["fast", "ultrafast"],
    });
    expect(listed.etag).toMatch(/^W\/"omnyo-/u);
  });

  it("uses an account advertising the requested model and tier despite a default-tier pin", async () => {
    const seenTiers: Array<string | undefined> = [];

    const pool = await createPool("event-stream", tierAccounts(), (call) => {
      seenTiers.push(call.serviceTier);

      return undefined;
    });

    await pool.listModels();
    await pool.request(SOL);
    expect(pool.attempts).toEqual([`primary:${SOL}`]);

    expect((await pool.request(SOL, "/v1/responses", "ultrafast")).status).toBe(
      200,
    );
    expect(pool.attempts).toEqual([`entitled:${SOL}`]);

    expect(
      (await pool.request(ASTRA, "/v1/responses", "other-tier")).status,
    ).toBe(200);
    expect(pool.attempts).toEqual([`entitled:${ASTRA}`]);

    await pool.request(SOL);
    expect(pool.attempts).toEqual([`primary:${SOL}`]);
    expect(seenTiers).toEqual([
      undefined,
      "ultrafast",
      "other-tier",
      undefined,
    ]);
  });

  it("tries another entitled account with quota before blocking and excludes unsupported accounts", async () => {
    const pool = await createPool("event-stream", [
      ...tierAccounts(3 * HOUR),
      {
        name: "second-entitled",
        plan: "another-provider-plan",
        unsupported: [],
        catalog: [SOL],
        serviceTiers: { [SOL]: ["ultrafast"] },
      },
    ]);

    await pool.listModels();
    await pool.request(SOL);

    expect((await pool.request(SOL, "/v1/responses", "ultrafast")).status).toBe(
      200,
    );
    expect(pool.attempts).toEqual([`second-entitled:${SOL}`]);

    await pool.disable("second-entitled");
    const blocked = await pool.request(SOL, "/v1/responses", "ultrafast");
    expect(pool.attempts).toEqual([]);
    expect(blocked).toMatchObject({ status: 429, retryAfter: "10800" });
    expect(
      await pool.hub().retryAvailability("codex", "other", SOL, "ultrafast"),
    ).toEqual({
      kind: "blocked",
      retryAt: pool.now() + 3 * HOUR,
    });
    expect(
      await pool.hub().retryAvailability("codex", "other", SOL, "fast"),
    ).toEqual({ kind: "ready" });

    await pool.disable("entitled");
    const unsupported = await pool.request(SOL, "/v1/responses", "ultrafast");
    expect(pool.attempts).toEqual([]);
    expect(unsupported.status).toBe(400);
    expect(unsupported.body).toContain("ultrafast");
  });

  it("refreshes routing evidence after an account changes subscription", async () => {
    const pool = await createPool("event-stream", tierAccounts());
    await pool.listModels();
    pool.setPlan("entitled", "renewed-provider-plan");
    await pool.refresh("entitled");

    expect((await pool.request(SOL, "/v1/responses", "ultrafast")).status).toBe(
      400,
    );
    expect(pool.attempts).toEqual([]);

    await pool.listModels();
    expect((await pool.request(SOL, "/v1/responses", "ultrafast")).status).toBe(
      200,
    );
    expect(pool.attempts).toEqual([`entitled:${SOL}`]);
  });
});
