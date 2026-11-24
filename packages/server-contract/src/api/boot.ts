import { z } from "zod";

export const BOOT_PART_NAMES = [
  "systemConfig",
  "uiPreferences",
  "serverMove",
  "appUpdate",
  "pluginInstallJobs",
  "pluginUpdateJobs",
  "hosts",
  "sidebarBootstrap",
  "plugins",
  "systemVersion",
  "systemProviders",
  "pluginSafeMode",
  "shelvedThreads",
  "threadAttention",
] as const;

export const bootPartNameSchema = z.enum(BOOT_PART_NAMES);

export type BootPartName = z.infer<typeof bootPartNameSchema>;

export const BOOT_PART_PATHS = {
  systemConfig: "/system/config",
  uiPreferences: "/preferences/ui",
  serverMove: "/server/move",
  appUpdate: "/system/app-update",
  pluginInstallJobs: "/plugins/install-jobs",
  pluginUpdateJobs: "/plugins/update-jobs",
  hosts: "/hosts?includeCreating=false",
  sidebarBootstrap: "/sidebar-bootstrap",
  plugins: "/plugins",
  systemVersion: "/system/version",
  systemProviders: "/system/providers",
  pluginSafeMode: "/plugins/safe-mode",
  shelvedThreads: "/threads?shelved=true&limit=200&offset=0",
  threadAttention: "/thread-attention",
} as const satisfies Record<BootPartName, `/${string}`>;

export const BOOT_API_PATH = "/api/v1/boot";

export const bootQuerySchema = z.object({
  parts: z.string().min(1).optional(),
});

export type BootQuery = z.infer<typeof bootQuerySchema>;

export function parseBootPartList(value: string | undefined): BootPartName[] {
  if (value === undefined) return [...BOOT_PART_NAMES];

  const names = z.array(bootPartNameSchema).min(1).parse(value.split(","));

  return BOOT_PART_NAMES.filter((name) => names.includes(name));
}

export function formatBootPartList(names: readonly BootPartName[]): string {
  return BOOT_PART_NAMES.filter((name) => names.includes(name)).join(",");
}

export const bootPartResultSchema = z.object({
  status: z.number().int().min(200).max(599),
  body: z.unknown(),
});

export type BootPartResult = z.infer<typeof bootPartResultSchema>;

export const bootResponseSchema = z.object({
  version: z.literal(1),
  serverIdentity: z.string().min(1),
  parts: z.partialRecord(bootPartNameSchema, bootPartResultSchema),
});

export type BootResponse = z.infer<typeof bootResponseSchema>;
