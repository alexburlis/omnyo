import {
  BOOT_PART_NAMES,
  BOOT_PART_PATHS,
  bootResponseSchema,
  type BootPartName,
  type BootResponse,
} from "@omnyo/server-contract";

export type BootOutcome =
  | { kind: "ok"; response: BootResponse; receivedAt: number }
  | { kind: "signed-out" }
  | { kind: "failed" };

export interface PageBoot {
  startedAt: number;
  outcome: Promise<BootOutcome>;
  settled: boolean;
}

type NetworkRead = () => Promise<Response>;

interface PendingRead {
  part: BootPartName;
  signal: AbortSignal | null;
  network: NetworkRead;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

export interface BootReads {
  serve(
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    network: NetworkRead,
  ): Promise<Response> | null;
  openRefreshWindow(): void;
}

export const PAGE_BOOT_ACCEPT_MS = 20_000;

export const BOOT_REFRESH_WINDOW_MS = 25;

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

function canonicalRead(pathname: string, search: URLSearchParams): string {
  const params = [...search.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  return `${pathname}?${new URLSearchParams(params).toString()}`;
}

function partsByCanonicalRead(origin: string): Map<string, BootPartName> {
  const parts = new Map<string, BootPartName>();

  for (const name of BOOT_PART_NAMES) {
    const url = new URL(`/api/v1${BOOT_PART_PATHS[name]}`, origin);
    parts.set(canonicalRead(url.pathname, url.searchParams), name);
  }

  return parts;
}

export function parseBootOutcome(args: {
  status: number;
  text: string;
  receivedAt: number;
}): BootOutcome {
  if (args.status === 401) return { kind: "signed-out" };

  if (args.status !== 200) return { kind: "failed" };

  let body: unknown;

  try {
    body = JSON.parse(args.text);
  } catch {
    return { kind: "failed" };
  }

  const parsed = bootResponseSchema.safeParse(body);

  return parsed.success
    ? { kind: "ok", response: parsed.data, receivedAt: args.receivedAt }
    : { kind: "failed" };
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The read was aborted", "AbortError")
  );
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | null,
): Promise<T> {
  if (signal === null) return promise;

  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createBootReads(deps: {
  origin: string;
  page: PageBoot | null;
  requestBoot: (parts: readonly BootPartName[]) => Promise<BootOutcome>;
  now?: () => number;
  onBootFailure?: () => void;
}): BootReads {
  const now = deps.now ?? Date.now;
  const parts = partsByCanonicalRead(deps.origin);
  let pageAccepting = deps.page !== null;
  let refreshWindow: PendingRead[] | null = null;

  const matchPart = (
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
  ): BootPartName | null => {
    if (input instanceof Request) return null;

    if ((init?.method ?? "GET").toUpperCase() !== "GET") return null;

    if (init?.body !== undefined && init.body !== null) return null;
    let url: URL;

    try {
      url = new URL(String(input), deps.origin);
    } catch {
      return null;
    }

    if (url.origin !== deps.origin) return null;

    return parts.get(canonicalRead(url.pathname, url.searchParams)) ?? null;
  };

  const respond = async (
    outcome: Promise<BootOutcome>,
    part: BootPartName,
    signal: AbortSignal | null,
    network: NetworkRead,
  ): Promise<Response> => {
    const settled = await abortable(outcome, signal);
    const result = settled.kind === "ok" ? settled.response.parts[part] : null;

    if (result === null || result === undefined) {
      if (settled.kind === "failed") deps.onBootFailure?.();

      return network();
    }

    if (NULL_BODY_STATUSES.has(result.status))
      return new Response(null, { status: result.status });

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };

  const flush = (pending: PendingRead[]) => {
    const live = pending.filter((read) => read.signal?.aborted !== true);
    const names = [...new Set(live.map((read) => read.part))];

    if (names.length < 2) {
      for (const read of live) read.network().then(read.resolve, read.reject);

      return;
    }

    const outcome = deps.requestBoot(names);

    for (const read of live)
      respond(outcome, read.part, read.signal, read.network).then(
        read.resolve,
        read.reject,
      );
  };

  return {
    serve(input, init, network) {
      const part = matchPart(input, init);

      if (part === null) return null;
      const signal = init?.signal ?? null;

      if (refreshWindow !== null) {
        const pending = refreshWindow;

        return abortable(
          new Promise<Response>((resolve, reject) => {
            pending.push({ part, signal, network, resolve, reject });
          }),
          signal,
        );
      }

      if (
        !pageAccepting ||
        deps.page === null ||
        now() - deps.page.startedAt > PAGE_BOOT_ACCEPT_MS
      ) {
        pageAccepting = false;

        return null;
      }

      return respond(deps.page.outcome, part, signal, network);
    },
    openRefreshWindow() {
      pageAccepting = false;

      if (refreshWindow !== null) return;
      const pending: PendingRead[] = [];
      refreshWindow = pending;
      setTimeout(() => {
        if (refreshWindow === pending) refreshWindow = null;
        flush(pending);
      }, BOOT_REFRESH_WINDOW_MS);
    },
  };
}

let installedBootReads: BootReads | null = null;

export function installBootReads(reads: BootReads | null): void {
  installedBootReads = reads;
}

export function serveBootRead(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  network: NetworkRead,
): Promise<Response> | null {
  return installedBootReads?.serve(input, init, network) ?? null;
}
