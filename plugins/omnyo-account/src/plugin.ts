import { hostname } from "node:os";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { AccountService } from "./account.js";
import {
  isAllowedBaseUrl,
  resolveDefaultBaseUrl,
  type BaseUrlAllowed,
} from "./base-url.js";
import { registerAccountCli } from "./cli.js";
import { ACCOUNT_REALTIME_CHANNEL } from "./contract.js";
import {
  DEFAULT_LINK_POLL_TIMING,
  LinkLogins,
  type LinkPollTiming,
} from "./login.js";
import { registerAccountRpc } from "./rpc.js";
import { createAccountStore } from "./store.js";

const CLIENT_NAME_MAX_LENGTH = 100;

function clientName(): string {
  const name = hostname().trim().slice(0, CLIENT_NAME_MAX_LENGTH);

  return name.length > 0 ? name : "Omnyo";
}

export interface OmnyoAccountPluginOptions {
  timing: LinkPollTiming;
  allowedBaseUrl: BaseUrlAllowed;
}

export function createOmnyoAccountPlugin(
  options: OmnyoAccountPluginOptions = {
    timing: DEFAULT_LINK_POLL_TIMING,
    allowedBaseUrl: (origin) => isAllowedBaseUrl(origin, process.env),
  },
) {
  return async function plugin(api: PluginApi): Promise<void> {
    const baseUrls = {
      defaultBaseUrl: resolveDefaultBaseUrl(process.env),
      allowed: options.allowedBaseUrl,
    };

    let logins!: LinkLogins;

    const publish = () => {
      api.realtime.publish(ACCOUNT_REALTIME_CHANNEL, {
        status: account.status(),
        login: logins.view(null),
      });
    };

    const account = new AccountService({
      store: createAccountStore(api.storage.kv, api.experimental_secrets),
      log: api.log,
      onChange: publish,
    });

    await account.load();
    logins = new LinkLogins({
      account,
      clientName: clientName(),
      log: api.log,
      timing: options.timing,
      onChange: publish,
    });

    registerAccountRpc({ api: api, account, logins, baseUrls });
    registerAccountCli({ api: api, account, logins, baseUrls });

    api.background.service("profile-refresh", {
      start: (signal) => account.runProfileRefresh(signal),
    });

    api.onDispose(() => {
      logins.dispose();
      account.dispose();
    });
  };
}
