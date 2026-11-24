import { createContext, useContext } from "react";

export interface WindowTitleBarSlots {
  pageTitle: HTMLElement | null;
  pageActions: HTMLElement | null;
  companionToolbar: HTMLElement | null;
}

export const WindowTitleBarSlotsContext =
  createContext<WindowTitleBarSlots | null>(null);

export function useWindowTitleBarSlots(): WindowTitleBarSlots | null {
  return useContext(WindowTitleBarSlotsContext);
}
