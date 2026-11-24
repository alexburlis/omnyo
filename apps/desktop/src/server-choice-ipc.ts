import {
  omnyoDesktopServerChoiceSchema,
  type OmnyoDesktopServerChoice,
} from "@omnyo/desktop-contract";
import { ipcMain } from "electron";
import {
  OMNYO_DESKTOP_GET_SERVER_CHOICES_CHANNEL,
  OMNYO_DESKTOP_SELECT_SERVER_CHANNEL,
} from "./desktop-window-command-ipc.js";

export function registerServerChoiceIpc({
  applicationWindowWebContentsIds,
  onListRequested,
  list,
  select,
  onError,
}: {
  applicationWindowWebContentsIds: ReadonlySet<number>;
  onListRequested(): void;
  list(): OmnyoDesktopServerChoice[];
  select(id: string): Promise<void>;
  onError(error: unknown): void;
}): void {
  ipcMain.handle(OMNYO_DESKTOP_GET_SERVER_CHOICES_CHANNEL, (event) => {
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error("Server choices are limited to Omnyo windows");
    }

    onListRequested();

    return list();
  });
  ipcMain.on(OMNYO_DESKTOP_SELECT_SERVER_CHANNEL, (event, payload: unknown) => {
    const parsed = omnyoDesktopServerChoiceSchema.shape.id.safeParse(payload);

    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame ||
      !parsed.success
    )
      return;

    if (!list().some((choice) => choice.id === parsed.data && !choice.active))
      return;
    void select(parsed.data).catch(onError);
  });
}
