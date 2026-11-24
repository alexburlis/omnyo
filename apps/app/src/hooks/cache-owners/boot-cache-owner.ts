import type {
  InfiniteData,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import { z } from "zod";
import {
  hostSchema,
  parseUiPreferenceValue,
  threadAttentionSnapshotSchema,
  UI_PREFERENCE_KEYS,
} from "@omnyo/domain";
import {
  pluginListResponseSchema,
  pluginSafeModeResponseSchema,
  systemConfigResponseSchema,
  systemVersionResponseSchema,
  threadListResponseSchema,
  type BootPartName,
  type ThreadListResponse,
  type UiPreferencesResponse,
} from "@omnyo/server-contract";
import {
  hostsQueryKey,
  pluginListQueryKey,
  pluginSafeModeQueryKey,
  shelvedThreadsListQueryKey,
  systemConfigQueryKey,
  systemVersionQueryKey,
  uiPreferencesQueryKey,
} from "../queries/query-keys";
import {
  createBootReads,
  type BootOutcome,
  type BootReads,
  type PageBoot,
} from "@/lib/boot-reads";
import {
  BOOT_SNAPSHOT_MAX_CHARS,
  bootSnapshotSize,
  type BootSnapshotRecord,
  type BootSnapshotStore,
} from "@/lib/boot-snapshot-store";
import { threadAttentionQueryKey } from "./thread-attention-cache-owner";

export const BOOT_SNAPSHOT_WRITE_DELAY_MS = 5_000;

interface DisplayPart {
  name: BootPartName;
  queryKey: QueryKey;
  read(queryClient: QueryClient, since: number): unknown;
  seed(queryClient: QueryClient, stored: unknown, savedAt: number): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUiPreferencesResponse(
  value: unknown,
): value is UiPreferencesResponse {
  if (!isRecord(value) || !isRecord(value.preferences)) return false;
  const preferences = value.preferences;

  return UI_PREFERENCE_KEYS.every((key) => {
    const entry = preferences[key];

    return (
      isRecord(entry) &&
      typeof entry.revision === "number" &&
      Number.isInteger(entry.revision) &&
      entry.revision >= 0 &&
      parseUiPreferenceValue(key, entry.value).success
    );
  });
}

function displayPart<TStored, TData>(args: {
  name: BootPartName;
  queryKey: QueryKey;
  parse(value: unknown): TStored | null;
  toData(stored: TStored): TData;
  toStored(data: TData): TStored | null;
}): DisplayPart {
  return {
    name: args.name,
    queryKey: args.queryKey,
    read(queryClient, since) {
      const state = queryClient.getQueryState<TData>(args.queryKey);

      if (
        state?.status !== "success" ||
        state.data === undefined ||
        state.isInvalidated ||
        state.dataUpdatedAt < since
      )
        return null;

      return args.toStored(state.data);
    },
    seed(queryClient, stored, savedAt) {
      if (queryClient.getQueryData(args.queryKey) !== undefined) return false;
      const parsed = args.parse(stored);

      if (parsed === null) return false;
      queryClient.setQueryData(args.queryKey, args.toData(parsed), {
        updatedAt: savedAt,
      });
      void queryClient.invalidateQueries(
        { queryKey: args.queryKey, exact: true, refetchType: "none" },
        { cancelRefetch: false },
      );

      return true;
    },
  };
}

function schemaPart<T>(
  name: BootPartName,
  queryKey: QueryKey,
  schema: z.ZodType<T>,
): DisplayPart {
  return displayPart<T, T>({
    name,
    queryKey,
    parse: (value) => {
      const parsed = schema.safeParse(value);

      return parsed.success ? parsed.data : null;
    },
    toData: (stored) => stored,
    toStored: (data) => data,
  });
}

const installedPluginsSchema = pluginListResponseSchema.shape.plugins;

const safeModeSchema = pluginSafeModeResponseSchema.shape.enabled;

export const BOOT_DISPLAY_PARTS: readonly DisplayPart[] = [
  schemaPart(
    "systemConfig",
    systemConfigQueryKey(),
    systemConfigResponseSchema,
  ),
  displayPart<UiPreferencesResponse, UiPreferencesResponse>({
    name: "uiPreferences",
    queryKey: uiPreferencesQueryKey(),
    parse: (value) => (isUiPreferencesResponse(value) ? value : null),
    toData: (stored) => stored,
    toStored: (data) => data,
  }),
  schemaPart("hosts", hostsQueryKey(false), hostSchema.array()),
  schemaPart(
    "threadAttention",
    threadAttentionQueryKey,
    threadAttentionSnapshotSchema,
  ),
  schemaPart("pluginSafeMode", pluginSafeModeQueryKey(), safeModeSchema),
  schemaPart(
    "systemVersion",
    systemVersionQueryKey(),
    systemVersionResponseSchema,
  ),
  schemaPart("plugins", pluginListQueryKey(true), installedPluginsSchema),
  displayPart<ThreadListResponse, InfiniteData<ThreadListResponse, number>>({
    name: "shelvedThreads",
    queryKey: shelvedThreadsListQueryKey(),
    parse: (value) => {
      const parsed = threadListResponseSchema.safeParse(value);

      return parsed.success ? parsed.data : null;
    },
    toData: (stored) => ({ pages: [stored], pageParams: [0] }),
    toStored: (data) => data.pages[0] ?? null,
  }),
];

export function seedStoredBootDisplay(
  queryClient: QueryClient,
  record: BootSnapshotRecord,
): BootPartName[] {
  const seeded: BootPartName[] = [];

  for (const part of BOOT_DISPLAY_PARTS) {
    if (!Object.hasOwn(record.parts, part.name)) continue;

    if (part.seed(queryClient, record.parts[part.name], record.savedAt))
      seeded.push(part.name);
  }

  return seeded;
}

export function captureBootSnapshot(args: {
  queryClient: QueryClient;
  origin: string;
  serverIdentity: string;
  since: number;
  savedAt: number;
}): BootSnapshotRecord | null {
  const record: BootSnapshotRecord = {
    schema: 1,
    origin: args.origin,
    serverIdentity: args.serverIdentity,
    savedAt: args.savedAt,
    parts: {},
  };

  for (const part of BOOT_DISPLAY_PARTS) {
    const value = part.read(args.queryClient, args.since);

    if (value === null || value === undefined) continue;
    record.parts[part.name] = value;

    if (bootSnapshotSize(record) > BOOT_SNAPSHOT_MAX_CHARS)
      delete record.parts[part.name];
  }

  return Object.keys(record.parts).length === 0 ? null : record;
}

export interface BootCacheDeps {
  queryClient: QueryClient;
  origin: string;
  page: PageBoot | null;
  store: BootSnapshotStore;
  requestBoot: (parts: readonly BootPartName[]) => Promise<BootOutcome>;
  clearLastKnownCaches: () => void;
  install: (reads: BootReads) => void;
  now?: () => number;
  onBootFailure?: () => void;
  onSnapshotReadTimeout?: () => void;
}

export const BOOT_SNAPSHOT_READ_DEADLINE_MS = 300;

async function readStoredBootWithinDeadline(
  stored: Promise<BootSnapshotRecord | null>,
  onTimeout: () => void,
): Promise<BootSnapshotRecord | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(null);
    }, BOOT_SNAPSHOT_READ_DEADLINE_MS);
  });

  try {
    return await Promise.race([stored, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export interface BootCache {
  persist(): Promise<void>;
  settled: Promise<void>;
  dispose(): void;
}

export async function startBootCache(deps: BootCacheDeps): Promise<BootCache> {
  const now = deps.now ?? Date.now;
  const sessionStartedAt = now();

  const reads = createBootReads({
    origin: deps.origin,
    page: deps.page,
    requestBoot: deps.requestBoot,
    now,
    onBootFailure: deps.onBootFailure,
  });

  deps.install(reads);
  let serverIdentity: string | null = null;
  let disposed = false;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;

  let waitingForStoredDisplay = true;

  const stored = deps.store.read(deps.origin);

  const storedDisplay = readStoredBootWithinDeadline(stored, () => {
    if (waitingForStoredDisplay) deps.onSnapshotReadTimeout?.();
  });

  const displayed =
    deps.page === null
      ? await storedDisplay
      : await Promise.race([
          storedDisplay,
          deps.page.outcome.then((outcome) =>
            outcome.kind === "failed" ? storedDisplay : null,
          ),
        ]);

  waitingForStoredDisplay = false;

  const seeded =
    displayed === null
      ? []
      : seedStoredBootDisplay(deps.queryClient, displayed);

  const persist = async () => {
    if (disposed || serverIdentity === null) return;

    const record = captureBootSnapshot({
      queryClient: deps.queryClient,
      origin: deps.origin,
      serverIdentity,
      since: sessionStartedAt,
      savedAt: now(),
    });

    if (record !== null) await deps.store.write(record);
  };

  const forget = async () => {
    if (displayed !== null) {
      for (const part of BOOT_DISPLAY_PARTS) {
        if (!seeded.includes(part.name)) continue;

        if (
          deps.queryClient.getQueryState(part.queryKey)?.dataUpdatedAt ===
          displayed.savedAt
        )
          void deps.queryClient.resetQueries({
            queryKey: part.queryKey,
            exact: true,
          });
      }
    }

    deps.clearLastKnownCaches();
    await deps.store.clear(deps.origin);
  };

  const settle = async (outcome: BootOutcome) => {
    if (disposed) return;

    if (outcome.kind === "signed-out") {
      await forget();

      return;
    }

    if (outcome.kind !== "ok") return;
    const previous = displayed ?? (await stored);
    serverIdentity = outcome.response.serverIdentity;

    if (previous !== null && previous.serverIdentity !== serverIdentity)
      await forget();

    if (disposed) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void persist();
    }, BOOT_SNAPSHOT_WRITE_DELAY_MS);
  };

  const settled =
    deps.page === null ? Promise.resolve() : deps.page.outcome.then(settle);

  return {
    persist,
    settled,
    dispose() {
      disposed = true;

      if (writeTimer !== null) clearTimeout(writeTimer);
    },
  };
}
