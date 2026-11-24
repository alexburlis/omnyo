import { join } from "node:path";
import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { desktopBrowserCookieSyncSourceSchema } from "@omnyo/host-daemon-contract";
import {
  COOKIE_SYNC_STATE_FILE,
  type BrowserCookieSync,
} from "./browser-import/cookie-sync.js";
import {
  OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_CONFIGURE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_RUN_CHANNEL,
  OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_STATUS_CHANNEL,
} from "./desktop-browser-ipc.js";

export interface BrowserCookieSyncHost {
  statePath(): string;
  bind(
    sync: BrowserCookieSync,
    isTrustedSender: (webContentsId: number) => boolean,
  ): () => void;
  log?(message: string, details?: Record<string, unknown>): void;
}

interface Binding {
  sync: BrowserCookieSync;
  isTrustedSender: (webContentsId: number) => boolean;
}

let binding: Binding | null = null;

let handlersRegistered = false;

function syncForSender(event: IpcMainInvokeEvent): BrowserCookieSync {
  if (
    binding === null ||
    !binding.isTrustedSender(event.sender.id) ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error("Browser cookie sync is limited to Omnyo windows");

  return binding.sync;
}

function registerHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  ipcMain.handle(OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_STATUS_CHANNEL, (event) =>
    syncForSender(event).status(),
  );
  ipcMain.handle(
    OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_CONFIGURE_CHANNEL,
    (event, payload: unknown) => {
      const sync = syncForSender(event);

      return sync.configure(
        desktopBrowserCookieSyncSourceSchema.nullable().parse(payload),
      );
    },
  );
  ipcMain.handle(OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_RUN_CHANNEL, (event) =>
    syncForSender(event).run(),
  );
}

export const electronBrowserCookieSyncHost: BrowserCookieSyncHost = {
  statePath: () => join(app.getPath("userData"), COOKIE_SYNC_STATE_FILE),
  bind(sync, isTrustedSender) {
    registerHandlers();
    const current = { sync, isTrustedSender };
    binding = current;

    return () => {
      if (binding === current) binding = null;
    };
  },
  log(message, details) {
    console.info(`[browser-cookie-sync] ${message}`, details ?? {});
  },
};
