import type { Stats } from "node:fs";

export const DESKTOP_PROFILE_MARKER_NAME_V1: "product-profile-v1.json";

export function isInsideDesktopProfilePathV2(
  root: string,
  path: string,
): boolean;
export function assertDesktopProfileOwnedPathV2(
  path: string,
  directory: boolean,
): Promise<Stats>;
export function inspectDesktopProfileAdoptionTreeV1(
  root: string,
  migrated?: boolean,
): Promise<string>;
export function readDesktopProfileCatalogV2(
  root: string,
  migrated?: boolean,
): Promise<{ version: 2; records: string[]; sha256: string }>;

export function canonicalDesktopProfilePathV2(
  key: string,
  migrated?: boolean,
): string;
export function readDesktopProfileSessionsV2(
  root: string,
  migrated?: boolean,
): Promise<{ key: string; path: string }[]>;
