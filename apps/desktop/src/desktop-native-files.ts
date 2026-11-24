import { stat } from "node:fs/promises";
import path from "node:path";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  omnyoDesktopNativeFileRequestSchema,
  type OmnyoDesktopNativeFileClassification,
} from "@omnyo/desktop-contract";
import { OMNYO_DESKTOP_RESOLVE_NATIVE_FILES_CHANNEL } from "./desktop-window-command-ipc.js";

interface ApplicationNavigation {
  url: string;
  serverGeneration: number;
  navigationGeneration: number;
}

export function registerDesktopNativeFilesIpc(args: {
  applicationWindowWebContentsIds: ReadonlySet<number>;
  getApplicationNavigation(webContentsId: number): ApplicationNavigation | null;
}): void {
  function requireSender(event: IpcMainInvokeEvent) {
    const frame = event.senderFrame;
    const navigation = args.getApplicationNavigation(event.sender.id);

    if (
      !args.applicationWindowWebContentsIds.has(event.sender.id) ||
      event.sender.isDestroyed() ||
      frame === null ||
      frame !== event.sender.mainFrame ||
      navigation === null
    ) {
      throw new Error(
        "Native files are limited to the current Omnyo app frame",
      );
    }

    const selected = new URL(navigation.url);

    if (
      !["http:", "https:"].includes(selected.protocol) ||
      new URL(frame.url).origin !== selected.origin
    ) {
      throw new Error(
        "Native files are limited to the selected Omnyo app origin",
      );
    }

    return { ...navigation, frame, frameUrl: frame.url };
  }

  ipcMain.handle(
    OMNYO_DESKTOP_RESOLVE_NATIVE_FILES_CHANNEL,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    async (event, payload: unknown) => {
      const admitted = requireSender(event);
      const request = omnyoDesktopNativeFileRequestSchema.parse(payload);

      if (request.paths.some((item) => !path.isAbsolute(item.path)))
        throw new Error("Native file paths must be absolute");

      const result: OmnyoDesktopNativeFileClassification[] = Array.from(
        { length: request.count },
        () => null,
      );

      await Promise.all(
        request.paths.map(async (item) => {
          const info = await stat(item.path).catch(() => {
            throw new Error("The selected native file could not be classified");
          });

          result[item.index] = info.isDirectory()
            ? { kind: "directory", path: item.path }
            : info.isFile()
              ? { kind: "file", path: item.path }
              : null;
        }),
      );
      const current = requireSender(event);

      if (
        current.frame !== admitted.frame ||
        current.frameUrl !== admitted.frameUrl ||
        current.url !== admitted.url ||
        current.serverGeneration !== admitted.serverGeneration ||
        current.navigationGeneration !== admitted.navigationGeneration
      ) {
        throw new Error("The Omnyo app changed while resolving native files");
      }

      return result;
    },
  );
}
