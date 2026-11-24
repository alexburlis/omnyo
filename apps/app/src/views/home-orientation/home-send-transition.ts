import { prefersReducedMotion } from "@omnyo/shared-ui/motion";
import "./home-send-transition.css";

const NAME_PREFIX = "omnyo-home-send-";

const COMMIT_WAIT_MS = 150;

const arrivals = new Map<string, (target: HTMLElement | null) => void>();

let latest = 0;

export function homeSendTransitionName(paneId: string): string {
  return `${NAME_PREFIX}${paneId.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
}

export function runHomeSendTransition({
  paneId,
  source,
  threadId,
  navigate,
}: {
  paneId: string;
  source: HTMLElement | null;
  threadId: string;
  navigate: () => void;
}): void {
  if (source === null || typeof document.startViewTransition !== "function") {
    navigate();

    return;
  }

  const reduced = prefersReducedMotion();

  const name = reduced ? null : homeSendTransitionName(paneId);
  const root = document.documentElement;
  const token = ++latest;
  const named: HTMLElement[] = [source];

  if (name !== null) source.style.viewTransitionName = name;
  root.dataset.homeSend = reduced ? "reduced" : "travel";

  const transition = document.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        const finish = (target: HTMLElement | null) => {
          window.clearTimeout(timer);
          arrivals.delete(threadId);

          if (target !== null && name !== null) {
            target.style.viewTransitionName = name;
            named.push(target);
          }

          resolve();
        };

        const timer = window.setTimeout(() => finish(null), COMMIT_WAIT_MS);

        source.style.viewTransitionName = "";
        arrivals.set(threadId, finish);
        navigate();
      }),
  );

  void transition.finished.finally(() => {
    for (const element of named) element.style.viewTransitionName = "";

    if (token === latest) delete root.dataset.homeSend;
  });
}

export function arriveFromHomeSend(
  threadId: string,
  target: HTMLElement | null,
): void {
  arrivals.get(threadId)?.(target);
}
