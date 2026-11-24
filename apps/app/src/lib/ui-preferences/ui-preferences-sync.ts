import type { QueryClient } from "@tanstack/react-query";
import type { SetStateAction, WritableAtom } from "jotai";
import { getDefaultStore } from "jotai";
import {
  parseUiPreferenceValue,
  type UiPreferenceEntry,
  type UiPreferenceKey,
  type UiPreferenceValue,
} from "@omnyo/domain";
import type { UiPreferencesResponse } from "@omnyo/server-contract";
import { appToast } from "@/components/ui/app-toast";
import {
  getCachedUiPreferences,
  invalidateCachedUiPreferences,
  setCachedUiPreferences,
} from "@/hooks/cache-owners/ui-preferences-cache-owner";
import { OmnyoHttpError, sdk } from "../sdk";

type JotaiStore = ReturnType<typeof getDefaultStore>;

type ValueAtom<Key extends UiPreferenceKey> = WritableAtom<
  UiPreferenceValue<Key>,
  [UiPreferenceValue<Key>],
  void
>;

interface RegisteredPreference<Key extends UiPreferenceKey> {
  valueAtom: ValueAtom<Key>;
}

interface PreferenceSyncState<Key extends UiPreferenceKey> {
  inFlight: Promise<void> | null;
  pending: SetStateAction<UiPreferenceValue<Key>>[] | null;
}

interface UiPreferencesSyncContext {
  queryClient: QueryClient;
  store: JotaiStore;
}

const MAX_WRITE_ATTEMPTS = 2;

const registry = new Map<
  UiPreferenceKey,
  RegisteredPreference<UiPreferenceKey>
>();

const syncStates = new Map<
  UiPreferenceKey,
  PreferenceSyncState<UiPreferenceKey>
>();

let context: UiPreferencesSyncContext | null = null;

let syncFailureNotified = false;

function getSyncState<Key extends UiPreferenceKey>(
  key: Key,
): PreferenceSyncState<Key> {
  let state = syncStates.get(key);

  if (state === undefined) {
    state = { inFlight: null, pending: null };
    syncStates.set(key, state);
  }

  return state as PreferenceSyncState<Key>;
}

function areUiPreferenceValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function importUiPreferenceValueV1<Key extends UiPreferenceKey>(
  key: Key,
  value: unknown,
): UiPreferenceValue<Key> {
  const parsed = parseUiPreferenceValue(key, value);

  if (!parsed.success)
    throw new Error(`Invalid UI preference ${key}: ${parsed.message}`);

  return parsed.value;
}

function applyOperations<Key extends UiPreferenceKey>(
  operations: readonly SetStateAction<UiPreferenceValue<Key>>[],
  base: UiPreferenceValue<Key>,
): UiPreferenceValue<Key> {
  return operations.reduce<UiPreferenceValue<Key>>(
    (value, update) => (typeof update === "function" ? update(value) : update),
    base,
  );
}

function composeOperation<Key extends UiPreferenceKey>(
  operations: readonly SetStateAction<UiPreferenceValue<Key>>[],
  operation: SetStateAction<UiPreferenceValue<Key>>,
): SetStateAction<UiPreferenceValue<Key>>[] {
  return typeof operation === "function"
    ? [...operations, operation]
    : [operation];
}

export function registerSyncedUiPreference<Key extends UiPreferenceKey>(
  key: Key,
  registration: RegisteredPreference<Key>,
): void {
  registry.set(key, registration as RegisteredPreference<UiPreferenceKey>);

  if (context === null) return;
  const cached = getCachedUiPreferences(context.queryClient);

  if (cached !== undefined) {
    reconcileUiPreference(context, key, registration.valueAtom, cached);
  }
}

export function startUiPreferencesSync(
  nextContext: UiPreferencesSyncContext,
): () => void {
  context = nextContext;
  const cached = getCachedUiPreferences(nextContext.queryClient);

  if (cached !== undefined) reconcileUiPreferences(cached);

  return () => {
    if (context === nextContext) context = null;
  };
}

export function hasPendingUiPreferenceWrite(key: UiPreferenceKey): boolean {
  const state = syncStates.get(key);

  return (
    state !== undefined && (state.pending !== null || state.inFlight !== null)
  );
}

export function reconcileUiPreferences(response: UiPreferencesResponse): void {
  if (context === null) return;

  for (const [key, { valueAtom }] of registry) {
    reconcileUiPreference(context, key, valueAtom, response);
  }
}

