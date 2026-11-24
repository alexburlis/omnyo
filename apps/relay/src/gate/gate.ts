import { randomUUID } from "node:crypto";
import { type IncomingMessage, STATUS_CODES } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { auditLog } from "@omnyo/connect-db";
import { SPLIT_ASSET_ATTEMPT_HEADER } from "@omnyo/process-utils/error-reporting-privacy";
import {
  createSplitAssetAttemptAdmission,
  type prepareSplitAssetAttempt,
} from "@omnyo/process-utils/split-asset-attempt";
import {
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
  type HeaderPair,
} from "@omnyo/tunnel-contract";
import { WebSocketServer, type WebSocket } from "ws";
import {
  RELAY_RATE_LIMITS,
  RELAY_STRICT_TRANSPORT_SECURITY,
  REVOCATION_SWEEP_INTERVAL_MS,
  TUNNEL_SOCKET_SERVER_OPTIONS,
  VISITOR_SOCKET_SERVER_OPTIONS,
  type RelayDeps,
  type TunnelOwner,
  type TunnelWsOpenResult,
  type VisitorGrant,
} from "../contracts.js";
import { clientAddressKey } from "../net/client-ip.js";
import { BEARER_REJECTED_ACTION } from "../prune.js";
import { tunnelOfflineResponse } from "../tunnel/offline.js";
import {
  type BearerFailureGuard,
  TENANT_ACCOUNT_ROUTES,
  handleTenantAccountRoute,
  jsonResponse,
  rateLimitedResponse,
  refuseCredential,
} from "./account-routes.js";
import {
  GATE_COOKIE,
  NONCE_COOKIE,
  desktopSessionCookieName,
  legacyDesktopSessionCookieName,
  expiredHostCookie,
  isAcceptableTenantSetCookie,
  readCookie,
  withoutPlatformCookies,
} from "./cookies.js";
import {
  desktopSessionSetCookie,
  expiredDesktopSessionSetCookie,
  issueDesktopSessionCookie,
  verifyDesktopSessionCookie,
} from "./desktop-session.js";
import {
  GATE_COOKIE_REISSUE_AFTER_MS,
  issueGateCookie,
  readGateCookie,
} from "./gate-cookie.js";
import {
  AUTHORIZE_PATH,
  CALLBACK_PATH,
  authorizeUrl,
  consumeGateCode,
  isWellFormedToken,
  mintGateCode,
  newNonce,
  nonceCookieFor,
  nonceMatches,
} from "./handshake.js";
import { type HostClass, classifyHost, originForHost } from "./host.js";
import {
  egressCapPage,
  machinePage,
  notYourServerPage,
  offlinePage,
  signInLinkExpiredPage,
} from "./pages.js";
import {
  GATE_AUTH_HEADER,
  GATE_CONTROLLED_HEADERS,
  GATE_MACHINE_ID_HEADER,
  GATE_REAUTH_HEADER,
  HOP_HEADERS,
  MACHINE_CREDENTIAL_HEADER,
  TUNNEL_OFFLINE_HEADER,
  isVisitorForwardingHeader,
} from "./protocol-headers.js";
import {
  type ResolvedLabel,
  createMachineSeenWriter,
  credentialMatches,
  labelOwnerUserId,
  liveMachineByHash,
  liveServerByHash,
  machineMayUseLabel,
  pairedCredentialHash,
  resolveLabel,
  sameTunnelOwner,
  serverMayUseLabel,
  verifyMachineCredential,
} from "./resolve.js";
import { validateReturn } from "./return-url.js";
import {
  REVOKED_BY_OWNER_REASON,
  type RevocationJournal,
  revokeMachine,
} from "./revocation.js";
import { applyFramingHeaders, sameOriginViolation } from "./same-origin.js";
import {
  DESKTOP_KEY_LABEL,
  GATE_KEY_LABEL,
  derivePurposeKey,
} from "./signed-token.js";
import {
  type DailyByteBudget,
  type StreamBinding,
  StreamTracker,
  type TrackedStream,
  createDailyByteBudget,
  meteredBody,
} from "./streams.js";

export const INSTALLER_PATHS: ReadonlySet<string> = new Set([
  "/install.sh",
  "/install.ps1",
  "/install/version",
  "/install/omnyo-app.tgz",
]);

const PREVIEW_SANDBOX_POLICY = "sandbox allow-scripts allow-forms";

const RELAY_TEXT_POLICY = "sandbox; default-src 'none'";

const INSTALLER_BUDGET_REASON = "installer budget reached";

const INSTALLER_SCRIPT_BUDGET_REASON = "installer script budget reached";

const PREVIEW_BUDGET_REASON = "preview budget reached";

const PREVIEW_REFUSAL_BUDGET_REASON = "preview refusal budget reached";

const BUDGET_RETRY_AFTER_SECONDS = "3600";

export const INSTALLER_VERSION_MAX_BYTES = 64 * 1024;

export const INSTALLER_SCRIPT_MAX_BYTES = 256 * 1024;

const INSTALLER_SCRIPT_BODY_LIMITS: ReadonlyMap<string, number> = new Map([
  ["/install/version", INSTALLER_VERSION_MAX_BYTES],
  ["/install.sh", INSTALLER_SCRIPT_MAX_BYTES],
  ["/install.ps1", INSTALLER_SCRIPT_MAX_BYTES],
]);

export const SHORT_ENROLLMENT_INSTALLER_PATH =
  /^\/m\/[0-9A-Za-z-]{1,16}(?:\.ps1)?$/u;

export function isInstallerPath(pathname: string): boolean {
  return (
    INSTALLER_PATHS.has(pathname) ||
    SHORT_ENROLLMENT_INSTALLER_PATH.test(pathname)
  );
}

function installerScriptBodyLimit(pathname: string): number | null {
  return (
    INSTALLER_SCRIPT_BODY_LIMITS.get(pathname) ??
    (SHORT_ENROLLMENT_INSTALLER_PATH.test(pathname)
      ? INSTALLER_SCRIPT_MAX_BYTES
      : null)
  );
}

const RAW_RESPONSE_LINGER_MS = 5_000;

const INSTALLER_RESPONSE_TOO_LARGE = "installer response too large";

const CONDITIONAL_REQUEST_HEADERS = ["if-none-match", "if-modified-since"];

const OWNER_DOCUMENT_OPENER_POLICY = "same-origin-allow-popups";

const AUDIT_WINDOW_MS = 3_600_000;

export const REJECTED_CREDENTIAL_ROWS_PER_WINDOW = 1_000;

export const REJECTED_CREDENTIAL_ROWS_PER_CLIENT_PER_WINDOW =
  RELAY_RATE_LIMITS.failedBearer.limit + 1;

const TUNNEL_DIAL_ROWS_PER_LABEL_PER_WINDOW = 4;

export const TUNNEL_DIAL_ROWS_PER_USER_PER_WINDOW = 8;

export const TUNNEL_DIAL_ROWS_PER_WINDOW = 500;

const PREVIEW_CAPABILITY_PATH = /^\/preview-content\/[^/]+\/[^/]+(?:\/.*)?$/u;

const MACHINE_API_PATH = /^\/(?:internal(?:\/.*)?|api\/v1(?:\/.*)?)$/u;

const FAILED_BEARER_BLOCK_MS = 60_000;

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export const ACCESS_REVOKED_REASON = "access revoked";

export const EGRESS_CAP_REASON = "monthly relay traffic used up";

const WS_POLICY_VIOLATION = 1008;

export interface GateRequestMeta {
  rawTarget: string;
  clientIp: string;
  splitAssetAttempt?: ReturnType<typeof prepareSplitAssetAttempt>;
}

