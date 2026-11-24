import { describe, expect, it } from "vitest";
import type { SessionState } from "../session/session-scheduler";
import {
  resolveShellLoadPath,
  resolveShellScreenState,
  revealsShellFailure,
  shouldReloadForSession,
  type ShellLoadPhase,
} from "./shell-state";

const READY: ShellLoadPhase = { kind: "ready" };

const IDLE: SessionState = { status: "idle" };

const AUTHENTICATED: SessionState = {
  status: "authenticated",
  expiresAt: 1_000,
  restored: false,
};

const BASE = { storeReady: true, hasAnyProfile: true, requiresSession: false };

describe("resolveShellScreenState", () => {
  it("sends a phone with no server to the add-server screen", () => {
    expect(
      resolveShellScreenState({
        storeReady: true,
        hasAnyProfile: false,
        hasProfile: false,
        requiresSession: false,
        session: IDLE,
        load: { kind: "loading" },
      }),
    ).toEqual({ kind: "no-profile" });
  });

  it("waits for the profile store before deciding anything", () => {
    expect(
      resolveShellScreenState({
        storeReady: false,
        hasAnyProfile: false,
        hasProfile: false,
        requiresSession: false,
        session: IDLE,
        load: { kind: "loading" },
      }).kind,
    ).toBe("loading");
  });
  it("keeps an Omnyo connect profile off the page until its session starts", () => {
    expect(
      resolveShellScreenState({
        ...BASE,
        hasProfile: true,
        requiresSession: true,
        session: IDLE,
        load: { kind: "loading" },
      }),
    ).toEqual({ kind: "loading", message: "Signing in" });
  });

  it("shows the page once a Direct profile is loaded", () => {
    expect(
      resolveShellScreenState({
        ...BASE,
        hasProfile: true,
        session: IDLE,
        load: READY,
      }),
    ).toEqual({ kind: "webview", serverErrorStatus: null });
  });

  it("asks for re-pairing when the gate rejected the credential", () => {
    const state = resolveShellScreenState({
      ...BASE,
      hasProfile: true,
      session: { status: "auth-required", detail: "credential revoked" },
      load: READY,
    });

    expect(state).toEqual({
      kind: "error",
      title: "Could not sign in",
      detail:
        "Omnyo connect could not renew this phone’s sign-in. Pair again to reconnect.",
      action: "re-pair",
    });
  });

  it("puts the session error ahead of any load result", () => {
    const state = resolveShellScreenState({
      ...BASE,
      hasProfile: true,
      session: { status: "error", detail: "offline", retryAt: 0 },
      load: READY,
    });

    expect(state.kind).toBe("error");

    if (state.kind !== "error") throw new Error("unreachable");
    expect(state.action).toBe("retry");
  });

  it("keeps an unclassified load failure available for manual retry", () => {
    const state = resolveShellScreenState({
      ...BASE,
      hasProfile: true,
      session: AUTHENTICATED,
      load: {
        kind: "failed",
        detail: "The page could not load.",
        code: null,
      },
    });

    expect(state).toEqual({
      kind: "error",
      title: "The page did not load",
      detail: "The page could not load.",
      action: "retry",
    });
  });

  it.each([500, 502, 503, 504, 599])(
    "reconnects automatically when the server returns %s",
    (status) => {
      expect(
        resolveShellScreenState({
          ...BASE,
          hasProfile: true,
          session: AUTHENTICATED,
          load: { kind: "http-error", status },
        }),
      ).toEqual({ kind: "reconnecting", message: "Reconnecting to server" });
    },
  );

  it.each([-1001, -1003, -1004, -1005, -1006, -1009])(
    "reconnects automatically after transient network error %s",
    (code) => {
      expect(
        resolveShellScreenState({
          ...BASE,
          hasProfile: true,
          session: IDLE,
          load: { kind: "failed", detail: "The connection was lost.", code },
        }).kind,
      ).toBe("reconnecting");
    },
  );

  it.each([-1002, -1200, -1201, -1202, -1203, -1204, -1205, -1206])(
    "keeps permanent network error %s visible for manual recovery",
    (code) => {
      expect(
        resolveShellScreenState({
          ...BASE,
          hasProfile: true,
          session: IDLE,
          load: {
            kind: "failed",
            detail: "The connection was rejected.",
            code,
          },
        }).kind,
      ).toBe("error");
    },
  );

  it.each([400, 401, 403, 404])(
    "keeps the server's own %s response for manual or authentication recovery",
    (status) => {
      expect(
        resolveShellScreenState({
          ...BASE,
          hasProfile: true,
          session: AUTHENTICATED,
          load: { kind: "http-error", status },
        }),
      ).toEqual({ kind: "webview", serverErrorStatus: status });
    },
  );

  it("does not reconnect a failed page when its profile is no longer active", () => {
    expect(
      resolveShellScreenState({
        ...BASE,
        hasProfile: false,
        session: IDLE,
        load: { kind: "http-error", status: 503 },
      }),
    ).toEqual({ kind: "loading", message: "Opening server" });
  });

  it("keeps the WebView mounted while a load is in flight", () => {
    expect(
      resolveShellScreenState({
        ...BASE,
        hasProfile: true,
        session: AUTHENTICATED,
        load: { kind: "loading" },
      }),
    ).toEqual({ kind: "webview", serverErrorStatus: null });
  });

  it("waits for the profile and for the first session mint", () => {
    expect(
      resolveShellScreenState({
        ...BASE,
        hasProfile: false,
        session: IDLE,
        load: { kind: "loading" },
      }).kind,
    ).toBe("loading");
    expect(
      resolveShellScreenState({
        ...BASE,
        hasProfile: true,
        session: { status: "authenticating" },
        load: { kind: "loading" },
      }).kind,
    ).toBe("loading");
  });
});

