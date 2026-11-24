export const RESERVED_CORE_CLI_COMMANDS: readonly string[] = [
  "browser",
  "callback",
  "diagnostics",
  "environment",
  "file",
  "guide",
  "help",
  "inbox",
  "machine",
  "marketplace",
  "plugin",
  "preview",
  "project",
  "prompt-history",
  "provider",
  "question",
  "server",
  "settings",
  "skill",
  "status",
  "terminal",
  "theme",
  "thread",
  "updates",
  "voice",
  "wait",
];

export function pluginCliCall(pluginId: string, name: string): string {
  if (RESERVED_CORE_CLI_COMMANDS.includes(name))
    return `omnyo plugin run ${pluginId}`;

  return `omnyo ${name}`;
}
