import type { ServerProfile } from "../profiles/profile";
import { refetchQueriesRejectedBeforeSession } from "../query/session-invalidation";
import type { AppStateLike } from "../realtime/app-state";
import type {
  ProfileClient,
  ProfileClientRegistry,
} from "../sdk/client-registry";
import { connectProfileClient } from "../sdk/connect-profile-client";
import { bindSessionToAppState } from "../session/app-state";
import type {
  SessionScheduler,
  SessionState,
} from "../session/session-scheduler";

export type ActiveProfileConnection =
  | { profile: ServerProfile; client: ProfileClient; session: SessionState }
  | {
      profile: ServerProfile;
      client: null;
      session: { status: "unsupported"; detail: string };
    };

export const UNSUPPORTED_RELAY_DETAIL =
  "This server uses a retired relay. Pair it again through omnyo.link, or choose another server in Servers.";

export interface ActiveProfileConnector {
  activate(profile: ServerProfile | null): void;
  getSnapshot(): ActiveProfileConnection | null;
  subscribe(listener: () => void): () => void;
  renewSession(profileId: string): Promise<void>;
  reportShellAuthFailure(profileId: string): void;
}

export interface CreateActiveProfileConnectorDeps {
  isSupportedRelay(serverUrl: string): boolean;
  registry: ProfileClientRegistry;
  appState: AppStateLike;
  createSessionScheduler: () => SessionScheduler;
}

const IDLE_SESSION: SessionState = { status: "idle" };

export const CONNECT_FAILURE_VERIFY_INTERVAL_MS = 30_000;

export const AUTH_FAILURE_VERIFY_DEBOUNCE_MS = 2000;

export const AUTH_FAILURE_REFETCH_DELAY_MS = 250;

export const AUTH_FAILURE_MAX_REMINTS = 3;

export const AUTH_FAILURE_STREAK_WINDOW_MS = 60_000;

export const AUTH_FAILURE_BREAKER_COOLDOWN_MS = 60_000;

const AUTH_FAILURE_BREAKER_DETAIL =
  "The session was minted but the server keeps rejecting it; check the device clock or pair again";

function connectionIdentity(profile: ServerProfile): string {
  return profile.mode === "connect"
    ? `${profile.id}\0${profile.serverUrl}\0${profile.credential}`
    : `${profile.id}\0${profile.serverUrl}`;
}

