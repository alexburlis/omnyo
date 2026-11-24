import weeklyBytes from "./workflow-catalog/weekly-content-feed.omnyoworkflow?raw";
import weeklyRelease from "./workflow-catalog/weekly-content-feed.release.json";
import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAccountApp } from "../../relay/src/account/routes.js";
import { createRelayAuth } from "../../relay/src/auth/index.js";
import {
  createGitHubOAuthStub,
  parseSetCookie,
} from "../../relay/src/auth/github-oauth-stub.js";
import { CLIENT_IP_HEADER } from "../../relay/src/contracts.js";
import { openRelayDatabase } from "../../relay/src/db.js";
import { sourceMigrationDirectories } from "../../relay/src/migrations.js";
import { createRelayRateLimiters } from "../../relay/src/rate-limit.js";
import {
  createRevocationJournal,
  replayRevocationJournal,
} from "../../relay/src/gate/revocation.js";
import { workflowSharePage, WORKFLOW_RELAY_ORIGIN } from "./workflow-share";

async function listen(
  handler: (request: Request) => Response | Promise<Response>,
) {
  const server = createServer(async (request, response) => {
    try {
      const headers = new Headers();

      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value))
          value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }

      headers.set(CLIENT_IP_HEADER, "127.0.0.1");
      const chunks: Buffer[] = [];

      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

      const result = await handler(
        new Request(`http://${request.headers.host}${request.url}`, {
          method: request.method,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
      );

      response.statusCode = result.status;
      result.headers.forEach((value, name) => {
        if (name !== "set-cookie") response.setHeader(name, value);
      });
      const cookies = result.headers.getSetCookie();

      if (cookies.length) response.setHeader("set-cookie", cookies);
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.name : "Test handler error");
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("No loopback address");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );

      server.closeAllConnections();
      await closed;
    },
  };
}

