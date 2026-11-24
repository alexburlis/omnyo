import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CLAUDE_POOL_LOGIN_RETIRED,
  CLAUDE_POOL_THREAD_RETIRED,
  accountSchema,
  accountSummarySchema,
  statusSchema,
} from "./contracts.js";
import { createAccountPoolPlugin } from "./server.js";
import {
  CLAUDE_API_KEY_PROXY_HEADER,
  PARENT_TOKEN_ENV,
  PARENT_URL_ENV,
} from "./parent-pool.js";
import { AccountStore, PoolAffinityStore } from "./store.js";

const UPSTREAM = "https://anthropic.test";

const CODEX_AUTH = "https://codex-auth.test";

interface CodexIdentity {
  accountId: string;
  email: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function jwt(payload: object): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

class FakeProviders {
  private issued = 0;
  nextCodexLogin: CodexIdentity | null = null;
  readonly upstreamRequests: Request[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin === UPSTREAM && url.pathname === "/v1/messages") {
      this.upstreamRequests.push(request);

      return Response.json({ id: "message" });
    }

    if (url.origin === CODEX_AUTH) {
      if (url.pathname === "/api/accounts/deviceauth/usercode") {
        return Response.json({
          device_auth_id: "device",
          user_code: "ABCD-1234",
          interval: 1,
          expires_in: 600,
        });
      }

      if (url.pathname === "/api/accounts/deviceauth/token") {
        return Response.json({
          authorization_code: "authorization",
          code_challenge: "challenge",
          code_verifier: "verifier",
        });
      }

      if (url.pathname === "/oauth/token" && this.nextCodexLogin !== null) {
        this.issued += 1;

        return Response.json({
          access_token: jwt({ exp: 4_102_444_800 }),
          refresh_token: `codex-refresh-${this.issued}`,
          id_token: jwt({
            email: this.nextCodexLogin.email,
            "https://api.openai.com/auth": {
              chatgpt_account_id: this.nextCodexLogin.accountId,
            },
          }),
        });
      }
    }

    if (url.pathname === "/codex-usage") return Response.json({});
    throw new Error(`Unexpected request to ${request.url}`);
  };
}

async function startPool(
  providers: FakeProviders,
  beforeHub?: (host: ReturnType<typeof createFakePluginHost>) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "omnyo-account-login-"));

  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: {
      hosts: { list: async () => [{ id: "host-one", name: "One" }] },
      threads: {
        events: {
          list: async ({ threadId }) =>
            threadId === "old-api-thread"
              ? [
                  {
                    type: "turn/completed",
                    data: { providerThreadId: "new-session" },
                  },
                ]
              : [],
        },
      },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: {
        list: async () => ({
          plugins: [{ id: "account-pool", enabled: true }],
        }),
      },
    },
  });

  await host.api.storage.kv.set("config", {
    anthropicUpstreamBaseUrl: UPSTREAM,
    codexUpstreamBaseUrl: UPSTREAM,
  });
  await createAccountPoolPlugin({
    fetch: providers.fetch,
    env,
    codexAuthBaseUrl: CODEX_AUTH,
    codexUsageUrl: `${CODEX_AUTH}/codex-usage`,
  })(host.api);
  await beforeHub?.(host);
  const service = host.harness.behavior.runService("hub");
  cleanups.push(async () => {
    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await vi.waitFor(async () => {
    expect(
      statusSchema.parse(
        await host.harness.behavior.callRpc("status.get", null),
      ).accepting,
    ).toBe(true);
  });

  const store = new AccountStore(
    host.api.storage.kv,
    host.api.experimental_secrets,
  );

  return { host, store };
}

type Pool = Awaited<ReturnType<typeof startPool>>;

async function summary(pool: Pool, id: string) {
  const accounts = z
    .array(accountSummarySchema)
    .parse(await pool.host.harness.behavior.callRpc("account.list", null));

  const account = accounts.find((candidate) => candidate.id === id);

  if (account === undefined) throw new Error(`Account ${id} is not listed.`);

  return account;
}

const RETIRED = accountSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  provider: "claude",
  kind: "oauth",
  label: "Retired Claude",
  email: null,
  subscriptionType: null,
  rateLimitTier: null,
  enabled: true,
  priority: 1,
  createdAt: 1,
});

const RETIRED_SECRET = `accounts/account-${RETIRED.id}.json`;

function threadContext(threadId: string) {
  return { threadId, projectId: "project-one", hostId: "host-one" };
}

