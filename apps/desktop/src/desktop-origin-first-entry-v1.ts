import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withFileLock } from "@omnyo/config/file-lock";
import { writeJsonFileAtomically } from "@omnyo/server-archive";
import {
  originLocalWindowSchemaV1,
  originNativeMappingSchemaV1,
  originNativeSessionRestoreSchemaV1,
  originNativeSessionIdentitySchemaV1,
  originNativeFirstEntryRequestSchemaV1,
  originNativeFirstEntryReplySchemaV1,
} from "@omnyo/desktop-contract/internal/origin-adoption-v1";
import { z } from "zod";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const sha = z.string().regex(/^[a-f0-9]{64}$/u);

const ids = z
  .array(sha)
  .max(32)
  .refine((value) => new Set(value).size === value.length);

const selectionSchema = z
  .object({
    version: z.literal(1),
    nativeJobId: z.string().min(1).max(200),
    mapping: originNativeMappingSchemaV1,
    localWindows: z.array(originLocalWindowSchemaV1).min(1).max(32),
  })
  .strict();

const recordSchema = z
  .object({
    version: z.literal(1),
    bindingSha256: sha,
    processEpoch: z.string().uuid(),
    recipeSha256: sha.nullable(),
    preflight: ids,
    ready: ids,
    prepared: ids,
    retired: ids,
    confirmed: ids,
    protectedAdmission: z.union([z.literal(0), z.literal(1)]),
    ordinaryEntryAuthorized: z.boolean(),
  })
  .strict();

type Request = z.infer<typeof originNativeFirstEntryRequestSchemaV1>;

type Reply = z.infer<typeof originNativeFirstEntryReplySchemaV1>;

type RecordValue = z.infer<typeof recordSchema>;

