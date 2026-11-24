import type { toast } from "sonner";

type SonnerToast = typeof toast;

let attachedToast: SonnerToast | null = null;

const pendingCalls: Array<(sonnerToast: SonnerToast) => void> = [];

type ToasterLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed"; retry: () => void }
  | { status: "ready" };

let toasterLoadState: ToasterLoadState = { status: "idle" };

const requestListeners = new Set<() => void>();

const settleWaiters: Array<() => void> = [];

function settleToaster(): void {
  for (const resolve of settleWaiters.splice(0)) resolve();
}

export function whenToasterSettled(): Promise<void> {
  requestToaster();

  if (toasterLoadState.status === "ready") return Promise.resolve();

  return new Promise((resolve) => settleWaiters.push(resolve));
}

export function markToasterUnavailable(retry: () => void): void {
  pendingCalls.length = 0;
  toasterLoadState = { status: "failed", retry };
  settleToaster();
}

export function requestToaster(): void {
  if (
    toasterLoadState.status === "loading" ||
    toasterLoadState.status === "ready"
  )
    return;

  const retry =
    toasterLoadState.status === "failed" ? toasterLoadState.retry : null;

  toasterLoadState = { status: "loading" };

  if (retry) {
    retry();

    return;
  }

  for (const listener of requestListeners) listener();
}

export function subscribeToasterRequest(listener: () => void): () => void {
  requestListeners.add(listener);

  return () => requestListeners.delete(listener);
}

export function isToasterRequested(): boolean {
  return toasterLoadState.status !== "idle";
}

export function withSonnerToast(run: (sonnerToast: SonnerToast) => void): void {
  if (attachedToast !== null) {
    run(attachedToast);

    return;
  }

  pendingCalls.push(run);
  requestToaster();
}

export function attachSonnerToast(sonnerToast: SonnerToast): void {
  const earlyToasts = attachedToast === null ? sonnerToast.getToasts() : [];
  attachedToast = sonnerToast;
  toasterLoadState = { status: "ready" };

  for (const entry of earlyToasts) {
    if ("dismiss" in entry) continue;
    sonnerToast.message(entry.title, entry);
  }

  for (const run of pendingCalls.splice(0)) run(sonnerToast);
  settleToaster();
}