export function createActiveProfileConnector(
  deps: CreateActiveProfileConnectorDeps,
): ActiveProfileConnector {
  const listeners = new Set<() => void>();
  let snapshot: ActiveProfileConnection | null = null;
  let identity: string | null = null;
  let teardown: (() => void) | null = null;

  let sessionControl: {
    profileId: string;
    renew(): Promise<void>;
    reportShellAuthFailure(): void;
  } | null = null;

  function setSnapshot(next: ActiveProfileConnection | null): void {
    snapshot = next;

    for (const listener of listeners) listener();
  }

  function teardownCurrent(): void {
    const current = teardown;
    teardown = null;
    identity = null;
    current?.();
  }

  function activateDirect(profile: ServerProfile, client: ProfileClient): void {
    const disconnectRealtime = connectProfileClient(client, deps.appState);
    teardown = disconnectRealtime;
    setSnapshot({ profile, client, session: IDLE_SESSION });
  }

  function activateConnect(
    profile: Extract<ServerProfile, { mode: "connect" }>,
    client: ProfileClient,
  ): void {
    const scheduler = deps.createSessionScheduler();
    let disconnectRealtime: (() => void) | null = null;
    let lastVerifyAt = -Infinity;
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    let remints = 0;

    let breaker: {
      retryAt: number;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;

    const publishSession = (session: SessionState): void => {
      if (snapshot?.client !== client) return;
      setSnapshot({
        ...snapshot,
        session:
          breaker !== null && session.status === "authenticated"
            ? {
                status: "error",
                detail: AUTH_FAILURE_BREAKER_DETAIL,
                retryAt: breaker.retryAt,
              }
            : session,
      });
    };

    const resetBreaker = (): void => {
      if (breaker === null) return;
      clearTimeout(breaker.timer);
      breaker = null;
    };

    const unsubscribe = scheduler.onStateChange((session) => {
      if (session.status === "authenticated") {
        if (!session.restored) lastVerifyAt = Date.now();
        refetchQueriesRejectedBeforeSession(client.queryClient);

        if (disconnectRealtime === null) {
          disconnectRealtime = connectProfileClient(client, deps.appState);
        }
      } else if (
        session.status === "auth-required" &&
        disconnectRealtime !== null
      ) {
        disconnectRealtime();
        disconnectRealtime = null;
      }

      publishSession(session);
    });

    const unbindAppState = bindSessionToAppState(scheduler, deps.appState);

    let verifying = false;

    const remintSession = (mode: "verify" | "renew"): void => {
      if (verifying) return;
      verifying = true;
      lastVerifyAt = Date.now();
      void (mode === "renew" ? scheduler.renewNow() : scheduler.verifySession())
        .then((session) => {
          if (session.status === "authenticated") {
            client.realtime.probeOrReconnect();
          }
        })
        .finally(() => {
          verifying = false;
        });
    };

    const refetchRejectedSoon = (): void => {
      if (refetchTimer !== null) return;
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        refetchQueriesRejectedBeforeSession(client.queryClient);
      }, AUTH_FAILURE_REFETCH_DELAY_MS);
    };

    const tripBreaker = (): void => {
      const retryAt = Date.now() + AUTH_FAILURE_BREAKER_COOLDOWN_MS;
      breaker = {
        retryAt,
        timer: setTimeout(() => {
          breaker = null;
          publishSession(scheduler.getState());
          remintSession("verify");
        }, AUTH_FAILURE_BREAKER_COOLDOWN_MS),
      };
      publishSession(scheduler.getState());
    };

    const handleAuthFailure = (source: "client" | "shell"): void => {
      if (breaker !== null) return;

      if (scheduler.getState().status !== "authenticated") return;
      const sinceVerify = Date.now() - lastVerifyAt;

      if (
        source === "client" &&
        sinceVerify < AUTH_FAILURE_VERIFY_DEBOUNCE_MS
      ) {
        refetchRejectedSoon();

        return;
      }

      if (verifying) return;

      if (sinceVerify >= AUTH_FAILURE_STREAK_WINDOW_MS) remints = 0;

      if (remints >= AUTH_FAILURE_MAX_REMINTS) {
        tripBreaker();

        return;
      }

      remints += 1;
      remintSession(source === "shell" ? "renew" : "verify");
    };

    const unsubscribeAuthFailure = client.onAuthFailure(() => {
      handleAuthFailure("client");
    });

    const unsubscribeConnected = client.realtime.onConnected(() => {
      remints = 0;

      if (breaker === null) return;
      resetBreaker();
      publishSession(scheduler.getState());
      refetchQueriesRejectedBeforeSession(client.queryClient);
    });

    const unsubscribeConnectFailed = client.realtime.onConnectFailed(
      (event) => {
        if (event.authRejected) return;

        if (client.realtime.isSuspended()) return;

        if (Date.now() - lastVerifyAt < CONNECT_FAILURE_VERIFY_INTERVAL_MS) {
          return;
        }

        remintSession("verify");
      },
    );

    sessionControl = {
      profileId: profile.id,
      renew: () => scheduler.renewNow().then(() => undefined),
      reportShellAuthFailure: () => handleAuthFailure("shell"),
    };

    teardown = () => {
      sessionControl = null;
      unsubscribe();
      unbindAppState();
      unsubscribeAuthFailure();
      unsubscribeConnectFailed();
      unsubscribeConnected();

      if (refetchTimer !== null) {
        clearTimeout(refetchTimer);
        refetchTimer = null;
      }

      resetBreaker();
      disconnectRealtime?.();
      disconnectRealtime = null;
      scheduler.stop();
    };

    setSnapshot({ profile, client, session: scheduler.getState() });
    void scheduler.start(profile);
  }

  return {
    activate(profile) {
      if (profile === null) {
        teardownCurrent();
        setSnapshot(null);

        return;
      }

      const nextIdentity = connectionIdentity(profile);

      if (identity === nextIdentity && snapshot) {
        if (snapshot.profile !== profile) setSnapshot({ ...snapshot, profile });

        return;
      }

      teardownCurrent();
      identity = nextIdentity;

      if (
        profile.mode === "connect" &&
        !deps.isSupportedRelay(profile.serverUrl)
      ) {
        setSnapshot({
          profile,
          client: null,
          session: { status: "unsupported", detail: UNSUPPORTED_RELAY_DETAIL },
        });

        return;
      }

      const client = deps.registry.getClientForProfile(profile);

      if (profile.mode === "connect") {
        activateConnect(profile, client);
      } else {
        activateDirect(profile, client);
      }
    },
    getSnapshot: () => snapshot,
    renewSession(profileId) {
      return sessionControl?.profileId === profileId
        ? sessionControl.renew()
        : Promise.resolve();
    },
    reportShellAuthFailure(profileId) {
      if (sessionControl?.profileId === profileId) {
        sessionControl.reportShellAuthFailure();
      }
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
