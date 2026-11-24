import { and, eq } from "drizzle-orm";
import { createWorkflowShareApp } from "./workflow-routes.js";
import type { RevocationJournalInput } from "../gate/revocation.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { routePath } from "hono/route";
import { z } from "zod";
import {
  SERVER_CREDENTIAL_HEADER,
  labelClaim,
  serverCredentialFromHeaders,
} from "@omnyo/connect-db";
import type { RelayConfig } from "../config.js";
import {
  MAX_SERVERS_PER_USER,
  type RateLimitRule,
  type RateLimiter,
  type RelayLogger,
  type RelayRateLimiters,
} from "../contracts.js";
import type { RelayDatabase } from "../db.js";
import { createTokenBucketRateLimiter } from "../rate-limit.js";
import {
  AuthFlowError,
  type RelayAuthService,
  type ResolvedApexSession,
  safeAppPath,
} from "../auth/auth-service.js";
import { AUTH_BASE_PATH } from "../auth/better-auth.js";
import {
  accountApiResponse,
  approveServerLink,
  denyServerLink,
  getAccountMe,
  getLinkRequestView,
  linkCodeExists,
  type LinkApprovalTarget,
  linkRequestOrigin,
  pollServerLink,
  readJsonObject,
  startServerLink,
} from "./account.js";
import {
  claimHandle,
  connectApiResponse,
  createConnectCode,
  createMachineCodeForServer,
  findServerByCredential,
  createServer,
  type Deps,
  disconnectServer,
  getAccountState,
  type IssuedCode,
  lookupMachineCodeForServerCredential,
  listMachinesForServerCredential,
  redeemConnectCode,
  redeemMachineCode,
  removeServer,
  revokeMachine,
  revokeMachineForServerCredential,
} from "./api.js";
import {
  type AccountRevocations,
  type AccountTunnels,
  accountDepsFrom,
} from "./deps.js";
import {
  SECURITY_TXT_PATH,
  dashboardPage,
  errorPage,
  linkPage,
  messageFor,
  securityTxt,
  signInPage,
} from "./html.js";
import {
  apexSecurityHeaders,
  sameOriginViolation,
  withApexSecurityHeaders,
} from "./same-origin.js";
import { listAccountServers } from "./servers.js";

export const CONNECT_CODE_HEADER = "x-omnyo-connect-code";

const DASHBOARD_PATH = "/dashboard";

const MINUTE_MS = 60_000;

export const ACCOUNT_RATE_LIMITS = {
  linkDecisionPerAccount: { limit: 10, periodMs: MINUTE_MS },
  linkDecisionPerIp: { limit: 30, periodMs: MINUTE_MS },
  linkViewPerAccount: { limit: 20, periodMs: MINUTE_MS },
  linkViewPerIp: { limit: 60, periodMs: MINUTE_MS },
  codeMintPerAccount: { limit: 10, periodMs: MINUTE_MS },
  machineCodeMintPerAccount: { limit: 10, periodMs: MINUTE_MS },
  machineCodeFailurePerIp: { limit: 30, periodMs: MINUTE_MS },
} as const satisfies Readonly<Record<string, RateLimitRule>>;

function securityTxtResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}

const SIGN_IN_FAILED = "sign-in-failed";

export interface AccountAppDeps {
  config: Pick<RelayConfig, "appUrl" | "baseDomain" | "securityContact">;
  database: Pick<RelayDatabase, "db">;
  tunnels: AccountTunnels;
  revocations: AccountRevocations;
  rateLimits: Pick<
    RelayRateLimiters,
    "signInStart" | "linkStart" | "codeRedeem"
  >;
  auth: RelayAuthService;
  log: RelayLogger;
  now: () => number;
  recordShareRevocation?: (entry: RevocationJournalInput) => void;
}

const redeemMachineSchema = z.object({
  code: z.string(),
  deviceName: z.string().trim().min(1).max(128).optional(),
});

function htmlResponse(
  body: string,
  status = 200,
  setCookies: readonly string[] = [],
): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });

  for (const value of setCookies) headers.append("set-cookie", value);

  return new Response(body, { status, headers });
}

