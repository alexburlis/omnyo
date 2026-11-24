import { omnyoDesktopClipboardContentSchema } from "@omnyo/desktop-contract";
import { clipboard, ClipboardItem, ipcMain } from "electron";
import { OMNYO_DESKTOP_WRITE_CLIPBOARD_CHANNEL } from "./desktop-window-command-ipc.js";

export function registerDesktopClipboardIpc(
  applicationWindowWebContentsIds: ReadonlySet<number>,
): void {
  ipcMain.handle(
    OMNYO_DESKTOP_WRITE_CLIPBOARD_CHANNEL,
    async (event, payload: unknown) => {
      if (!applicationWindowWebContentsIds.has(event.sender.id)) {
        throw new Error("Clipboard writes are limited to Omnyo windows");
      }

      const { text, html } = omnyoDesktopClipboardContentSchema.parse(payload);

      if (html === undefined) {
        await clipboard.writeText(text);

        return;
      }

      await clipboard.write([
        new ClipboardItem({ "text/plain": text, "text/html": html }),
      ]);
    },
  );
}
