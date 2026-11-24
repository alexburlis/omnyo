import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import type { z } from "zod";
import {
  omnyoDesktopBrowserAttachRequestSchema,
  omnyoDesktopBrowserEvaluateRequestSchema,
  omnyoDesktopBrowserFindInPageRequestSchema,
  omnyoDesktopBrowserHostFocusRequestSchema,
  omnyoDesktopBrowserNavigateRequestSchema,
  omnyoDesktopBrowserSetBoundsRequestSchema,
  omnyoDesktopBrowserSetVisibleRequestSchema,
  omnyoDesktopBrowserStopFindInPageRequestSchema,
  omnyoDesktopBrowserTabRefSchema,
  type OmnyoDesktopBrowserEvaluateResult,
} from "@omnyo/desktop-contract";
import {
  OMNYO_DESKTOP_BROWSER_ATTACH_CHANNEL,
  OMNYO_DESKTOP_BROWSER_DETACH_CHANNEL,
  OMNYO_DESKTOP_BROWSER_EVALUATE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_FOCUS_CHANNEL,
  OMNYO_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_GO_BACK_CHANNEL,
  OMNYO_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
  OMNYO_DESKTOP_BROWSER_HOST_FOCUS_CHANNEL,
  OMNYO_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_RELOAD_CHANNEL,
  OMNYO_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
  OMNYO_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
  OMNYO_DESKTOP_BROWSER_STOP_CHANNEL,
  OMNYO_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
} from "./desktop-browser-ipc.js";
import type { DesktopBrowserViewManager } from "./desktop-browser-view.js";

function hostWindowFromBrowserIpcEvent(
  event: IpcMainEvent,
): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function registerRequestCommand<T>(
  channel: string,
  schema: z.ZodType<T>,
  run: (args: { hostWindow: BrowserWindow; request: T }) => void,
): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    const hostWindow = hostWindowFromBrowserIpcEvent(event);

    if (hostWindow === null) {
      return;
    }

    const parsed = schema.safeParse(payload);

    if (!parsed.success) {
      return;
    }

    run({ hostWindow, request: parsed.data });
  });
}

export function registerDesktopBrowserIpc(
  manager: DesktopBrowserViewManager,
): void {
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_ATTACH_CHANNEL,
    omnyoDesktopBrowserAttachRequestSchema,
    (args) => manager.attach(args),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
    omnyoDesktopBrowserNavigateRequestSchema,
    (args) => manager.navigate(args),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
    omnyoDesktopBrowserSetBoundsRequestSchema,
    (args) => manager.setBounds(args),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
    omnyoDesktopBrowserSetVisibleRequestSchema,
    (args) => manager.setVisible(args),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
    omnyoDesktopBrowserSetVisibleRequestSchema,
    (args) => manager.setVisibleWithoutFocus(args),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
    omnyoDesktopBrowserFindInPageRequestSchema,
    (args) => manager.findInPage(args),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
    omnyoDesktopBrowserStopFindInPageRequestSchema,
    (args) => manager.stopFindInPage(args),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_DETACH_CHANNEL,
    omnyoDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.detach({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_FOCUS_CHANNEL,
    omnyoDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.focus({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_HOST_FOCUS_CHANNEL,
    omnyoDesktopBrowserHostFocusRequestSchema,
    ({ hostWindow, request }) =>
      manager.setHostFocus({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_GO_BACK_CHANNEL,
    omnyoDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.goBack({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
    omnyoDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.goForward({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_RELOAD_CHANNEL,
    omnyoDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.reload({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    OMNYO_DESKTOP_BROWSER_STOP_CHANNEL,
    omnyoDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.stop({ hostWindow, tabId: request.tabId }),
  );
  ipcMain.handle(
    OMNYO_DESKTOP_BROWSER_EVALUATE_CHANNEL,
    async (
      event,
      payload: unknown,
    ): Promise<OmnyoDesktopBrowserEvaluateResult> => {
      const hostWindow = BrowserWindow.fromWebContents(event.sender);

      if (hostWindow === null) {
        return { ok: false, error: "Browser host window is not available" };
      }

      const parsed =
        omnyoDesktopBrowserEvaluateRequestSchema.safeParse(payload);

      if (!parsed.success) {
        return { ok: false, error: "Invalid browser page evaluation request" };
      }

      return manager.evaluate({ hostWindow, request: parsed.data });
    },
  );
}
