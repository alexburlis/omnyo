import { randomInt } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  CONNECT_CODE_TTL_MS,
  HANDLE_MAX_LENGTH,
  SERVER_OFFLINE_AFTER_MS,
  checkLabelAvailability,
  connectCode,
  isLive,
  labelClaim,
  machine,
  machineRoutingKey,
  profile,
  resolveServerCredential,
  rowsChanged,
  server,
  sha256Hex,
  user,
} from "@omnyo/connect-db";
import type {
  ConnectDb,
  LabelAvailability,
  TunnelConnectedLookup,
} from "@omnyo/connect-db";
import { MAX_MACHINES_PER_USER, MAX_SERVERS_PER_USER } from "../contracts.js";
import {
  type LabelWriteRefusal,
  labelWriteRefusal,
  relayLabelProblem,
} from "../reserved-labels.js";
import { deviceBelongsToServer } from "../gate/resolve.js";
import { isAccountSuspended } from "../user-blocks.js";
import {
  MACHINE_CREDENTIAL_PREFIX,
  SERVER_CREDENTIAL_PREFIX,
  generateConnectCode,
  generateToken,
} from "./tokens.js";

export type AccountRevocation =
  | { kind: "machine"; id: string; userId: string }
  | {
      kind: "server";
      id: string;
      userId: string;
      credentialHash: string | null;
    };

export interface Deps {
  db: ConnectDb;
  appUrl: string;
  serverUrlTemplate: string;
  closeTunnel: (routingKey: string) => Promise<void>;
  recordRevocation: (revocation: AccountRevocation) => void;
  tunnelConnected: TunnelConnectedLookup | null;
}

export function resolveServerUrlTemplate(
  value: string | undefined,
  baseDomain: string,
): string {
  const template = value?.trim() || `https://{label}.${baseDomain}`;

  if (template.split("{label}").length !== 2) {
    throw new Error("CONNECT_SERVER_URL_TEMPLATE must contain {label} once");
  }

  const probe = "omnyo-label-probe";
  const url = new URL(template.replace("{label}", probe));

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname !== `${probe}.${baseDomain}`
  ) {
    throw new Error(
      "CONNECT_SERVER_URL_TEMPLATE must be an HTTP(S) origin under BASE_DOMAIN",
    );
  }

  return `${url.protocol}//{label}.${baseDomain}${url.port ? `:${url.port}` : ""}`;
}

export function serverUrlForLabel(label: string, template: string): string {
  return template.replace("{label}", label);
}

