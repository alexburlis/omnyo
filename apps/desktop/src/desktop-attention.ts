import { ipcMain, type WebContents } from "electron";
import { OMNYO_DESKTOP_SET_ATTENTION_CHANNEL } from "./desktop-attention-ipc.js";

interface RegisterDesktopAttentionIpcArgs {
  applicationWindowWebContentsIds: ReadonlySet<number>;
  onChange(active: boolean): void;
}

type AttentionSender = Pick<WebContents, "id" | "mainFrame" | "on" | "once">;

export function registerDesktopAttentionIpc(
  args: RegisterDesktopAttentionIpcArgs,
): void {
  const votes = new Set<number>();
  const watched = new Set<number>();
  let active = false;

  const publish = () => {
    const next = votes.size > 0;

    if (next === active) return;
    active = next;
    args.onChange(next);
  };

  const drop = (webContentsId: number) => {
    votes.delete(webContentsId);
    publish();
  };

  const watch = (sender: AttentionSender) => {
    const webContentsId = sender.id;

    if (watched.has(webContentsId)) return;
    watched.add(webContentsId);
    sender.on("did-navigate", () => drop(webContentsId));
    sender.on("render-process-gone", () => drop(webContentsId));
    sender.once("destroyed", () => {
      watched.delete(webContentsId);
      drop(webContentsId);
    });
  };

  ipcMain.on(OMNYO_DESKTOP_SET_ATTENTION_CHANNEL, (event, payload: unknown) => {
    const sender: AttentionSender = event.sender;

    if (
      typeof payload !== "boolean" ||
      !args.applicationWindowWebContentsIds.has(sender.id) ||
      event.senderFrame !== sender.mainFrame
    ) {
      return;
    }

    watch(sender);

    if (payload) {
      votes.add(sender.id);
    } else {
      votes.delete(sender.id);
    }

    publish();
  });
}
