import type { EventEmitter } from "node:events";

const RUN_DIALOG_EVENT = "-run-dialog";

const CANCEL_DIALOGS_EVENT = "-cancel-dialogs";

export const DESKTOP_BROWSER_DIALOG_CLOSED_METHOD =
  "Page.javascriptDialogClosed";

type DialogCallback = (accepted: boolean, promptText: string) => void;

export type DesktopBrowserDialogEmitter = Pick<
  EventEmitter,
  "listeners" | "on" | "removeAllListeners"
>;

interface DialogRoute {
  agentControlled: boolean;
  heldDialog: DialogCallback | null;
}

const routes = new WeakMap<DesktopBrowserDialogEmitter, DialogRoute>();

function routeFor(emitter: DesktopBrowserDialogEmitter): DialogRoute | null {
  const existing = routes.get(emitter);

  if (existing !== undefined) return existing;

  const nativeHandlers = emitter.listeners(RUN_DIALOG_EVENT);
  const nativeHandler = nativeHandlers[0];

  if (nativeHandler === undefined || nativeHandlers.length > 1) {
    console.error(
      `[desktop-browser] Expected one native page dialog handler, found ${nativeHandlers.length}; dialogs from agent-controlled tabs stay native`,
    );

    return null;
  }

  const route: DialogRoute = { agentControlled: false, heldDialog: null };

  emitter.removeAllListeners(RUN_DIALOG_EVENT);
  emitter.on(RUN_DIALOG_EVENT, (info: unknown, callback: DialogCallback) => {
    if (route.agentControlled) {
      route.heldDialog = callback;

      return;
    }

    Reflect.apply(nativeHandler, emitter, [info, callback]);
  });
  emitter.on(CANCEL_DIALOGS_EVENT, () => {
    route.heldDialog = null;
  });
  routes.set(emitter, route);

  return route;
}

export function routeDialogsToAgent(
  emitter: DesktopBrowserDialogEmitter,
): void {
  const route = routeFor(emitter);

  if (route !== null) route.agentControlled = true;
}

export function agentClosedDialog(emitter: DesktopBrowserDialogEmitter): void {
  const route = routes.get(emitter);

  if (route !== undefined) route.heldDialog = null;
}

export function returnDialogsToOwner(
  emitter: DesktopBrowserDialogEmitter,
  isDestroyed: () => boolean,
): void {
  const route = routes.get(emitter);

  if (route === undefined) return;

  const heldDialog = route.heldDialog;
  route.agentControlled = false;
  route.heldDialog = null;

  if (heldDialog !== null && !isDestroyed()) heldDialog(false, "");
}
