import { z } from "zod";
import {
  fetchPluginSettings,
  type PluginSettingsRequest,
  type PluginSettingsTransport,
} from "./plugins.js";

const compatiblePluginSettingDescriptorSchema = z.looseObject({
  type: z.enum(["string", "number", "boolean", "select", "project"]),
  label: z.string(),
  description: z.string().optional(),
  experimental_section: z.looseObject({ title: z.string() }).optional(),
  secret: z.literal(true).optional(),
  default: z.union([z.string(), z.number().finite(), z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
});

const compatiblePluginSettingsResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  schema: z
    .record(z.string(), compatiblePluginSettingDescriptorSchema)
    .optional(),
  values: z.record(z.string(), z.unknown()).optional(),
});

export type CompatiblePluginSettingsResult = z.infer<
  typeof compatiblePluginSettingsResultSchema
>;

export async function requestCompatiblePluginSettings(
  transport: PluginSettingsTransport,
  request: PluginSettingsRequest,
): Promise<CompatiblePluginSettingsResult> {
  const { path, response } = fetchPluginSettings(transport, request);
  const result = await response;
  const text = await result.text();
  let body: unknown;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Unexpected response from ${path} (${result.status}): ${text.slice(0, 200)}`,
    );
  }

  if (!result.ok && ![400, 404, 409, 422].includes(result.status)) {
    throw new Error(`${path} failed: HTTP ${result.status}`);
  }

  return compatiblePluginSettingsResultSchema.parse(body);
}
