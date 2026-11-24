export function inspectMacStateAclV1(
  root: string,
): Promise<Array<{ path: string; acl: string }>>;
export function copyMacStateAclV1(
  source: string,
  destination: string,
): Promise<void>;

export interface MacStateAclSocketBindingV1 {
  path: string;
  sourcePath: string;
  device: string;
  inode: string;
  uid: number;
  gid: number;
  mode: number;
}

export interface MacStateAclTreeResultV1 {
  complete: boolean;
  continuationPath: string | null;
  phase: "copy" | "verify" | "complete";
  entriesVerified: number;
  aclDigest: string;
}

export function copyMacStateAclTreeV1(
  source: string,
  destination: string,
  options: {
    checkpointPath: string;
    socketBindings?: MacStateAclSocketBindingV1[];
    maxEntriesPerCall?: number;
  },
): Promise<MacStateAclTreeResultV1>;
