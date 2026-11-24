import type { BrowserClient } from "@sentry/browser";
import type { Envelope, ErrorEvent } from "@sentry/core";

import { ANALYTICS_HOST, SENTRY_DSN } from "./config";
import { diagnosticsAllowedNow } from "./consent";
import {
  rebuildErrorEvent,
  routeSection,
  type ErrorReportIdentity,
} from "./error-event";

const MAX_REPORTS_PER_PAGE = 10;

const ENVELOPE_HEADER_KEYS = new Set(["event_id", "sent_at"]);

let client: BrowserClient | null = null;

let loading: Promise<void> | null = null;

let loadFailed = false;

let reportsThisPage = 0;

const requests = new Set<AbortController>();

const approved = new WeakSet<object>();

function ownBrowserFrame(filename: string): string | undefined {
  try {
    const url = new URL(filename);

    return url.origin === window.location.origin
      ? `${url.origin}${url.pathname}`
      : undefined;
  } catch {
    return undefined;
  }
}

function browserName(agent: string): string {
  if (agent.includes("Firefox/")) return "Firefox";

  if (agent.includes("Edg/")) return "Edge";

  if (agent.includes("Chrome/")) return "Chrome";

  return agent.includes("Safari/") ? "Safari" : "Other";
}

function osName(agent: string): string {
  if (/iPhone|iPad/.test(agent)) return "iOS";

  if (agent.includes("Android")) return "Android";

  if (agent.includes("Windows")) return "Windows";

  if (agent.includes("Mac OS")) return "macOS";

  return agent.includes("Linux") ? "Linux" : "Other";
}

function browserIdentity(): ErrorReportIdentity {
  const agent = navigator.userAgent;
  const version = /(?:Firefox|Edg|Chrome|Version)\/(\d{1,3})/.exec(agent)?.[1];

  return {
    service: "website-browser",
    environment:
      window.location.hostname === ANALYTICS_HOST
        ? "production"
        : "development",
    platform: "javascript",
    ownFrame: ownBrowserFrame,
    contexts: {
      browser: {
        name: browserName(agent),
        ...(version === undefined ? {} : { version }),
      },
      os: { name: osName(agent) },
    },
  };
}

function onlyApprovedEvents(envelope: Envelope): boolean {
  const [, items] = envelope;

  return (
    items.length > 0 &&
    items.every(
      ([header, payload]) =>
        header.type === "event" &&
        typeof payload === "object" &&
        payload !== null &&
        approved.has(payload),
    )
  );
}

function beforeSend(event: ErrorEvent): ErrorEvent | null {
  if (!diagnosticsAllowedNow() || reportsThisPage >= MAX_REPORTS_PER_PAGE)
    return null;

  const rebuilt = rebuildErrorEvent(event, browserIdentity(), {
    stage: "browser",
    route: routeSection(window.location.pathname),
  });

  if (rebuilt === null) return null;
  reportsThisPage += 1;
  approved.add(rebuilt);

  return rebuilt;
}

export function startBrowserErrors(): void {
  if (SENTRY_DSN === "" || client !== null || loading !== null || loadFailed)
    return;

  if (!diagnosticsAllowedNow()) return;

  loading = import("@sentry/browser")
    .then((Sentry) => {
      if (!diagnosticsAllowedNow()) return;
      const nativeFetch = window.fetch.bind(window);

      const gatedFetch: typeof fetch = async (input, init) => {
        if (!diagnosticsAllowedNow())
          return new Response(null, { status: 204 });
        const controller = new AbortController();
        requests.add(controller);

        try {
          return await nativeFetch(input, {
            ...init,
            signal: controller.signal,
            keepalive: false,
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
        } finally {
          requests.delete(controller);
        }
      };

      const next = new Sentry.BrowserClient({
        dsn: SENTRY_DSN,
        environment: browserIdentity().environment,
        stackParser: Sentry.defaultStackParser,
        integrations: [
          Sentry.eventFiltersIntegration(),
          Sentry.functionToStringIntegration(),
          Sentry.browserApiErrorsIntegration(),
          Sentry.globalHandlersIntegration({
            onerror: true,
            onunhandledrejection: true,
          }),
          Sentry.linkedErrorsIntegration({ limit: 5 }),
          Sentry.dedupeIntegration(),
        ],
        dataCollection: {
          cookies: false,
          frameContextLines: 0,
          httpBodies: [],
          httpHeaders: false,
          stackFrameVariables: false,
          urlQueryParams: false,
          userInfo: false,
        },
        enhanceFetchErrorMessages: false,
        maxBreadcrumbs: 0,
        beforeBreadcrumb: () => null,
        sendClientReports: false,
        beforeSend,
        beforeSendTransaction: () => null,
        traceLifecycle: "static",
        transport: (options) => {
          const transport = Sentry.makeFetchTransport(options, gatedFetch);

          return {
            flush: (timeout) => transport.flush(timeout),
            send: (envelope) => {
              if (!diagnosticsAllowedNow() || !onlyApprovedEvents(envelope))
                return Promise.resolve({});
              const [headers] = envelope;

              for (const key of Object.keys(headers)) {
                if (!ENVELOPE_HEADER_KEYS.has(key))
                  Reflect.deleteProperty(headers, key);
              }

              return transport.send(envelope);
            },
          };
        },
      });

      Sentry.getCurrentScope().setClient(next);
      next.init();
      client = next;
    })
    .catch((error: unknown) => {
      loadFailed = true;
      console.error("Error reports could not start", error);
    })
    .finally(() => {
      loading = null;
    });
}

export function stopBrowserErrors(): void {
  const current = client;
  client = null;

  for (const request of requests) request.abort();
  requests.clear();

  if (current === null) return;
  current.getOptions().enabled = false;
  void current.close(0);
}
