import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  labelClaim,
  machine,
  machineRoutingKey,
  profile,
  server,
} from "@omnyo/connect-db";
import type { TunnelOwner } from "../contracts.js";
import type { RelayDb } from "../db.js";
import { sha256HexOf } from "./signed-token.js";
import { isUserBlocked } from "../user-blocks.js";

export interface ResolvedServerLabel {
  kind: "server";
  label: string;
  routingKey: string;
  userId: string;
  owner: Extract<TunnelOwner, { kind: "server" }>;
  createdAt: number;
  credentialHash: string | null;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
}

export interface ResolvedMachineLabel {
  kind: "machine";
  label: string;
  routingKey: string;
  userId: string;
  accountHandle: string;
  owner: Extract<TunnelOwner, { kind: "machine" }>;
  credentialHash: string;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
}

export type ResolvedLabel = ResolvedServerLabel | ResolvedMachineLabel;

export function resolveLabel(db: RelayDb, label: string): ResolvedLabel | null {
  const resolved = resolveLabelOwner(db, label);

  return resolved !== null && isUserBlocked(db, resolved.userId)
    ? null
    : resolved;
}

function resolveLabelOwner(db: RelayDb, label: string): ResolvedLabel | null {
  const serverRow = db
    .select({
      id: server.id,
      userId: server.userId,
      createdAt: server.createdAt,
      credentialHash: server.credentialHash,
      revokedAt: server.revokedAt,
      lastSeenAt: server.lastSeenAt,
    })
    .from(server)
    .where(eq(server.subdomain, label))
    .get();

  if (serverRow !== undefined) {
    return {
      kind: "server",
      label,
      routingKey: label,
      userId: serverRow.userId,
      owner: { kind: "server", serverId: serverRow.id },
      createdAt: serverRow.createdAt.getTime(),
      credentialHash: serverRow.credentialHash,
      revokedAt: serverRow.revokedAt,
      lastSeenAt: serverRow.lastSeenAt,
    };
  }

  const machineRow = db
    .select({
      id: machine.id,
      userId: machine.userId,
      accountHandle: profile.handle,
      credentialHash: machine.credentialHash,
      revokedAt: machine.revokedAt,
      lastSeenAt: machine.lastSeenAt,
      generation: labelClaim.generation,
    })
    .from(machine)
    .innerJoin(profile, eq(profile.userId, machine.userId))
    .innerJoin(
      labelClaim,
      and(
        eq(labelClaim.label, machine.subdomain),
        eq(labelClaim.kind, "machine"),
        eq(labelClaim.ownerId, machine.id),
      ),
    )
    .where(eq(machine.subdomain, label))
    .get();

  if (machineRow === undefined) return null;

  return {
    kind: "machine",
    label,
    routingKey: machineRoutingKey(label, machineRow.generation),
    userId: machineRow.userId,
    accountHandle: machineRow.accountHandle,
    owner: { kind: "machine", machineId: machineRow.id },
    credentialHash: machineRow.credentialHash,
    revokedAt: machineRow.revokedAt,
    lastSeenAt: machineRow.lastSeenAt,
  };
}

export function labelOwnerUserId(db: RelayDb, label: string): string | null {
  return resolveLabel(db, label)?.userId ?? null;
}

export function pairedCredentialHash(resolved: ResolvedLabel): string | null {
  return resolved.revokedAt === null ? resolved.credentialHash : null;
}

export function sameTunnelOwner(
  left: TunnelOwner,
  right: TunnelOwner,
): boolean {
  if (left.kind === "server")
    return right.kind === "server" && right.serverId === left.serverId;

  return right.kind === "machine" && right.machineId === left.machineId;
}

export interface DeviceIdentity {
  userId: string;
  createdAt: number;
  boundServerId: string | null;
}

export interface ServerIdentity {
  serverId: string;
  userId: string;
  createdAt: number;
}

export function deviceBelongsToServer(
  device: DeviceIdentity,
  owner: ServerIdentity,
): boolean {
  if (device.userId !== owner.userId) return false;

  if (device.boundServerId !== null) {
    return device.boundServerId === owner.serverId;
  }

  return owner.createdAt <= device.createdAt;
}

