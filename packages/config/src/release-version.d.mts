export interface ParsedReleaseVersion {
  numeric: string;
  major: number;
  minor: number;
  patch: number;
  revision: number | null;
}

export declare const RELEASE_VERSION_PATTERN: RegExp;

export declare function parseReleaseVersion(
  value: unknown,
): ParsedReleaseVersion | null;
export declare function compareReleaseNumbers(
  left: string,
  right: string,
): -1 | 0 | 1;
export declare function compareReleaseVersions(
  left: string,
  right: string,
): -1 | 0 | 1;
export declare function macBundleVersion(version: string): string;