export interface GateOptions {
  deps: RelayDeps;
  journal: RevocationJournal;
  signInUrl(returnTo: string): string;
}

export interface Gate {
  fetch(request: Request, meta: GateRequestMeta): Promise<Response>;
  upgrade(
    incoming: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    meta: GateRequestMeta,
  ): Promise<void>;
  sweep(): void;
  startRevocationSweep(): () => void;
  revokeMachine(input: { userId: string; machineId: string }): boolean;
  openStreams(): number;
  failureBlocks(): number;
}

type RouteClass =
  | "healthcheck"
  | "misdirected"
  | "reserved"
  | "authorize"
  | "callback"
  | "account"
  | "tunnel-dial"
  | "installer"
  | "preview"
  | "machine-api"
  | "proxy"
  | "page"
  | "not-found";

interface Authenticated {
  binding: Exclude<StreamBinding, { kind: "anonymous" }>;
  grant: VisitorGrant;
  authKind: "session" | "machine";
  machineId: string | null;
  viaCookie: boolean;
  setCookies: string[];
}

type Authentication =
  | { kind: "ok"; auth: Authenticated }
  | { kind: "none" }
  | { kind: "wrong-user" }
  | { kind: "denied"; response: Response };

function text(
  body: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": RELAY_TEXT_POLICY,
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function reauthRequired(): Response {
  return jsonResponse({ error: "reauthentication_required" }, 401, {
    [GATE_REAUTH_HEADER]: "1",
  });
}

function wantsHtml(method: string, headers: Headers): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    (headers.get("accept") ?? "").includes("text/html")
  );
}

function headersFromIncoming(incoming: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;

    for (const item of Array.isArray(value) ? value : [value])
      headers.append(name, item);
  }

  return headers;
}

function forwardHeaders(
  source: Headers,
  auth: { kind: "session" | "machine"; machineId: string | null } | null,
): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  const controlled = new Set(GATE_CONTROLLED_HEADERS);

  source.forEach((value, name) => {
    if (
      HOP_HEADERS.has(name) ||
      name === SPLIT_ASSET_ATTEMPT_HEADER ||
      controlled.has(name) ||
      isVisitorForwardingHeader(name)
    )
      return;

    if (name === "cookie") {
      const tenant = withoutPlatformCookies(value);

      if (tenant !== null) pairs.push([name, tenant]);

      return;
    }

    pairs.push([name, value]);
  });

  if (auth === null) {
    pairs.push([GATE_AUTH_HEADER, "anonymous"]);

    return pairs;
  }

  pairs.push([GATE_AUTH_HEADER, auth.kind]);

  if (auth.machineId !== null)
    pairs.push([GATE_MACHINE_ID_HEADER, auth.machineId]);

  return pairs;
}

function isHostManagementMutation(method: string, pathname: string): boolean {
  if (method === "POST" && pathname === "/internal/hosts/enroll-key")
    return true;

  if (method === "POST" && pathname === "/api/v1/hosts/join-codes") return true;

  if (
    method === "PATCH" &&
    /^\/api\/v1\/hosts\/[^/]+\/permission-ceiling$/u.test(pathname)
  ) {
    return true;
  }

  return (
    (method === "PATCH" || method === "DELETE") &&
    /^\/api\/v1\/hosts\/[^/]+$/u.test(pathname)
  );
}

function isConditionalRequest(headers: Headers): boolean {
  return CONDITIONAL_REQUEST_HEADERS.some((name) => headers.has(name));
}

function isHtmlResponse(headers: Headers): boolean {
  return (headers.get("content-type") ?? "")
    .trim()
    .toLowerCase()
    .startsWith("text/html");
}

function auditWindowStart(at: number): number {
  return Math.floor(at / AUDIT_WINDOW_MS) * AUDIT_WINDOW_MS;
}

function grantFor(binding: Authenticated["binding"]): VisitorGrant {
  if (binding.kind === "gate") {
    return {
      kind: "session",
      userId: binding.userId,
      sessionId: binding.sessionId,
    };
  }

  if (binding.kind === "machine-credential") {
    return {
      kind: "machine",
      userId: binding.userId,
      machineId: binding.machineId,
    };
  }

  return binding.grant.kind === "machine"
    ? {
        kind: "machine",
        userId: binding.userId,
        machineId: binding.grant.machineId,
      }
    : {
        kind: "server",
        userId: binding.userId,
        serverId: binding.grant.serverId,
      };
}