export function machineMayUseLabel(
  resolved: ResolvedLabel,
  verified: Pick<
    VerifiedMachine,
    "machineId" | "userId" | "createdAt" | "boundServerId"
  >,
): boolean {
  if (verified.userId !== resolved.userId) return false;

  if (resolved.kind === "server") {
    return deviceBelongsToServer(verified, {
      serverId: resolved.owner.serverId,
      userId: resolved.userId,
      createdAt: resolved.createdAt,
    });
  }

  return (
    verified.boundServerId === null ||
    resolved.owner.machineId === verified.machineId
  );
}

export function machineBelongsToServer(
  db: RelayDb,
  machineId: string,
  owner: ServerIdentity,
): boolean {
  const row = db.get<
    | { user_id: string; created_at: number; server_id: string | null }
    | undefined
  >(
    sql`SELECT m.user_id AS user_id, m.created_at AS created_at, b.server_id AS server_id FROM machine m LEFT JOIN relay_machine_server b ON b.machine_id = m.id WHERE m.id = ${machineId} LIMIT 1`,
  );

  return (
    row !== undefined &&
    deviceBelongsToServer(
      {
        userId: row.user_id,
        createdAt: row.created_at,
        boundServerId: row.server_id,
      },
      owner,
    )
  );
}

export function serverMayUseLabel(
  db: RelayDb,
  resolved: ResolvedLabel,
  verified: Pick<VerifiedServer, "serverId" | "userId" | "createdAt">,
): boolean {
  if (verified.userId !== resolved.userId) return false;

  return resolved.kind === "server"
    ? resolved.owner.serverId === verified.serverId
    : machineBelongsToServer(db, resolved.owner.machineId, verified);
}

export function credentialMatches(
  presented: string,
  storedHash: string,
): boolean {
  const presentedDigest = Buffer.from(sha256HexOf(presented), "hex");
  const storedDigest = Buffer.from(storedHash, "hex");

  if (storedDigest.length !== presentedDigest.length) return false;

  return timingSafeEqual(presentedDigest, storedDigest);
}

export interface VerifiedMachine {
  machineId: string;
  userId: string;
  createdAt: number;
  credentialHash: string;
  boundServerId: string | null;
}

export interface VerifiedServer {
  serverId: string;
  userId: string;
  createdAt: number;
  credentialHash: string;
}

export function liveMachineByHash(
  db: RelayDb,
  credentialHash: string,
): VerifiedMachine | null {
  const row = db.get<
    | {
        machine_id: string;
        user_id: string;
        created_at: number;
        server_id: string | null;
      }
    | undefined
  >(
    sql`SELECT m.id AS machine_id, m.user_id AS user_id, m.created_at AS created_at, b.server_id AS server_id FROM machine m LEFT JOIN relay_machine_server b ON b.machine_id = m.id WHERE m.credential_hash = ${credentialHash} AND m.revoked_at IS NULL LIMIT 1`,
  );

  return row === undefined
    ? null
    : {
        machineId: row.machine_id,
        userId: row.user_id,
        createdAt: row.created_at,
        credentialHash,
        boundServerId: row.server_id,
      };
}

export function liveServerByHash(
  db: RelayDb,
  credentialHash: string,
): VerifiedServer | null {
  const row = db
    .select({
      serverId: server.id,
      userId: server.userId,
      createdAt: server.createdAt,
    })
    .from(server)
    .where(
      and(eq(server.credentialHash, credentialHash), isNull(server.revokedAt)),
    )
    .get();

  return row === undefined
    ? null
    : {
        serverId: row.serverId,
        userId: row.userId,
        createdAt: row.createdAt.getTime(),
        credentialHash,
      };
}

export function verifyMachineCredential(
  db: RelayDb,
  credential: string,
): VerifiedMachine | null {
  return credential === ""
    ? null
    : liveMachineByHash(db, sha256HexOf(credential));
}

export function verifyServerCredential(
  db: RelayDb,
  credential: string,
): VerifiedServer | null {
  return credential === ""
    ? null
    : liveServerByHash(db, sha256HexOf(credential));
}

export const MACHINE_LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

export function createMachineSeenWriter(db: RelayDb) {
  const lastWrites = new Map<string, number>();

  return (machineId: string, now: number): boolean => {
    const previous = lastWrites.get(machineId);

    if (
      previous !== undefined &&
      now - previous < MACHINE_LAST_SEEN_WRITE_INTERVAL_MS
    ) {
      return false;
    }

    lastWrites.set(machineId, now);
    db.update(machine)
      .set({ lastSeenAt: new Date(now) })
      .where(and(eq(machine.id, machineId), isNull(machine.revokedAt)))
      .run();

    return true;
  };
}
