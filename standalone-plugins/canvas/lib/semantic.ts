export type SemanticDetail = "map" | "overview" | "evidence" | "sources";

export function nextSemanticDetail(previous: SemanticDetail, zoom: number): SemanticDetail {
  if (zoom <= 0.12) return "map";

  if (previous === "map" && zoom < 0.14) return "map";

  if (zoom <= 0.15) return "overview";

  if (zoom >= 1.15) return "sources";

  if (previous === "overview" && zoom < 0.18) return "overview";

  if (previous === "sources" && zoom > 1.05) return "sources";

  return "evidence";
}

export function showsTitleTile(detail: SemanticDetail, hasOverview: boolean): boolean {
  return detail === "map" || (detail === "overview" && !hasOverview);
}
