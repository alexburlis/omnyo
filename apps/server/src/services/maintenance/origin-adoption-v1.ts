import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  createOriginAdoptionMetadataV1,
  originAdoptionRecordSchemaV1 as recordSchema,
} from "@omnyo/server-archive";
import type { MaintenanceStatus } from "@omnyo/server-contract";
import { ApiError } from "../../errors.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

const ticketSchema = z
  .object({
    version: z.literal(1),
    adoptionId: z.string().min(1).max(200),
    id: digest,
    selectedIds: z.array(digest).min(1).max(32),
    nonce: digest,
    fromOrigin: z.literal("https://bb.alexburlis.com"),
    toOrigin: z.literal("https://app.omnyohq.com"),
  })
  .strict()
  .refine(
    (value) =>
      value.selectedIds.includes(value.id) &&
      new Set(value.selectedIds).size === value.selectedIds.length &&
      JSON.stringify([...value.selectedIds].sort()) ===
        JSON.stringify(value.selectedIds),
  );

const preparationSchema = z
  .object({
    ticket: ticketSchema,
    holdId: z.string().min(1).max(200),
    ownerId: z.string().min(1).max(200),
    expectedRuntimeId: z.string().min(1).max(200),
    expectedServerHostId: z.string().min(1).max(200),
  })
  .strict();

const controlSchema = z
  .object({
    ticket: ticketSchema,
    action: z.enum(["check", "verified", "accept", "admitted"]),
    payloadSha256: digest.nullable(),
  })
  .strict();

export const originAdoptionControlPathV1 =
  "/api/v1/server/maintenance/origin-adoption-v1/check";

