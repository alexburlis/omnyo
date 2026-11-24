import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import {
  booleanLocalStorage,
  createLocalStorageSyncStorage,
} from "@/lib/browser-storage";
import { hasThreadId } from "@/lib/thread-id";

export const threadSecondaryPanelResizingAtom = atom(false);

type ResolvedThreadSecondaryPanelThreadId = string;

type ThreadSecondaryPanelThreadId =
  | ResolvedThreadSecondaryPanelThreadId
  | null
  | undefined;

const DEFAULT_SECONDARY_PANEL_WIDTH_PERCENT = 50;

const secondaryPanelWidthStorage = createLocalStorageSyncStorage<number>({
  parse: (storedValue, initialValue) => {
    if (storedValue === null) return initialValue;
    const parsed = Number.parseFloat(storedValue);

    return Number.isFinite(parsed) && parsed > 0 && parsed <= 100
      ? parsed
      : initialValue;
  },
  serialize: (value) => String(value),
});

export const secondaryPanelWidthPercentAtom = atomWithStorage<number>(
  "omnyo.thread.secondaryPanel.widthPercent",
  DEFAULT_SECONDARY_PANEL_WIDTH_PERCENT,
  secondaryPanelWidthStorage,
  { getOnInit: true },
);

export const PREVIEW_SECONDARY_PANEL_WIDTH_PERCENT = 60;

export const widenSecondaryPanelForPreviewAtom = atom(null, (get, set) => {
  if (
    get(secondaryPanelWidthPercentAtom) < PREVIEW_SECONDARY_PANEL_WIDTH_PERCENT
  ) {
    set(secondaryPanelWidthPercentAtom, PREVIEW_SECONDARY_PANEL_WIDTH_PERCENT);
  }
});

const THREAD_CONVERSATION_COLLAPSED_STORAGE_PREFIX =
  "omnyo.thread.conversation.collapsed";

const threadConversationCollapsedAtomFamily = atomFamily(
  (threadId: ResolvedThreadSecondaryPanelThreadId) =>
    atomWithStorage<boolean>(
      `${THREAD_CONVERSATION_COLLAPSED_STORAGE_PREFIX}-${encodeURIComponent(threadId)}`,
      false,
      booleanLocalStorage,
      { getOnInit: true },
    ),
);

const disabledThreadConversationCollapsedAtom = atom(false);

export function getThreadConversationCollapsedAtom(
  threadId: ThreadSecondaryPanelThreadId,
) {
  return hasThreadId(threadId)
    ? threadConversationCollapsedAtomFamily(threadId)
    : disabledThreadConversationCollapsedAtom;
}
