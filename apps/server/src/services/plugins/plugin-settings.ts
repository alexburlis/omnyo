import {
  getPluginSettingsValues,
  setPluginSettingsValues,
  type DbConnection,
} from "@omnyo/db";
import type {
  PluginSettingDescriptor,
  PluginSettingDescriptors,
  PluginSettingValue,
} from "@omnyo/plugin-sdk";
import { coerceStoredPluginSettingValue } from "@omnyo/plugin-sdk/internal/host-policy";
import type { PluginSettingDescriptor as PublicPluginSettingDescriptor } from "@omnyo/server-contract";
import type { PluginSecretStore } from "./plugin-secrets.js";

export class PluginSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSettingsValidationError";
  }
}

function isSecret(descriptor: PluginSettingDescriptor): boolean {
  return descriptor.type === "string" && descriptor.secret === true;
}

interface PluginSettingsStoreArgs {
  db: DbConnection;
  secrets: PluginSecretStore;
  pluginId: string;
  descriptors: PluginSettingDescriptors;
}

export function sealLegacySecretSettings(
  args: Pick<PluginSettingsStoreArgs, "secrets" | "descriptors">,
): Promise<void> {
  return args.secrets.sealLegacy(
    Object.entries(args.descriptors)
      .filter(([, descriptor]) => isSecret(descriptor))
      .map(([key]) => key),
  );
}

function parseStoredSettingValue(
  descriptor: PluginSettingDescriptor,
  raw: string | undefined,
): PluginSettingValue | undefined {
  let parsed: unknown;

  if (raw !== undefined) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }

  return coerceStoredPluginSettingValue(descriptor, parsed);
}

export function readPluginSettingsValuesSync(
  args: Omit<PluginSettingsStoreArgs, "secrets">,
): Record<string, PluginSettingValue | undefined> {
  const stored = getPluginSettingsValues(args.db, args.pluginId);
  const values: Record<string, PluginSettingValue | undefined> = {};

  for (const [key, descriptor] of Object.entries(args.descriptors)) {
    if (isSecret(descriptor)) continue;
    values[key] = parseStoredSettingValue(
      descriptor,
      Object.hasOwn(stored, key) ? stored[key] : undefined,
    );
  }

  return values;
}

export async function readPluginSettingsValues(
  args: PluginSettingsStoreArgs,
): Promise<Record<string, PluginSettingValue | undefined>> {
  const values = readPluginSettingsValuesSync(args);

  for (const [key, descriptor] of Object.entries(args.descriptors)) {
    if (!isSecret(descriptor)) continue;
    values[key] = (await args.secrets.get(key)) ?? descriptor.default;
  }

  return values;
}

export async function writePluginSettingsUpdate(
  args: PluginSettingsStoreArgs & { values: Record<string, unknown> },
): Promise<void> {
  const rowUpdates: Record<string, string | null> = {};

  for (const [key, value] of Object.entries(args.values)) {
    const descriptor = Object.hasOwn(args.descriptors, key)
      ? args.descriptors[key]
      : undefined;

    if (!descriptor) continue;

    if (isSecret(descriptor)) {
      if (value === null) await args.secrets.delete(key);
      else await args.secrets.set(key, value as string);
      continue;
    }

    rowUpdates[key] = value === null ? null : JSON.stringify(value);
  }

  if (Object.keys(rowUpdates).length > 0) {
    setPluginSettingsValues(args.db, args.pluginId, rowUpdates);
  }
}

export interface PluginSettingsView {
  schema: Record<string, PublicPluginSettingDescriptor>;
  values: Record<string, unknown>;
}

function publicSettingDescriptor(
  descriptor: PluginSettingDescriptor,
): PublicPluginSettingDescriptor {
  const publicDescriptor = { ...descriptor };
  delete publicDescriptor.experimental_schema;

  return publicDescriptor;
}

export async function buildPluginSettingsView(
  args: PluginSettingsStoreArgs,
): Promise<PluginSettingsView> {
  const effective = readPluginSettingsValuesSync(args);
  const values: Record<string, unknown> = {};

  for (const [key, descriptor] of Object.entries(args.descriptors)) {
    if (isSecret(descriptor)) {
      values[key] = { set: await args.secrets.has(key) };
    } else if (effective[key] !== undefined) {
      values[key] = effective[key];
    }
  }

  return {
    schema: Object.fromEntries(
      Object.entries(args.descriptors).map(([key, descriptor]) => [
        key,
        publicSettingDescriptor(descriptor),
      ]),
    ),
    values,
  };
}