function reconcileUiPreference<Key extends UiPreferenceKey>(
  activeContext: UiPreferencesSyncContext,
  key: Key,
  valueAtom: ValueAtom<Key>,
  response: UiPreferencesResponse,
): void {
  const state = getSyncState(key);

  if (state.pending !== null || state.inFlight !== null) return;
  const entry = response.preferences[key];

  if (entry === undefined) return;
  const value = importUiPreferenceValueV1(key, entry.value);

  const cachedEntry = getCachedUiPreferences(activeContext.queryClient)
    ?.preferences[key];

  if (cachedEntry !== undefined && cachedEntry.revision > entry.revision)
    return;

  if (areUiPreferenceValuesEqual(activeContext.store.get(valueAtom), value)) {
    return;
  }

  activeContext.store.set(valueAtom, value);
}

export function scheduleUiPreferenceWrite<Key extends UiPreferenceKey>(
  key: Key,
  update: SetStateAction<UiPreferenceValue<Key>>,
): void {
  if (context === null) return;
  const state = getSyncState(key);
  state.pending = composeOperation(state.pending ?? [], update);

  if (state.inFlight === null) void flushUiPreference(key);
}

async function readCurrentUiPreferences(
  queryClient: QueryClient,
): Promise<UiPreferencesResponse> {
  const cached = getCachedUiPreferences(queryClient);

  if (cached !== undefined) return cached;

  return refetchUiPreferences(queryClient);
}

async function refetchUiPreferences(
  queryClient: QueryClient,
): Promise<UiPreferencesResponse> {
  const response = await sdk.system.uiPreferences.list();
  setCachedUiPreferences(queryClient, response);

  return response;
}

function isUiPreferenceConflict(error: unknown): boolean {
  return error instanceof OmnyoHttpError && error.status === 409;
}

function recordServerEntry<Key extends UiPreferenceKey>(
  queryClient: QueryClient,
  key: Key,
  entry: UiPreferenceEntry<Key>,
): void {
  const cached = getCachedUiPreferences(queryClient);

  if (
    cached === undefined ||
    (cached.preferences[key]?.revision ?? -1) >= entry.revision
  ) {
    return;
  }

  setCachedUiPreferences(queryClient, {
    preferences: {
      ...cached.preferences,
      [key]: { ...entry, value: importUiPreferenceValueV1(key, entry.value) },
    },
  });
}

async function writeUiPreference<Key extends UiPreferenceKey>(
  queryClient: QueryClient,
  key: Key,
  operations: readonly SetStateAction<UiPreferenceValue<Key>>[],
): Promise<void> {
  let base = (await readCurrentUiPreferences(queryClient)).preferences[key];

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    if (base === undefined) return;

    const value = importUiPreferenceValueV1(
      key,
      applyOperations(operations, importUiPreferenceValueV1(key, base.value)),
    );

    if (base.revision > 0 && areUiPreferenceValuesEqual(value, base.value)) {
      return;
    }

    try {
      const response = await sdk.system.uiPreferences.set({
        expectedRevision: base.revision,
        key,
        value,
      });

      recordServerEntry(queryClient, key, {
        revision: response.revision,
        value: response.value,
      });

      return;
    } catch (error) {
      if (!isUiPreferenceConflict(error)) throw error;
    }

    base = (await refetchUiPreferences(queryClient)).preferences[key];
  }
}

function notifySyncFailure(error: unknown): void {
  if (syncFailureNotified) return;
  syncFailureNotified = true;
  appToast.error("Couldn’t sync preferences", {
    description:
      error instanceof Error ? error.message : "Changes stay on this device.",
  });
}

async function flushUiPreference<Key extends UiPreferenceKey>(
  key: Key,
): Promise<void> {
  const activeContext = context;
  const state = getSyncState(key);
  const operations = state.pending;

  if (
    activeContext === null ||
    operations === null ||
    state.inFlight !== null
  ) {
    return;
  }

  state.pending = null;
  let failed = false;

  const run = writeUiPreference(activeContext.queryClient, key, operations)
    .catch((error: unknown) => {
      failed = true;
      notifySyncFailure(error);
      invalidateCachedUiPreferences(activeContext.queryClient);
    })
    .finally(() => {
      state.inFlight = null;

      if (state.pending !== null) {
        void flushUiPreference(key);

        return;
      }

      if (failed) return;
      const cached = getCachedUiPreferences(activeContext.queryClient);

      if (cached !== undefined) reconcileUiPreferences(cached);
    });

  state.inFlight = run;
  await run;
}

export async function waitForUiPreferenceWrites(): Promise<void> {
  let settled = false;

  while (!settled) {
    settled = true;

    for (const state of syncStates.values()) {
      if (state.inFlight !== null) {
        settled = false;
        await state.inFlight;
      }
    }
  }
}

export function resetUiPreferencesSyncForTest(): void {
  syncStates.clear();
  context = null;
  syncFailureNotified = false;
}
