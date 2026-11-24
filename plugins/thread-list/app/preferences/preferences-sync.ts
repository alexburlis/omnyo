import { toast } from "sonner";
import { z } from "zod";
import { atom, getDefaultStore, type PrimitiveAtom } from "jotai";

type PreferencesStore = ReturnType<typeof getDefaultStore>;

import {
  defaultPreferences,
  getPreferenceDefault,
  parsePreferenceValue,
  parseStoredPreferenceValue,
  PREFERENCE_KEYS,
  preferencesChangedSignalSchema,
  preferenceWriteReplySchema,
  type PreferenceKey,
  type PreferenceValue,
  type PreferenceValues,
} from "../../shared/preferences.js";

const WRITE_DEBOUNCE_MS = 150;

export function preferencesMirrorStorageKey(pluginId: string): string {
  return `omnyo.${pluginId}.preferences.v1`;
}

const mirrorPayloadSchemaV1 = z.record(z.string(), z.unknown());

const mirrorImportReceiptSchemaV1 = z
  .object({
    schema: z.literal(1),
    phase: z.enum(["prepared", "imported"]),
    legacyKey: z.string(),
    canonicalKey: z.string(),
    originalRaw: z.string(),
    acknowledged: z.record(z.string(), z.unknown()),
    serverValues: z.record(z.string(), z.unknown()),
  })
  .strict();

type MirrorImportReceiptV1 = z.infer<typeof mirrorImportReceiptSchemaV1>;

function isPreferenceKeyV1(key: string): key is PreferenceKey {
  return PREFERENCE_KEYS.some((known) => known === key);
}

function parseMirrorPayloadV1(raw: string): Record<string, unknown> {
  try {
    return mirrorPayloadSchemaV1.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      "Saved sidebar preferences are invalid. The original bytes were preserved.",
    );
  }
}

function parseMirrorReceiptV1(raw: string): MirrorImportReceiptV1 {
  try {
    const receipt = mirrorImportReceiptSchemaV1.parse(JSON.parse(raw));
    parseMirrorPayloadV1(receipt.originalRaw);

    for (const record of [receipt.acknowledged, receipt.serverValues]) {
      for (const [key, value] of Object.entries(record)) {
        if (
          !isPreferenceKeyV1(key) ||
          !parsePreferenceValue(key, value).success
        )
          throw new Error("Invalid preference acknowledgement");
      }
    }

    return receipt;
  } catch {
    throw new Error(
      "Saved sidebar preference import receipt is invalid. All copies were preserved.",
    );
  }
}

function persistMirrorReceiptV1(
  storage: Storage,
  key: string,
  previous: string | null,
  receipt: MirrorImportReceiptV1,
): string {
  if (storage.getItem(key) !== previous)
    throw new Error(
      "Saved sidebar preference import receipt changed. All copies were preserved.",
    );
  const serialized = JSON.stringify(receipt);

  if (serialized !== previous) storage.setItem(key, serialized);

  if (storage.getItem(key) !== serialized)
    throw new Error("Sidebar preference import receipt could not be verified.");

  return serialized;
}

