import type { SessionState } from "../session/session-scheduler";

export type ShellLoadPhase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; detail: string; code: number | null }
  | { kind: "http-error"; status: number };

export type ShellScreenState =
  | { kind: "loading"; message: string }
  | { kind: "reconnecting"; message: string }
  | { kind: "no-profile" }
  | { kind: "webview"; serverErrorStatus: number | null }
  | {
      kind: "error";
      title: string;
      detail: string;
      action: "retry" | "re-pair";
    };

interface ShellScreenInput {
  storeReady: boolean;
  hasAnyProfile: boolean;
  hasProfile: boolean;
  requiresSession: boolean;
  session: SessionState;
  load: ShellLoadPhase;
}

const TRANSIENT_NETWORK_ERRORS = new Set([
  -1001, -1003, -1004, -1005, -1006, -1009,
]);

export function resolveShellScreenState(
  input: ShellScreenInput,
): ShellScreenState {
  if (!input.storeReady) {
    return { kind: "loading", message: "Opening server" };
  }

  if (!input.hasAnyProfile) {
    return { kind: "no-profile" };
  }

  if (!input.hasProfile) {
    return { kind: "loading", message: "Opening server" };
  }

  switch (input.session.status) {
    case "auth-required":
      return {
        kind: "error",
        title: "Could not sign in",
        detail:
          "Omnyo connect could not renew this phone’s sign-in. Pair again to reconnect.",
        action: "re-pair",
      };
    case "error":
      return {
        kind: "error",
        title: "Cannot reach this server",
        detail: input.session.detail,
        action: "retry",
      };
    case "authenticating":
      return { kind: "loading", message: "Signing in" };
    case "idle":
      if (input.requiresSession) {
        return { kind: "loading", message: "Signing in" };
      }

      break;
    case "authenticated":
      break;
  }

  if (
    (input.load.kind === "http-error" &&
      input.load.status >= 500 &&
      input.load.status < 600) ||
    (input.load.kind === "failed" &&
      input.load.code !== null &&
      TRANSIENT_NETWORK_ERRORS.has(input.load.code))
  ) {
    return { kind: "reconnecting", message: "Reconnecting to server" };
  }

  switch (input.load.kind) {
    case "failed":
      return {
        kind: "error",
        title: "The page did not load",
        detail: input.load.detail,
        action: "retry",
      };
    case "http-error":
      return { kind: "webview", serverErrorStatus: input.load.status };
    case "loading":
    case "ready":
      return { kind: "webview", serverErrorStatus: null };
  }
}

export function revealsShellFailure(
  screen: ShellScreenState,
  requiresSession: boolean,
): boolean {
  if (screen.kind === "error" || screen.kind === "reconnecting") return true;

  if (screen.kind !== "webview" || screen.serverErrorStatus === null) {
    return false;
  }

  return !(
    requiresSession &&
    (screen.serverErrorStatus === 401 || screen.serverErrorStatus === 403)
  );
}

export function resolveShellLoadPath(input: {
  visitedPath: string | null;
  requestedPath: string | undefined;
}): string {
  if (input.visitedPath !== null) return input.visitedPath;

  if (input.requestedPath !== undefined && input.requestedPath.length > 0) {
    return input.requestedPath;
  }

  return "/";
}

export function shouldReloadForSession(
  previous: SessionState,
  next: SessionState,
  now: number,
  load: ShellLoadPhase,
): boolean {
  return (
    previous.status === "authenticated" &&
    next.status === "authenticated" &&
    previous !== next &&
    ((load.kind === "http-error" &&
      (load.status === 401 || load.status === 403)) ||
      (previous.expiresAt !== next.expiresAt && previous.expiresAt <= now))
  );
}
