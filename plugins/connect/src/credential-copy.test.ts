import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import {
  COPY_MARKER_KV_KEY,
  CREDENTIAL_COPY_KV_KEY,
  CREDENTIAL_COPY_SECRET_NAME,
  createCredentialCopyStore,
  credentialMarker,
  CredentialCopy,
} from "./credential-copy.js";

import { createAccountClient } from "./account-client.js";
import { FakeAccount } from "./testing/fake-account.js";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

function copy(credential: string) {
  return {
    serverUrl: "https://sawyer.omnyo.link",
    handle: "sawyer",
    credential,
  };
}

function setup() {
  const host = createFakePluginHost({ pluginId: "connect" });
  hosts.push(host);

  return {
    host,
    store: createCredentialCopyStore(
      host.api.storage.kv,
      host.api.experimental_secrets,
    ),
  };
}

async function secretValue(host: FakePluginHost): Promise<unknown> {
  const value = await host.api.experimental_secrets.get(
    CREDENTIAL_COPY_SECRET_NAME,
  );

  return value === undefined ? undefined : JSON.parse(value);
}

describe("connect credential copy storage", () => {
  it("moves a plugin storage copy into the secret store", async () => {
    const { host, store } = setup();
    await host.api.storage.kv.set(CREDENTIAL_COPY_KV_KEY, copy("bbcred_row"));

    await store.migrate();

    expect(await secretValue(host)).toEqual(copy("bbcred_row"));
    expect(
      await host.api.storage.kv.get(CREDENTIAL_COPY_KV_KEY),
    ).toBeUndefined();
    expect(await store.read()).toEqual(copy("bbcred_row"));
  });

  it("reads a copy that is already in the secret store", async () => {
    const { host, store } = setup();
    await host.api.experimental_secrets.set(
      CREDENTIAL_COPY_SECRET_NAME,
      JSON.stringify(copy("bbcred_secret")),
    );

    expect(await store.read()).toEqual(copy("bbcred_secret"));
    expect(await host.api.storage.kv.list()).toEqual([]);
  });

  it("finishes a move interrupted after the secret was written", async () => {
    const { host, store } = setup();
    await host.api.experimental_secrets.set(
      CREDENTIAL_COPY_SECRET_NAME,
      JSON.stringify(copy("bbcred_same")),
    );
    await host.api.storage.kv.set(CREDENTIAL_COPY_KV_KEY, copy("bbcred_same"));

    expect(await store.read()).toEqual(copy("bbcred_same"));
    expect(await host.api.storage.kv.list()).toEqual([]);
    expect(await host.api.experimental_secrets.list()).toEqual([
      CREDENTIAL_COPY_SECRET_NAME,
    ]);
  });

  it("prefers a plugin storage copy written by an older build after the move", async () => {
    const { host, store } = setup();
    await host.api.experimental_secrets.set(
      CREDENTIAL_COPY_SECRET_NAME,
      JSON.stringify(copy("bbcred_moved")),
    );
    await host.api.storage.kv.set(
      CREDENTIAL_COPY_KV_KEY,
      copy("bbcred_repaired"),
    );

    expect(await store.read()).toEqual(copy("bbcred_repaired"));
    expect(await secretValue(host)).toEqual(copy("bbcred_repaired"));
    expect(
      await host.api.storage.kv.get(CREDENTIAL_COPY_KV_KEY),
    ).toBeUndefined();
  });

  it("writes and clears the copy in the secret store and keeps the marker in plugin storage", async () => {
    const { host, store } = setup();

    await store.write(copy("bbcred_written"));

    expect(await secretValue(host)).toEqual(copy("bbcred_written"));
    expect(await host.api.storage.kv.list()).toEqual([COPY_MARKER_KV_KEY]);
    expect(await store.readMarker()).toBe(credentialMarker("bbcred_written"));

    await store.clear();

    expect(await store.read()).toBeNull();
    expect(await host.api.storage.kv.list()).toEqual([]);
    expect(await host.api.experimental_secrets.list()).toEqual([]);
  });
});

describe("connect credential URL reconciliation", () => {
  it("updates a same-token copy after the account changes relay origins", async () => {
    const { host, store } = setup();

    const legacy = {
      ...copy("bbcred_kept"),
      serverUrl: "https://sawyer.slashnew.com",
    };

    await store.write(legacy);
    const account = new FakeAccount();
    account.serverCredential = legacy.credential;
    account.signIn();

    const reconciler = new CredentialCopy({
      account: createAccountClient(() => ({
        ...host.api.sdk,
        plugins: {
          ...host.api.sdk.plugins,
          callRpc: async (args) =>
            args.outputSchema.parse(await account.callRpc(args)),
        },
      })),
      store,
      log: host.api.log,
    });

    expect(await reconciler.sync(account.status)).toBe(false);
    expect(await store.read()).toEqual(copy(legacy.credential));
    expect(account.adoptions).toEqual([]);
    expect(await reconciler.sync(account.status)).toBe(false);
    expect(await store.read()).toEqual(copy(legacy.credential));
  });
});
