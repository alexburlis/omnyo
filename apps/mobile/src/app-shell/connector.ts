import {
  createActiveProfileConnector,
  type ActiveProfileConnector,
} from "@/lib/connection";
import { isSupportedRelayServer } from "@/lib/profiles/supported-relay";
import {
  nativeAppState,
  nativeCookieStore,
  nativeSessionCache,
} from "@/lib/native";
import { getAppProfileClientRegistry } from "./client-registry";
import { createSessionScheduler } from "@/lib/session";

let instance: ActiveProfileConnector | null = null;

export function getActiveProfileConnector(): ActiveProfileConnector {
  if (!instance) {
    instance = createActiveProfileConnector({
      isSupportedRelay: isSupportedRelayServer,
      registry: getAppProfileClientRegistry(),
      appState: nativeAppState,
      createSessionScheduler: () =>
        createSessionScheduler({
          cookieStore: nativeCookieStore,
          sessionCache: nativeSessionCache,
        }),
    });
  }

  return instance;
}

export function waitForActiveConnection(profileId: string): Promise<boolean> {
  const timeoutMs = 5_000;
  const connector = getActiveProfileConnector();

  const hasClient = () => {
    const active = connector.getSnapshot();

    return (
      active !== null &&
      active.client !== null &&
      active.profile.id === profileId
    );
  };

  if (hasClient()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };

    const unsubscribe = connector.subscribe(() => {
      if (hasClient()) finish(true);
    });

    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
