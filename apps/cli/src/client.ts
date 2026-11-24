import { readCliUsageConsent } from "./usage-consent.js";
import {
  ANALYTICS_CONSENT_HEADER,
  USER_ACTIVITY_HEADER,
  usageRequestEligible,
} from "@omnyo/domain/usage-telemetry";
import {
  INBOX_CALLER_AUTOMATION_HEADER,
  INBOX_CALLER_AUTOMATION_RUN_HEADER,
  INBOX_CALLER_THREAD_HEADER,
} from "@omnyo/domain";
import { createNodeOmnyoSdk, type OmnyoSdk } from "@omnyo/sdk/node";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

const CALLER_HEADER_ENV_NAMES = [
  [INBOX_CALLER_THREAD_HEADER, "OMNYO_THREAD_ID"],
  [INBOX_CALLER_AUTOMATION_HEADER, "OMNYO_AUTOMATION_ID"],
  [INBOX_CALLER_AUTOMATION_RUN_HEADER, "OMNYO_AUTOMATION_RUN_ID"],
] as const;

const PROXY_ENV_NAMES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
];

let proxyDispatcher: Dispatcher | null | undefined;

export function proxyEnvironmentConfigured(): boolean {
  return PROXY_ENV_NAMES.some(
    (name) => (process.env[name]?.trim() ?? "") !== "",
  );
}

function environmentProxyDispatcher(): Dispatcher | null {
  if (proxyDispatcher === undefined) {
    proxyDispatcher = proxyEnvironmentConfigured()
      ? new EnvHttpProxyAgent()
      : null;
  }

  return proxyDispatcher;
}

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  const dispatcher = environmentProxyDispatcher();

  if (dispatcher === null || init?.dispatcher !== undefined) {
    return fetch(input, init);
  }

  const proxiedInit: CliRequestInit = { ...init, dispatcher };

  return fetch(input, proxiedInit);
}

function callerHeaders(): [string, string][] {
  return CALLER_HEADER_ENV_NAMES.flatMap(
    ([header, name]): [string, string][] => {
      const value = process.env[name]?.trim() ?? "";

      return value === "" ? [] : [[header, value]];
    },
  );
}

function callerFetch(
  caller: readonly [string, string][],
  baseUrl: string,
): typeof cliFetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);

    const target = new URL(
      input instanceof Request ? input.url : String(input),
      baseUrl,
    );

    const eligible =
      target.origin === new URL(baseUrl).origin &&
      usageRequestEligible(
        target.pathname,
        init?.method ?? (input instanceof Request ? input.method : "GET"),
      );

    for (const [name, value] of caller) {
      if (
        (name === ANALYTICS_CONSENT_HEADER || name === USER_ACTIVITY_HEADER) &&
        !eligible
      )
        continue;
      headers.set(name, value);
    }

    const control =
      target.origin === new URL(baseUrl).origin &&
      target.pathname.startsWith("/api/v1/system/usage");

    return cliFetch(input, {
      ...init,
      headers,
      ...(eligible || control ? { redirect: "error" } : {}),
    });
  };
}

export function createCliOmnyoSdk(baseUrl: string): OmnyoSdk {
  const headers = callerHeaders();
  const consent = readCliUsageConsent(baseUrl);

  if (consent.active) headers.push([ANALYTICS_CONSENT_HEADER, consent.active]);

  if (
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !process.env.OMNYO_THREAD_ID &&
    !process.env.OMNYO_AUTOMATION_ID
  )
    headers.push([USER_ACTIVITY_HEADER, "1"]);

  const sdk = createNodeOmnyoSdk({
    baseUrl,
    fetch: callerFetch(headers, baseUrl),
  });

  return {
    ...sdk,
    threads: {
      ...sdk.threads,
      send(args) {
        return sdk.threads.send({
          ...args,
          messageSource: args.messageSource ?? { kind: "script", label: "CLI" },
        });
      },
      queuedMessages: {
        ...sdk.threads.queuedMessages,
        create(args) {
          return sdk.threads.queuedMessages.create({
            ...args,
            messageSource: args.messageSource ?? {
              kind: "script",
              label: "CLI",
            },
          });
        },
      },
    },
  };
}