export const originAdoptionBootstrapPathV1 = "/origin-adoption-v1.html";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function createOriginAdoptionV1(args: {
  dataDir: string;
  status(): MaintenanceStatus;
  assetPaths?(): Promise<readonly string[]>;
}) {
  const metadata = createOriginAdoptionMetadataV1(args.dataDir);
  const read = metadata.read;

  function assertHold(record: z.infer<typeof recordSchema>) {
    const status = args.status();

    if (
      record.expiresAt < Date.now() ||
      status.hold?.phase !== "held" ||
      status.hold.kind !== "desktop-update" ||
      status.hold.id !== record.holdId ||
      status.hold.id !== record.adoptionId ||
      status.hold.ownerId !== record.ownerId ||
      status.runtime.runtimeId !== record.runtimeId ||
      status.runtime.serverHostId !== record.serverHostId ||
      Object.values(status.activity).some((count) => count !== 0)
    )
      throw new ApiError(
        409,
        "origin_adoption_hold",
        "Origin adoption requires its exact idle maintenance owner",
      );
  }

  async function cohort(record: z.infer<typeof recordSchema>) {
    const records = await Promise.all(record.selectedIds.map((id) => read(id)));

    for (const selected of records) {
      if (
        selected === null ||
        selected.adoptionId !== record.adoptionId ||
        JSON.stringify(selected.selectedIds) !==
          JSON.stringify(record.selectedIds) ||
        selected.holdId !== record.holdId ||
        selected.ownerId !== record.ownerId ||
        selected.runtimeId !== record.runtimeId ||
        selected.serverHostId !== record.serverHostId
      )
        throw new ApiError(
          409,
          "origin_adoption_cohort",
          "Every selected browser window must share the exact prepared adoption",
        );
      assertHold(selected);
    }

    return records;
  }

  function mapping(record: z.infer<typeof recordSchema>) {
    const fields = {
      version: 1 as const,
      adoptionId: record.adoptionId,
      fromOrigin: record.fromOrigin,
      toOrigin: record.toOrigin,
      serverHostId: record.serverHostId,
      runtimeId: record.runtimeId,
      selectedIds: record.selectedIds,
    };

    return { ...fields, mappingSha256: hash(JSON.stringify(fields)) };
  }

  async function authenticated(
    ticket: z.infer<typeof ticketSchema>,
    requireCohort = true,
  ) {
    const record = await read(ticket.id);

    if (
      record === null ||
      record.id !== ticket.id ||
      record.adoptionId !== ticket.adoptionId ||
      JSON.stringify(record.selectedIds) !==
        JSON.stringify(ticket.selectedIds) ||
      record.fromOrigin !== ticket.fromOrigin ||
      record.toOrigin !== ticket.toOrigin ||
      !timingSafeEqual(
        Buffer.from(record.nonceSha256, "hex"),
        Buffer.from(hash(ticket.nonce), "hex"),
      )
    )
      throw new ApiError(
        403,
        "origin_adoption_auth",
        "Origin adoption capability does not match",
      );
    assertHold(record);

    if (requireCohort) await cohort(record);

    return record;
  }

  return {
    async prepare(value: unknown) {
      const input = preparationSchema.parse(value);

      const record = recordSchema.parse({
        version: 1,
        adoptionId: input.ticket.adoptionId,
        id: input.ticket.id,
        selectedIds: input.ticket.selectedIds,
        nonceSha256: hash(input.ticket.nonce),
        fromOrigin: input.ticket.fromOrigin,
        toOrigin: input.ticket.toOrigin,
        holdId: input.holdId,
        ownerId: input.ownerId,
        runtimeId: input.expectedRuntimeId,
        serverHostId: input.expectedServerHostId,
        expiresAt: Date.now() + 30 * 60 * 1000,
        phase: "prepared",
        payloadSha256: null,
      });

      assertHold(record);
      await metadata.initialize();

      return metadata.locked(async () => {
        assertHold(record);
        const previous = await read(record.id);

        if (previous !== null) {
          await authenticated(input.ticket, false);

          if (
            previous.holdId !== record.holdId ||
            previous.ownerId !== record.ownerId ||
            previous.runtimeId !== record.runtimeId
          )
            throw new ApiError(
              409,
              "origin_adoption_collision",
              "Another origin transfer already owns this record",
            );

          return {
            prepared: true as const,
            phase: previous.phase,
            mapping: mapping(previous),
          };
        }

        const existing = await Promise.all(
          (await metadata.list()).map((id) => read(id)),
        );

        if (
          existing.some(
            (other) =>
              other !== null &&
              other.adoptionId === record.adoptionId &&
              JSON.stringify(other.selectedIds) !==
                JSON.stringify(record.selectedIds),
          )
        )
          throw new ApiError(
            409,
            "origin_adoption_selection",
            "Selected browser window set is immutable",
          );

        if (existing.length >= 32)
          throw new ApiError(
            409,
            "origin_adoption_capacity",
            "Origin adoption exceeds its selected window bound",
          );
        await metadata.write(record, true);

        return {
          prepared: true as const,
          phase: record.phase,
          mapping: mapping(record),
        };
      });
    },
    async control(value: unknown, origin: string) {
      const input = controlSchema.parse(value);

      return metadata.locked(async () => {
        const record = await authenticated(input.ticket);

        if (origin !== record.fromOrigin && origin !== record.toOrigin)
          throw new ApiError(
            403,
            "origin_adoption_origin",
            "Origin adoption caller is outside the selected origins",
          );

        if (input.action === "verified") {
          if (
            origin !== record.toOrigin ||
            input.payloadSha256 === null ||
            (record.payloadSha256 !== null &&
              record.payloadSha256 !== input.payloadSha256)
          )
            throw new ApiError(
              409,
              "origin_adoption_verification",
              "Origin adoption verification differs",
            );

          if (record.phase !== "accepted" && record.phase !== "admitted")
            await metadata.write({
              ...record,
              phase: "verified",
              payloadSha256: input.payloadSha256,
            });
        }

        if (input.action === "accept") {
          if (
            origin !== record.fromOrigin ||
            record.phase === "prepared" ||
            record.payloadSha256 === null ||
            input.payloadSha256 !== record.payloadSha256
          )
            throw new ApiError(
              409,
              "origin_adoption_admission",
              "Origin adoption has not verified its destination",
            );

          if (record.phase !== "accepted" && record.phase !== "admitted")
            await metadata.write({
              ...record,
              phase: "accepted",
            });
        }

        if (input.action === "admitted") {
          if (
            origin !== record.toOrigin ||
            (record.phase !== "accepted" && record.phase !== "admitted") ||
            input.payloadSha256 !== record.payloadSha256 ||
            record.payloadSha256 === null
          )
            throw new ApiError(
              409,
              "origin_adoption_admission",
              "Destination browser window has not committed its verified admission",
            );

          if (record.phase !== "admitted")
            await metadata.write({ ...record, phase: "admitted" });
        }

        const current = await read(record.id);

        if (current === null)
          throw new ApiError(
            409,
            "origin_adoption_owner",
            "Origin adoption record disappeared",
          );
        const selected = await cohort(current);

        return {
          authorized: true as const,
          mapping: mapping(current),
          phase: current.phase,
          adoptionAccepted: selected.every(
            (value) => value?.phase === "admitted",
          ),
        };
      });
    },
    async permitsRequest(
      url: string,
      method: string,
      origin: string | undefined,
    ) {
      const target = new URL(url);

      if (
        target.origin !== "https://bb.alexburlis.com" &&
        target.origin !== "https://app.omnyohq.com"
      )
        return false;

      const selected = await metadata.list();

      if (selected.length > 32) return false;

      const records = await Promise.all(selected.map((id) => read(id)));

      let active = false;

      for (const record of records) {
        if (record === null) continue;

        try {
          await cohort(record);
          active = true;
          break;
        } catch {}
      }

      if (!active) return false;

      if (
        method === "GET" &&
        (target.pathname === originAdoptionBootstrapPathV1 ||
          (await args.assetPaths?.())?.includes(target.pathname) === true)
      )
        return true;

      return (
        method === "POST" &&
        target.pathname === originAdoptionControlPathV1 &&
        origin === target.origin
      );
    },
  };
}
