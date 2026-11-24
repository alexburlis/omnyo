export function importLegacyTasksBrowserKeyV1(
  legacyKey: string,
  key: string,
): void {
  try {
    const storage = window.localStorage;
    const legacy = storage.getItem(legacyKey);

    if (legacy === null) return;

    if (storage.getItem(key) === null) storage.setItem(key, legacy);
    storage.removeItem(legacyKey);
  } catch {}
}