describe("revealsShellFailure", () => {
  const page = (serverErrorStatus: number | null) =>
    ({ kind: "webview", serverErrorStatus }) as const;

  it("reveals error screens and server error pages", () => {
    expect(
      revealsShellFailure(
        { kind: "error", title: "", detail: "", action: "retry" },
        true,
      ),
    ).toBe(true);
    expect(revealsShellFailure(page(500), true)).toBe(true);
    expect(revealsShellFailure(page(401), false)).toBe(true);
    expect(revealsShellFailure(page(null), true)).toBe(false);
    expect(
      revealsShellFailure(
        { kind: "reconnecting", message: "Reconnecting to server" },
        false,
      ),
    ).toBe(true);
  });

  it("keeps an Omnyo connect page the gate rejected covered while the session is repaired", () => {
    expect(revealsShellFailure(page(401), true)).toBe(false);
    expect(revealsShellFailure(page(403), true)).toBe(false);
  });
});

describe("resolveShellLoadPath", () => {
  it("reloads the page where the user is, not where it was first opened", () => {
    expect(
      resolveShellLoadPath({
        visitedPath: "/projects/p1/threads/thr_new",
        requestedPath: "/projects/p1/threads/thr_notified",
      }),
    ).toBe("/projects/p1/threads/thr_new");
  });

  it("opens a requested thread before the page reports where it is", () => {
    expect(
      resolveShellLoadPath({
        visitedPath: null,
        requestedPath: "/projects/p1/threads/thr_notified",
      }),
    ).toBe("/projects/p1/threads/thr_notified");
  });

  it("opens the new-thread page on a cold start", () => {
    expect(
      resolveShellLoadPath({ visitedPath: null, requestedPath: undefined }),
    ).toBe("/");
    expect(resolveShellLoadPath({ visitedPath: null, requestedPath: "" })).toBe(
      "/",
    );
  });
});

describe("shouldReloadForSession", () => {
  const RENEWED: SessionState = {
    status: "authenticated",
    expiresAt: 2_000,
    restored: false,
  };

  it("reloads when the cookie the page loaded with has expired", () => {
    expect(shouldReloadForSession(AUTHENTICATED, RENEWED, 1_000, READY)).toBe(
      true,
    );
    expect(shouldReloadForSession(AUTHENTICATED, RENEWED, 1_500, READY)).toBe(
      true,
    );
  });

  it("does not reload when a renewal replaces a cookie that is still valid", () => {
    expect(shouldReloadForSession(AUTHENTICATED, RENEWED, 999, READY)).toBe(
      false,
    );
  });

  it.each([401, 403])(
    "reloads a rejected page after session repair (%s)",
    (status) => {
      for (const repaired of [RENEWED, { ...AUTHENTICATED }]) {
        expect(
          shouldReloadForSession(AUTHENTICATED, repaired, 999, {
            kind: "http-error",
            status,
          }),
        ).toBe(true);
      }

      expect(
        shouldReloadForSession(AUTHENTICATED, AUTHENTICATED, 999, {
          kind: "http-error",
          status,
        }),
      ).toBe(false);
    },
  );

  it("does not reload on the first mint, since the page only mounts after it", () => {
    expect(
      shouldReloadForSession(
        { status: "authenticating" },
        AUTHENTICATED,
        0,
        READY,
      ),
    ).toBe(false);
    expect(shouldReloadForSession(IDLE, AUTHENTICATED, 0, READY)).toBe(false);
  });

  it("does not reload on an unchanged session or a failure", () => {
    expect(
      shouldReloadForSession(AUTHENTICATED, AUTHENTICATED, 5_000, READY),
    ).toBe(false);
    expect(
      shouldReloadForSession(
        AUTHENTICATED,
        { status: "error", detail: "offline", retryAt: 0 },
        5_000,
        READY,
      ),
    ).toBe(false);
    expect(shouldReloadForSession(IDLE, IDLE, 5_000, READY)).toBe(false);
  });
});