function seeOther(
  location: string,
  setCookies: readonly string[] = [],
): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });

  for (const value of setCookies) headers.append("set-cookie", value);

  return new Response(null, { status: 303, headers });
}

function withQuery(path: string, key: string, value: string): string {
  const url = new URL(path, "http://relay.invalid");
  url.searchParams.set(key, value);

  return `${url.pathname}${url.search}`;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

async function readForm(request: Request): Promise<Map<string, string> | null> {
  const type = request.headers.get("content-type") ?? "";

  if (
    !type.startsWith("application/x-www-form-urlencoded") &&
    !type.startsWith("multipart/form-data")
  ) {
    return null;
  }

  const form = await request.formData();
  const fields = new Map<string, string>();

  for (const [key, value] of form) {
    if (typeof value === "string") fields.set(key, value);
  }

  return fields;
}

export interface TenantReturnTo {
  url: string;
  label: string;
}

export function tenantReturnTo(
  raw: string | null,
  config: Pick<RelayConfig, "appUrl" | "baseDomain">,
): TenantReturnTo | null {
  if (raw === null || raw === "") return null;
  let target: URL;

  try {
    target = new URL(raw);
  } catch {
    return null;
  }

  const app = new URL(config.appUrl);
  const suffix = `.${config.baseDomain}`;

  if (
    target.protocol !== app.protocol ||
    target.port !== app.port ||
    target.username !== "" ||
    target.password !== "" ||
    !target.hostname.endsWith(suffix)
  ) {
    return null;
  }

  const label = target.hostname.slice(0, -suffix.length);

  return label === "" || label.includes(".")
    ? null
    : { url: target.toString(), label };
}

function linkApprovalTarget(
  fields: Map<string, string>,
): LinkApprovalTarget | null {
  const kind = fields.get("kind");
  const label = fields.get("label");
  const serverId = fields.get("serverId");

  if (kind === "new" && label !== undefined) return { kind, label };

  if (kind === "existing" && serverId !== undefined) return { kind, serverId };

  return null;
}

export function createAccountApp(input: AccountAppDeps): Hono {
  const deps: Deps = accountDepsFrom(input);
  const { auth, rateLimits, log, now } = input;
  const appOrigin = new URL(input.config.appUrl).origin;
  const securityHeaders = apexSecurityHeaders(input.config.baseDomain);

  const securityTxtBody = securityTxt({
    appUrl: appOrigin,
    contact: input.config.securityContact,
    at: now(),
  });

  const limiter = (rule: RateLimitRule) =>
    createTokenBucketRateLimiter(rule, now);

  const linkDecisionPerAccount = limiter(
    ACCOUNT_RATE_LIMITS.linkDecisionPerAccount,
  );

  const linkDecisionPerIp = limiter(ACCOUNT_RATE_LIMITS.linkDecisionPerIp);
  const linkViewPerAccount = limiter(ACCOUNT_RATE_LIMITS.linkViewPerAccount);
  const linkViewPerIp = limiter(ACCOUNT_RATE_LIMITS.linkViewPerIp);
  const codeMintPerAccount = limiter(ACCOUNT_RATE_LIMITS.codeMintPerAccount);

  const machineCodeMintPerAccount = limiter(
    ACCOUNT_RATE_LIMITS.machineCodeMintPerAccount,
  );

  const machineCodeFailurePerIp = limiter(
    ACCOUNT_RATE_LIMITS.machineCodeFailurePerIp,
  );

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.res = withApexSecurityHeaders(c.res, securityHeaders);

    if (c.req.path.includes("workflow")) {
      c.header("referrer-policy", "no-referrer");
      c.header("cache-control", "no-store");
      c.header("x-robots-tag", "noindex, nofollow");
    }

    log.info("apex.request", {
      method: c.req.method,
      route: c.req.path.includes("workflow")
        ? "/workflow-shares"
        : routePath(c, -1),
      status: c.res.status,
    });
  });

  if (input.recordShareRevocation)
    app.route(
      "/",
      createWorkflowShareApp({
        db: input.database.db,
        auth,
        origin: appOrigin,
        now,
        record: input.recordShareRevocation,
      }),
    );

  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => jsonError("payload-too-large", 413),
    }),
  );

  app.onError((error, c) => {
    const authFlow = error instanceof AuthFlowError;

    log.error("apex.error", {
      route: c.req.path.includes("workflow")
        ? "/workflow-shares"
        : routePath(c, -1),
      kind: authFlow ? "auth-flow" : error.name,
      ...(authFlow ? { status: error.status } : {}),
    });

    return authFlow && error.status === 429
      ? htmlResponse(errorPage(429), 429)
      : htmlResponse(errorPage(500), 500);
  });

  const cookieRoutes = [
    "/",
    DASHBOARD_PATH,
    `${DASHBOARD_PATH}/*`,
    "/link",
    "/link/*",
    "/sign-in",
    "/sign-out",
    `${AUTH_BASE_PATH}/*`,
    "/api/connect/servers",
  ];

  for (const path of cookieRoutes) {
    app.use(path, async (c, next) => {
      if (sameOriginViolation(c.req.raw, appOrigin) !== null) {
        return c.req.path.startsWith("/api/")
          ? jsonError("forbidden", 403)
          : htmlResponse(errorPage(403), 403);
      }

      await next();
    });
  }

  function clientIp(c: Context): string | null {
    return linkRequestOrigin(c.req.raw.headers)?.clientIp ?? null;
  }

  function missingClientIp(c: Context): Response {
    log.error("apex.client-ip-missing", { route: routePath(c, -1) });

    return jsonError("client-ip-unavailable", 500);
  }

  async function apexSession(c: Context): Promise<ResolvedApexSession | null> {
    return auth.resolveSession(c.req.raw.headers);
  }

  async function ownsLabel(userId: string, label: string): Promise<boolean> {
    const claim = await deps.db
      .select({ label: labelClaim.label })
      .from(labelClaim)
      .where(and(eq(labelClaim.label, label), eq(labelClaim.userId, userId)))
      .get();

    return claim !== undefined;
  }

  async function overLimit(
    checks: ReadonlyArray<readonly [RateLimiter, string]>,
  ): Promise<boolean> {
    for (const [rateLimiter, key] of checks) {
      if (!(await rateLimiter.limit({ key })).success) return true;
    }

    return false;
  }

  async function refuseSignedInForm(
    c: Context,
    perAccount: readonly [RateLimiter, string],
    perIp: RateLimiter | null,
  ): Promise<Response | null> {
    const ip = clientIp(c);

    if (ip === null) return missingClientIp(c);

    const checks: Array<readonly [RateLimiter, string]> = [perAccount];

    if (perIp !== null) checks.push([perIp, ip]);

    return (await overLimit(checks)) ? htmlResponse(errorPage(429), 429) : null;
  }

  async function probeLimiter(
    code: string,
    perIp: RateLimiter,
  ): Promise<RateLimiter | null> {
    return (await linkCodeExists(deps, code)) ? null : perIp;
  }

  async function signedInForm(
    c: Context,
    run: (
      session: ResolvedApexSession,
      fields: Map<string, string>,
    ) => Promise<Response>,
  ): Promise<Response> {
    const session = await apexSession(c);

    if (session === null) return seeOther(DASHBOARD_PATH);
    const fields = await readForm(c.req.raw);

    if (fields === null) return htmlResponse(errorPage(400), 400);

    return run(session, fields);
  }

  async function renderDashboard(
    session: ResolvedApexSession,
    message: string | null,
    issued: IssuedCode | null,
  ): Promise<Response> {
    const state = await getAccountState(deps, session.user.id);

    return htmlResponse(
      dashboardPage(state, { message, issued }),
      200,
      session.setCookies,
    );
  }

  app.all(`${AUTH_BASE_PATH}/*`, (c) => auth.handler(c.req.raw));

  app.get(SECURITY_TXT_PATH, () => securityTxtResponse(securityTxtBody));

  app.get("/", () => seeOther(DASHBOARD_PATH));

  app.post("/sign-in", async (c) => {
    const ip = clientIp(c);

    if (ip === null) return missingClientIp(c);

    if (!(await rateLimits.signInStart.limit({ key: ip })).success) {
      return htmlResponse(errorPage(429), 429);
    }

    const fields = await readForm(c.req.raw);
    const next = fields?.get("next") ?? DASHBOARD_PATH;

    if (safeAppPath(next, appOrigin) === null) {
      return htmlResponse(errorPage(400), 400);
    }

    return auth.startGitHubSignIn(c.req.raw.headers, next);
  });

  app.get("/sign-in", async (c) => {
    const next = safeAppPath(c.req.query("next") ?? DASHBOARD_PATH, appOrigin);

    if (next === null) return htmlResponse(errorPage(400), 400);
    const session = await apexSession(c);

    if (session !== null) return seeOther(next, session.setCookies);

    return htmlResponse(signInPage(next, null));
  });

  app.post("/sign-out", (c) => auth.signOut(c.req.raw.headers, DASHBOARD_PATH));

  app.get(DASHBOARD_PATH, async (c) => {
    const session = await apexSession(c);

    const returnTo = tenantReturnTo(
      c.req.query("returnTo") ?? null,
      input.config,
    );

    const error = c.req.query("error");

    if (session === null) {
      const next =
        returnTo === null
          ? DASHBOARD_PATH
          : withQuery(DASHBOARD_PATH, "returnTo", returnTo.url);

      return htmlResponse(
        signInPage(
          next,
          error === undefined ? null : messageFor(SIGN_IN_FAILED),
        ),
      );
    }

    if (
      returnTo !== null &&
      (await ownsLabel(session.user.id, returnTo.label))
    ) {
      return seeOther(returnTo.url, session.setCookies);
    }

    return renderDashboard(
      session,
      messageFor(c.req.query("notice") ?? error),
      null,
    );
  });

  app.post(`${DASHBOARD_PATH}/claim-handle`, (c) =>
    signedInForm(c, async (session, fields) => {
      const result = await claimHandle(
        deps,
        session.user.id,
        fields.get("handle") ?? "",
      );

      return seeOther(
        "error" in result
          ? withQuery(DASHBOARD_PATH, "error", result.error)
          : withQuery(DASHBOARD_PATH, "notice", "server-claimed"),
      );
    }),
  );

  app.post(`${DASHBOARD_PATH}/servers`, (c) =>
    signedInForm(c, async (session, fields) => {
      const result = await createServer(
        deps,
        session.user.id,
        fields.get("label") ?? "",
      );

      return seeOther(
        "error" in result
          ? withQuery(DASHBOARD_PATH, "error", result.error)
          : withQuery(DASHBOARD_PATH, "notice", "server-added"),
      );
    }),
  );

  app.post(`${DASHBOARD_PATH}/servers/:serverId/code`, (c) =>
    signedInForm(c, async (session) => {
      const refused = await refuseSignedInForm(
        c,
        [codeMintPerAccount, session.user.id],
        null,
      );

      if (refused !== null) return refused;

      const issued = await createConnectCode(deps, session.user.id, {
        serverId: c.req.param("serverId"),
        reuse: true,
      });

      if ("error" in issued) {
        return seeOther(withQuery(DASHBOARD_PATH, "error", issued.error));
      }

      return renderDashboard(session, null, issued);
    }),
  );

  app.post(`${DASHBOARD_PATH}/servers/:serverId/disconnect`, (c) =>
    signedInForm(c, async (session) => {
      const result = await disconnectServer(
        deps,
        session.user.id,
        c.req.param("serverId"),
      );

      return seeOther(
        "error" in result
          ? withQuery(DASHBOARD_PATH, "error", result.error)
          : withQuery(DASHBOARD_PATH, "notice", "server-disconnected"),
      );
    }),
  );

  app.post(`${DASHBOARD_PATH}/servers/:serverId/remove`, (c) =>
    signedInForm(c, async (session) => {
      const result = await removeServer(
        deps,
        session.user.id,
        c.req.param("serverId"),
      );

      return seeOther(
        "error" in result
          ? withQuery(DASHBOARD_PATH, "error", result.error)
          : withQuery(DASHBOARD_PATH, "notice", "server-removed"),
      );
    }),
  );

  app.post(`${DASHBOARD_PATH}/machines/:machineId/revoke`, (c) =>
    signedInForm(c, async (session) => {
      const result = await revokeMachine(
        deps,
        session.user.id,
        c.req.param("machineId"),
      );

      return seeOther(
        "error" in result
          ? withQuery(DASHBOARD_PATH, "error", result.error)
          : withQuery(DASHBOARD_PATH, "notice", "machine-revoked"),
      );
    }),
  );

  async function renderLink(
    session: ResolvedApexSession,
    code: string,
    message: string | null,
  ): Promise<Response> {
    const view = await getLinkRequestView(
      deps,
      session.user.id,
      code,
      MAX_SERVERS_PER_USER,
      now(),
    );

    return htmlResponse(
      linkPage(view, session.user.githubLogin, message),
      200,
      session.setCookies,
    );
  }

  app.get("/link", async (c) => {
    const code = c.req.query("code") ?? "";
    const session = await apexSession(c);

    if (session === null) {
      return htmlResponse(signInPage(withQuery("/link", "code", code), null));
    }

    const refused = await refuseSignedInForm(
      c,
      [linkViewPerAccount, session.user.id],
      await probeLimiter(code, linkViewPerIp),
    );

    if (refused !== null) return refused;

    return renderLink(session, code, messageFor(c.req.query("error")));
  });

  app.post("/link/claim-handle", (c) =>
    signedInForm(c, async (session, fields) => {
      const code = fields.get("code") ?? "";

      const result = await claimHandle(
        deps,
        session.user.id,
        fields.get("handle") ?? "",
      );

      const back = withQuery("/link", "code", code);

      return seeOther(
        "error" in result ? withQuery(back, "error", result.error) : back,
      );
    }),
  );

  app.post("/link/approve", (c) =>
    signedInForm(c, async (session, fields) => {
      const code = fields.get("code") ?? "";

      const refused = await refuseSignedInForm(
        c,
        [linkDecisionPerAccount, session.user.id],
        await probeLimiter(code, linkDecisionPerIp),
      );

      if (refused !== null) return refused;
      const target = linkApprovalTarget(fields);

      if (target === null)
        return renderLink(session, code, messageFor("invalid"));

      const result = await approveServerLink(
        deps,
        session.user.id,
        code,
        target,
        now(),
      );

      if ("error" in result) {
        return renderLink(session, code, messageFor(result.error));
      }

      return seeOther(withQuery("/link", "code", code));
    }),
  );

  app.post("/link/deny", (c) =>
    signedInForm(c, async (session, fields) => {
      const code = fields.get("code") ?? "";

      const refused = await refuseSignedInForm(
        c,
        [linkDecisionPerAccount, session.user.id],
        await probeLimiter(code, linkDecisionPerIp),
      );

      if (refused !== null) return refused;
      const result = await denyServerLink(deps, code, now());

      return renderLink(
        session,
        code,
        messageFor("error" in result ? result.error : "link-denied"),
      );
    }),
  );

  app.get("/api/connect/servers", async (c) => {
    const session = await apexSession(c);

    if (session === null) return jsonError("unauthorized", 401);

    const servers = await listAccountServers(
      deps.db,
      session.user.id,
      now(),
      deps.tunnelConnected,
    );

    return Response.json({ servers });
  });

  app.get("/api/account/me", async (c) =>
    accountApiResponse(
      await getAccountMe(deps, serverCredentialFromHeaders(c.req.raw.headers)),
    ),
  );

  app.post("/api/account/link/start", async (c) => {
    const origin = linkRequestOrigin(c.req.raw.headers);

    if (origin === null) return missingClientIp(c);
    const body = await readJsonObject(c.req.raw);

    return accountApiResponse(
      await startServerLink(
        { ...deps, rateLimiter: rateLimits.linkStart },
        { clientName: body.clientName, ...origin },
        now(),
      ),
    );
  });

  app.post("/api/account/link/poll", async (c) => {
    const body = await readJsonObject(c.req.raw);

    return accountApiResponse(
      await pollServerLink(deps, body.deviceCode, now()),
    );
  });

  async function admitRedeem(c: Context): Promise<Response | null> {
    const ip = clientIp(c);

    if (ip === null) return missingClientIp(c);

    return (await rateLimits.codeRedeem.limit({ key: ip })).success
      ? null
      : jsonError("rate-limited", 429);
  }

  app.post("/api/connect/redeem", async (c) => {
    const refused = await admitRedeem(c);

    if (refused !== null) return refused;
    const body = await readJsonObject(c.req.raw);
    const code = typeof body.code === "string" ? body.code : "";

    return connectApiResponse(await redeemConnectCode(deps, code));
  });

  app.post("/api/connect/redeem-machine", async (c) => {
    const refused = await admitRedeem(c);

    if (refused !== null) return refused;

    const parsed = redeemMachineSchema.safeParse(
      await c.req.raw.json().catch(() => null),
    );

    if (!parsed.success) return jsonError("invalid-request", 400);

    return connectApiResponse(
      await redeemMachineCode(
        deps,
        parsed.data.code,
        parsed.data.deviceName ?? null,
      ),
    );
  });

  app.get("/api/connect/devices", async (c) => {
    const result = await listMachinesForServerCredential(
      deps,
      serverCredentialFromHeaders(c.req.raw.headers),
    );

    return Response.json(result, {
      status: "status" in result ? result.status : 200,
      headers: { "cache-control": "no-store" },
    });
  });

  app.get("/api/connect/machine-code", async (c) => {
    const result = await lookupMachineCodeForServerCredential(
      deps,
      c.req.header(SERVER_CREDENTIAL_HEADER) ?? "",
      c.req.header(CONNECT_CODE_HEADER) ?? "",
    );

    return Response.json(result, {
      status: "status" in result ? result.status : 200,
    });
  });

  app.post("/api/connect/machine-code", async (c) => {
    const ip = clientIp(c);

    if (ip === null) return missingClientIp(c);

    const owner = await findServerByCredential(
      deps.db,
      c.req.header(SERVER_CREDENTIAL_HEADER) ?? "",
    );

    if (owner === undefined) {
      return (await overLimit([[machineCodeFailurePerIp, ip]]))
        ? jsonError("rate-limited", 429)
        : connectApiResponse({ error: "unauthorized", status: 401 });
    }

    if (await overLimit([[machineCodeMintPerAccount, owner.userId]])) {
      return jsonError("rate-limited", 429);
    }

    return connectApiResponse(await createMachineCodeForServer(deps, owner));
  });

  app.post("/api/connect/machine-code-lookup", async (c) => {
    const body = await readJsonObject(c.req.raw);
    const code = typeof body.code === "string" ? body.code : "";

    if (code.trim() === "") return jsonError("missing-code", 400);

    const result = await lookupMachineCodeForServerCredential(
      deps,
      serverCredentialFromHeaders(c.req.raw.headers),
      code,
    );

    return Response.json(result, {
      status: "status" in result ? result.status : 200,
    });
  });

  app.post("/api/connect/revoke-machine", async (c) => {
    const body = await readJsonObject(c.req.raw);
    const machineId = typeof body.machineId === "string" ? body.machineId : "";

    if (machineId === "") return jsonError("missing-machine-id", 400);

    return connectApiResponse(
      await revokeMachineForServerCredential(
        deps,
        c.req.header(SERVER_CREDENTIAL_HEADER) ?? "",
        machineId,
      ),
    );
  });

  app.notFound((c) =>
    c.req.path.startsWith("/api/")
      ? jsonError("not-found", 404)
      : htmlResponse(errorPage(404), 404),
  );

  return app;
}
