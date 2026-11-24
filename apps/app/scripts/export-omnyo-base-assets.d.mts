type AssetFamily = "root" | "browser" | "desktop" | "mobile" | "site";

type ExportedAsset = {
  path: string;
  beforeSha256: string | null;
  sha256: string;
  width?: number;
  height?: number;
  canvas?: "tile" | "opaque" | "transparent";
  variant?: "black" | "white" | "orange" | "green" | "yellow" | "shaded";
  markScale?: number;
  format?: "icns";
};

export function exportOmnyoBaseAssets(options: {
  root: string;
  selectedFamilies?: AssetFamily[];
  checkOnly?: boolean;
  scratchRoot?: string;
}): Promise<{ sourceSha256: string; records: ExportedAsset[] }>;
