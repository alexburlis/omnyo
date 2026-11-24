import {
  storedSessionSchema,
  type SessionCacheLike,
} from "../session/session-cache";
import {
  SECURE_STORAGE_MAX_VALUE_BYTES,
  utf8ByteLength,
  type SecureStorageLike,
} from "../profiles/secure-storage";

export function createMigratingSessionCacheV1(
  storage: SecureStorageLike,
): SessionCacheLike {
  const pending = new Map<string, Promise<unknown>>();

  function serialize<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    const result = (pending.get(profileId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);

    pending.set(profileId, result);
    void result
      .finally(() => {
        if (pending.get(profileId) === result) pending.delete(profileId);
      })
      .catch(() => undefined);

    return result;
  }

  function keys(profileId: string) {
    return {
      legacy: `bb.connectSession.${profileId}`,
      canonical: `omnyo.connectSession.${profileId}`,
      receipt: `omnyo.connectSession.import.v1.${profileId}`,
    };
  }

  function parse(raw: string) {
    try {
      if (utf8ByteLength(raw) > SECURE_STORAGE_MAX_VALUE_BYTES)
        throw new Error();

      return storedSessionSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error(
        "Saved session is invalid. Its stored copy was preserved.",
      );
    }
  }

  async function verifiedWrite(key: string, value: string) {
    await storage.setItem(key, value);

    if ((await storage.getItem(key)) !== value)
      throw new Error("Saved session copy could not be verified.");
  }

  async function adopt(profileId: string) {
    const key = keys(profileId);
    const canonical = await storage.getItem(key.canonical);
    const receipt = await storage.getItem(key.receipt);

    if (receipt !== null && receipt !== "accepted-v1")
      throw new Error("Saved session migration receipt is invalid.");
    const current = canonical === null ? null : parse(canonical);

    if (receipt === "accepted-v1") return current;
    const legacy = await storage.getItem(key.legacy);

    if (legacy === null) return current;
    const previous = parse(legacy);

    if (
      current !== null &&
      JSON.stringify(current) !== JSON.stringify(previous)
    )
      throw new Error("Saved session conflict. Both copies were preserved.");

    if (canonical === null) await verifiedWrite(key.canonical, legacy);
    await verifiedWrite(key.receipt, "accepted-v1");

    return current ?? previous;
  }

  return {
    read: (id) => serialize(id, () => adopt(id)),
    write: (id, value) =>
      serialize(id, async () => {
        await adopt(id);
        const key = keys(id);
        const raw = JSON.stringify(value);
        parse(raw);
        await verifiedWrite(key.receipt, "accepted-v1");
        await verifiedWrite(key.canonical, raw);
      }),
    clear: (id) =>
      serialize(id, async () => {
        await adopt(id);
        const key = keys(id);
        await verifiedWrite(key.receipt, "accepted-v1");
        await storage.deleteItem(key.canonical);
      }),
  };
}
