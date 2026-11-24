export declare const RUNTIME_MAC_SIGNING_TEAM_ENV: "OMNYO_RUNTIME_MAC_SIGNING_TEAM";

export declare function fatFirstSliceOffset(header: Buffer): number | null;

export declare function machOFileType(path: string): Promise<number | null>;

export declare function findMachOFiles(
  root: string,
  relativeRoots: readonly string[],
): Promise<{ path: string; fileType: number }[]>;

export declare function selectDeveloperIdIdentity(
  findIdentityOutput: string,
  team: string,
): string;

export declare function signRuntimeMacNativeCode(args: {
  root: string;
  relativeRoots: readonly string[];
  team: string;
  entitlements: string;
}): Promise<string[]>;