function importLegacyPreferencesMirrorV1(
  storage: Storage,
  pluginId: string,
): {
  raw: string | null;
  receipt: MirrorImportReceiptV1 | null;
  receiptRaw: string | null;
  receiptKey: string;
} {
  const canonicalKey = preferencesMirrorStorageKey(pluginId);
  const legacyKey = `bb.${pluginId}.preferences.v1`;
  const receiptKey = `omnyo.${pluginId}.preferences-import.v1`;
  const legacy = storage.getItem(legacyKey);
  let canonical = storage.getItem(canonicalKey);
  let receiptRaw = storage.getItem(receiptKey);

  if (legacy !== null) parseMirrorPayloadV1(legacy);

  if (canonical !== null) parseMirrorPayloadV1(canonical);

  if (legacy === null && receiptRaw === null)
    return { raw: canonical, receipt: null, receiptRaw, receiptKey };
  let receipt: MirrorImportReceiptV1;

  if (receiptRaw === null) {
    if (canonical !== null)
      throw new Error(
        "Saved sidebar preferences conflict. Both copies were preserved.",
      );

    if (legacy === null)
      return { raw: canonical, receipt: null, receiptRaw, receiptKey };
    receipt = {
      schema: 1,
      phase: "prepared",
      legacyKey,
      canonicalKey,
      originalRaw: legacy,
      acknowledged: {},
      serverValues: {},
    };
    receiptRaw = persistMirrorReceiptV1(storage, receiptKey, null, receipt);
  } else {
    receipt = parseMirrorReceiptV1(receiptRaw);

    if (
      receipt.legacyKey !== legacyKey ||
      receipt.canonicalKey !== canonicalKey
    )
      throw new Error(
        "Saved sidebar preference import receipt conflicts with this plugin.",
      );
  }

  if (receipt.phase === "imported") {
    if (legacy !== null || canonical === null)
      throw new Error(
        "Saved sidebar preferences conflict with the completed import. All copies were preserved.",
      );

    return { raw: canonical, receipt, receiptRaw, receiptKey };
  }

  const raw = receipt.originalRaw;

  if (
    (legacy !== null && legacy !== raw) ||
    (canonical !== null && canonical !== raw) ||
    (legacy === null && canonical === null)
  )
    throw new Error(
      "Saved sidebar preferences changed during import. All copies were preserved.",
    );

  if (
    storage.getItem(legacyKey) !== legacy ||
    storage.getItem(canonicalKey) !== canonical ||
    storage.getItem(receiptKey) !== receiptRaw
  )
    throw new Error(
      "Saved sidebar preferences changed during import. All copies were preserved.",
    );

  if (canonical === null) storage.setItem(canonicalKey, raw);

  if (storage.getItem(canonicalKey) !== raw)
    throw new Error("Saved sidebar preference copy could not be verified.");

  if (storage.getItem(legacyKey) !== legacy)
    throw new Error(
      "Saved sidebar preferences changed during import. All copies were preserved.",
    );

  if (legacy !== null) storage.removeItem(legacyKey);

  if (
    storage.getItem(legacyKey) !== null ||
    storage.getItem(canonicalKey) !== raw
  )
    throw new Error(
      "Saved sidebar preference import cleanup could not be verified.",
    );
  receipt = { ...receipt, phase: "imported" };
  receiptRaw = persistMirrorReceiptV1(storage, receiptKey, receiptRaw, receipt);
  canonical = raw;

  return { raw: canonical, receipt, receiptRaw, receiptKey };
}

function mirrorConflictsV1(receipt: MirrorImportReceiptV1): PreferenceKey[] {
  const original = parseMirrorPayloadV1(receipt.originalRaw);

  return PREFERENCE_KEYS.filter((key) => {
    if (
      !Object.hasOwn(original, key) ||
      Object.hasOwn(receipt.acknowledged, key)
    )
      return false;
    const imported = parseStoredPreferenceValue(key, original[key]);
    const server = parsePreferenceValue(key, receipt.serverValues[key]);

    return (
      imported.success &&
      server.success &&
      JSON.stringify(imported.value) !== JSON.stringify(server.value)
    );
  });
}

function mirrorConflictErrorV1(
  conflicts: readonly PreferenceKey[],
): Error | null {
  return conflicts.length === 0
    ? null
    : new Error(
        `Saved sidebar preferences conflict for ${conflicts.join(", ")}. Original and server values were preserved. Use omnyo plugin rpc call ${state.pluginId} setPreference --input-file FILE with the chosen JSON key/value, then Reload the thread list.`,
      );
}

function reconcileMirrorAuthorityV1(
  storage: Storage | null,
  values: Partial<PreferenceValues>,
  acknowledgedKey: PreferenceKey | null,
): PreferenceKey[] {
  if (storage === null || state.pluginId === null) return [];
  const imported = importLegacyPreferencesMirrorV1(storage, state.pluginId);

  if (imported.receipt === null) return [];
  const original = parseMirrorPayloadV1(imported.receipt.originalRaw);

  const receipt = {
    ...imported.receipt,
    acknowledged: { ...imported.receipt.acknowledged },
    serverValues: { ...imported.receipt.serverValues },
  };

  if (acknowledgedKey === null) {
    for (const key of PREFERENCE_KEYS) {
      if (
        Object.hasOwn(original, key) &&
        parseStoredPreferenceValue(key, original[key]).success &&
        !Object.hasOwn(values, key)
      )
        throw new Error(
          `Current sidebar preference ${key} is invalid or missing. Imported values were preserved.`,
        );
    }
  }

  for (const key of PREFERENCE_KEYS) {
    if (!Object.hasOwn(values, key)) continue;
    const server = parsePreferenceValue(key, values[key]);

    if (!server.success)
      throw new Error(
        "Current sidebar preferences are invalid. Imported values were preserved.",
      );
    receipt.serverValues[key] = server.value;

    if (!Object.hasOwn(original, key)) continue;

    if (key === acknowledgedKey) {
      receipt.acknowledged[key] = server.value;
      continue;
    }

    if (Object.hasOwn(receipt.acknowledged, key)) continue;
    const previous = parseStoredPreferenceValue(key, original[key]);

    if (
      key === acknowledgedKey ||
      (previous.success &&
        JSON.stringify(previous.value) === JSON.stringify(server.value))
    )
      receipt.acknowledged[key] = server.value;
  }

  const conflicts = mirrorConflictsV1(receipt);

  const serialized = persistMirrorReceiptV1(
    storage,
    imported.receiptKey,
    imported.receiptRaw,
    receipt,
  );

  const unresolved = Object.keys(original).some(
    (key) =>
      !isPreferenceKeyV1(key) || !Object.hasOwn(receipt.acknowledged, key),
  );

  if (!unresolved && conflicts.length === 0) {
    if (storage.getItem(imported.receiptKey) !== serialized)
      throw new Error(
        "Sidebar preference import receipt changed before cleanup.",
      );
    storage.removeItem(imported.receiptKey);

    if (storage.getItem(imported.receiptKey) !== null)
      throw new Error(
        "Sidebar preference import receipt cleanup could not be verified.",
      );
  }

  return conflicts;
}

