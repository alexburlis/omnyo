import { contextBridge, ipcRenderer } from "electron";
import {
  OMNYO_DESKTOP_BROWSER_GUEST_MESSAGE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_PAGE_BRIDGE_KEY,
  OMNYO_DESKTOP_BROWSER_PAGE_WORLD_ID,
} from "./desktop-browser-ipc.js";

contextBridge.exposeInIsolatedWorld(
  OMNYO_DESKTOP_BROWSER_PAGE_WORLD_ID,
  OMNYO_DESKTOP_BROWSER_PAGE_BRIDGE_KEY,
  {
    postMessage(channel: unknown, data: unknown): void {
      ipcRenderer.send(OMNYO_DESKTOP_BROWSER_GUEST_MESSAGE_CHANNEL, {
        channel,
        data,
      });
    },
  },
);
