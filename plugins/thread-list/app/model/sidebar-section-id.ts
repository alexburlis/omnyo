export type CollapsibleSidebarSectionId = "pinned" | "threads" | "shelf";

export type SidebarSectionId =
  | CollapsibleSidebarSectionId
  | `project:${string}`
  | `section:${string}`
  | `machine:${string}`;

export function isCollapsibleSidebarSectionId(
  value: string,
): value is CollapsibleSidebarSectionId {
  return value === "pinned" || value === "threads" || value === "shelf";
}
