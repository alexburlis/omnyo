import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import { registerAccountCli } from "./cli.js";
import { LinkLogins, DEFAULT_LINK_POLL_TIMING } from "./login.js";
import { AccountService } from "./account.js";
import {
  createAccountStore,
  CREDENTIAL_SECRET_NAME,
  PROFILE_KV_KEY,
  REVISION_KV_KEY,
} from "./store.js";
import type { AccountProfile } from "./hosted.js";
import type { RelayRebindInput } from "./relay-rebind.js";

const checkpoint: RelayRebindInput = {
  fromBaseUrl: "https://slashnew.com",
  fromServerUrl: "https://owner-relay.example.invalid",
  userId: "usr_preserved",
  serverId: "srv_preserved",
  serverLabel: "alexb",
  check: false,
};

const oldCredential = {
  baseUrl: checkpoint.fromBaseUrl,
  serverUrl: checkpoint.fromServerUrl,
  serverId: checkpoint.serverId,
  credential: "fixture-credential",
};

const oldProfile: AccountProfile = {
  userId: checkpoint.userId,
  serverId: checkpoint.serverId,
  serverLabel: checkpoint.serverLabel,
  githubLogin: "fixture",
  name: "Fixture",
  avatarUrl: null,
  handle: "alexb",
  serverUrl: checkpoint.fromServerUrl,
};

const nextProfile = { ...oldProfile, serverUrl: "https://alexb.omnyo.link" };

let host: FakePluginHost;

let account: AccountService;

const profileResponse = (profile = nextProfile) => Response.json(profile);

beforeEach(async () => {
  host = createFakePluginHost({ pluginId: "omnyo-account" });
  await host.api.experimental_secrets.set(
    CREDENTIAL_SECRET_NAME,
    JSON.stringify(oldCredential),
  );
  await host.api.storage.kv.set(PROFILE_KV_KEY, oldProfile);
  account = new AccountService({
    store: createAccountStore(
      host.api.storage.kv,
      host.api.experimental_secrets,
    ),
    log: host.api.log,
    onChange: () => {},
  });
  await account.load();
});

