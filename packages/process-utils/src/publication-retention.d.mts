export function withPublicationLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T>;
export function acquirePublicationReader(
  root: string,
  sourceCommit: string,
): Promise<() => Promise<void>>;
export function verifyDesktopPublication(
  root: string,
  manifest: unknown,
): Promise<void>;
export function runtimePublicationTreeDigest(root: string): Promise<string>;
