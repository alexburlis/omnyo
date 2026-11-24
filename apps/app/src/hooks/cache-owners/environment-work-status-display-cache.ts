import {
  environmentStatusResponseSchema,
  type EnvironmentStatusResponse,
} from "@omnyo/server-contract";
import { z } from "zod";
import { getLocalStorage } from "@/lib/browser-storage";

export const ENVIRONMENT_WORK_STATUS_DISPLAY_MAX_RECORDS = 32;

export const ENVIRONMENT_WORK_STATUS_DISPLAY_MAX_RECORD_BYTES = 64 * 1024;

export const ENVIRONMENT_WORK_STATUS_DISPLAY_MAX_TOTAL_BYTES = 512 * 1024;

export const ENVIRONMENT_WORK_STATUS_DISPLAY_MAX_AGE_MS = 24 * 60 * 60_000;

const DISPLAY_CACHE_STORAGE_KEY = "omnyo.environmentWorkStatusDisplay.v1";

const DISPLAY_CACHE_VERSION = 1;

const persistedDisplayRecordSchema = z
  .object({
    origin: z.string().min(1),
    environmentId: z.string().min(1),
    mergeBaseBranch: z.string().nullable(),
    savedAt: z.number().int().nonnegative(),
    response: z.unknown(),
  })
  .strict();

const persistedDisplayCacheSchema = z
  .object({
    version: z.literal(DISPLAY_CACHE_VERSION),
    records: z.array(persistedDisplayRecordSchema),
  })
  .strict();

type PersistedDisplayRecord = z.infer<typeof persistedDisplayRecordSchema>;

export interface EnvironmentWorkStatusDisplay {
  response: EnvironmentStatusResponse;
  savedAt: number;
}

interface DisplayScope {
  environmentId: string;
  mergeBaseBranch: string | null;
  origin: string;
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function resolveDisplayScope(
  environmentId: string,
  mergeBaseBranch: string | null,
): DisplayScope | null {
  if (typeof window === "undefined") return null;

  return { environmentId, mergeBaseBranch, origin: window.location.origin };
}

function isScopeRecord(
  record: PersistedDisplayRecord,
  scope: DisplayScope,
): boolean {
  return (
    record.origin === scope.origin &&
    record.environmentId === scope.environmentId &&
    record.mergeBaseBranch === scope.mergeBaseBranch
  );
}

function readDisplayRecords(storage: Storage): PersistedDisplayRecord[] {
  try {
    const serialized = storage.getItem(DISPLAY_CACHE_STORAGE_KEY);

    if (!serialized) return [];

    const parsed = persistedDisplayCacheSchema.safeParse(
      JSON.parse(serialized),
    );

    if (parsed.success) return parsed.data.records;

    storage.removeItem(DISPLAY_CACHE_STORAGE_KEY);

    return [];
  } catch {
    return [];
  }
}

function writeDisplayRecords(
  storage: Storage,
  records: PersistedDisplayRecord[],
  now: number,
): void {
  const retained = records
    .filter(
      (record) =>
        now - record.savedAt <= ENVIRONMENT_WORK_STATUS_DISPLAY_MAX_AGE_MS,
    )
    .sort((left, right) => right.savedAt - left.savedAt)
    .slice(0, ENVIRONMENT_WORK_STATUS_DISPLAY_MAX_RECORDS);

  while (
    retained.length > 0 &&
    utf8Bytes({ version: DISPLAY_CACHE_VERSION, records: retained }) >
      ENVIRONMENT_WORK_STATUS_DISPLAY_MAX_TOTAL_BYTES
  ) {
    retained.pop();
  }

  try {
    if (retained.length === 0) {
      storage.removeItem(DISPLAY_CACHE_STORAGE_KEY);

      return;
    }

    storage.setItem(
      DISPLAY_CACHE_STORAGE_KEY,
      JSON.stringify({ version: DISPLAY_CACHE_VERSION, records: retained }),
    );
  } catch {
    return;
  }
}

export function readEnvironmentWorkStatusDisplay(
  environmentId: string,
  mergeBaseBranch: string | null,
): EnvironmentWorkStatusDisplay | null {
  const storage = getLocalStorage();
  const scope = resolveDisplayScope(environmentId, mergeBaseBranch);

  if (!storage || !scope) return null;

  const record = readDisplayRecords(storage).find((candidate) =>
    isScopeRecord(candidate, scope),
  );

  if (
    !record ||
    Date.now() - record.savedAt > ENVIRONMENT_WORK_STATUS_DISPLAY_MAX_AGE_MS
  ) {
    return null;
  }

  const response = environmentStatusResponseSchema.safeParse(record.response);

  return response.success && response.data.outcome === "available"
    ? { response: response.data, savedAt: record.savedAt }
    : null;
}

export function rememberEnvironmentWorkStatusDisplay(
  environmentId: string,
  mergeBaseBranch: string | null,
  response: EnvironmentStatusResponse,
): void {
  const storage = getLocalStorage();
  const scope = resolveDisplayScope(environmentId, mergeBaseBranch);

  if (!storage || !scope) return;

  const now = Date.now();

  const others = readDisplayRecords(storage).filter(
    (record) => !isScopeRecord(record, scope),
  );

  const record: PersistedDisplayRecord = { ...scope, savedAt: now, response };

  writeDisplayRecords(
    storage,
    response.outcome === "available" &&
      utf8Bytes(record) <= ENVIRONMENT_WORK_STATUS_DISPLAY_MAX_RECORD_BYTES
      ? [record, ...others]
      : others,
    now,
  );
}
