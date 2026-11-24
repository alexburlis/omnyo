export interface OmnyoStateSocketBindingV1 {
  path: string;
  sourcePath: string;
  device: string;
  inode: string;
  uid: number;
  gid: number;
  mode: number;
}

export interface OmnyoStateTreeCountsV1 {
  entries: number;
  directories: number;
  regularFiles: number;
  symbolicLinks: number;
  sockets: number;
  logicalBytes: number;
  hardlinkAliases: number;
  largestRegularFileBytes: number;
}

export interface OmnyoStateTreeResultV1 {
  complete: boolean;
  continuationPath: string | null;
  phase: "preflight" | "copy" | "verify" | "complete";
  counts: OmnyoStateTreeCountsV1;
  socketBindings: OmnyoStateSocketBindingV1[];
  unsupported: Array<{ path: string; kind: string }>;
  unsupportedCount: number;
  metadataDigest: string;
  phaseEntries: number;
  phaseBytes: number;
}

export function isOmnyoStateSocketPathV1(path: string): boolean;
export function inspectOmnyoStateTreeKindsV1(
  sourceRoot: string,
  options: { checkpointPath: string; maxShards?: number },
): Promise<OmnyoStateTreeResultV1>;
export function copyOmnyoStateTreeV1(
  sourceRoot: string,
  destinationRoot: string,
  options: { checkpointPath: string; maxShards?: number },
): Promise<OmnyoStateTreeResultV1>;
export function validateOmnyoSocketBridgesV1(
  sourceRoot: string,
  destinationRoot: string,
  bindings: OmnyoStateSocketBindingV1[],
): Promise<void>;

export interface OmnyoStateFileBindingV1 {
  device: string;
  inode: string;
  uid: number;
  gid: number;
  mode: number;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  nlink: number;
}

export type OmnyoStateTreeConfigDigestV1 =
  | { kind: "absent" }
  | {
      kind: "normalized";
      sha256: string | null;
      binding: OmnyoStateFileBindingV1;
    };

export interface OmnyoStateTreeDigestResultV1 {
  algorithm: "state-tree-v2";
  complete: boolean;
  continuationPath: string | null;
  digest: string | null;
  metadataDigest: string | null;
  files: number;
  bytes: number;
  bytesHashed: number;
  bytesReadThisCall: number;
  phaseEntries: number;
  phaseBytes: number;
}

export function inspectOmnyoStateTreeDigestV1(
  root: string,
  options: {
    checkpointPath: string;
    maxShards?: number;
    config: OmnyoStateTreeConfigDigestV1;
    durable?: boolean;
    socketBridgeSource?: {
      root: string;
      bindings: OmnyoStateSocketBindingV1[];
    };
  },
): Promise<OmnyoStateTreeDigestResultV1>;
