type ProjectTarget = { kind: "s" | "v" | "c" | "u"; id: string } | { kind: "h" };

export function readProjectRoute(subPath: string) {
  const [projectId = "", kind, id] = subPath.split("/");

  return { projectId, kind, id };
}

export function projectPath(projectId: string, target?: ProjectTarget): string {
  if (!target) return projectId;

  return target.kind === "h" ? `${projectId}/h` : `${projectId}/${target.kind}/${target.id}`;
}

export function projectHref(pluginId: string, projectId: string, target?: ProjectTarget): string {
  const encoded =
    target && target.kind !== "h" ? { ...target, id: encodeURIComponent(target.id) } : target;

  return `/plugins/${encodeURIComponent(pluginId)}/p/${projectPath(encodeURIComponent(projectId), encoded)}`;
}
