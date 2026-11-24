import { atom, useStore } from "jotai";
import { useCallback } from "react";
import { shellHaptic } from "@/lib/native-shell/native-shell";

export const visibleChatIdsAtom = atom<readonly string[]>([]);

export function useChatOpenHaptic(): (threadId: string) => void {
  const store = useStore();

  return useCallback(
    (threadId) => {
      if (!store.get(visibleChatIdsAtom).includes(threadId)) {
        shellHaptic("impact-light");
      }
    },
    [store],
  );
}
