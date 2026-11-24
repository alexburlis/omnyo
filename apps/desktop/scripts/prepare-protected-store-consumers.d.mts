import type { DesktopProtectedStoreBindingV2 } from "../src/desktop-protected-store-closed-v2.js";

export type SealDesktopProtectedStoreJobInputV2 = Pick<
  DesktopProtectedStoreBindingV2,
  | "oldStorageName"
  | "newStorageName"
  | "profileBindingSha256"
  | "admissionPath"
  | "sourceApplication"
> & {
  envelopePath: DesktopProtectedStoreBindingV2["job"]["path"];
  readerPath: DesktopProtectedStoreBindingV2["reader"]["path"];
  writerPath: DesktopProtectedStoreBindingV2["writer"]["path"];
  timestamp?: boolean;
};

export function compileDesktopProtectedStoreConsumersV1(
  packageRoot: string,
  distDir: string,
): Promise<void>;

export type DesktopProtectedStoreBuildJobV1 = {
  version: 1;
  sourceCommit: string;
  runtimeVersion: string;
  platform: "darwin";
  arch: "arm64";
  appId: "dev.omnyo.private";
  applicationName: "Omnyo Private";
  desktopProfileAdoptionProtocol: 2;
};

export function inspectDesktopProtectedStoreBuildV1(
  packageRoot: string,
  value: unknown,
): Promise<{
  selected: DesktopProtectedStoreBuildJobV1;
  compileReceiptSha256: string;
  sources: Array<{ file: string; sha256: string; mode: number }>;
  consumers: Array<{ file: string; sha256: string; mode: number }>;
  evidence: Record<string, string>;
}>;
export function signDesktopProtectedStoreConsumersV1(
  packageRoot: string,
  selectedBuild?: unknown,
): Promise<string[]>;
export function sealDesktopProtectedStoreJobV2(
  input: SealDesktopProtectedStoreJobInputV2,
): Promise<DesktopProtectedStoreBindingV2>;

export type DesktopProtectedStoreCodeEnvelopeFileV2 = {
  file: string;
  sha256: string;
  mode: number;
  bytes: number;
};

export type DesktopProtectedStoreUnsignedJobV2 = {
  version: 2;
  phase: "target-attested-unsigned";
  binding: DesktopProtectedStoreBindingV2;
  selectionSha256: string;
  selectionBindingSha256: string;
  files: DesktopProtectedStoreCodeEnvelopeFileV2[];
};

export type DesktopProtectedStoreSignedJobV2 = Omit<
  DesktopProtectedStoreUnsignedJobV2,
  "phase"
> & { phase: "centrally-signed" };

export function prepareDesktopProtectedStoreUnsignedJobV2(
  input: SealDesktopProtectedStoreJobInputV2,
): Promise<DesktopProtectedStoreUnsignedJobV2>;
export function finalizeDesktopProtectedStoreUnsignedJobV2(input: {
  envelopePath: string;
  prepared: DesktopProtectedStoreUnsignedJobV2;
  timestamp?: boolean;
}): Promise<DesktopProtectedStoreSignedJobV2>;
export function verifyDesktopProtectedStoreSignedJobV2(input: {
  envelopePath: string;
  prepared: DesktopProtectedStoreUnsignedJobV2;
  signed: DesktopProtectedStoreSignedJobV2;
}): Promise<DesktopProtectedStoreBindingV2>;

export function inspectDesktopProtectedStorePreparedJobV2(input: {
  envelopePath: string;
  jobPath?: string;
  expected: Omit<DesktopProtectedStoreBindingV2, "version" | "job">;
}): Promise<
  | {
      phase: "target-attested-unsigned";
      prepared: DesktopProtectedStoreUnsignedJobV2;
    }
  | {
      phase: "centrally-signed";
      prepared: DesktopProtectedStoreUnsignedJobV2;
      signed: DesktopProtectedStoreSignedJobV2;
    }
>;