export function tunnelUrlForServerUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/u, "ws")}/__tunnel`;
}

type ProfileRow = typeof profile.$inferSelect;

export async function findProfile(
  db: ConnectDb,
  userId: string,
): Promise<ProfileRow | undefined> {
  return db.select().from(profile).where(eq(profile.userId, userId)).get();
}

export async function findServerByCredential(
  db: ConnectDb,
  credential: string,
): Promise<{ id: string; userId: string; createdAt: number } | undefined> {
  const resolved = await resolveServerCredential(db, credential);

  if (!resolved || (await isAccountSuspended(db, resolved.userId))) {
    return undefined;
  }

  return {
    id: resolved.server.id,
    userId: resolved.userId,
    createdAt: resolved.server.createdAt.getTime(),
  };
}

interface DeviceRow {
  machine_id: string;
  user_id: string;
  created_at: number;
  server_id: string | null;
}

function toDeviceIdentity(row: DeviceRow) {
  return {
    userId: row.user_id,
    createdAt: row.created_at,
    boundServerId: row.server_id,
  };
}

export async function devicesBelongingToServer(
  db: ConnectDb,
  srv: { id: string; userId: string; createdAt: Date },
): Promise<string[]> {
  const rows = await db.all<DeviceRow>(
    sql`SELECT m.id AS machine_id, m.user_id AS user_id, m.created_at AS created_at, b.server_id AS server_id FROM machine m LEFT JOIN relay_machine_server b ON b.machine_id = m.id WHERE m.user_id = ${srv.userId} AND m.revoked_at IS NULL`,
  );

  return rows
    .filter((row) =>
      deviceBelongsToServer(toDeviceIdentity(row), {
        serverId: srv.id,
        userId: srv.userId,
        createdAt: srv.createdAt.getTime(),
      }),
    )
    .map((row) => row.machine_id);
}

async function insertConnectCode(
  db: ConnectDb,
  {
    userId,
    serverId,
    purpose,
  }: {
    userId: string;
    serverId: string;
    purpose: "server-pair" | "machine-pair";
  },
): Promise<string> {
  const code = generateConnectCode();
  const now = new Date();
  await db
    .insert(connectCode)
    .values({
      code,
      userId,
      serverId,
      purpose,
      expiresAt: new Date(now.getTime() + CONNECT_CODE_TTL_MS),
      createdAt: now,
    })
    .run();

  return code;
}

async function hasMachineCapacity(
  db: ConnectDb,
  userId: string,
): Promise<boolean> {
  const active = await db
    .select({ id: machine.id })
    .from(machine)
    .where(and(eq(machine.userId, userId), isNull(machine.revokedAt)))
    .all();

  return active.length < MAX_MACHINES_PER_USER;
}

export const MAX_PENDING_MACHINE_CODES = MAX_MACHINES_PER_USER;

export const MAX_DEVICE_PAIRINGS_PER_DAY = 50;

export const MAX_DEVICE_PAIRINGS_PER_SERVER_PER_DAY = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

async function hasPairingAllowance(
  db: ConnectDb,
  userId: string,
): Promise<boolean> {
  const pairedToday = await db
    .select({ id: machine.id })
    .from(machine)
    .where(
      and(
        eq(machine.userId, userId),
        gt(machine.createdAt, new Date(Date.now() - DAY_MS)),
      ),
    )
    .limit(MAX_DEVICE_PAIRINGS_PER_DAY)
    .all();

  return pairedToday.length < MAX_DEVICE_PAIRINGS_PER_DAY;
}

async function serverHasPairingAllowance(
  db: ConnectDb,
  serverId: string,
): Promise<boolean> {
  const since = Date.now() - DAY_MS;

  const row = await db.get<{ pairings: number }>(
    sql`SELECT (SELECT COUNT(*) FROM relay_machine_server WHERE server_id = ${serverId} AND created_at > ${since}) + (SELECT COUNT(*) FROM connect_code WHERE server_id = ${serverId} AND purpose = 'machine-pair' AND consumed_at IS NULL AND expires_at > ${Date.now()}) AS pairings`,
  );

  return row.pairings < MAX_DEVICE_PAIRINGS_PER_SERVER_PER_DAY;
}

async function hasMachineCodeCapacity(
  db: ConnectDb,
  userId: string,
): Promise<boolean> {
  const pending = await db
    .select({ code: connectCode.code })
    .from(connectCode)
    .where(
      and(
        eq(connectCode.userId, userId),
        eq(connectCode.purpose, "machine-pair"),
        isNull(connectCode.consumedAt),
        gt(connectCode.expiresAt, new Date()),
      ),
    )
    .all();

  return pending.length < MAX_PENDING_MACHINE_CODES;
}

async function machineWithinLimit(
  db: ConnectDb,
  userId: string,
  machineId: string,
): Promise<boolean> {
  const row = await db.get<{ position: number }>(
    sql`SELECT COUNT(*) AS position FROM machine WHERE user_id = ${userId} AND revoked_at IS NULL AND rowid <= (SELECT rowid FROM machine WHERE id = ${machineId})`,
  );

  return row.position <= MAX_MACHINES_PER_USER;
}

async function consumeConnectCode(
  db: ConnectDb,
  code: string,
): Promise<boolean> {
  const consumed = await db
    .update(connectCode)
    .set({ consumedAt: new Date() })
    .where(and(eq(connectCode.code, code), isNull(connectCode.consumedAt)))
    .run();

  return rowsChanged(consumed) > 0;
}

type ConnectApiResult =
  | Awaited<ReturnType<typeof redeemConnectCode>>
  | Awaited<ReturnType<typeof redeemMachineCode>>
  | Awaited<ReturnType<typeof createMachineCodeForServerCredential>>
  | Awaited<ReturnType<typeof revokeMachineForServerCredential>>;

export function connectApiResponse(result: ConnectApiResult): Response {
  return "status" in result
    ? Response.json({ error: result.error }, { status: result.status })
    : Response.json(result);
}

export interface ServerSummary {
  id: string;
  subdomain: string;
  name: string;
  isPrimary: boolean;
  connected: boolean;
  online: boolean;
  lastSeenAt: number | null;
  version: string | null;
  createdAt: number;
  serverUrl: string;
}

export interface AccountState {
  handle: string | null;
  suggestedHandle: string | null;
  servers: ServerSummary[];
  appUrl: string;
  serverUrlTemplate: string;
  githubLogin: string | null;
  maxServers: number;
  machines: MachineSummary[];
}

export interface MachineSummary {
  id: string;
  name: string | null;
  subdomain: string | null;
  online: boolean;
  lastSeenAt: number | null;
  createdAt: number;
}

type ServerRow = typeof server.$inferSelect;

export function toServerSummary(
  srv: ServerRow,
  handle: string,
  serverUrlTemplate: string,
  now: number,
  tunnelConnected: boolean | null,
): ServerSummary {
  const lastSeenMs = srv.lastSeenAt?.getTime() ?? null;
  const connected = srv.credentialHash != null && srv.revokedAt == null;

  return {
    id: srv.id,
    subdomain: srv.subdomain,
    name: srv.name,
    isPrimary: srv.subdomain === handle,
    connected,
    online:
      connected &&
      isLive({
        lastSeenMs,
        now,
        offlineAfterMs: SERVER_OFFLINE_AFTER_MS,
        tunnelConnected,
      }),
    lastSeenAt: lastSeenMs,
    version: srv.version,
    createdAt: srv.createdAt.getTime(),
    serverUrl: serverUrlForLabel(srv.subdomain, serverUrlTemplate),
  };
}

export async function listServerSummaries(
  deps: Pick<Deps, "serverUrlTemplate" | "tunnelConnected">,
  rows: readonly ServerRow[],
  handle: string,
  now: number,
): Promise<ServerSummary[]> {
  const lookup = deps.tunnelConnected;

  const summaries = await Promise.all(
    rows.map(async (srv) =>
      toServerSummary(
        srv,
        handle,
        deps.serverUrlTemplate,
        now,
        lookup !== null && srv.credentialHash != null && srv.revokedAt == null
          ? await lookup(srv.subdomain)
          : null,
      ),
    ),
  );

  return summaries.sort((a, b) =>
    a.isPrimary !== b.isPrimary
      ? a.isPrimary
        ? -1
        : 1
      : a.createdAt - b.createdAt,
  );
}

async function resolveServer(
  db: ConnectDb,
  userId: string,
  serverId: string | undefined,
): Promise<ServerRow | undefined> {
  if (serverId) {
    return db
      .select()
      .from(server)
      .where(and(eq(server.id, serverId), eq(server.userId, userId)))
      .get();
  }

  const prof = await findProfile(db, userId);

  if (!prof) return undefined;

  const primary = await db
    .select()
    .from(server)
    .where(and(eq(server.userId, userId), eq(server.subdomain, prof.handle)))
    .get();

  if (primary) return primary;

  const all = await db
    .select()
    .from(server)
    .where(eq(server.userId, userId))
    .all();

  return [...all].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];
}

export async function getAccountState(
  deps: Deps,
  userId: string,
): Promise<AccountState> {
  const { db, serverUrlTemplate } = deps;
  await retryPendingMachineRevocations(deps, userId);
  const prof = await findProfile(db, userId);

  const userRow = await db
    .select({ githubLogin: user.githubLogin })
    .from(user)
    .where(eq(user.id, userId))
    .get();

  const now = Date.now();

  const base = {
    appUrl: deps.appUrl,
    serverUrlTemplate,
    githubLogin: userRow?.githubLogin ?? null,
    maxServers: MAX_SERVERS_PER_USER,
  };

  const machineRows = await db
    .select({
      id: machine.id,
      name: machine.name,
      subdomain: machine.subdomain,
      lastSeenAt: machine.lastSeenAt,
      createdAt: machine.createdAt,
    })
    .from(machine)
    .where(and(eq(machine.userId, userId), isNull(machine.revokedAt)))
    .all();

  const machineTunnels = await machineTunnelsConnected(deps, userId);

  const machines = machineRows
    .map((row) => {
      const lastSeenMs = row.lastSeenAt?.getTime() ?? null;

      return {
        id: row.id,
        name: row.name,
        subdomain: row.subdomain,
        online:
          machineTunnels.get(row.id) === true ||
          isLive({
            lastSeenMs,
            now,
            offlineAfterMs: SERVER_OFFLINE_AFTER_MS,
            tunnelConnected: null,
          }),
        lastSeenAt: lastSeenMs,
        createdAt: row.createdAt.getTime(),
      };
    })
    .sort((left, right) => left.createdAt - right.createdAt);

  if (!prof) {
    return {
      handle: null,
      suggestedHandle: await suggestAvailableHandle(
        db,
        base.githubLogin,
        userId,
      ),
      machines,
      servers: [],
      ...base,
    };
  }

  const serverRows = await db
    .select()
    .from(server)
    .where(eq(server.userId, userId))
    .all();

  const servers = await listServerSummaries(deps, serverRows, prof.handle, now);

  return {
    handle: prof.handle,
    suggestedHandle: null,
    machines,
    servers,
    ...base,
  };
}

async function machineTunnelsConnected(
  deps: Pick<Deps, "db" | "tunnelConnected">,
  userId: string,
): Promise<Map<string, boolean | null>> {
  const lookup = deps.tunnelConnected;

  if (lookup === null) return new Map();

  const claims = await deps.db
    .select({
      machineId: labelClaim.ownerId,
      label: labelClaim.label,
      generation: labelClaim.generation,
    })
    .from(labelClaim)
    .where(and(eq(labelClaim.userId, userId), eq(labelClaim.kind, "machine")))
    .all();

  return new Map(
    await Promise.all(
      claims.map(
        async (claim) =>
          [
            claim.machineId,
            await lookup(machineRoutingKey(claim.label, claim.generation)),
          ] as const,
      ),
    ),
  );
}

export async function revokeMachine(
  deps: Pick<Deps, "db" | "closeTunnel" | "recordRevocation">,
  userId: string,
  machineId: string,
): Promise<{ ok: true } | { error: "not-found" | "tunnel-close-failed" }> {
  const existing = await deps.db
    .select({ id: machine.id, revokedAt: machine.revokedAt })
    .from(machine)
    .where(and(eq(machine.id, machineId), eq(machine.userId, userId)))
    .get();

  if (!existing) return { error: "not-found" };

  const newlyRevoked = await deps.db
    .update(machine)
    .set({ revokedAt: existing.revokedAt ?? new Date() })
    .where(
      and(
        eq(machine.id, machineId),
        eq(machine.userId, userId),
        isNull(machine.revokedAt),
      ),
    )
    .returning({ id: machine.id })
    .get();

  if (newlyRevoked !== undefined) {
    deps.recordRevocation({ kind: "machine", id: machineId, userId });
  }

  const claim = await deps.db
    .select()
    .from(labelClaim)
    .where(
      and(eq(labelClaim.kind, "machine"), eq(labelClaim.ownerId, machineId)),
    )
    .get();

  if (claim) {
    try {
      await deps.closeTunnel(machineRoutingKey(claim.label, claim.generation));
    } catch {
      return { error: "tunnel-close-failed" };
    }
  }

  await deps.db
    .update(machine)
    .set({ subdomain: null })
    .where(and(eq(machine.id, machineId), eq(machine.userId, userId)))
    .run();

  return { ok: true };
}

async function retryPendingMachineRevocations(
  deps: Pick<Deps, "db" | "closeTunnel" | "recordRevocation">,
  userId: string,
): Promise<void> {
  const pending = await deps.db
    .select({ id: machine.id })
    .from(machine)
    .where(
      and(
        eq(machine.userId, userId),
        isNotNull(machine.revokedAt),
        isNotNull(machine.subdomain),
      ),
    )
    .all();

  for (const row of pending) {
    await revokeMachine(deps, userId, row.id);
  }
}

const NAMESPACE_FOR_KIND: Readonly<
  Record<string, "handle" | "subdomain" | "machine">
> = { handle: "handle", server: "subdomain", machine: "machine" };

async function retiredLabelFor(
  db: ConnectDb,
  label: string,
  claimant: string | null,
): Promise<{ kind: string } | undefined> {
  const retired = await db.get<
    { kind: string; github_id: string | null; user_id: string } | undefined
  >(
    sql`SELECT kind, github_id, user_id FROM relay_retired_label WHERE label = ${label}`,
  );

  if (retired === undefined) return undefined;

  if (claimant !== null && retired.user_id === claimant) return undefined;

  if (claimant !== null && retired.github_id !== null) {
    const owned = await db.get<{ matched: number } | undefined>(
      sql`SELECT 1 AS matched FROM account WHERE user_id = ${claimant} AND provider_id = 'github' AND account_id = ${retired.github_id}`,
    );

    if (owned !== undefined) return undefined;
  }

  return { kind: retired.kind };
}

export async function wasLabelRetired(
  db: ConnectDb,
  label: string,
): Promise<boolean> {
  return (await retiredLabelFor(db, label, null)) !== undefined;
}

async function checkRelayLabelAvailability(
  db: ConnectDb,
  rawLabel: string,
  claimant: string | null,
): Promise<LabelAvailability> {
  const availability = await checkLabelAvailability(db, rawLabel);

  if (!availability.available) return availability;
  const problem = relayLabelProblem(availability.label);

  if (problem !== null) {
    return { available: false, reason: "invalid", error: problem };
  }

  const retired = await retiredLabelFor(db, availability.label, claimant);

  if (retired !== undefined) {
    return {
      available: false,
      reason: "taken",
      namespace: NAMESPACE_FOR_KIND[retired.kind] ?? "subdomain",
    };
  }

  return availability;
}

export async function checkAvailability(
  deps: Deps,
  rawLabel: string,
  claimant: string | null = null,
): Promise<LabelAvailability> {
  return checkRelayLabelAvailability(deps.db, rawLabel, claimant);
}

function refusedLabelWrite(error: unknown): LabelWriteRefusal {
  const refusal = labelWriteRefusal(error);

  if (refusal === null) throw error;

  return refusal;
}

export function labelSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function fitLabel(value: string): string {
  return value.slice(0, HANDLE_MAX_LENGTH).replace(/-+$/u, "");
}

const GENERATED_SUFFIX_LENGTH = 4;

const GENERATED_ATTEMPTS_PER_STEM = 3;

function generatedSuffix(): string {
  return randomInt(36 ** GENERATED_SUFFIX_LENGTH)
    .toString(36)
    .padStart(GENERATED_SUFFIX_LENGTH, "0");
}

export async function suggestAvailableLabel(
  db: ConnectDb,
  desired: string,
  claimant: string | null,
  fallbackStems: readonly string[],
): Promise<string> {
  const exact = fitLabel(desired);

  if (exact !== "") {
    const availability = await checkRelayLabelAvailability(db, exact, claimant);

    if (availability.available) return availability.label;
  }

  const stemLength = HANDLE_MAX_LENGTH - GENERATED_SUFFIX_LENGTH - 1;

  const stems = [desired, ...fallbackStems].map((stem) =>
    fitLabel(stem.slice(0, stemLength)),
  );

  for (const stem of stems) {
    if (stem === "") continue;

    for (let attempt = 0; attempt < GENERATED_ATTEMPTS_PER_STEM; attempt += 1) {
      const availability = await checkRelayLabelAvailability(
        db,
        `${stem}-${generatedSuffix()}`,
        claimant,
      );

      if (availability.available) return availability.label;
    }
  }

  return "";
}

export async function suggestAvailableHandle(
  db: ConnectDb,
  githubLogin: string | null,
  claimant: string | null = null,
): Promise<string> {
  const slug = githubLogin === null ? "" : labelSlug(githubLogin);

  return suggestAvailableLabel(db, slug, claimant, ["member"]);
}

type ClaimError =
  | "already-claimed"
  | "taken"
  | "label-limit"
  | "too-short"
  | "too-long"
  | "invalid-format"
  | "reserved";

export async function claimHandle(
  deps: Deps,
  userId: string,
  rawHandle: string,
): Promise<{ ok: true; handle: string } | { error: ClaimError }> {
  const { db } = deps;
  const existing = await findProfile(db, userId);

  if (existing) return { error: "already-claimed" };

  const avail = await checkRelayLabelAvailability(db, rawHandle, userId);

  if (!avail.available) {
    return { error: avail.reason === "invalid" ? avail.error : "taken" };
  }

  const handle = avail.label;

  const now = new Date();

  try {
    await db.insert(profile).values({ userId, handle, createdAt: now }).run();
  } catch (error) {
    return { error: refusedLabelWrite(error) };
  }

  try {
    await db
      .insert(server)
      .values({
        id: crypto.randomUUID(),
        userId,
        name: "default",
        subdomain: handle,
        createdAt: now,
      })
      .run();
  } catch (error) {
    await db
      .delete(profile)
      .where(and(eq(profile.userId, userId), eq(profile.handle, handle)))
      .run();

    return { error: refusedLabelWrite(error) };
  }

  return { ok: true, handle };
}

export type CreateServerError =
  | "no-handle"
  | "server-limit"
  | "taken"
  | "label-retired"
  | ClaimError;

export async function createServer(
  deps: Deps,
  userId: string,
  rawLabel: string,
  options: { reclaimRetired: boolean } = { reclaimRetired: true },
): Promise<{ ok: true; server: ServerSummary } | { error: CreateServerError }> {
  const { db, serverUrlTemplate } = deps;
  const prof = await findProfile(db, userId);

  if (!prof) return { error: "no-handle" };

  const owned = await db
    .select()
    .from(server)
    .where(eq(server.userId, userId))
    .all();

  if (owned.length >= MAX_SERVERS_PER_USER) return { error: "server-limit" };

  const avail = await checkRelayLabelAvailability(db, rawLabel, userId);

  if (!avail.available) {
    return { error: avail.reason === "invalid" ? avail.error : "taken" };
  }

  const label = avail.label;

  if (!options.reclaimRetired && (await wasLabelRetired(db, label))) {
    return { error: "label-retired" };
  }

  const now = new Date();
  const id = crypto.randomUUID();

  try {
    await db
      .insert(server)
      .values({ id, userId, name: label, subdomain: label, createdAt: now })
      .run();
  } catch (error) {
    return { error: refusedLabelWrite(error) };
  }

  const afterCount = await db
    .select()
    .from(server)
    .where(eq(server.userId, userId))
    .all();

  if (afterCount.length > MAX_SERVERS_PER_USER) {
    await db.delete(server).where(eq(server.id, id)).run();

    return { error: "server-limit" };
  }

  const created = await db.select().from(server).where(eq(server.id, id)).get();

  if (!created) {
    return { error: "taken" };
  }

  return {
    ok: true,
    server: toServerSummary(
      created,
      prof.handle,
      serverUrlTemplate,
      Date.now(),
      null,
    ),
  };
}

export interface IssuedCode {
  code: string;
  expiresInMs: number;
  serverUrl: string;
  serverId: string;
  replacesConnectedServer: boolean;
  takesOverDevices: number;
}

export async function createConnectCode(
  deps: Deps,
  userId: string,
  opts: { serverId?: string; reuse?: boolean } = {},
): Promise<IssuedCode | { error: string }> {
  const { db, serverUrlTemplate } = deps;
  const srv = await resolveServer(db, userId, opts.serverId);

  if (!srv) return { error: "no-server" };
  const serverUrl = serverUrlForLabel(srv.subdomain, serverUrlTemplate);
  const now = Date.now();

  const replacesConnectedServer =
    srv.credentialHash !== null && srv.revokedAt === null;

  const takesOverDevices = (await devicesBelongingToServer(db, srv)).length;

  if (opts.reuse) {
    const open = await db
      .select()
      .from(connectCode)
      .where(
        and(
          eq(connectCode.serverId, srv.id),
          eq(connectCode.purpose, "server-pair"),
          isNull(connectCode.consumedAt),
        ),
      )
      .all();

    const valid = open
      .filter((c) => c.expiresAt.getTime() > now)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

    if (valid) {
      return {
        code: valid.code,
        expiresInMs: valid.expiresAt.getTime() - now,
        serverUrl,
        serverId: srv.id,
        replacesConnectedServer,
        takesOverDevices,
      };
    }
  }

  const code = await insertConnectCode(db, {
    userId,
    serverId: srv.id,
    purpose: "server-pair",
  });

  return {
    code,
    expiresInMs: CONNECT_CODE_TTL_MS,
    serverUrl,
    serverId: srv.id,
    replacesConnectedServer,
    takesOverDevices,
  };
}

async function createMachineCode(
  deps: Deps,
  userId: string,
  serverId?: string,
): Promise<
  { code: string; expiresInMs: number; serverUrl: string } | { error: string }
> {
  const { db, serverUrlTemplate } = deps;

  if (await isAccountSuspended(db, userId)) return { error: "no-server" };
  const prof = await findProfile(db, userId);

  if (!prof) return { error: "no-handle" };

  const srv = await resolveServer(db, userId, serverId);

  if (!srv) return { error: "no-server" };

  if (!(await hasMachineCapacity(db, userId))) {
    return { error: "machine-limit" };
  }

  if (!(await hasMachineCodeCapacity(db, userId))) {
    return { error: "too-many-codes" };
  }

  if (
    !(await hasPairingAllowance(db, userId)) ||
    !(await serverHasPairingAllowance(db, srv.id))
  ) {
    return { error: "pairing-limit" };
  }

  const code = await insertConnectCode(db, {
    userId,
    serverId: srv.id,
    purpose: "machine-pair",
  });

  return {
    code,
    expiresInMs: CONNECT_CODE_TTL_MS,
    serverUrl: serverUrlForLabel(srv.subdomain, serverUrlTemplate),
  };
}

export async function createMachineCodeForServerCredential(
  deps: Deps,
  credential: string,
): Promise<
  | { code: string; expiresInMs: number; serverUrl: string }
  | { error: string; status: number }
> {
  const srv = await findServerByCredential(deps.db, credential);

  if (!srv) return { error: "unauthorized", status: 401 };

  return createMachineCodeForServer(deps, srv);
}

export async function createMachineCodeForServer(
  deps: Deps,
  srv: { id: string; userId: string },
): Promise<
  | { code: string; expiresInMs: number; serverUrl: string }
  | { error: string; status: number }
> {
  const result = await createMachineCode(deps, srv.userId, srv.id);

  if ("error" in result) {
    return {
      error: result.error,
      status:
        result.error === "machine-limit"
          ? 409
          : result.error === "too-many-codes" ||
              result.error === "pairing-limit"
            ? 429
            : 404,
    };
  }

  return result;
}

export async function listMachinesForServerCredential(
  deps: Pick<Deps, "db">,
  credential: string,
): Promise<
  | {
      devices: {
        id: string;
        name: string | null;
        lastSeenAt: number | null;
        createdAt: number;
      }[];
    }
  | { error: string; status: number }
> {
  const owner = await findServerByCredential(deps.db, credential);

  if (!owner) return { error: "unauthorized", status: 401 };

  const devices = await deps.db.all<{
    id: string;
    name: string | null;
    lastSeenAt: number | null;
    createdAt: number;
  }>(sql`SELECT m.id, m.name, m.last_seen_at AS lastSeenAt, m.created_at AS createdAt
    FROM machine m LEFT JOIN relay_machine_server b ON b.machine_id = m.id
    WHERE m.user_id = ${owner.userId} AND m.revoked_at IS NULL
      AND (b.server_id = ${owner.id} OR (b.server_id IS NULL AND m.created_at >= ${owner.createdAt}))
    ORDER BY m.created_at, m.id`);

  return { devices };
}

export async function revokeMachineForServerCredential(
  deps: Pick<Deps, "db" | "closeTunnel" | "recordRevocation">,
  credential: string,
  machineId: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const srv = await findServerByCredential(deps.db, credential);

  if (!srv) return { error: "unauthorized", status: 401 };

  const device = await deps.db.get<DeviceRow | undefined>(
    sql`SELECT m.id AS machine_id, m.user_id AS user_id, m.created_at AS created_at, b.server_id AS server_id FROM machine m LEFT JOIN relay_machine_server b ON b.machine_id = m.id WHERE m.id = ${machineId} LIMIT 1`,
  );

  if (
    device === undefined ||
    !deviceBelongsToServer(toDeviceIdentity(device), {
      serverId: srv.id,
      userId: srv.userId,
      createdAt: srv.createdAt,
    })
  ) {
    return { error: "not-found", status: 404 };
  }

  const result = await revokeMachine(deps, srv.userId, machineId);

  return "error" in result
    ? {
        error: result.error,
        status: result.error === "tunnel-close-failed" ? 503 : 404,
      }
    : result;
}

export async function denyOutstandingLinkApprovals(
  db: ConnectDb,
  serverId: string,
  now: Date,
  exceptCode: string | null,
): Promise<void> {
  await db
    .update(connectCode)
    .set({ deniedAt: now })
    .where(
      and(
        eq(connectCode.purpose, "server-link"),
        eq(connectCode.serverId, serverId),
        isNotNull(connectCode.approvedAt),
        isNull(connectCode.consumedAt),
        isNull(connectCode.deniedAt),
        ...(exceptCode === null ? [] : [ne(connectCode.code, exceptCode)]),
      ),
    )
    .run();
}

export async function disconnectServer(
  deps: Deps,
  userId: string,
  serverId: string,
): Promise<{ ok: true } | { error: string }> {
  const { db } = deps;

  const srv = await db
    .select()
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.userId, userId)))
    .get();

  if (!srv) return { error: "not-found" };

  const now = new Date();
  await db
    .update(server)
    .set({ credentialHash: null, revokedAt: now })
    .where(eq(server.id, srv.id))
    .run();

  if (srv.revokedAt == null) {
    deps.recordRevocation({
      kind: "server",
      id: srv.id,
      userId,
      credentialHash: srv.credentialHash,
    });
  }

  await denyOutstandingLinkApprovals(db, srv.id, now, null);

  try {
    await deps.closeTunnel(srv.subdomain);
  } catch {}

  return { ok: true };
}

export async function removeServer(
  deps: Deps,
  userId: string,
  serverId: string,
): Promise<{ ok: true } | { error: string }> {
  const { db } = deps;
  const prof = await findProfile(db, userId);

  const srv = await db
    .select()
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.userId, userId)))
    .get();

  if (!srv) return { error: "not-found" };

  if (prof && srv.subdomain === prof.handle) return { error: "is-primary" };

  if (srv.credentialHash != null && srv.revokedAt == null) {
    return { error: "connected" };
  }

  const bound = await db.all<{ machine_id: string }>(
    sql`SELECT b.machine_id AS machine_id FROM relay_machine_server b JOIN machine m ON m.id = b.machine_id WHERE b.server_id = ${srv.id} AND m.revoked_at IS NULL`,
  );

  for (const row of bound) await revokeMachine(deps, userId, row.machine_id);

  await db.delete(server).where(eq(server.id, srv.id)).run();

  return { ok: true };
}

export async function redeemConnectCode(
  deps: Pick<Deps, "db" | "serverUrlTemplate">,
  code: string,
): Promise<
  | {
      credential: string;
      serverId: string;
      handle: string | null;
      tunnelUrl: string | null;
    }
  | { error: string; status: number }
> {
  const { db, serverUrlTemplate } = deps;
  const normalized = code.trim().toUpperCase();

  if (!normalized) return { error: "missing-code", status: 400 };

  const row = await db
    .select()
    .from(connectCode)
    .where(eq(connectCode.code, normalized))
    .get();

  if (
    !row ||
    row.serverId == null ||
    row.purpose !== "server-pair" ||
    (row.userId !== null && (await isAccountSuspended(db, row.userId)))
  )
    return { error: "invalid-code", status: 404 };

  if (row.consumedAt != null) return { error: "already-used", status: 409 };

  if (row.expiresAt.getTime() < Date.now())
    return { error: "expired", status: 410 };

  if (!(await consumeConnectCode(db, normalized)))
    return { error: "already-used", status: 409 };

  const minted = await mintServerCredential(db, row.serverId);
  const handle = minted.server?.subdomain ?? null;

  const serverUrl = handle
    ? serverUrlForLabel(handle, serverUrlTemplate)
    : null;

  return {
    credential: minted.credential,
    serverId: row.serverId,
    handle,
    tunnelUrl: serverUrl ? tunnelUrlForServerUrl(serverUrl) : null,
  };
}

async function mintServerCredential(
  db: ConnectDb,
  serverId: string,
): Promise<{ credential: string; server: ServerRow | undefined }> {
  const credential = generateToken(SERVER_CREDENTIAL_PREFIX);
  await db
    .update(server)
    .set({ credentialHash: await sha256Hex(credential), revokedAt: null })
    .where(eq(server.id, serverId))
    .run();
  await denyOutstandingLinkApprovals(db, serverId, new Date(), null);

  const minted = await db
    .select()
    .from(server)
    .where(eq(server.id, serverId))
    .get();

  return { credential, server: minted };
}

async function machineIdForCode(userId: string, code: string): Promise<string> {
  const hash = await sha256Hex(JSON.stringify([userId, code]));

  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export async function lookupMachineCodeForServerCredential(
  deps: Pick<Deps, "db">,
  credential: string,
  code: string,
): Promise<
  | { consumed: boolean; machineId: string | null }
  | { error: string; status: number }
> {
  const srv = await findServerByCredential(deps.db, credential);

  if (!srv) return { error: "unauthorized", status: 401 };

  const row = await deps.db
    .select()
    .from(connectCode)
    .where(
      and(
        eq(connectCode.code, code.trim().toUpperCase()),
        eq(connectCode.serverId, srv.id),
        eq(connectCode.userId, srv.userId),
        eq(connectCode.purpose, "machine-pair"),
      ),
    )
    .get();

  if (!row || row.userId === null)
    return { error: "invalid-code", status: 404 };

  const device = await deps.db
    .select({ id: machine.id })
    .from(machine)
    .where(
      and(
        eq(machine.id, await machineIdForCode(row.userId, row.code)),
        eq(machine.userId, srv.userId),
      ),
    )
    .get();

  return { consumed: row.consumedAt !== null, machineId: device?.id ?? null };
}

export async function redeemMachineCode(
  deps: Pick<Deps, "db" | "serverUrlTemplate">,
  code: string,
  deviceName: string | null,
): Promise<
  | {
      credential: string;
      machineId: string;
      handle: string | null;
      serverUrl: string | null;
    }
  | { error: string; status: number }
> {
  const { db, serverUrlTemplate } = deps;
  const normalized = code.trim().toUpperCase();

  if (!normalized) return { error: "missing-code", status: 400 };

  const row = await db
    .select()
    .from(connectCode)
    .where(eq(connectCode.code, normalized))
    .get();

  if (
    !row ||
    row.purpose !== "machine-pair" ||
    row.userId === null ||
    (await isAccountSuspended(db, row.userId))
  )
    return { error: "invalid-code", status: 404 };
  const ownerId = row.userId;

  if (row.consumedAt != null) return { error: "already-used", status: 409 };

  if (row.expiresAt.getTime() < Date.now())
    return { error: "expired", status: 410 };

  if (!(await hasMachineCapacity(db, ownerId))) {
    return { error: "machine-limit", status: 409 };
  }

  if (!(await consumeConnectCode(db, normalized)))
    return { error: "already-used", status: 409 };

  const credential = generateToken(MACHINE_CREDENTIAL_PREFIX);
  const machineId = await machineIdForCode(ownerId, normalized);
  const credentialHash = await sha256Hex(credential);
  const createdAt = new Date();
  await db
    .insert(machine)
    .values({
      id: machineId,
      name: deviceName,
      userId: ownerId,
      credentialHash,
      createdAt,
    })
    .run();

  try {
    if (row.serverId != null) {
      await db.run(
        sql`INSERT INTO relay_machine_server (machine_id, server_id, created_at) VALUES (${machineId}, ${row.serverId}, ${createdAt.getTime()})`,
      );
    }
  } catch (error) {
    await db.delete(machine).where(eq(machine.id, machineId)).run();
    throw error;
  }

  if (!(await machineWithinLimit(db, ownerId, machineId))) {
    await db.delete(machine).where(eq(machine.id, machineId)).run();

    return { error: "machine-limit", status: 409 };
  }

  const prof = await findProfile(db, ownerId);

  const targetServer =
    row.serverId == null
      ? null
      : await db.select().from(server).where(eq(server.id, row.serverId)).get();

  const label = targetServer?.subdomain ?? prof?.handle ?? null;

  return {
    credential,
    machineId,
    handle: prof?.handle ?? null,
    serverUrl: label ? serverUrlForLabel(label, serverUrlTemplate) : null,
  };
}