function setMirrorConflictV1(conflicts: readonly PreferenceKey[]): void {
  const error = mirrorConflictErrorV1(conflicts);

  if (error !== null) {
    reportPreferencesSyncError(error);

    return;
  }

  activeStore().set(state.errorAtom, null);

  if (state.hasServerSnapshot) activeStore().set(state.readyAtom, true);

  if (state.pluginId !== null)
    toast.dismiss(`${state.pluginId}:preferences-import-v1`);
}

export interface PreferencesRpc {
  call(method: "listPreferences", input: null): Promise<unknown>;
  call(
    method: "setPreference",
    input: { key: PreferenceKey; value: unknown; origin: string },
  ): Promise<unknown>;
}

interface SyncState {
  valueAtoms: Map<PreferenceKey, PrimitiveAtom<unknown>>;
  readyAtom: PrimitiveAtom<boolean>;
  errorAtom: PrimitiveAtom<Error | null>;
  hasServerSnapshot: boolean;
  serverValues: Partial<PreferenceValues>;
  pendingWrites: Map<
    PreferenceKey,
    { timer: number | null; inFlight: boolean; value: unknown }
  >;
  rpc: PreferencesRpc | null;
  store: PreferencesStore | null;
  pluginId: string | null;
  hydrateGeneration: number;
  origin: string;
}