function writeRawResponse(
  socket: Duplex,
  status: number,
  body: string,
  headers: Record<string, string>,
): void {
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Refused"}`,
    "connection: close",
    `content-length: ${Buffer.byteLength(body)}`,
    `strict-transport-security: ${RELAY_STRICT_TRANSPORT_SECURITY}`,
    ...Object.entries(headers)
      .filter(([name]) => name.toLowerCase() !== "strict-transport-security")
      .map(([name, value]) => `${name}: ${value}`),
  ];

  const linger = setTimeout(() => socket.destroy(), RAW_RESPONSE_LINGER_MS);
  linger.unref();
  socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`, () => {
    clearTimeout(linger);
    socket.destroy();
  });
}

async function writeResponseToSocket(
  socket: Duplex,
  response: Response,
): Promise<void> {
  const headers: Record<string, string> = {};

  response.headers.forEach((value, name) => {
    if (
      name !== "content-length" &&
      name !== "connection" &&
      name !== "set-cookie"
    )
      headers[name] = value;
  });

  writeRawResponse(socket, response.status, await response.text(), headers);
}

export function createGate(options: GateOptions): Gate {
  const { deps, journal } = options;
  const { config, tunnels, egress, log, rateLimits, auth } = deps;
  const db = deps.database.db;
  const gateKey = derivePurposeKey(config.betterAuthSecret, GATE_KEY_LABEL);

  const desktopKey = derivePurposeKey(
    config.betterAuthSecret,
    DESKTOP_KEY_LABEL,
  );

  const desktopCookie = desktopSessionCookieName(config.appUrl);
  const legacyDesktopCookie = legacyDesktopSessionCookieName(config.appUrl);
  const secureCookies = new URL(config.appUrl).protocol === "https:";
  const tracker = new StreamTracker();
  const admitSplitAssetAttempt = createSplitAssetAttemptAdmission(deps.now);

  const installerBudget = createDailyByteBudget(
    config.installerBytesPerLabelPerDay,
    deps.now,
  );

  const installerScriptBudget = createDailyByteBudget(
    config.installerBytesPerLabelPerDay,
    deps.now,
  );

  const previewBudget = createDailyByteBudget(
    config.previewBytesPerLabelPerDay,
    deps.now,
  );

  const previewRefusalBudget = createDailyByteBudget(
    config.previewBytesPerLabelPerDay,
    deps.now,
  );

  const markMachineSeen = createMachineSeenWriter(db);
  const bearerBlocks = new Map<string, number>();

  interface DialedTunnel {
    socket: WebSocket;
    label: string;
    owner: TunnelOwner;
    credentialHash: string;
  }

  const dialedTunnels = new Map<string, DialedTunnel>();

  function trackDialedTunnel(routingKey: string, dialed: DialedTunnel): void {
    dialedTunnels.set(routingKey, dialed);
    dialed.socket.once("close", () => {
      if (dialedTunnels.get(routingKey) === dialed)
        dialedTunnels.delete(routingKey);
    });
  }

  function staleTunnelReason(
    routingKey: string,
    dialed: DialedTunnel,
  ): string | null {
    const resolved = resolveLabel(db, dialed.label);

    if (
      resolved === null ||
      resolved.routingKey !== routingKey ||
      !sameTunnelOwner(resolved.owner, dialed.owner)
    )
      return ACCESS_REVOKED_REASON;
    const paired = pairedCredentialHash(resolved);

    if (paired === null) return REVOKED_BY_OWNER_REASON;

    return paired === dialed.credentialHash ? null : ACCESS_REVOKED_REASON;
  }

  function closeDialedTunnel(routingKey: string, reason: string): void {
    dialedTunnels.delete(routingKey);
    tunnels.close(routingKey, reason);
  }

  function tunnelMayAnswer(resolved: ResolvedLabel): boolean {
    const paired = pairedCredentialHash(resolved);

    if (paired === null) return false;
    const dialed = dialedTunnels.get(resolved.routingKey);

    if (dialed === undefined || dialed.credentialHash === paired) return true;
    closeDialedTunnel(resolved.routingKey, ACCESS_REVOKED_REASON);

    return false;
  }

  let rejectionWindow = {
    start: auditWindowStart(deps.now()),
    rows: 0,
    skipped: 0,
    clients: new Map<string, number>(),
  };

  const dialAudits = new Map<
    string,
    { start: number; clientIps: Set<string> }
  >();

  let dialWindow = {
    start: auditWindowStart(deps.now()),
    rows: 0,
    skipped: 0,
    users: new Map<string, number>(),
  };

  function rollDialWindow(at: number): void {
    const start = auditWindowStart(at);

    if (start === dialWindow.start) return;

    if (dialWindow.skipped > 0) {
      log.warn("gate.tunnel_dials_unrecorded", {
        count: dialWindow.skipped,
        windowStart: new Date(dialWindow.start).toISOString(),
      });
    }

    dialWindow = { start, rows: 0, skipped: 0, users: new Map() };
  }

  interface BudgetMeter {
    spent(): boolean;
    add(bytes: number): void;
    pastCeiling(): boolean;
    reason: string;
  }

  type TrafficMeter =
    | { kind: "owner" }
    | {
        kind: "budget";
        budget: BudgetMeter;
        ceiling: boolean;
        refusals?: BudgetMeter;
      };

  function budgetMeter(
    budget: DailyByteBudget,
    limitBytes: number,
    resolved: ResolvedLabel,
    reason: string,
  ): BudgetMeter {
    const keys = [resolved.label, `user:${resolved.userId}`];

    return {
      spent: () => keys.some((key) => budget.exhausted(key)),
      add(bytes) {
        for (const key of keys) budget.add(key, bytes);
      },
      pastCeiling: () => keys.some((key) => budget.used(key) >= 2 * limitBytes),
      reason,
    };
  }

  function budgetSpentResponse(error: string): Response {
    return jsonResponse({ error }, 429, {
      "retry-after": BUDGET_RETRY_AFTER_SECONDS,
    });
  }

  function rollRejectionWindow(at: number): void {
    const start = auditWindowStart(at);

    if (start === rejectionWindow.start) return;

    if (rejectionWindow.skipped > 0) {
      log.warn("gate.bearer_rejections_unrecorded", {
        count: rejectionWindow.skipped,
        windowStart: new Date(rejectionWindow.start).toISOString(),
      });
    }

    rejectionWindow = { start, rows: 0, skipped: 0, clients: new Map() };
  }

  function admitRejectionRow(at: number, clientIp: string): boolean {
    rollRejectionWindow(at);
    const client = clientAddressKey(clientIp);
    const fromClient = rejectionWindow.clients.get(client) ?? 0;

    if (
      rejectionWindow.rows >= REJECTED_CREDENTIAL_ROWS_PER_WINDOW ||
      fromClient >= REJECTED_CREDENTIAL_ROWS_PER_CLIENT_PER_WINDOW
    ) {
      rejectionWindow.skipped += 1;

      return false;
    }

    rejectionWindow.rows += 1;
    rejectionWindow.clients.set(client, fromClient + 1);

    return true;
  }

  function isClientBlocked(clientIp: string, at: number): boolean {
    const key = clientAddressKey(clientIp);
    const until = bearerBlocks.get(key);

    if (until === undefined) return false;

    if (until > at) return true;
    bearerBlocks.delete(key);

    return false;
  }

  function recordTunnelDial(
    resolved: ResolvedLabel,
    clientIp: string,
    at: number,
  ): void {
    const start = auditWindowStart(at);
    const existing = dialAudits.get(resolved.routingKey);

    const entry =
      existing !== undefined && existing.start === start
        ? existing
        : { start, clientIps: new Set<string>() };

    dialAudits.set(resolved.routingKey, entry);
    const client = clientAddressKey(clientIp);

    if (
      entry.clientIps.has(client) ||
      entry.clientIps.size >= TUNNEL_DIAL_ROWS_PER_LABEL_PER_WINDOW
    )
      return;
    entry.clientIps.add(client);
    rollDialWindow(at);
    const fromUser = dialWindow.users.get(resolved.userId) ?? 0;

    if (
      dialWindow.rows >= TUNNEL_DIAL_ROWS_PER_WINDOW ||
      fromUser >= TUNNEL_DIAL_ROWS_PER_USER_PER_WINDOW
    ) {
      dialWindow.skipped += 1;

      return;
    }

    dialWindow.rows += 1;
    dialWindow.users.set(resolved.userId, fromUser + 1);
    db.insert(auditLog)
      .values({
        id: randomUUID(),
        userId: resolved.userId,
        action: "gate.tunnel_dialed",
        detail: JSON.stringify({ label: resolved.label, kind: resolved.kind }),
        ipAddress: clientIp,
        createdAt: new Date(at),
      })
      .run();
  }

  function pruneClientState(at: number): void {
    rollRejectionWindow(at);
    rollDialWindow(at);

    for (const [clientIp, until] of bearerBlocks) {
      if (until <= at) bearerBlocks.delete(clientIp);
    }

    const start = auditWindowStart(at);

    for (const [routingKey, entry] of dialAudits) {
      if (entry.start !== start) dialAudits.delete(routingKey);
    }

    installerBudget.prune();
    installerScriptBudget.prune();
    previewBudget.prune();
    previewRefusalBudget.prune();
  }

  const tunnelSockets = new WebSocketServer(TUNNEL_SOCKET_SERVER_OPTIONS);

  const visitorProtocols = new WeakMap<IncomingMessage, string | null>();

  const visitorSockets = new WebSocketServer({
    ...VISITOR_SOCKET_SERVER_OPTIONS,
    handleProtocols: (protocols, request) => {
      const chosen = visitorProtocols.get(request) ?? null;

      return chosen !== null && protocols.has(chosen) ? chosen : false;
    },
  });

  function logRoute(
    route: RouteClass,
    method: string,
    status: number,
    startedAt: number,
  ): void {
    log.info("gate.request", {
      route,
      method,
      status,
      ms: deps.now() - startedAt,
    });
  }

  function bearerGuard(
    clientIp: string,
    route: RouteClass,
  ): BearerFailureGuard {
    return {
      isBlocked: () => isClientBlocked(clientIp, deps.now()),
      async recordFailure() {
        const at = deps.now();

        if (admitRejectionRow(at, clientIp)) {
          db.insert(auditLog)
            .values({
              id: randomUUID(),
              userId: null,
              action: BEARER_REJECTED_ACTION,
              detail: JSON.stringify({ route }),
              ipAddress: clientIp,
              createdAt: new Date(at),
            })
            .run();
        }

        const { success } = await rateLimits.failedBearer.limit({
          key: clientIp,
        });

        if (!success) {
          bearerBlocks.set(
            clientAddressKey(clientIp),
            at + FAILED_BEARER_BLOCK_MS,
          );
        }
      },
    };
  }

  function machineGrantAdmitted(
    resolved: ResolvedLabel,
    credentialHash: string,
  ): boolean {
    const verified = liveMachineByHash(db, credentialHash);

    return verified !== null && machineMayUseLabel(resolved, verified);
  }

  function desktopGrantAdmitted(
    resolved: ResolvedLabel,
    grant: { kind: "machine" | "server"; credentialHash: string },
  ): boolean {
    if (grant.kind === "machine") {
      return machineGrantAdmitted(resolved, grant.credentialHash);
    }

    const verified = liveServerByHash(db, grant.credentialHash);

    return verified !== null && serverMayUseLabel(db, resolved, verified);
  }

  function bindingValid(binding: StreamBinding, now: number): boolean {
    const resolved = resolveLabel(db, binding.label);

    if (
      resolved === null ||
      resolved.userId !== binding.userId ||
      pairedCredentialHash(resolved) === null
    )
      return false;

    switch (binding.kind) {
      case "gate":
        return (
          binding.exp > now &&
          auth.findLiveSession(binding.sessionId, now)?.userId ===
            binding.userId
        );
      case "desktop":
        if (binding.exp <= now) return false;

        return desktopGrantAdmitted(resolved, binding.grant);
      case "machine-credential":
        return machineGrantAdmitted(resolved, binding.credentialHash);
      case "anonymous":
        return true;
    }
  }

  function authenticateCookies(
    headers: Headers,
    host: string,
    resolved: ResolvedLabel,
    now: number,
  ): Authentication {
    const cookieHeader = headers.get("cookie");
    const gateValue = readCookie(cookieHeader, GATE_COOKIE);
    const legacyDesktopValue = readCookie(cookieHeader, legacyDesktopCookie);

    const desktopCandidates = [
      { value: readCookie(cookieHeader, desktopCookie), isLegacy: false },
      { value: legacyDesktopValue, isLegacy: true },
    ];

    let gateCookieUserId: string | null = null;

    if (gateValue !== null) {
      const payload = readGateCookie(gateKey, gateValue, host, now);

      const session =
        payload === null
          ? null
          : auth.findLiveSession(payload.grant.sessionId, now);

      if (
        payload !== null &&
        session !== null &&
        session.userId === payload.userId
      ) {
        gateCookieUserId = payload.userId;

        if (payload.userId === resolved.userId) {
          const setCookies: string[] = [];
          let current = session;

          if (
            now - session.updatedAt.getTime() >=
            GATE_COOKIE_REISSUE_AFTER_MS
          ) {
            current = auth.renewSession(session.id, now) ?? session;
          }

          let exp = payload.exp;

          if (now - payload.iat >= GATE_COOKIE_REISSUE_AFTER_MS) {
            const reissued = issueGateCookie(
              gateKey,
              {
                userId: payload.userId,
                host,
                sessionId: session.id,
                sessionExpiresAt: current.expiresAt.getTime(),
              },
              now,
            );

            setCookies.push(reissued.setCookie);
            exp = reissued.payload.exp;
          }

          const binding = {
            kind: "gate",
            label: resolved.label,
            userId: payload.userId,
            sessionId: session.id,
            exp,
          } as const;

          return {
            kind: "ok",
            auth: {
              binding,
              grant: grantFor(binding),
              authKind: "session",
              machineId: null,
              viaCookie: true,
              setCookies,
            },
          };
        }
      }
    }

    for (const candidate of desktopCandidates) {
      if (candidate.value === null) continue;

      const verified = verifyDesktopSessionCookie(
        db,
        desktopKey,
        candidate.value,
        now,
      );

      if (
        verified !== null &&
        verified.userId === resolved.userId &&
        desktopGrantAdmitted(resolved, verified.grant)
      ) {
        if (verified.grant.kind === "machine")
          markMachineSeen(verified.grant.machineId, now);

        const setCookies: string[] = [];
        let exp = verified.exp;

        if (legacyDesktopValue !== null) {
          setCookies.push(
            expiredDesktopSessionSetCookie(
              legacyDesktopCookie,
              config.baseDomain,
              secureCookies,
            ),
          );
        }

        if (verified.needsRefresh || candidate.isLegacy) {
          const renewed = issueDesktopSessionCookie(
            {
              userId: verified.userId,
              grant: {
                kind: verified.grant.kind,
                credentialHash: verified.grant.credentialHash,
              },
            },
            {
              key: desktopKey,
              baseDomain: config.baseDomain,
              name: desktopCookie,
            },
            now,
          );

          setCookies.push(desktopSessionSetCookie(renewed, secureCookies));
          exp = renewed.expiresAt;
        }

        const binding = {
          kind: "desktop",
          label: resolved.label,
          userId: verified.userId,
          grant: verified.grant,
          exp,
        } as const;

        return {
          kind: "ok",
          auth: {
            binding,
            grant: grantFor(binding),
            authKind: verified.grant.kind === "machine" ? "machine" : "session",
            machineId:
              verified.grant.kind === "machine"
                ? verified.grant.machineId
                : null,
            viaCookie: true,
            setCookies,
          },
        };
      }
    }

    return gateCookieUserId === null
      ? { kind: "none" }
      : { kind: "wrong-user" };
  }

  function authenticate(
    method: string,
    pathname: string,
    headers: Headers,
    host: string,
    resolved: ResolvedLabel,
    target: string | null,
    now: number,
    route: { clientIp: string },
  ): Authentication | Promise<Authentication> {
    const presented = headers.get(MACHINE_CREDENTIAL_HEADER);

    if (MACHINE_API_PATH.test(pathname) && presented !== null) {
      if (target !== null)
        return { kind: "denied", response: text("Not found\n", 404) };
      const verified = verifyMachineCredential(db, presented.trim());

      if (verified === null || !machineMayUseLabel(resolved, verified)) {
        return refuseCredential(
          bearerGuard(route.clientIp, "machine-api"),
          text("Machine not authorized\n", 403),
        ).then((response) => ({ kind: "denied", response }) as const);
      }

      if (isHostManagementMutation(method, pathname)) {
        return {
          kind: "denied",
          response: text("This machine cannot manage hosts\n", 403),
        };
      }

      markMachineSeen(verified.machineId, now);

      const binding = {
        kind: "machine-credential",
        label: resolved.label,
        userId: verified.userId,
        machineId: verified.machineId,
        credentialHash: verified.credentialHash,
      } as const;

      return {
        kind: "ok",
        auth: {
          binding,
          grant: grantFor(binding),
          authKind: "machine",
          machineId: verified.machineId,
          viaCookie: false,
          setCookies: [],
        },
      };
    }

    if (pathname === "/internal" || pathname.startsWith("/internal/")) {
      return {
        kind: "denied",
        response: text("Machine not authorized\n", 403),
      };
    }

    return authenticateCookies(headers, host, resolved, now);
  }

  function track(
    binding: StreamBinding,
    close: (reason: string) => void,
    settle: () => void,
  ): () => void {
    const stream: TrackedStream = { binding, close, settle };

    return tracker.add(stream);
  }

  function chargeOwner(userId: string): (bytes: number) => void {
    return (bytes) => egress.add(userId, bytes);
  }

  function meteredRequestBody(
    request: Request,
    userId: string | null,
  ): ReadableStream<Uint8Array> | null {
    if (request.body === null) return null;

    return userId === null
      ? request.body
      : meteredBody(request.body, chargeOwner(userId), () => undefined).stream;
  }

  interface VisitorResponseOptions {
    route: RouteClass;
    method: string;
    startedAt: number;
    framing: boolean;
    ownerDocument: boolean;
    installerPath: string | null;
    setCookies: readonly string[];
    onBytes: (bytes: number) => void;
    meterHead: boolean;
    ceiling: BudgetMeter | null;
    binding: StreamBinding | null;
    abort: AbortController;
  }

  function visitorResponse(
    response: Response,
    opts: VisitorResponseOptions,
  ): Response {
    const headers = new Headers();

    response.headers.forEach((value, name) => {
      if (
        name !== "set-cookie" &&
        name !== "set-cookie2" &&
        name !== "clear-site-data" &&
        name !== "strict-transport-security"
      )
        headers.append(name, value);
    });

    const cookieless = opts.route === "preview" || opts.installerPath !== null;

    if (!cookieless) {
      for (const cookie of response.headers.getSetCookie()) {
        if (isAcceptableTenantSetCookie(cookie))
          headers.append("set-cookie", cookie);
      }
    }

    for (const cookie of opts.setCookies) headers.append("set-cookie", cookie);

    if (opts.framing) applyFramingHeaders(headers);

    if (
      opts.ownerDocument &&
      !headers.has("cross-origin-opener-policy") &&
      isHtmlResponse(headers)
    )
      headers.set("cross-origin-opener-policy", OWNER_DOCUMENT_OPENER_POLICY);

    if (opts.route === "preview")
      headers.append("content-security-policy", PREVIEW_SANDBOX_POLICY);

    if (opts.installerPath !== null) {
      headers.set("x-content-type-options", "nosniff");
      headers.set("content-security-policy", "sandbox");

      if (opts.installerPath === "/install/omnyo-app.tgz") {
        headers.set("content-type", "application/octet-stream");
        headers.set(
          "content-disposition",
          'attachment; filename="omnyo-app.tgz"',
        );
      } else {
        headers.set("content-type", "text/plain; charset=utf-8");
        headers.delete("content-disposition");
      }
    }

    let bytes = 0;

    if (opts.meterHead) {
      let headBytes = 0;

      response.headers.forEach((value, name) => {
        headBytes += name.length + value.length + 4;
      });
      opts.onBytes(headBytes);
    }

    const finish = () =>
      log.info("gate.stream", {
        route: opts.route,
        method: opts.method,
        status: response.status,
        bytes,
        ms: deps.now() - opts.startedAt,
      });

    if (response.body === null || NULL_BODY_STATUSES.has(response.status)) {
      finish();

      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    let untrack: () => void = () => undefined;

    const bodyLimit =
      opts.installerPath === null
        ? null
        : installerScriptBodyLimit(opts.installerPath);

    const metered = meteredBody(
      response.body,
      (count) => {
        bytes += count;
        opts.onBytes(count);

        if (bodyLimit !== null && bytes > bodyLimit) {
          opts.abort.abort(INSTALLER_RESPONSE_TOO_LARGE);
          metered.abort(INSTALLER_RESPONSE_TOO_LARGE);
        } else if (opts.ceiling?.pastCeiling() === true) {
          opts.abort.abort(opts.ceiling.reason);
          metered.abort(opts.ceiling.reason);
        }
      },
      () => {
        untrack();
        finish();
      },
    );

    if (opts.binding !== null) {
      untrack = track(
        opts.binding,
        (reason) => {
          opts.abort.abort(reason);
          metered.abort(reason);
        },
        () => undefined,
      );
    }

    return new Response(metered.stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  function hostClass(host: string): HostClass {
    return classifyHost(host, {
      baseDomain: config.baseDomain,
      appUrl: config.appUrl,
    });
  }

  async function authorize(
    request: Request,
    meta: GateRequestMeta,
    startedAt: number,
  ): Promise<Response> {
    if (request.method !== "GET")
      return jsonResponse({ error: "method_not_allowed" }, 405, {
        allow: "GET",
      });

    const session = await auth.getSession(request.headers);

    const handshakeKey =
      session === null ? meta.clientIp : `session:${session.session.id}`;

    if (!(await rateLimits.gateHandshake.limit({ key: handshakeKey })).success)
      return rateLimitedResponse();
    const appOrigin = new URL(config.appUrl).origin;

    if (
      sameOriginViolation({
        method: request.method,
        headers: request.headers,
        origin: appOrigin,
        isWebSocket: false,
      }) !== null
    ) {
      return text("Forbidden\n", 403);
    }

    const params = new URL(request.url).searchParams;
    const host = params.getAll("host");
    const returnPath = params.getAll("return");
    const digest = params.getAll("n");

    if (host.length !== 1 || returnPath.length !== 1 || digest.length !== 1)
      return text("Bad request\n", 400);
    const tenantHost = (host[0] ?? "").toLowerCase();
    const tenant = hostClass(tenantHost);

    if (tenant.kind !== "tenant") return text("Bad request\n", 400);
    const origin = originForHost(tenantHost, config.appUrl);
    const validReturn = validateReturn(returnPath[0] ?? "", origin);

    if (validReturn === null || !isWellFormedToken(digest[0] ?? null))
      return text("Bad request\n", 400);

    if (session === null) {
      return new Response(null, {
        status: 302,
        headers: {
          location: options.signInUrl(
            authorizeUrl(
              config.appUrl,
              tenantHost,
              validReturn,
              digest[0] ?? "",
            ),
          ),
          "cache-control": "no-store",
          "referrer-policy": "strict-origin-when-cross-origin",
        },
      });
    }

    const resolved = resolveLabel(db, tenant.label);

    if (resolved === null) return text("No server has this address\n", 404);

    if (resolved.userId !== session.user.id)
      return notYourServerPage(tenant.label);

    const code = mintGateCode(
      db,
      {
        userId: session.user.id,
        host: tenantHost,
        sessionId: session.session.id,
        return: validReturn,
        n: digest[0] ?? "",
      },
      deps.now(),
    );

    logRoute("authorize", request.method, 302, startedAt);

    return new Response(null, {
      status: 302,
      headers: {
        location: `${origin}${CALLBACK_PATH}?code=${code}`,
        "cache-control": "no-store",
        "referrer-policy": "strict-origin-when-cross-origin",
      },
    });
  }

  async function callback(
    request: Request,
    meta: GateRequestMeta,
    host: string,
    label: string,
  ): Promise<Response> {
    if (request.method !== "GET")
      return jsonResponse({ error: "method_not_allowed" }, 405, {
        allow: "GET",
      });

    const now = deps.now();
    const codes = new URL(request.url).searchParams.getAll("code");

    const grant =
      codes.length === 1 ? consumeGateCode(db, codes[0] ?? "", now) : null;

    if (grant === null) {
      return (await rateLimits.gateHandshake.limit({ key: meta.clientIp }))
        .success
        ? signInLinkExpiredPage()
        : rateLimitedResponse();
    }

    if (grant.host !== host)
      return text("This sign-in link is for another address\n", 403);

    if (
      !nonceMatches(
        readCookie(request.headers.get("cookie"), NONCE_COOKIE),
        grant.n,
      )
    ) {
      return text("This sign-in link was opened in another browser\n", 403);
    }

    const origin = originForHost(host, config.appUrl);
    const validReturn = validateReturn(grant.return, origin);

    if (validReturn === null) return text("Bad request\n", 400);
    const session = auth.findLiveSession(grant.sessionId, now);

    if (session === null || session.userId !== grant.userId)
      return signInLinkExpiredPage();

    if (labelOwnerUserId(db, label) !== grant.userId)
      return notYourServerPage(label);

    const issued = issueGateCookie(
      gateKey,
      {
        userId: grant.userId,
        host,
        sessionId: session.id,
        sessionExpiresAt: session.expiresAt.getTime(),
      },
      now,
    );

    const headers = new Headers({
      location: `${origin}${validReturn}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });

    headers.append("set-cookie", expiredHostCookie(NONCE_COOKIE));
    headers.append("set-cookie", issued.setCookie);

    return new Response(null, { status: 302, headers });
  }

  function startHandshake(
    request: Request,
    meta: GateRequestMeta,
    host: string,
  ): Response {
    const origin = originForHost(host, config.appUrl);
    const validReturn = validateReturn(meta.rawTarget, origin);

    if (validReturn === null)
      return text("This address contains characters the relay refuses\n", 400);

    if (!wantsHtml(request.method, request.headers)) return reauthRequired();
    const existing = readCookie(request.headers.get("cookie"), NONCE_COOKIE);

    const nonce = isWellFormedToken(existing)
      ? nonceCookieFor(existing)
      : newNonce();

    return new Response(null, {
      status: 302,
      headers: {
        location: authorizeUrl(config.appUrl, host, validReturn, nonce.digest),
        "set-cookie": nonce.setCookie,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  async function forwardHttp(
    request: Request,
    url: URL,
    resolved: ResolvedLabel,
    target: string | null,
    authResult: Authenticated | null,
    opts: {
      route: RouteClass;
      startedAt: number;
      installerPath: string | null;
      binding: StreamBinding | null;
      ownerDocument: boolean;
      meter: TrafficMeter;
      splitAssetAttempt?: GateRequestMeta["splitAssetAttempt"];
    },
  ): Promise<Response> {
    const abort = new AbortController();
    request.signal.addEventListener(
      "abort",
      () => abort.abort("visitor closed"),
      { once: true },
    );
    const { meter } = opts;
    const charged = meter.kind === "owner" ? resolved.userId : null;

    const headers = forwardHeaders(
      request.headers,
      authResult === null
        ? null
        : { kind: authResult.authKind, machineId: authResult.machineId },
    );

    const { splitAssetAttempt } = opts;

    if (splitAssetAttempt !== undefined && admitSplitAssetAttempt()) {
      headers.push([SPLIT_ASSET_ATTEMPT_HEADER, splitAssetAttempt.id]);
      splitAssetAttempt.observe();
    }

    const response = tunnelMayAnswer(resolved)
      ? await tunnels.openHttpStream({
          routingKey: resolved.routingKey,
          ownerUserId: resolved.userId,
          expectedOwner: resolved.owner,
          target,
          grant: authResult?.grant ?? { kind: "anonymous" },
          signal: abort.signal,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers,
          body: meteredRequestBody(request, charged),
        })
      : tunnelOfflineResponse(headers);

    if (
      response.status === 503 &&
      response.headers.get(TUNNEL_OFFLINE_HEADER) === "1" &&
      wantsHtml(request.method, request.headers)
    ) {
      logRoute(opts.route, request.method, 503, opts.startedAt);

      return offlinePage(resolved.lastSeenAt, resolved.kind, deps.now(), {
        [TUNNEL_OFFLINE_HEADER]: "1",
      });
    }

    const budget =
      meter.kind === "owner"
        ? null
        : meter.refusals !== undefined &&
            response.status >= 400 &&
            response.status < 500
          ? meter.refusals
          : meter.budget;

    if (
      meter.kind === "budget" &&
      budget !== meter.budget &&
      budget !== null &&
      budget.spent()
    ) {
      abort.abort(budget.reason);
      await response.body?.cancel(budget.reason).catch(() => undefined);
      logRoute(opts.route, request.method, 429, opts.startedAt);

      return budgetSpentResponse("preview_budget_reached");
    }

    return visitorResponse(response, {
      route: opts.route,
      method: request.method,
      startedAt: opts.startedAt,
      framing: authResult?.viaCookie === true,
      ownerDocument: opts.ownerDocument,
      installerPath: opts.installerPath,
      setCookies: authResult?.setCookies ?? [],
      onBytes:
        budget === null
          ? chargeOwner(resolved.userId)
          : (bytes) => budget.add(bytes),
      meterHead: budget !== null,
      ceiling: meter.kind === "budget" && meter.ceiling ? budget : null,
      binding: opts.binding,
      abort,
    });
  }

  async function ownerInstallerFetch(
    request: Request,
    url: URL,
    resolved: ResolvedLabel,
    presented: string,
    meta: GateRequestMeta,
    startedAt: number,
  ): Promise<Response> {
    const verified = verifyMachineCredential(db, presented.trim());

    if (verified === null || !machineMayUseLabel(resolved, verified)) {
      const refused = await refuseCredential(
        bearerGuard(meta.clientIp, "installer"),
        text("Machine not authorized\n", 403),
      );

      logRoute("installer", request.method, refused.status, startedAt);

      return refused;
    }

    let meter: TrafficMeter = { kind: "owner" };

    if (
      installerScriptBodyLimit(url.pathname) === null &&
      egress.isOverCap(resolved.userId)
    ) {
      const budget = budgetMeter(
        installerBudget,
        config.installerBytesPerLabelPerDay,
        resolved,
        INSTALLER_BUDGET_REASON,
      );

      if (!isConditionalRequest(request.headers) && budget.spent())
        return budgetSpentResponse("installer_budget_reached");
      meter = { kind: "budget", budget, ceiling: true };
    }

    markMachineSeen(verified.machineId, deps.now());

    const binding = {
      kind: "machine-credential",
      label: resolved.label,
      userId: verified.userId,
      machineId: verified.machineId,
      credentialHash: verified.credentialHash,
    } as const;

    return forwardHttp(
      request,
      url,
      resolved,
      null,
      {
        binding,
        grant: grantFor(binding),
        authKind: "machine",
        machineId: verified.machineId,
        viaCookie: false,
        setCookies: [],
      },
      {
        route: "installer",
        startedAt,
        installerPath: url.pathname,
        binding,
        ownerDocument: false,
        meter,
      },
    );
  }

  function overCapResponse(userId: string, html: boolean): Response | null {
    if (!egress.isOverCap(userId)) return null;
    const usage = egress.usage(userId);

    return html
      ? egressCapPage(usage.capBytes, usage.resetsAt, deps.now())
      : jsonResponse(
          {
            error: "egress_cap_reached",
            resetsAt: usage.resetsAt.toISOString(),
          },
          429,
        );
  }

  async function tenantFetch(
    request: Request,
    meta: GateRequestMeta,
    url: URL,
    host: string,
    tenant: { label: string; target: string | null },
    startedAt: number,
  ): Promise<Response> {
    const { label, target } = tenant;
    const pathname = url.pathname;

    if (target === null && TENANT_ACCOUNT_ROUTES.has(pathname)) {
      const response = await handleTenantAccountRoute(request, pathname, {
        db,
        tunnels,
        journal,
        now: deps.now,
        desktopKey,
        baseDomain: config.baseDomain,
        desktopCookieName: desktopCookie,
        bearerGuard: bearerGuard(meta.clientIp, "account"),
      });

      logRoute("account", request.method, response.status, startedAt);

      return response;
    }

    if (pathname === "/__tunnel")
      return text("Upgrade required\n", 426, { upgrade: "websocket" });

    if (pathname === CALLBACK_PATH) {
      const response = await callback(request, meta, host, label);
      logRoute("callback", request.method, response.status, startedAt);

      return response;
    }

    if (pathname.startsWith("/__")) return text("Not found\n", 404);
    const resolved = resolveLabel(db, label);

    if (resolved === null) return text("No server has this address\n", 404);

    if (resolved.kind === "machine" && target === null) {
      return machinePage(label, config.appUrl, new URL(config.appUrl).host);
    }

    const method = request.method;

    if (
      target === null &&
      method === "POST" &&
      pathname === "/api/v1/plugins/sentry/http/webhook"
    ) {
      if (
        !(await rateLimits.previewPerIp.limit({ key: meta.clientIp })).success
      )
        return rateLimitedResponse();

      const budget = budgetMeter(
        previewBudget,
        config.previewBytesPerLabelPerDay,
        resolved,
        PREVIEW_BUDGET_REASON,
      );

      if (budget.spent()) return budgetSpentResponse("preview_budget_reached");

      return forwardHttp(request, url, resolved, null, null, {
        route: "proxy",
        startedAt,
        installerPath: null,
        binding: { kind: "anonymous", label, userId: resolved.userId },
        ownerDocument: false,
        meter: { kind: "budget", budget, ceiling: true },
      });
    }

    if ((method === "GET" || method === "HEAD") && isInstallerPath(pathname)) {
      if (target !== null) return text("Not found\n", 404);
      const presented = request.headers.get(MACHINE_CREDENTIAL_HEADER);

      if (presented !== null) {
        return ownerInstallerFetch(
          request,
          url,
          resolved,
          presented,
          meta,
          startedAt,
        );
      }

      if (
        !(await rateLimits.installerPerIp.limit({ key: meta.clientIp })).success
      )
        return rateLimitedResponse();

      const script = installerScriptBodyLimit(pathname) !== null;

      const budget = script
        ? budgetMeter(
            installerScriptBudget,
            config.installerBytesPerLabelPerDay,
            resolved,
            INSTALLER_SCRIPT_BUDGET_REASON,
          )
        : budgetMeter(
            installerBudget,
            config.installerBytesPerLabelPerDay,
            resolved,
            INSTALLER_BUDGET_REASON,
          );

      if (!isConditionalRequest(request.headers) && budget.spent())
        return budgetSpentResponse(
          script
            ? "installer_script_budget_reached"
            : "installer_budget_reached",
        );

      return forwardHttp(request, url, resolved, null, null, {
        route: "installer",
        startedAt,
        installerPath: pathname,
        binding: { kind: "anonymous", label, userId: resolved.userId },
        ownerDocument: false,
        meter: { kind: "budget", budget, ceiling: true },
      });
    }

    if (
      target === null &&
      (method === "GET" || method === "HEAD") &&
      PREVIEW_CAPABILITY_PATH.test(pathname)
    ) {
      if (
        !(await rateLimits.previewPerIp.limit({ key: meta.clientIp })).success
      )
        return rateLimitedResponse();

      if (
        request.headers.has("cookie") &&
        authenticateCookies(request.headers, host, resolved, deps.now())
          .kind === "ok"
      ) {
        const capped = overCapResponse(resolved.userId, false);

        if (capped !== null) return capped;

        return forwardHttp(request, url, resolved, target, null, {
          route: "preview",
          startedAt,
          installerPath: null,
          binding: { kind: "anonymous", label, userId: resolved.userId },
          ownerDocument: false,
          meter: { kind: "owner" },
        });
      }

      const budget = budgetMeter(
        previewBudget,
        config.previewBytesPerLabelPerDay,
        resolved,
        PREVIEW_BUDGET_REASON,
      );

      if (budget.spent()) return budgetSpentResponse("preview_budget_reached");

      return forwardHttp(request, url, resolved, target, null, {
        route: "preview",
        startedAt,
        installerPath: null,
        binding: { kind: "anonymous", label, userId: resolved.userId },
        ownerDocument: false,
        meter: {
          kind: "budget",
          budget,
          ceiling: true,
          refusals: budgetMeter(
            previewRefusalBudget,
            config.previewBytesPerLabelPerDay,
            resolved,
            PREVIEW_REFUSAL_BUDGET_REASON,
          ),
        },
      });
    }

    const now = deps.now();

    const authentication = await authenticate(
      method,
      pathname,
      request.headers,
      host,
      resolved,
      target,
      now,
      meta,
    );

    if (authentication.kind === "denied") {
      logRoute(
        "machine-api",
        method,
        authentication.response.status,
        startedAt,
      );

      return authentication.response;
    }

    if (authentication.kind === "none")
      return startHandshake(request, meta, host);

    if (authentication.kind === "wrong-user") {
      return wantsHtml(method, request.headers)
        ? notYourServerPage(label)
        : text("Not your server\n", 403);
    }

    const authResult = authentication.auth;
    const origin = originForHost(host, config.appUrl);

    if (
      authResult.viaCookie &&
      sameOriginViolation({
        method,
        headers: request.headers,
        origin,
        isWebSocket: false,
      }) !== null
    ) {
      return text("Forbidden\n", 403);
    }

    const capped = overCapResponse(
      resolved.userId,
      wantsHtml(method, request.headers),
    );

    if (capped !== null) return capped;

    return forwardHttp(request, url, resolved, target, authResult, {
      route:
        authResult.binding.kind === "machine-credential"
          ? "machine-api"
          : "proxy",
      startedAt,
      installerPath: null,
      binding: authResult.binding,
      ownerDocument: authResult.viaCookie && target === null,
      meter: { kind: "owner" },
      splitAssetAttempt:
        authResult.viaCookie && target === null
          ? meta.splitAssetAttempt
          : undefined,
    });
  }

  async function fetch(
    request: Request,
    meta: GateRequestMeta,
  ): Promise<Response> {
    const startedAt = deps.now();
    const url = new URL(request.url);
    const host = url.host.toLowerCase();
    const cls = hostClass(host);

    switch (cls.kind) {
      case "misdirected":
        logRoute("misdirected", request.method, 421, startedAt);

        return text("Misdirected request\n", 421);
      case "healthcheck":
        return text("ok\n", 200);
      case "reserved":
        logRoute("reserved", request.method, 301, startedAt);

        return new Response(null, {
          status: 301,
          headers: {
            location: `${new URL(config.appUrl).origin}${url.pathname}${url.search}`,
          },
        });
      case "apex":
        if (url.pathname === AUTHORIZE_PATH)
          return authorize(request, meta, startedAt);

        return text("Not found\n", 404);
      case "tenant":
        return tenantFetch(request, meta, url, host, cls, startedAt);
    }
  }

  async function dial(
    incoming: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    meta: GateRequestMeta,
    url: URL,
    tenant: { label: string; target: string | null },
  ): Promise<void> {
    const startedAt = deps.now();

    const refuse = (status: number, body: string) => {
      logRoute("tunnel-dial", "GET", status, startedAt);
      writeRawResponse(socket, status, body, {
        "content-type": "text/plain; charset=utf-8",
      });
    };

    if (tenant.target !== null) return refuse(404, "Not found\n");
    const resolved = resolveLabel(db, tenant.label);
    const authorization = incoming.headers.authorization ?? "";

    const credential = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    const pairedHash =
      resolved === null ? null : pairedCredentialHash(resolved);

    if (
      resolved === null ||
      pairedHash === null ||
      !credentialMatches(credential, pairedHash)
    ) {
      const guard = bearerGuard(meta.clientIp, "tunnel-dial");

      if (guard.isBlocked())
        return refuse(429, "Too many failed credentials\n");

      if (
        !(await rateLimits.tunnelDialPerIp.limit({ key: meta.clientIp }))
          .success
      )
        return refuse(429, "Too many tunnel dials\n");

      if (resolved === null) return refuse(404, "No server has this address\n");

      if (pairedHash === null) {
        return refuse(
          403,
          resolved.kind === "server"
            ? "Server not paired\n"
            : "Machine not paired\n",
        );
      }

      await guard.recordFailure();

      return refuse(401, "Invalid credential\n");
    }

    if (
      !(await rateLimits.tunnelDialPerLabel.limit({ key: tenant.label }))
        .success
    )
      return refuse(429, "Too many tunnel dials\n");

    const rawVersion = url.searchParams.get(TUNNEL_PROTOCOL_QUERY_PARAM);

    const parsedVersion =
      rawVersion === null ? 0 : Number.parseInt(rawVersion, 10);

    const protocolVersion =
      Number.isFinite(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0;

    tunnelSockets.handleUpgrade(incoming, socket, head, (ws) => {
      logRoute("tunnel-dial", "GET", 101, startedAt);
      recordTunnelDial(resolved, meta.clientIp, deps.now());
      tunnels.attach({
        routingKey: resolved.routingKey,
        owner: resolved.owner,
        protocolVersion: Math.min(protocolVersion, PROTOCOL_VERSION),
        socket: ws,
      });
      trackDialedTunnel(resolved.routingKey, {
        socket: ws,
        label: resolved.label,
        owner: resolved.owner,
        credentialHash: pairedHash,
      });
    });
  }

  async function visitorUpgrade(
    incoming: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    meta: GateRequestMeta,
    url: URL,
    host: string,
    tenant: { label: string; target: string | null },
  ): Promise<void> {
    const startedAt = deps.now();
    const headers = headersFromIncoming(incoming);

    const refuse = async (response: Response) => {
      logRoute("proxy", "GET", response.status, startedAt);
      await writeResponseToSocket(socket, response);
    };

    if (url.pathname.startsWith("/__")) return refuse(text("Not found\n", 404));
    const resolved = resolveLabel(db, tenant.label);

    if (resolved === null)
      return refuse(text("No server has this address\n", 404));

    if (resolved.kind === "machine" && tenant.target === null)
      return refuse(text("Not found\n", 404));
    const now = deps.now();

    const authentication = await authenticate(
      "GET",
      url.pathname,
      headers,
      host,
      resolved,
      tenant.target,
      now,
      meta,
    );

    if (authentication.kind === "denied")
      return refuse(authentication.response);

    if (authentication.kind === "none") return refuse(reauthRequired());

    if (authentication.kind === "wrong-user")
      return refuse(text("Not your server\n", 403));
    const authResult = authentication.auth;
    const origin = originForHost(host, config.appUrl);

    if (
      authResult.viaCookie &&
      sameOriginViolation({
        method: "GET",
        headers,
        origin,
        isWebSocket: true,
      }) !== null
    ) {
      return refuse(text("Forbidden\n", 403));
    }

    const capped = overCapResponse(resolved.userId, false);

    if (capped !== null) return refuse(capped);

    const forwarded = forwardHeaders(headers, {
      kind: authResult.authKind,
      machineId: authResult.machineId,
    });

    if (!tunnelMayAnswer(resolved))
      return refuse(tunnelOfflineResponse(forwarded));
    const abort = new AbortController();
    let accepted = false;
    let pending: TunnelWsOpenResult | null = null;

    socket.once("close", () => {
      if (accepted) return;
      abort.abort("visitor closed");

      if (pending?.kind === "accepted") pending.cancel("visitor closed");
    });

    const protocols = (headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter((protocol) => protocol !== "");

    const opened = await tunnels.openWsStream({
      routingKey: resolved.routingKey,
      ownerUserId: resolved.userId,
      expectedOwner: resolved.owner,
      target: tenant.target,
      grant: authResult.grant,
      signal: abort.signal,
      path: `${url.pathname}${url.search}`,
      headers: forwarded,
      protocols,
    });

    if (socket.destroyed || !socket.writable) {
      if (opened.kind === "accepted") opened.cancel("visitor closed");

      return;
    }

    if (opened.kind === "refused") return refuse(opened.response);
    pending = opened;
    visitorProtocols.set(incoming, opened.protocol);

    visitorSockets.handleUpgrade(incoming, socket, head, (ws: WebSocket) => {
      accepted = true;
      logRoute("proxy", "GET", 101, startedAt);
      let settledRead = 0;
      let settledWritten = 0;

      const settle = () => {
        const read = socket instanceof Socket ? socket.bytesRead : 0;
        const written = socket instanceof Socket ? socket.bytesWritten : 0;
        const delta = read - settledRead + (written - settledWritten);
        settledRead = read;
        settledWritten = written;

        if (delta > 0) egress.add(resolved.userId, delta);
      };

      let untrack: () => void = () => undefined;

      untrack = track(
        authResult.binding,
        (reason) => {
          untrack();
          abort.abort(reason);
          ws.close(WS_POLICY_VIOLATION, reason);
          setTimeout(() => ws.terminate(), 1_000).unref();
        },
        settle,
      );

      ws.once("close", () => {
        settle();
        untrack();
        abort.abort("visitor closed");
        log.info("gate.stream", {
          route: "proxy",
          method: "GET",
          status: 101,
          ms: deps.now() - startedAt,
        });
      });
      opened.bind(ws);
    });
  }

  async function upgrade(
    incoming: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    meta: GateRequestMeta,
  ): Promise<void> {
    socket.on("error", () => socket.destroy());

    const hostHeader = originForHost(
      incoming.headers.host ?? "",
      config.appUrl,
    ).replace(/^[a-z]+:\/\//u, "");

    const cls = hostClass(hostHeader);

    if (cls.kind !== "tenant") {
      writeRawResponse(
        socket,
        cls.kind === "misdirected" ? 421 : 404,
        "Not found\n",
        {
          "content-type": "text/plain; charset=utf-8",
        },
      );

      return;
    }

    if (!meta.rawTarget.startsWith("/") || meta.rawTarget.startsWith("//")) {
      writeRawResponse(socket, 400, "Bad request\n", {
        "content-type": "text/plain; charset=utf-8",
      });

      return;
    }

    let url: URL;

    try {
      url = new URL(meta.rawTarget, originForHost(hostHeader, config.appUrl));
    } catch {
      writeRawResponse(socket, 400, "Bad request\n", {
        "content-type": "text/plain; charset=utf-8",
      });

      return;
    }

    if (url.pathname === "/__tunnel")
      return dial(incoming, socket, head, meta, url, cls);

    return visitorUpgrade(incoming, socket, head, meta, url, hostHeader, cls);
  }

  function sweep(): void {
    const now = deps.now();

    for (const stream of tracker.all()) {
      stream.settle();

      if (!bindingValid(stream.binding, now)) {
        stream.close(ACCESS_REVOKED_REASON);
      } else if (
        stream.binding.kind !== "anonymous" &&
        egress.isOverCap(stream.binding.userId)
      ) {
        stream.close(EGRESS_CAP_REASON);
      }
    }

    for (const [routingKey, dialed] of [...dialedTunnels]) {
      const reason = staleTunnelReason(routingKey, dialed);

      if (reason !== null) closeDialedTunnel(routingKey, reason);
    }

    pruneClientState(now);
  }

  return {
    fetch,
    upgrade,
    sweep,
    startRevocationSweep() {
      const timer = setInterval(sweep, REVOCATION_SWEEP_INTERVAL_MS);
      timer.unref();

      return () => clearInterval(timer);
    },
    revokeMachine(input) {
      const revoked = revokeMachine(
        { db, tunnels, journal, now: deps.now },
        input,
      );

      if (revoked) sweep();

      return revoked;
    },
    openStreams: () => tracker.size,
    failureBlocks: () => bearerBlocks.size,
  };
}
