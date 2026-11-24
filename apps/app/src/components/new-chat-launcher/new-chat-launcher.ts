import { atom } from "jotai";
import { getPendingChatSnapshot } from "@/lib/pending-chat-creations";
import { findPaneByContent, type SplitLayout } from "@/lib/split-layout";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import {
  focusedPaneRoute,
  paneContentForPathname,
} from "@/views/thread-detail/splitThreadNavigation";

export const NEW_CHAT_LAUNCHER_WIDTH_CLASS = "max-w-[620px]";

export const NEW_CHAT_LAUNCHER_PANEL_CLASS =
  "border-0 bg-(--material-raised) shadow-(--material-shadow-raised) backdrop-blur-xl sm:rounded-[14px]";

export interface NewChatLauncherState {
  open: boolean;
  focusRequest: number;
}

export const newChatLauncherAtom = atom<NewChatLauncherState>({
  open: false,
  focusRequest: 0,
});

export function openNewChatLauncher(
  state: NewChatLauncherState,
): NewChatLauncherState {
  return { open: true, focusRequest: state.focusRequest + 1 };
}

export function closeNewChatLauncher(
  state: NewChatLauncherState,
): NewChatLauncherState {
  return { ...state, open: false };
}

export function isPendingChatResolution(from: string, to: string): boolean {
  const pending = paneContentForPathname(from);
  const resolved = paneContentForPathname(to);

  return (
    pending?.kind === "thread" &&
    resolved?.kind === "thread" &&
    getPendingChatSnapshot(pending.threadId)?.realThreadId === resolved.threadId
  );
}

export type NewChatEntry =
  | { kind: "focus-launcher" }
  | { kind: "open-launcher" }
  | { kind: "show-page" }
  | { kind: "ignore" };

export function resolveNewChatEntry({
  launcher,
  otherModalOpen,
  compact,
  pathname,
  layout,
}: {
  launcher: NewChatLauncherState;
  otherModalOpen: boolean;
  compact: boolean;
  pathname: string;
  layout: SplitLayout | null;
}): NewChatEntry {
  if (compact) return { kind: "show-page" };

  if (launcher.open) return { kind: "focus-launcher" };

  if (otherModalOpen) return { kind: "ignore" };

  const visibleLayout =
    layout !== null && focusedPaneRoute(layout) === pathname ? layout : null;

  const showsNewChat =
    pathname === getRootComposeRoutePath() ||
    (visibleLayout !== null &&
      findPaneByContent(visibleLayout.root, { kind: "new-thread" }) !== null);

  return showsNewChat ? { kind: "show-page" } : { kind: "open-launcher" };
}
