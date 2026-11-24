import {
  getNativeThreadImport,
  hasThreadNativeSessionHistory,
  type DbQueryConnection,
} from "@omnyo/db";
import { ApiError } from "../../errors.js";
import type { ThreadForkDescriptor } from "./thread-startup-store.js";

export function resolveNativeImportFork(
  db: DbQueryConnection,
  args: { hostId: string; providerId: string; threadId: string },
): ThreadForkDescriptor | null {
  const nativeImport = getNativeThreadImport(db, args.threadId);

  if (
    nativeImport === null ||
    hasThreadNativeSessionHistory(db, args.threadId)
  ) {
    return null;
  }

  if (
    nativeImport.providerId !== args.providerId ||
    nativeImport.hostId !== args.hostId
  ) {
    throw new ApiError(
      409,
      "provider_session_unavailable",
      "This imported chat can only continue with its original agent on its original machine. Clear the context to start a fresh session here.",
    );
  }

  return {
    sourceProviderThreadId: nativeImport.sourceProviderThreadId,
    restoreArchivedSource: false,
  };
}