export async function createDesktopOriginFirstEntryOwnerV1(args: {
  jobDir: string;
  selection: unknown;
  readProtectedAdmission(): Promise<
    "closed" | "admitted-recovery-required" | "admitted"
  >;
  assertFinalRuntime(): Promise<void>;
  admitProtectedProfile(): Promise<void>;
  startOrdinaryNativeOwner(): Promise<void>;
}) {
  const directory = await lstat(args.jobDir);

  if (
    resolve(args.jobDir) !== args.jobDir ||
    (await realpath(args.jobDir)) !== args.jobDir ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid?.()
  )
    throw new Error(
      "Native first-entry requires its exact private profile job",
    );
  const selection = selectionSchema.parse(args.selection);

  const bindings = selection.localWindows.map((window) => ({
    transferId: window.ticket.id,
    windowKey: window.windowKey,
    targetStageSha256: window.targetStageSha256,
    nonceSha256: digest(window.ticket.nonce),
    originPayloadSha256: window.originPayloadSha256,
    composerTabId: window.composerTabId,
  }));

  const selectedIds = bindings.map((window) => window.transferId);

  if (
    new Set(selectedIds).size !== selectedIds.length ||
    new Set(bindings.map((window) => window.windowKey)).size !==
      bindings.length ||
    selection.localWindows.some(
      ({ ticket }) =>
        ticket.adoptionId !== selection.mapping.adoptionId ||
        ticket.fromOrigin !== selection.mapping.fromOrigin ||
        ticket.toOrigin !== selection.mapping.toOrigin ||
        JSON.stringify(ticket.selectedIds) !==
          JSON.stringify(selection.mapping.selectedIds),
    )
  )
    throw new Error(
      "Native local windows differ from their immutable full origin cohort",
    );
  const localSelectionSha256 = digest(JSON.stringify(bindings));
  const bindingSha256 = digest(JSON.stringify(selection));
  const recordPath = join(args.jobDir, "desktop-origin-first-entry-v1.json");
  const lockPath = join(args.jobDir, "desktop-origin-first-entry-v1.lock");
  const processEpoch = randomUUID();

  const waiters = new Set<{
    request: Request;
    resolve(value: Reply): void;
    reject(error: unknown): void;
  }>();

  let ordinaryStart: Promise<void> | null = null;

  let pendingLock: Promise<void> = Promise.resolve();

  const locked = <T>(work: () => Promise<T>) => {
    const result = pendingLock.then(() =>
      withFileLock({ path: lockPath, timeoutMs: 1000, work }),
    );

    pendingLock = result.then(
      () => {},
      () => {},
    );

    return result;
  };

  async function read(): Promise<RecordValue | null> {
    let info;

    try {
      info = await lstat(recordPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== directory.uid ||
      (info.mode & 0o077) !== 0 ||
      info.size > 32768 ||
      (await realpath(recordPath)) !== recordPath
    )
      throw new Error("Native first-entry journal owner changed");

    const record = recordSchema.parse(
      JSON.parse(await readFile(recordPath, "utf8")),
    );

    if (
      record.bindingSha256 !== bindingSha256 ||
      [
        ...record.preflight,
        ...record.ready,
        ...record.prepared,
        ...record.retired,
        ...record.confirmed,
      ].some((id) => !selectedIds.includes(id)) ||
      (record.ordinaryEntryAuthorized && record.protectedAdmission !== 1)
    )
      throw new Error(
        "Native first-entry journal belongs to different selected work",
      );

    return record;
  }

  async function save(value: RecordValue) {
    await writeJsonFileAtomically(recordPath, recordSchema.parse(value));
  }

  await locked(async () => {
    const record = await read();

    if (record === null) {
      if ((await args.readProtectedAdmission()) !== "closed")
        throw new Error(
          "An admitted protected profile has no bound first-entry history",
        );
      await save({
        version: 1,
        bindingSha256,
        processEpoch,
        recipeSha256: null,
        preflight: [],
        ready: [],
        prepared: [],
        retired: [],
        confirmed: [],
        protectedAdmission: 0,
        ordinaryEntryAuthorized: false,
      });
    } else if (!record.ordinaryEntryAuthorized) {
      await save({
        ...record,
        processEpoch,
        preflight: [],
        ready: [],
        prepared: [],
        retired: [],
      });
    }
  });

  const complete = (values: readonly string[]) =>
    selectedIds.every((id) => values.includes(id));

  function reply(request: Request, record: RecordValue): Reply {
    const { kind, ...binding } = request;

    if (
      kind !== "inspect" &&
      kind !== "will-enter" &&
      kind !== "entered" &&
      record.ordinaryEntryAuthorized
    )
      throw new Error(
        "Ordinary entry already began; the old session must not be replayed",
      );

    const phase =
      kind === "preflight"
        ? "all-local-preflight"
        : kind === "ready"
          ? "all-local-ready"
          : kind === "prepared"
            ? "all-local-prepared"
            : kind === "retired"
              ? "all-local-retired"
              : record.ordinaryEntryAuthorized
                ? "ordinary-entry-authorized"
                : complete(record.retired)
                  ? "all-local-retired"
                  : complete(record.prepared)
                    ? "all-local-prepared"
                    : complete(record.ready)
                      ? "all-local-ready"
                      : "pre-entry";

    return originNativeFirstEntryReplySchemaV1.parse({
      ...binding,
      kind:
        kind === "inspect"
          ? "inspect-accepted"
          : kind === "preflight"
            ? "preflight-accepted"
            : kind === "ready"
              ? "ready-accepted"
              : kind === "prepared"
                ? "prepared-accepted"
                : kind === "retired"
                  ? "retired-accepted"
                  : kind === "entered"
                    ? "entry-confirmed"
                    : "entry-authorized",
      recipeSha256: record.recipeSha256,
      phase,
      protectedAdmission: record.protectedAdmission,
      ordinaryEntryAuthorized: record.ordinaryEntryAuthorized,
    });
  }

  async function advance() {
    const record = await locked(async () => {
      const record = await read();

      if (record === null)
        throw new Error("Native first-entry journal disappeared");
      const protectedAdmission = await args.readProtectedAdmission();

      if (record.protectedAdmission === 1 && protectedAdmission !== "admitted")
        throw new Error("Native protected admission regressed");

      if (
        !record.ordinaryEntryAuthorized &&
        complete(record.ready) &&
        record.protectedAdmission === 0
      ) {
        await args.assertFinalRuntime();

        if (protectedAdmission !== "admitted")
          await args.admitProtectedProfile();

        if ((await args.readProtectedAdmission()) !== "admitted")
          throw new Error("Native protected admission did not verify");

        if (record.protectedAdmission === 0) {
          record.protectedAdmission = 1;
          await save(record);
        }
      }

      return record;
    });

    for (const waiter of [...waiters]) {
      const kind = waiter.request.kind;

      const eligible =
        kind === "preflight"
          ? complete(record.preflight)
          : kind === "ready"
            ? complete(record.ready) && record.protectedAdmission === 1
            : kind === "prepared"
              ? complete(record.prepared)
              : kind === "retired"
                ? complete(record.retired)
                : false;

      if (eligible) {
        waiters.delete(waiter);

        try {
          waiter.resolve(reply(waiter.request, record));
        } catch (error) {
          waiter.reject(error);
        }
      }
    }
  }

  async function request(windowKey: string, value: unknown) {
    const input = originNativeFirstEntryRequestSchemaV1.parse(value);

    const window = selection.localWindows.find(
      (window) => window.windowKey === windowKey,
    );

    if (window === undefined)
      throw new Error("Native request came from an unselected window");

    const expected = {
      version: 1,
      nativeJobId: selection.nativeJobId,
      localSelectionSha256,
      transferId: window.ticket.id,
      windowKey,
      targetStageSha256: window.targetStageSha256,
      originPayloadSha256: window.originPayloadSha256,
      composerTabId: window.composerTabId,
      mapping: selection.mapping,
    };

    const { kind, recipeSha256, ...actual } = input;

    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        "Native first-entry request differs from its sealed profile window",
      );

    const result = await locked(async () => {
      const record = await read();

      if (record === null)
        throw new Error("Native first-entry journal disappeared");

      if (kind === "inspect") {
        if (record.ordinaryEntryAuthorized) {
          await args.assertFinalRuntime();

          if ((await args.readProtectedAdmission()) !== "admitted")
            throw new Error("Native identity continuation lost its admission");
        }

        return reply(input, record);
      }

      if (
        recipeSha256 === null ||
        (record.recipeSha256 !== null && record.recipeSha256 !== recipeSha256)
      )
        throw new Error("Native first-entry recipe changed");

      if (record.recipeSha256 === null) record.recipeSha256 = recipeSha256;

      if (kind === "will-enter") {
        if (!record.ordinaryEntryAuthorized) {
          if (!complete(record.retired) || record.protectedAdmission !== 1)
            throw new Error(
              "Every local controller must retire before ordinary entry",
            );
          await args.assertFinalRuntime();

          if ((await args.readProtectedAdmission()) !== "admitted")
            throw new Error(
              "Protected admission changed before ordinary entry",
            );
          record.ordinaryEntryAuthorized = true;
          await save(record);
        }

        return reply(input, record);
      }

      if (kind === "entered") {
        if (!record.ordinaryEntryAuthorized)
          throw new Error("Ordinary entry has not been authorized");

        if (!record.confirmed.includes(window.ticket.id)) {
          record.confirmed.push(window.ticket.id);
          await save(record);
        }

        return reply(input, record);
      }

      if (
        record.ordinaryEntryAuthorized ||
        record.processEpoch !== processEpoch
      )
        throw new Error(
          "Old native session recovery cannot enter a later process epoch",
        );

      const field =
        kind === "preflight"
          ? "preflight"
          : kind === "ready"
            ? "ready"
            : kind === "prepared"
              ? "prepared"
              : "retired";

      if (
        (kind === "ready" && !complete(record.preflight)) ||
        (kind === "prepared" &&
          (!complete(record.ready) || record.protectedAdmission !== 1)) ||
        (kind === "retired" && !complete(record.prepared))
      )
        throw new Error("Native first-entry phases arrived out of order");

      if (!record[field].includes(window.ticket.id))
        record[field].push(window.ticket.id);
      await save(record);

      return null;
    });

    if (result !== null) {
      if (kind === "will-enter") {
        ordinaryStart ??= args.startOrdinaryNativeOwner();
        await ordinaryStart;
      }

      return result;
    }

    return new Promise<Reply>((resolve, reject) => {
      waiters.add({ request: input, resolve, reject });
      void advance().catch((error) => {
        for (const waiter of waiters) waiter.reject(error);
        waiters.clear();
      });
    });
  }

  return {
    request,
    async descriptor(windowKey: string) {
      return locked(async () => {
        const record = await read();

        const window = selection.localWindows.find(
          (window) => window.windowKey === windowKey,
        );

        if (record === null || window === undefined)
          throw new Error("Native descriptor has no selected owner");

        if (record.ordinaryEntryAuthorized) {
          if (
            record.recipeSha256 === null ||
            (await args.readProtectedAdmission()) !== "admitted"
          )
            throw new Error("Native identity continuation lost its admission");
          await args.assertFinalRuntime();

          return originNativeSessionIdentitySchemaV1.parse({
            version: 1,
            nativeJobId: selection.nativeJobId,
            localSelectionSha256,
            transferId: window.ticket.id,
            windowKey,
            targetStageSha256: window.targetStageSha256,
            originPayloadSha256: window.originPayloadSha256,
            composerTabId: window.composerTabId,
            mapping: selection.mapping,
            kind: "origin-native-session-identity",
            recipeSha256: record.recipeSha256,
          });
        }

        return originNativeSessionRestoreSchemaV1.parse({
          version: 1,
          ticket: window.ticket,
          windowKey,
          targetStageSha256: window.targetStageSha256,
          nativeJobId: selection.nativeJobId,
          mapping: selection.mapping,
          localWindows: selection.localWindows,
        });
      });
    },
    dispose(error: Error) {
      for (const waiter of waiters) waiter.reject(error);
      waiters.clear();
    },
  };
}
