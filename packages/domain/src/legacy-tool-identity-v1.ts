export const LEGACY_TOOL_SERVER_V1 = "bb";

export const LEGACY_BRIDGE_MCP_SERVER_V1 = "bb-bridge";

export const legacyOwnedToolNamesV1 = [
  ["bb_workflow_run", "omnyo_workflow_run"],
  ["bb_workflow_result", "omnyo_workflow_result"],
] as const;

export function importLegacyOwnedToolNameV1(name: string): string | null {
  return (
    legacyOwnedToolNamesV1.find(([legacy]) => name === legacy)?.[1] ?? null
  );
}

export function importLegacyOwnedToolItemV1(item: unknown): unknown {
  if (item === null || typeof item !== "object" || Array.isArray(item))
    return item;

  if (
    !("type" in item) ||
    item.type !== "toolCall" ||
    !("tool" in item) ||
    typeof item.tool !== "string" ||
    !("server" in item) ||
    item.server !== LEGACY_TOOL_SERVER_V1
  )
    return item;
  const tool = importLegacyOwnedToolNameV1(item.tool);

  return tool === null ? item : { ...item, tool, server: "omnyo" };
}
