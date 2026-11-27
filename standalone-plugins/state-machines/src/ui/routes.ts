export const PANEL_PATH = "machines";

export type Selection = { kind: "state"; id: string } | { kind: "transition"; id: string } | null;

export type InstanceTab = "graph" | "outline" | "log";

export type Route =
  | { screen: "list" }
  | { screen: "new" }
  | { screen: "attention" }
  | { screen: "machine"; machineId: string }
  | {
      screen: "instance";
      machineId: string;
      instanceId: string;
      view: InstanceTab;
      selection: Selection;
    }
  | { screen: "draft"; machineId: string; selection: Selection }
  | { screen: "versions"; machineId: string }
  | {
      screen: "version";
      machineId: string;
      versionId: string;
      compareWith: string | null;
      selection: Selection;
    }
  | { screen: "settings"; machineId: string }
  | { screen: "not-found"; subPath: string };

const ID = /^[A-Za-z0-9_-]{1,256}$/;

function parseSelection(segment: string | undefined): Selection {
  if (segment === undefined || !segment.startsWith("@")) return null;

  const [kind, id] = segment.slice(1).split(":", 2);

  if (id === undefined || !ID.test(id)) return null;

  if (kind === "state") return { kind: "state", id };

  if (kind === "tr") return { kind: "transition", id };

  return null;
}

function selectionSegment(selection: Selection): string {
  if (selection === null) return "";

  return `/@${selection.kind === "state" ? "state" : "tr"}:${selection.id}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(subPath: string): Route {
  const all = subPath
    .split("/")
    .filter((part) => part.length > 0)
    .map(decodeSegment);

  const last = all.at(-1);
  const selection = parseSelection(last);
  const parts = selection === null && last?.startsWith("@") !== true ? all : all.slice(0, -1);

  if (parts.length === 0) return { screen: "list" };

  if (parts.length === 1 && parts[0] === "new") return { screen: "new" };

  if (parts.length === 1 && parts[0] === "attention") return { screen: "attention" };

  const [head, machineId, section, sectionId, tail, tailId] = parts;

  if (head !== "m" || machineId === undefined || !ID.test(machineId))
    return { screen: "not-found", subPath };

  if (section === undefined) return { screen: "machine", machineId };

  if (section === "draft" && sectionId === undefined)
    return { screen: "draft", machineId, selection };

  if (section === "versions" && sectionId === undefined) return { screen: "versions", machineId };

  if (section === "settings" && sectionId === undefined) return { screen: "settings", machineId };

  if (section === "v" && sectionId !== undefined && ID.test(sectionId)) {
    if (tail === undefined)
      return { screen: "version", machineId, versionId: sectionId, compareWith: null, selection };

    if (tail === "compare" && tailId !== undefined && ID.test(tailId))
      return { screen: "version", machineId, versionId: sectionId, compareWith: tailId, selection };
  }

  if (section === "i" && sectionId !== undefined && ID.test(sectionId) && tailId === undefined) {
    if (tail === undefined || tail === "graph" || tail === "outline" || tail === "log")
      return {
        screen: "instance",
        machineId,
        instanceId: sectionId,
        view: tail ?? "graph",
        selection,
      };
  }

  return { screen: "not-found", subPath };
}

export function formatRoute(route: Route): string {
  switch (route.screen) {
    case "list":
      return "";
    case "new":
      return "new";
    case "attention":
      return "attention";
    case "machine":
      return `m/${route.machineId}`;
    case "instance":
      return `m/${route.machineId}/i/${route.instanceId}${route.view === "graph" ? "" : `/${route.view}`}${selectionSegment(route.selection)}`;
    case "draft":
      return `m/${route.machineId}/draft${selectionSegment(route.selection)}`;
    case "versions":
      return `m/${route.machineId}/versions`;
    case "version":
      return `m/${route.machineId}/v/${route.versionId}${route.compareWith === null ? "" : `/compare/${route.compareWith}`}${selectionSegment(route.selection)}`;
    case "settings":
      return `m/${route.machineId}/settings`;
    case "not-found":
      return route.subPath;
  }
}