it("crosses real loopback site and relay HTTP, then refuses a revoked package after backup restore and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-http-"));
  const path = join(root, "relay.sqlite");
  const backup = join(root, "before-revoke.sqlite");
  const journal = createRevocationJournal(join(root, "revocations.jsonl"));
  let database = openRelayDatabase(path, sourceMigrationDirectories());
  let account: ReturnType<typeof createAccountApp> | undefined;

  let relay = await listen((request) => {
    if (!account) throw new Error("Relay is not ready");

    return account.fetch(request);
  });

  const nativeFetch = globalThis.fetch;

  const github = createGitHubOAuthStub({
    id: 4242,
    login: "synthetic",
    name: "Synthetic",
    email: "synthetic@example.invalid",
  });

  vi.stubGlobal("fetch", github.fetch);
  const fixedOriginRequests: string[] = [];

  const forward: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(WORKFLOW_RELAY_ORIGIN);
    fixedOriginRequests.push(url.pathname);

    return nativeFetch(new URL(url.pathname, relay.origin), init);
  };

  const site = await listen((request) =>
    workflowSharePage(new URL(request.url).pathname.slice(3), forward),
  );

  function mountAccount() {
    const auth = createRelayAuth(
      {
        appUrl: relay.origin,
        betterAuthSecret: "synthetic-loopback-key-012345678901234567890",
        github: {
          clientId: "synthetic",
          clientSecret: "synthetic",
          allowedUserIds: ["4242"],
        },
      },
      database,
    );

    account = createAccountApp({
      config: {
        appUrl: relay.origin,
        baseDomain: "localhost",
        securityContact: "abuse@example.invalid",
      },
      database,
      auth: auth.service,
      tunnels: { has: () => false, close() {} },
      revocations: { record() {} },
      recordShareRevocation: (entry) => journal.append(entry),
      rateLimits: createRelayRateLimiters(),
      log: { info() {}, warn() {}, error() {} },
      now: Date.now,
    });
  }

  const cookies = new Map<string, string>();

  async function ownerRequest(pathname: string, body?: string) {
    const headers = new Headers({
      cookie: [...cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    });

    if (body !== undefined) {
      headers.set("origin", relay.origin);
      headers.set("content-type", "application/x-www-form-urlencoded");
    }

    const result = await nativeFetch(relay.origin + pathname, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body,
      redirect: "manual",
    });

    for (const header of result.headers.getSetCookie()) {
      const cookie = parseSetCookie(header);
      cookies.set(cookie.name, cookie.value);
    }

    return result;
  }

  try {
    mountAccount();

    const catalogFile = `${relay.origin}/api/workflow-shares/${weeklyRelease.sha256.slice(0, 32)}/file`;

    const published = vi
      .fn()
      .mockResolvedValueOnce(new Response(weeklyBytes))
      .mockResolvedValueOnce(new Response("changed package"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    vi.stubGlobal("fetch", published);
    const imported = await nativeFetch(catalogFile);
    expect(imported.status).toBe(200);
    expect(await imported.text()).toBe(weeklyBytes);
    expect(published).toHaveBeenCalledWith(
      `https://omnyohq.com/workflows/weekly-content-feed/file/${weeklyRelease.sha256}`,
      expect.objectContaining({ redirect: "error" }),
    );
    expect((await nativeFetch(catalogFile)).status).toBe(500);
    expect((await nativeFetch(catalogFile)).status).toBe(404);
    vi.stubGlobal("fetch", github.fetch);

    const start = await ownerRequest(
      "/sign-in",
      "next=%2Fdashboard%2Fworkflows",
    );

    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location") ?? "");
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set(
      "state",
      authorize.searchParams.get("state") ?? "",
    );
    callback.searchParams.set("code", github.issueCode());
    expect(
      (await ownerRequest(callback.pathname + callback.search)).status,
    ).toBe(302);

    const payload = {
      schemaVersion: 1,
      revision: 1,
      title: "Loopback synthetic feed",
      description: "A fictional package",
      inputs: [],
      trigger: { kind: "manual" },
      flow: { kind: "prompt", prompt: "Write fictional content." },
      skills: [],
    };

    const upload = await ownerRequest(
      "/api/workflow-shares",
      JSON.stringify(payload),
    );

    expect(upload.status).toBe(404);
    const user = database.sqlite
      .prepare<[], { id: string }>("SELECT id FROM user")
      .get();
    if (!user) throw new Error("Expected the signed-in fixture owner.");

    const id = "a".repeat(32);
    const now = Date.now();
    const expiresAt = now + 86_400_000;
    const metadata = {
      id,
      title: payload.title,
      description: payload.description,
      revision: payload.revision,
      packageDigest: "a".repeat(64),
      executionDigest: "b".repeat(64),
      capabilities: ["model-text"],
      expiresAt,
    };
    database.sqlite
      .prepare(
        "INSERT INTO relay_workflow_share (id, user_id, package, metadata, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        user.id,
        Buffer.from(JSON.stringify(payload)),
        JSON.stringify(metadata),
        now,
        expiresAt,
      );
    const firstPage = await nativeFetch(`${site.origin}/w/${id}`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.headers.get("cache-control")).toBe("no-store");
    const html = await firstPage.text();
    expect(html).toContain(payload.title);
    expect(html).toContain(`omnyo://workflows/import/${id}`);
    expect(html).toContain(
      `${WORKFLOW_RELAY_ORIGIN}/api/workflow-shares/${id}/file`,
    );

    const downloaded = await nativeFetch(
      `${relay.origin}/api/workflow-shares/${id}/file`,
    );

    expect(downloaded.status).toBe(200);
    expect(await downloaded.json()).toEqual(payload);
    await database.sqlite.backup(backup);
    expect(
      (await ownerRequest(`/api/workflow-shares/${id}/revoke`, "")).status,
    ).toBe(200);
    expect((await nativeFetch(`${site.origin}/w/${id}`)).status).toBe(404);
    expect(
      (await nativeFetch(`${relay.origin}/api/workflow-shares/${id}/file`))
        .status,
    ).toBe(404);
    await relay.close();
    database.close();
    await copyFile(backup, path);
    database = openRelayDatabase(path, sourceMigrationDirectories());
    expect(replayRevocationJournal(database.db, journal).applied).toBe(1);
    relay = await listen((request) => {
      if (!account) throw new Error("Relay is not ready");

      return account.fetch(request);
    });
    mountAccount();
    expect((await nativeFetch(`${site.origin}/w/${id}`)).status).toBe(404);
    expect(
      (await nativeFetch(`${relay.origin}/api/workflow-shares/${id}/file`))
        .status,
    ).toBe(404);
    expect(fixedOriginRequests).toEqual(
      Array(3).fill(`/api/workflow-shares/${id}`),
    );
  } finally {
    await site.close();
    await relay.close();
    database.close();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
