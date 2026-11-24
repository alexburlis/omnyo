export function relativizeWorkspacePath(
  path: string,
  workspaceRoot: string | null,
): string {
  if (!workspaceRoot) return path;
  const normalizedRoot = workspaceRoot.replace(/\/+$/u, "");

  if (normalizedRoot.length === 0) return path;

  if (path.startsWith(`${normalizedRoot}/`)) {
    return path.slice(normalizedRoot.length + 1);
  }

  return path;
}
