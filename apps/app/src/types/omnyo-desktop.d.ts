import type { OmnyoDesktopApi } from "@omnyo/desktop-contract";

declare global {
  interface Window {
    omnyoDesktop?: OmnyoDesktopApi;
  }
}

export {};
