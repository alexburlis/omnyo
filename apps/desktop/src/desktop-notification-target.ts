import type { BrowserWindow } from "electron";

type NotificationWindow = Pick<
  BrowserWindow,
  "isMinimized" | "restore" | "show" | "focus"
>;

export async function openDesktopNotificationThread<
  T extends NotificationWindow,
>(args: {
  serverUrl: string;
  threadId: string | null;
  window: T | null;
  createWindow(url: string): Promise<unknown>;
  openThreadInWindow(window: T, threadId: string): Promise<boolean>;
  navigateWindow(window: T, url: string): Promise<void>;
}): Promise<void> {
  const url = new URL(args.serverUrl);

  if (args.threadId !== null)
    url.pathname = `/threads/${encodeURIComponent(args.threadId)}`;

  if (args.window === null) {
    await args.createWindow(url.href);

    return;
  }

  if (args.window.isMinimized()) args.window.restore();
  args.window.show();
  args.window.focus();

  if (args.threadId === null) return;

  if (await args.openThreadInWindow(args.window, args.threadId)) return;

  await args.navigateWindow(args.window, url.href);
}
