import { and, eq, isNull } from "drizzle-orm";
import { HANDLE_MAX_LENGTH, machine, validateLabel } from "@omnyo/connect-db";
import type { RelayDb } from "../db.js";
import { sha256HexOf } from "./signed-token.js";
import {
  RelayLabelLimitError,
  isClaimableRelayLabel,
  isRelayReservedLabel,
  labelWriteRefusal,
} from "../reserved-labels.js";

const GENERATED_LABEL = /^machine-[a-f0-9]{8}(?:-[0-9]+)?$/u;

const MAX_LABEL_ATTEMPTS = 100;

const NAMED_LABEL_ATTEMPTS = 20;

export class MachineLabelUnavailableError extends Error {
  constructor() {
    super("No address could be assigned to this device");
  }
}

export function fallbackLabel(seed: string): string {
  const idPrefix = seed
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase()
    .slice(0, 8);

  return `machine-${idPrefix || "unknown"}`;
}

function normalizedDeviceName(desiredName: string): string {
  return desiredName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, HANDLE_MAX_LENGTH)
    .replace(/-+$/gu, "");
}

export function routableLabel(label: string): boolean {
  return (
    label.length > 0 &&
    validateLabel(label) === null &&
    (GENERATED_LABEL.test(label) || isClaimableRelayLabel(label))
  );
}

export function fallbackSeedFor(userId: string): string {
  return sha256HexOf(JSON.stringify([userId]));
}

export function sanitizeMachineLabelBase(
  desiredName: string,
  fallbackSeed: string,
): string {
  const label = normalizedDeviceName(desiredName);

  return routableLabel(label) && !GENERATED_LABEL.test(label)
    ? label
    : fallbackLabel(fallbackSeed);
}

function labelWithSuffix(base: string, ordinal: number): string {
  if (ordinal === 1) return base;
  const suffix = `-${ordinal}`;

  const stem = base
    .slice(0, HANDLE_MAX_LENGTH - suffix.length)
    .replace(/-+$/gu, "");

  return `${stem}${suffix}`;
}

export function assignMachineLabel(
  db: RelayDb,
  machineId: string,
  desiredName: string,
): string | null {
  const row = db
    .select({
      subdomain: machine.subdomain,
      revokedAt: machine.revokedAt,
      userId: machine.userId,
    })
    .from(machine)
    .where(eq(machine.id, machineId))
    .get();

  if (row === undefined) return null;

  if (row.revokedAt !== null) return row.subdomain;

  if (row.subdomain !== null) {
    if (!isRelayReservedLabel(row.subdomain)) return row.subdomain;
    db.update(machine)
      .set({ subdomain: null })
      .where(
        and(eq(machine.id, machineId), eq(machine.subdomain, row.subdomain)),
      )
      .run();
  }

  const seed = fallbackSeedFor(row.userId);
  const fallback = fallbackLabel(seed);
  let base = sanitizeMachineLabelBase(desiredName, seed);

  let ordinal = 0;

  const switchToFallback = () => {
    if (base === fallback) return;
    base = fallback;
    ordinal = 0;
  };

  for (let attempt = 0; attempt < MAX_LABEL_ATTEMPTS; attempt += 1) {
    ordinal += 1;
    const candidate = labelWithSuffix(base, ordinal);

    if (!routableLabel(candidate)) {
      switchToFallback();

      continue;
    }

    let changes: number;

    try {
      changes = db
        .update(machine)
        .set({ subdomain: candidate })
        .where(
          and(
            eq(machine.id, machineId),
            isNull(machine.subdomain),
            isNull(machine.revokedAt),
          ),
        )
        .run().changes;
    } catch (error) {
      const refusal = labelWriteRefusal(error);

      if (refusal === "taken") {
        if (ordinal >= NAMED_LABEL_ATTEMPTS) switchToFallback();

        continue;
      }

      if (refusal === "label-limit") {
        if (base === fallback) throw new RelayLabelLimitError();
        switchToFallback();

        continue;
      }

      throw error;
    }

    if (changes === 1) return candidate;

    const current = db
      .select({ subdomain: machine.subdomain, revokedAt: machine.revokedAt })
      .from(machine)
      .where(eq(machine.id, machineId))
      .get();

    if (current === undefined || current.revokedAt !== null) return null;

    if (current.subdomain !== null) return current.subdomain;
  }

  throw new MachineLabelUnavailableError();
}
