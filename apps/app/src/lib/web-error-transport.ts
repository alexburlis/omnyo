import { makeFetchTransport } from "@sentry/react";

const pending = new Set<AbortController>();

export function makeSameOriginErrorTransport(
  options: Parameters<typeof makeFetchTransport>[0],
): ReturnType<typeof makeFetchTransport> {
  return makeFetchTransport(options, async (_url, init) => {
    const controller = new AbortController();
    pending.add(controller);

    try {
      return await fetch("/api/v1/system/web-errors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope: init?.body }),
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      pending.delete(controller);
    }
  });
}

export function abortPendingWebErrorReports(): void {
  for (const controller of pending) controller.abort();
  pending.clear();
}