function createOrigin(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function createSyncState(): SyncState {
  return {
    valueAtoms: new Map(),
    readyAtom: atom(false),
    errorAtom: atom<Error | null>(null),
    hasServerSnapshot: false,
    serverValues: {},
    pendingWrites: new Map(),
    rpc: null,
    store: null,
    pluginId: null,
    hydrateGeneration: 0,
    origin: createOrigin(),
  };
}

const state = createSyncState();

function activeStore(): PreferencesStore {
  return state.store ?? getDefaultStore();
}

export function attachPreferencesStore(
  store: PreferencesStore,
  pluginId: string,
): void {
  state.store = store;
  state.pluginId = pluginId;
}

function mirrorStorageKey(): string | null {
  return state.pluginId === null
    ? null
    : preferencesMirrorStorageKey(state.pluginId);
}

function logPrefix(): string {
  return state.pluginId === null ? "" : `${state.pluginId}: `;
}

function valueAtomFor<Key extends PreferenceKey>(
  key: Key,
): PrimitiveAtom<PreferenceValue<Key>> {
  let existing = state.valueAtoms.get(key);

  if (existing === undefined) {
    existing = atom<unknown>(getPreferenceDefault(key));
    state.valueAtoms.set(key, existing);
  }

  return existing as PrimitiveAtom<PreferenceValue<Key>>;
}

export function preferenceValueAtom<Key extends PreferenceKey>(
  key: Key,
): PrimitiveAtom<PreferenceValue<Key>> {
  return valueAtomFor(key);
}

export function preferencesReadyAtom(): PrimitiveAtom<boolean> {
  return state.readyAtom;
}

export function preferencesErrorAtom(): PrimitiveAtom<Error | null> {
  return state.errorAtom;
}

export function reportPreferencesSyncError(error: unknown): void {
  const failure =
    error instanceof Error
      ? error
      : new Error("Could not load saved sidebar preferences.");

  activeStore().set(state.errorAtom, failure);
  activeStore().set(state.readyAtom, false);

  if (state.pluginId !== null)
    toast.error("Sidebar preferences need attention", {
      id: `${state.pluginId}:preferences-import-v1`,
      description: failure.message,
      duration: Infinity,
    });
}

export function clearPreferencesSyncError(): void {
  activeStore().set(state.errorAtom, null);
  activeStore().set(state.readyAtom, false);
}

function readMirror(storage: Storage | null): Partial<PreferenceValues> | null {
  if (storage === null || state.pluginId === null) return null;
  const imported = importLegacyPreferencesMirrorV1(storage, state.pluginId);

  if (imported.raw === null) return null;
  const parsed = parseMirrorPayloadV1(imported.raw);
  const values: Partial<PreferenceValues> = {};

  for (const key of PREFERENCE_KEYS) {
    const candidate = parsed[key];

    if (candidate === undefined) continue;
    const result = parseStoredPreferenceValue(key, candidate);

    if (result.success)
      (values as Record<PreferenceKey, unknown>)[key] = result.value;
  }

  return values;
}

function writeMirror(
  storage: Storage | null,
  changedKeys: readonly PreferenceKey[],
): void {
  const storageKey = mirrorStorageKey();

  if (storage === null || storageKey === null || state.pluginId === null)
    return;
  const imported = importLegacyPreferencesMirrorV1(storage, state.pluginId);

  const snapshot =
    imported.raw === null ? {} : parseMirrorPayloadV1(imported.raw);

  const original =
    imported.receipt === null
      ? null
      : parseMirrorPayloadV1(imported.receipt.originalRaw);

  const store = activeStore();

  for (const key of PREFERENCE_KEYS) {
    if (!changedKeys.includes(key)) {
      if (
        original !== null &&
        Object.hasOwn(original, key) &&
        !Object.hasOwn(imported.receipt?.acknowledged ?? {}, key)
      )
        continue;

      if (
        snapshot[key] !== undefined &&
        !parseStoredPreferenceValue(key, snapshot[key]).success
      )
        continue;
    }

    snapshot[key] = store.get(valueAtomFor(key));
  }

  const serialized = JSON.stringify(snapshot);
  storage.setItem(storageKey, serialized);

  if (storage.getItem(storageKey) !== serialized)
    throw new Error("Saved sidebar preferences could not be verified.");
}

let mirrorStorageOverride: Storage | null | undefined;

function mirrorStorage(): Storage | null {
  if (mirrorStorageOverride !== undefined) return mirrorStorageOverride;

  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

export function setPreferencesMirrorStorageForTest(
  storage: Storage | null | undefined,
): void {
  mirrorStorageOverride = storage;
}

function applyValues(values: Partial<PreferenceValues>): void {
  const store = activeStore();

  for (const key of PREFERENCE_KEYS) {
    const value = values[key];

    if (value === undefined) continue;

    if (state.pendingWrites.has(key)) continue;
    store.set(valueAtomFor(key), value);
  }
}

export function hydratePreferencesFromMirror(): boolean {
  const mirrored = readMirror(mirrorStorage());

  if (mirrored === null) return false;
  applyValues(mirrored);

  return true;
}

export async function hydratePreferences(rpc: PreferencesRpc): Promise<void> {
  state.rpc = rpc;
  const generation = ++state.hydrateGeneration;
  const response = await rpc.call("listPreferences", null);

  if (generation !== state.hydrateGeneration) return;

  const preferences =
    typeof response === "object" && response !== null
      ? (response as { preferences?: unknown }).preferences
      : undefined;

  const values: Partial<PreferenceValues> = {};

  if (typeof preferences === "object" && preferences !== null) {
    for (const key of PREFERENCE_KEYS) {
      const result = parseStoredPreferenceValue(
        key,
        (preferences as Record<string, unknown>)[key],
      );

      if (result.success) {
        (values as Record<PreferenceKey, unknown>)[key] = result.value;
      }
    }
  }

  state.hasServerSnapshot = true;
  state.serverValues = values;
  const conflicts = reconcileMirrorAuthorityV1(mirrorStorage(), values, null);
  const conflict = mirrorConflictErrorV1(conflicts);

  if (conflict !== null) {
    setMirrorConflictV1(conflicts);
    throw conflict;
  }

  applyValues({ ...defaultPreferences(), ...values });

  try {
    writeMirror(mirrorStorage(), []);
  } catch (error: unknown) {
    reportPreferencesSyncError(error);
    throw error;
  }

  activeStore().set(state.errorAtom, null);
  activeStore().set(state.readyAtom, true);

  if (state.pluginId !== null)
    toast.dismiss(`${state.pluginId}:preferences-import-v1`);
}

export function applyRemotePreferenceSignal(payload: unknown): void {
  try {
    const parsed = preferencesChangedSignalSchema.safeParse(payload);

    if (!parsed.success) return;
    const { key, value, origin } = parsed.data;

    if (origin === state.origin) return;
    const result = parsePreferenceValue(key, value);

    if (!result.success) return;
    const values = { [key]: result.value } as Partial<PreferenceValues>;
    state.serverValues = { ...state.serverValues, ...values };
    const conflicts = reconcileMirrorAuthorityV1(mirrorStorage(), values, key);
    applyValues(
      conflicts.length === 0 && state.hasServerSnapshot
        ? state.serverValues
        : values,
    );
    writeMirror(mirrorStorage(), [key]);
    setMirrorConflictV1(conflicts);
  } catch (error: unknown) {
    reportPreferencesSyncError(error);
    throw error;
  }
}

function flushWrite(key: PreferenceKey): void {
  const pending = state.pendingWrites.get(key);

  if (pending === undefined) return;
  pending.timer = null;

  if (pending.inFlight) return;
  const rpc = state.rpc;

  if (rpc === null) {
    state.pendingWrites.delete(key);

    return;
  }

  pending.inFlight = true;
  const value = pending.value;
  void rpc
    .call("setPreference", { key, value, origin: state.origin })
    .then((response: unknown) => {
      const reply = preferenceWriteReplySchema.safeParse(response);

      if (!reply.success || reply.data.key !== key)
        throw new Error(
          "Preference write acknowledgement did not match its requested field.",
        );
      const actual = parsePreferenceValue(key, reply.data.value);
      const requested = parsePreferenceValue(key, value);

      if (
        !actual.success ||
        !requested.success ||
        JSON.stringify(actual.value) !== JSON.stringify(requested.value)
      )
        throw new Error(
          "Preference write acknowledgement did not match its requested value.",
        );
      const values = { [key]: actual.value } as Partial<PreferenceValues>;
      state.serverValues = { ...state.serverValues, ...values };

      const conflicts = reconcileMirrorAuthorityV1(
        mirrorStorage(),
        values,
        key,
      );

      if (conflicts.length === 0 && state.hasServerSnapshot)
        applyValues(state.serverValues);
      writeMirror(mirrorStorage(), [key]);
      setMirrorConflictV1(conflicts);
    })
    .catch((error: unknown) => {
      reportPreferencesSyncError(error);
      console.warn(
        `${logPrefix()}saving preference ${key} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => {
      const current = state.pendingWrites.get(key);

      if (current !== pending) return;

      current.inFlight = false;

      if (current.timer !== null) return;

      if (!Object.is(current.value, value)) {
        flushWrite(key);

        return;
      }

      state.pendingWrites.delete(key);
    });
}

export function schedulePreferenceWrite(
  key: PreferenceKey,
  value: unknown,
): void {
  writeMirror(mirrorStorage(), [key]);
  let pending = state.pendingWrites.get(key);

  if (pending === undefined) {
    pending = { timer: null, inFlight: false, value };
    state.pendingWrites.set(key, pending);
  }

  pending.value = value;

  if (pending.timer !== null) window.clearTimeout(pending.timer);
  pending.timer = window.setTimeout(() => flushWrite(key), WRITE_DEBOUNCE_MS);
}

export async function flushPreferenceWritesForTest(): Promise<void> {
  for (const [key, pending] of [...state.pendingWrites]) {
    if (pending.timer !== null) {
      window.clearTimeout(pending.timer);
      flushWrite(key);
    }
  }

  await Promise.resolve();
  await Promise.resolve();
}

export function resetPreferencesSyncForTest(): void {
  for (const pending of state.pendingWrites.values()) {
    if (pending.timer !== null) window.clearTimeout(pending.timer);
  }

  state.pendingWrites.clear();
  state.rpc = null;
  state.hasServerSnapshot = false;
  state.serverValues = {};
  state.hydrateGeneration += 1;
  const store = activeStore();

  for (const key of PREFERENCE_KEYS) {
    store.set(valueAtomFor(key), getPreferenceDefault(key));
  }

  store.set(state.readyAtom, false);
  store.set(state.errorAtom, null);
  state.store = null;
  state.pluginId = null;
}