describe("Account Pooler logins", () => {
  it("retires saved Claude OAuth without opening its secret or changing native authentication", async () => {
    const providers = new FakeProviders();
    const fetch = vi.spyOn(providers, "fetch");
    let reads = 0;

    const { host, store } = await startPool(providers, async (fixture) => {
      await fixture.api.storage.kv.set("accounts:v1", [RETIRED]);
      await fixture.api.storage.kv.set("retry-route:old-thread", "claude");
      await fixture.api.experimental_secrets.set(RETIRED_SECRET, "unreadable");
      const secrets = fixture.api.experimental_secrets;
      const read = secrets.get.bind(secrets);

      vi.spyOn(secrets, "get").mockImplementation((key) => {
        if (key === RETIRED_SECRET) reads++;

        return read(key);
      });

      new PoolAffinityStore(fixture.api.storage.database()).putBinding(
        JSON.stringify(["claude", "host-one", "session:retired-session"]),
        { accountId: RETIRED.id, lastUsedAt: Date.now() },
      );
    });

    const behavior = host.harness.behavior;
    await expect(
      behavior.resolveProviderEnv(
        "claude-code",
        threadContext("native-thread"),
      ),
    ).resolves.toEqual([]);
    await expect(
      behavior.resolveProviderEnv("claude-code", threadContext("old-thread")),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ANTHROPIC_BASE_URL",
          value: {
            serverPath: expect.stringContaining("/retired-claude-pool"),
          },
        }),
      ]),
    );

    const retired = await behavior.fetchHttp(
      "POST",
      "/retired-claude-pool/v1/messages",
    );

    expect(retired.status).toBe(409);
    expect(await retired.text()).toContain(CLAUDE_POOL_THREAD_RETIRED);

    await expect(
      behavior.callRpc("login.start", {
        kind: "add",
        priority: 100,
        label: null,
      }),
    ).rejects.toThrow(CLAUDE_POOL_LOGIN_RETIRED);
    await expect(
      behavior.callRpc("login.complete", {
        sessionId: RETIRED.id,
        pasted: "obsolete-code",
      }),
    ).rejects.toThrow(CLAUDE_POOL_LOGIN_RETIRED);
    await expect(
      behavior.callRpc("account.enable", { id: RETIRED.id }),
    ).rejects.toThrow(CLAUDE_POOL_LOGIN_RETIRED);
    await expect(store.readSecret(RETIRED)).rejects.toThrow(
      CLAUDE_POOL_LOGIN_RETIRED,
    );
    await expect(
      store.writeSecret(RETIRED.id, {
        kind: "oauth",
        accessToken: "obsolete-access",
        refreshToken: "obsolete-refresh",
        expiresAt: null,
      }),
    ).rejects.toThrow(CLAUDE_POOL_LOGIN_RETIRED);

    const usage = await behavior.callRpc("account.refreshUsage", {
      accountId: RETIRED.id,
    });

    expect(usage).toMatchObject({
      account: { enabled: false, error: CLAUDE_POOL_LOGIN_RETIRED },
    });
    expect(await store.listRoutable()).toEqual([]);
    expect(await store.list()).toEqual([RETIRED]);
    expect(fetch).not.toHaveBeenCalled();
    expect(reads).toBe(0);

    await behavior.runCli([
      "account",
      "add",
      "--provider",
      "claude",
      "--api-key",
      "fixture-key",
    ]);

    const env = await behavior.resolveProviderEnv(
      "claude-code",
      threadContext("api-thread"),
    );

    const token = env.find(
      (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
    )?.value;

    if (typeof token !== "string")
      throw new Error("Expected an Account Pooler token");

    const send = (sessionId: string, parentSessionId?: string) =>
      behavior.fetchHttp("POST", "/v1/messages", {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-1",
          metadata: {
            user_id: JSON.stringify({
              session_id: sessionId,
              parent_session_id: parentSessionId,
            }),
          },
          messages: [],
        }),
      });

    for (const request of [
      send("retired-session"),
      send("child-session", "retired-session"),
    ]) {
      const response = await request;
      expect(response.status).toBe(409);
      expect(await response.text()).toContain(CLAUDE_POOL_THREAD_RETIRED);
    }

    expect(fetch).not.toHaveBeenCalled();

    const direct = await send("new-session");
    expect(direct.status).toBe(200);
    await direct.text();
    expect(providers.upstreamRequests).toHaveLength(1);
    expect(providers.upstreamRequests[0]?.headers.get("x-api-key")).toBe(
      "fixture-key",
    );
    expect(
      providers.upstreamRequests[0]?.headers.get("authorization"),
    ).toBeNull();
    await host.api.storage.kv.set("retry-route:old-api-thread", "claude");

    const proven = await behavior.resolveProviderEnv(
      "claude-code",
      threadContext("old-api-thread"),
    );

    expect(proven).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ANTHROPIC_BASE_URL",
          value: { serverPath: "/api/v1/plugins/account-pool/http" },
        }),
      ]),
    );
    expect(await host.api.storage.kv.get("retry-route:old-api-thread")).toBe(
      "claude-api-key",
    );

    const ambiguous = await behavior.resolveProviderEnv(
      "claude-code",
      threadContext("old-thread"),
    );

    expect(ambiguous).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ANTHROPIC_BASE_URL",
          value: {
            serverPath: expect.stringContaining("/retired-claude-pool"),
          },
        }),
      ]),
    );
    await behavior.callRpc("bypass.set", {
      threadId: "old-thread",
      bypassed: true,
    });
    await expect(
      behavior.resolveProviderEnv("claude-code", threadContext("old-thread")),
    ).resolves.toEqual([]);
    expect(reads).toBe(0);
  });

  it("blocks a historical nested Claude route without asking the parent to choose an account", async () => {
    const providers = new FakeProviders();

    const fetch = vi
      .spyOn(providers, "fetch")
      .mockImplementation(async () =>
        Response.json(
          { claude: true, codex: false },
          { headers: { [CLAUDE_API_KEY_PROXY_HEADER]: "1" } },
        ),
      );

    const { host } = await startPool(
      providers,
      async (fixture) => {
        await fixture.api.storage.kv.set("retry-route:old-thread", "claude");
      },
      {
        [PARENT_URL_ENV]:
          "https://parent.test/api/v1/plugins/account-pool/http",
        [PARENT_TOKEN_ENV]: "A".repeat(43),
        _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
        ENABLE_PROMPT_CACHING_1H: "1",
      },
    );

    const behavior = host.harness.behavior;
    const before = fetch.mock.calls.length;

    const historical = await behavior.resolveProviderEnv(
      "claude-code",
      threadContext("old-thread"),
    );

    expect(historical).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ANTHROPIC_BASE_URL",
          value: {
            serverPath: expect.stringContaining("/retired-claude-pool"),
          },
        }),
      ]),
    );
    expect(fetch.mock.calls).toHaveLength(before);
    expect(historical).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
          value: "",
        }),
        expect.objectContaining({
          name: "ENABLE_PROMPT_CACHING_1H",
          value: "",
        }),
      ]),
    );

    const current = await behavior.resolveProviderEnv(
      "claude-code",
      threadContext("api-thread"),
    );

    expect(current).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ANTHROPIC_BASE_URL",
          value: { serverPath: "/api/v1/plugins/account-pool/http" },
        }),
      ]),
    );
  });

  it("re-logs a Codex account in place through the device flow and refuses another workspace", async () => {
    const providers = new FakeProviders();
    const pool = await startPool(providers);

    const account = await pool.store.add(
      {
        provider: "codex",
        kind: "oauth",
        label: "Work Codex",
        email: "codex@example.com",
        accountUuid: null,
        codexAccountId: "workspace-a",
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 3,
      },
      {
        kind: "oauth",
        accessToken: "stale-access",
        refreshToken: "stale-refresh",
        expiresAt: null,
      },
    );

    const relogin = async (identity: CodexIdentity) => {
      const started = await pool.host.harness.behavior.runCli([
        "account",
        "login",
        account.id,
      ]);

      expect(started.stdout).toContain("Enter this code: ABCD-1234");
      const sessionId = started.stdout.match(/Session ID: ([0-9a-f-]+)/u)?.[1];

      if (sessionId === undefined) throw new Error("No Codex session.");
      providers.nextCodexLogin = identity;

      return pool.host.harness.behavior.runCli([
        "account",
        "login-poll",
        "--session",
        sessionId,
      ]);
    };

    const refused = await relogin({
      accountId: "workspace-b",
      email: "codex@example.com",
    });

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(
      "This login is for a different ChatGPT workspace than Work Codex.",
    );
    expect(await pool.store.readSecret(account)).toMatchObject({
      refreshToken: "stale-refresh",
    });

    const accepted = await relogin({
      accountId: "workspace-a",
      email: "codex@example.com",
    });

    expect(accepted).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Signed in Work Codex"),
    });
    expect(await summary(pool, account.id)).toMatchObject({
      id: account.id,
      label: "Work Codex",
      priority: 3,
      enabled: true,
      codexAccountId: "workspace-a",
      error: null,
    });
    const secret = await pool.store.readSecret(account);
    expect(secret).toMatchObject({ kind: "oauth" });
    expect(secret).not.toMatchObject({ refreshToken: "stale-refresh" });
  });
});
