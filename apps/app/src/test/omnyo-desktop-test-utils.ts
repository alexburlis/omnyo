import type {
  OmnyoDesktopApi,
  OmnyoDesktopBrowserApi,
  OmnyoDesktopInfo,
} from "@omnyo/desktop-contract";

export function createNoopDesktopBrowserApi(): OmnyoDesktopBrowserApi {
  return {
    attach() {},
    detach() {},
    navigate() {},
    goBack() {},
    goForward() {},
    reload() {},
    stop() {},
    focus() {},
    setBounds() {},
    setVisible() {},
    setVisibleWithoutFocus() {},
    onState() {
      return () => {};
    },
    onOpenTab() {
      return () => {};
    },
    onFocus() {
      return () => {};
    },
  };
}

export function createOmnyoDesktopApi(
  info: OmnyoDesktopInfo,
  browser: OmnyoDesktopBrowserApi = createNoopDesktopBrowserApi(),
): OmnyoDesktopApi {
  return {
    ...info,
    browser,
    async checkForUpdates() {
      return info;
    },
    async getInfo() {
      return info;
    },
    async installUpdate() {},
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };
}
