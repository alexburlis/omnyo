import type { PluginApi } from "@omnyo/plugin-sdk";
import { createAccountClient } from "./account-client.js";
import { AccountLink } from "./account-link.js";
import { resolveDefaultConnectBaseUrl } from "./base-url.js";
import { registerConnectCli } from "./cli.js";
import { HostedConnectApi } from "./hosted.js";
import { ShareHostResolver } from "./hosts.js";
import {
  CredentialCopy,
  createCredentialCopyStore,
} from "./credential-copy.js";
import { resolveLocalCloudLoopbackUrl } from "./local-loopback.js";
import {
  connectRpcContract,
  createRpcHandlers,
  type RemoteAccessSwitch,
} from "./rpc.js";
import {
  createServerAccessCloud,
  createServerAccessRecheck,
  registerServerAccess,
} from "./server-access.js";
import { ShareRegistry } from "./shares.js";
import { ConnectTunnel } from "./tunnel.js";
import {
  CONNECT_REALTIME_CHANNEL,
  REMOTE_ACTIVITY_INSTRUCTIONS_MS,
} from "./types.js";

export interface ConnectPluginOptions {
  accountRetryMinMs?: number;
}

export function createConnectPlugin(options: ConnectPluginOptions = {}) {
  return async function plugin(api: PluginApi): Promise<void> {
    const settings = api.settings.define({
      remoteAccess: {
        type: "boolean",
        label: "Remote access",
        description:
          "Keep this Omnyo reachable at its omnyo.link address while it is signed in to your Omnyo account. Turning it off keeps the account signed in.",
        default: true,
      },
      sendRemoteInstructions: {
        type: "boolean",
        label: "Tell agents about remote access",
        description:
          "When there is recent remote activity, remind agents how to share managed preview links. Applies to new agent sessions.",
        default: true,
      },
    });

    let currentSettings = await settings.get();
    const account = createAccountClient(() => api.sdk);
    const hosted = new HostedConnectApi(account);
    let tunnel!: ConnectTunnel;
    const hostResolver = new ShareHostResolver(() => api.sdk);

    const getLoopbackBaseUrl = () =>
      resolveLocalCloudLoopbackUrl(
        tunnel.getIdentity()?.serverUrl,
        process.env.OMNYO_DEV_APP_PORT,
      ) ?? api.server.loopbackBaseUrl;

    const shares = new ShareRegistry({
      kv: api.storage.kv,
      hosts: api.hosts,
      hostResolver,
      getLoopbackBaseUrl,
      getIdentity: () => tunnel.getIdentity(),
      log: api.log,
      onChange: () => {
        api.realtime.publish(CONNECT_REALTIME_CHANNEL, tunnel.status());
      },
    });

    api.events.on("experimental_host.deleted", async ({ host }) => {
      await shares.pruneHost(host.id);
    });

    const recheckServerAccess = createServerAccessRecheck(api);
    tunnel = new ConnectTunnel({
      shares,
      readCredential: () => account.connectCredential(),
      confirmRefusedCredential: (credential) =>
        account.confirmRefusedCredential(credential),
      defaultBaseUrl: resolveDefaultConnectBaseUrl(process.env),
      enabled: currentSettings.remoteAccess,
      getLoopbackBaseUrl,
      log: api.log,
      onStatusChange: (status) => {
        api.realtime.publish(CONNECT_REALTIME_CHANNEL, status);
        recheckServerAccess(status);
      },
    });
    settings.onChange((next) => {
      currentSettings = next;
      tunnel.setEnabled(next.remoteAccess);
    });

    const remoteAccess: RemoteAccessSwitch = {
      async set(enabled) {
        await settings.experimental_set({ remoteAccess: enabled });
        tunnel.setEnabled(enabled);

        return tunnel.refreshStatus();
      },
    };

    await registerServerAccess(api, {
      cloud: createServerAccessCloud(hosted),
      status: () => tunnel.status(),
    });

    api.rpc.register(
      connectRpcContract,
      createRpcHandlers({
        tunnel,
        hosted,
        hostResolver,
        remoteAccess,
      }),
    );
    registerConnectCli({
      api: api,
      tunnel,
      account,
      hosted,
      hostResolver,
      remoteAccess,
    });

    api.agents.contributeInstructions(() => {
      if (!currentSettings.sendRemoteInstructions) return null;
      const status = tunnel.status();

      if (!status.paired || !status.enabled || status.url === null) return null;

      const recent =
        status.remoteClients > 0 ||
        (status.lastRemoteActivityAt !== null &&
          Date.now() - status.lastRemoteActivityAt <
            REMOTE_ACTIVITY_INSTRUCTIONS_MS);

      if (!recent) return null;

      return (
        "For a dev server the user should open in Omnyo, register it as a managed preview for this chat using `omnyo preview register` and start it with `omnyo preview restart`. " +
        "Once it is ready, post a Markdown link to the original loopback URL, including the page path. Omnyo opens it directly on the owning device and routes it through a private preview for other viewers. " +
        "See `omnyo guide previews` for the commands. Use Connect port shares only when the user asks for a link to open outside Omnyo."
      );
    });

    const copyStore = createCredentialCopyStore(
      api.storage.kv,
      api.experimental_secrets,
    );

    await copyStore.migrate();

    const link = new AccountLink({
      account,
      copy: new CredentialCopy({ account, store: copyStore, log: api.log }),
      log: api.log,
      onAccount: (next) => tunnel.setAccount(next),
      ...(options.accountRetryMinMs === undefined
        ? {}
        : { retryMinMs: options.accountRetryMinMs }),
    });

    api.background.service("tunnel", {
      async start(signal) {
        await tunnel.start();
        await link.run(signal);
        tunnel.stop();
      },
    });
  };
}
