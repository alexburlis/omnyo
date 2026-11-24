import type { PluginKvStorage, PluginSecrets } from "@omnyo/plugin-sdk";

export async function moveKvValueToSecret(
  kv: Pick<PluginKvStorage, "get" | "delete">,
  secrets: PluginSecrets,
  key: string,
  name: string,
): Promise<void> {
  const row = await kv.get<unknown>(key);

  if (row === undefined) return;
  const value = JSON.stringify(row);
  await secrets.set(name, value);

  if ((await secrets.get(name)) !== value) {
    throw new Error(
      `Secret "${name}" did not read back the value moved from plugin storage key "${key}".`,
    );
  }

  await kv.delete(key);
}

export async function readJsonSecret(
  secrets: PluginSecrets,
  name: string,
): Promise<unknown> {
  const value = await secrets.get(name);

  if (value === undefined) return undefined;

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
