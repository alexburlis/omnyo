const WATCHED_KEY = "omnyo.watched-plugin-updates";

const REPORTED_KEY = "omnyo.reported-plugin-updates";

function readIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");

    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function setTrackedId(key: string, id: string, tracked: boolean): void {
  const ids = readIds(key).filter((candidate) => candidate !== id);

  if (tracked) ids.push(id);

  try {
    sessionStorage.setItem(key, JSON.stringify(ids.slice(-100)));
  } catch {}
}

export function isWatchedPluginUpdate(id: string): boolean {
  return readIds(WATCHED_KEY).includes(id);
}

export function trackPluginUpdate(id: string, active: boolean): void {
  setTrackedId(WATCHED_KEY, id, active);
}

export function hasReportedPluginUpdate(id: string): boolean {
  return readIds(REPORTED_KEY).includes(id);
}

export function markPluginUpdateReported(id: string): void {
  setTrackedId(REPORTED_KEY, id, true);
}