afterEach(async () => {
  account.dispose();
  await host.harness.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function serveProfile() {
  const request = vi.fn(async () => profileResponse());
  vi.stubGlobal("fetch", request);

  return request;
}

describe("same-identity relay rebind", () => {
  it("pins the credential to the new apex, preserves identity and converges on repeat", async () => {
    const request = serveProfile();
    const first = await account.rebindRelay(checkpoint);
    expect(first).toMatchObject({
      changed: true,
      status: {
        state: "signed-in",
        account: { ...nextProfile, baseUrl: "https://omnyo.link" },
      },
    });
    expect(account.connectCredential()).toEqual({
      ...oldCredential,
      baseUrl: "https://omnyo.link",
      serverUrl: nextProfile.serverUrl,
    });
    expect(request).toHaveBeenCalledWith(
      new URL("https://omnyo.link/api/account/me"),
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({
          authorization: "Bearer fixture-credential",
        }),
      }),
    );
    const revision = first.status.revision;
    expect(await account.rebindRelay(checkpoint)).toMatchObject({
      changed: false,
      status: { revision },
    });
    expect(await host.api.storage.kv.get(REVISION_KV_KEY)).toBe(revision);
  });

  it("verifies staging without writing in check mode", async () => {
    const input = {
      ...checkpoint,
      fromBaseUrl: "https://stg.slashnew.com",
      fromServerUrl: "https://alexb.stg.slashnew.com",
      check: true,
    };

    await host.api.experimental_secrets.set(
      CREDENTIAL_SECRET_NAME,
      JSON.stringify({
        ...oldCredential,
        baseUrl: input.fromBaseUrl,
        serverUrl: input.fromServerUrl,
      }),
    );
    await host.api.storage.kv.set(PROFILE_KV_KEY, {
      ...oldProfile,
      serverUrl: input.fromServerUrl,
    });
    await account.load();
    const before = account.status();

    const storedBefore = await host.api.experimental_secrets.get(
      CREDENTIAL_SECRET_NAME,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        profileResponse({
          ...nextProfile,
          serverUrl: "https://alexb.stg.omnyo.link",
        }),
      ),
    );
    expect(await account.rebindRelay(input)).toEqual({
      changed: false,
      status: before,
    });
    expect(
      await host.api.experimental_secrets.get(CREDENTIAL_SECRET_NAME),
    ).toBe(storedBefore);
  });

  it.each([
    { userId: "usr_other" },
    { serverId: "srv_other" },
    { serverLabel: "other" },
    { serverUrl: "https://other.omnyo.link" },
    { serverUrl: "https://alexb.omnyo.link.evil.test" },
  ])("keeps the pairing when the new identity differs: %j", async (changed) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => profileResponse({ ...nextProfile, ...changed })),
    );
    const before = account.status();
    await expect(account.rebindRelay(checkpoint)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(account.status()).toEqual(before);
    expect(account.connectCredential()).toEqual(oldCredential);
  });

  it.each([
    { fromBaseUrl: "https://slashnew.com.evil.test" },
    { fromServerUrl: "https://other.slashnew.com" },
    { fromServerUrl: "https://owner-relay.example.invalid/path" },
    { fromBaseUrl: "https://slashnew.com/" },
    { serverId: "srv_other" },
  ])(
    "rejects an untrusted or stale checkpoint before sending a credential: %j",
    async (changed) => {
      const request = serveProfile();
      await expect(
        account.rebindRelay({ ...checkpoint, ...changed }),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
      expect(account.connectCredential()).toEqual(oldCredential);
    },
  );

  it.each([401, 302, 503])(
    "keeps the pairing after HTTP %i and never follows a redirect",
    async (status) => {
      const request = vi.fn(
        async () =>
          new Response(null, {
            status,
            headers: { location: "https://evil.test" },
          }),
      );

      vi.stubGlobal("fetch", request);
      await expect(account.rebindRelay(checkpoint)).rejects.toThrow();
      expect(account.connectCredential()).toEqual(oldCredential);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]).toEqual([
        new URL("https://omnyo.link/api/account/me"),
        expect.objectContaining({ redirect: "manual" }),
      ]);
    },
  );

  it("does not restore a pairing after concurrent sign-out", async () => {
    let release!: (response: Response) => void;

    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.pathname === "/api/account/me"
          ? pending
          : new Response(null, { status: 200 }),
      ),
    );
    const rebind = account.rebindRelay(checkpoint);
    await account.signOut();
    release(profileResponse());
    await expect(rebind).rejects.toMatchObject({ code: "superseded" });
    expect(account.status().state).toBe("signed-out");
    expect(account.connectCredential()).toBeNull();
  });

  it("recovers the committed identity after an interrupted profile mirror write and restart", async () => {
    serveProfile();
    const set = host.api.storage.kv.set.bind(host.api.storage.kv);
    let fail = true;
    vi.spyOn(host.api.storage.kv, "set").mockImplementation(
      async (key, value) => {
        if (key === PROFILE_KV_KEY && fail) {
          fail = false;
          throw new Error("fixture interrupted mirror write");
        }

        return set(key, value);
      },
    );
    await expect(account.rebindRelay(checkpoint)).rejects.toThrow(
      "fixture interrupted",
    );
    expect(account.status()).toMatchObject({
      state: "signed-in",
      account: { baseUrl: "https://omnyo.link", serverId: checkpoint.serverId },
    });
    await account.load();
    expect(await account.rebindRelay(checkpoint)).toMatchObject({
      changed: false,
      status: { account: { serverUrl: nextProfile.serverUrl } },
    });
    expect(await host.api.storage.kv.get(PROFILE_KV_KEY)).toEqual(nextProfile);
  });

  it("ignores an old-origin unauthorized response that arrives after the rebind", async () => {
    let release!: (response: Response) => void;

    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.host === "slashnew.com" ? pending : profileResponse(),
      ),
    );
    const refresh = account.refreshProfile();
    await account.rebindRelay(checkpoint);
    release(new Response(null, { status: 401 }));
    await refresh;
    expect(account.status()).toMatchObject({
      state: "signed-in",
      account: { baseUrl: "https://omnyo.link", serverId: checkpoint.serverId },
    });
  });
});

it("routes the operator CLI through the same read-only identity check", async () => {
  serveProfile();

  const logins = new LinkLogins({
    account,
    clientName: "fixture",
    log: host.api.log,
    timing: DEFAULT_LINK_POLL_TIMING,
    onChange: () => {},
  });

  registerAccountCli({
    api: host.api,
    account,
    logins,
    baseUrls: { defaultBaseUrl: "https://omnyo.link", allowed: () => false },
  });

  const result = await host.harness.runCli([
    "rebind-relay",
    "--from-base-url",
    checkpoint.fromBaseUrl,
    "--from-server-url",
    checkpoint.fromServerUrl,
    "--user-id",
    checkpoint.userId,
    "--server-id",
    checkpoint.serverId,
    "--server-label",
    checkpoint.serverLabel,
    "--check",
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    changed: false,
    status: { account: { serverUrl: checkpoint.fromServerUrl } },
  });
  expect(result.stdout).not.toContain(oldCredential.credential);
  logins.dispose();
});

it("recovers an existing checkpointed pairing whose old profile was unavailable", async () => {
  await host.api.storage.kv.delete(PROFILE_KV_KEY);
  await account.load();
  expect(account.status().state).toBe("profile-pending");
  serveProfile();
  expect(await account.rebindRelay(checkpoint)).toMatchObject({
    changed: true,
    status: {
      state: "signed-in",
      account: { userId: checkpoint.userId, serverId: checkpoint.serverId },
    },
  });
});
