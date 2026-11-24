import { createContext, useContext } from "react";
import type { Thread } from "@omnyo/domain";

export type ThreadRef = Pick<Thread, "id" | "projectId">;

export interface ThreadActionsContextValue {
  archiveEnvironmentThreads: (environmentId: string) => Promise<void>;
  archiveThreadAsync: (thread: ThreadRef) => Promise<void>;
  requestArchive: (thread: Thread) => void;
  requestShelve: (thread: ThreadRef) => void;
  renameThreadAsync: (threadId: string, title: string) => Promise<void>;
  requestRename: (thread: Thread) => void;
  requestDelete: (thread: Thread) => void;
  unarchiveThread: (thread: Thread) => void;
  togglePin: (thread: Thread) => void;
  toggleRead: (thread: Thread) => void;
}

export const ThreadActionsContext =
  createContext<ThreadActionsContextValue | null>(null);

export function useThreadActions(): ThreadActionsContextValue {
  const value = useContext(ThreadActionsContext);

  if (!value) {
    throw new Error(
      "useThreadActions must be used within a <ThreadActionsProvider>",
    );
  }

  return value;
}
