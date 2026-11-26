import type {
  Client,
  Envelope,
  ErrorEvent,
  Event,
  EventEnvelope,
  EventItem,
  EventHint,
  Exception,
  Integration,
  StackFrame,
  Transport,
} from "@sentry/core";

const operations = [
  "request",
  "thread-startup",
  "claude-model-confirmation",
  "timeline-read",
  "provider-request",
  "voice-transcription",
  "plugin",
  "startup",
  "uncaught-exception",
] as const;

const stages = [
  "admission",
  "queue",
  "connect",
  "send",
  "receive",
  "decode",
  "execute",
  "persist",
  "complete",
  "startup",
  "unknown",
] as const;

const failureClasses = [
  "timeout",
  "dns",
  "connection",
  "tls",
  "rate-limit",
  "upstream-rejected",
  "sdk-rejected",
  "upstream-unavailable",
  "invalid-response",
  "empty-result",
  "cancelled",
  "internal",
  "unknown",
] as const;

const outcomes = ["terminal", "recovered", "cancelled", "deferred"] as const;

const dependencies = [
  "coordinator",
  "host-daemon",
  "provider",
  "relay",
  "local-voice",
  "plugin",
  "storage",
] as const;

const transportCodes = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
] as const;

const exceptionTypes = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DOMException",
  "TRPCError",
  "SplitDownloadError",
] as const;

const mechanisms = [
  "generic",
  "onerror",
  "onunhandledrejection",
  "instrument",
  "auto.browser.global_handlers.onerror",
  "auto.browser.global_handlers.onunhandledrejection",
] as const;

const modules = [
  "app",
  "server",
  "coordinator",
  "host-daemon",
  "web",
  "@omnyo/domain",
  "@omnyo/process-utils",
  "@omnyo/plugin-sdk",
  "@omnyo/server-contract",
  "@omnyo/host-daemon-contract",
] as const;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GeneralErrorDiagnosticContext {
  operation: (typeof operations)[number];
  stage: (typeof stages)[number];
  failureClass: (typeof failureClasses)[number];
  outcome: (typeof outcomes)[number];
  retryable?: boolean;
  attempt?: number;
  durationMs?: number;
  status?: number;
  transportCode?: (typeof transportCodes)[number];
  dependency?: (typeof dependencies)[number];
  operationId?: string;
  itemCount?: number;
}

export interface TimelineProjectionDiagnosticContext {
  operation: "timeline-read";
  stage: "execute";
  failureClass: "internal";
  outcome: "terminal";
  reason: "missing-turn-start";
  source: "turn/completed" | "turn/input/accepted" | "message";
  projectionEventCount: number;
  projectionMessageCount: number;
  projectionStartSequence: number;
  projectionEndSequence: number;
  failureSequence: number;
  turnEventCount: number;
  turnStartCount: number;
  eventsOrdered: boolean;
  storedStart:
    | "unknown"
    | "missing"
    | "before-window"
    | "in-window"
    | "after-failure";
  storedStartSequence?: number;
}

export type SplitLoadDiagnosticContext = {
  operation: "split-load";
  outcome: "terminal";
  attempt: number;
  assetName?: string;
  online?: boolean;
} & (
  | {
      stage: "download";
      kind: "http";
      failureClass: "upstream-rejected";
      status: number;
      downloadPhase?: "request" | "body";
    }
  | {
      stage: "download";
      kind: "timeout";
      failureClass: "timeout";
      downloadPhase?: "request" | "body";
      assetAttemptId?: string;
    }
  | {
      stage: "download";
      kind: "network";
      failureClass: "connection";
      downloadPhase?: "request" | "body";
    }
  | {
      stage: "import";
      kind: "module";
      failureClass: "unknown";
      preflight?: "downloaded" | "unlisted";
      importFailure?: "fetch" | "css-preload" | "syntax" | "exception";
    }
);

export type ErrorDiagnosticContext =
  | GeneralErrorDiagnosticContext
  | SplitLoadDiagnosticContext
  | TimelineProjectionDiagnosticContext;

export interface ErrorReportIdentity {
  service: "coordinator" | "host-daemon" | "web";
  release?: string;
  runtimeRelease?: string;
  sourceRevision?: string;
  webOrigin?: string;
  platform?: string;
  arch?: string;
  runtime?: { name: string; version: string };
}

function allowed<T extends string>(
  value: unknown,
  values: readonly T[],
): T | undefined {
  return values.find((candidate) => candidate === value);
}

function boundedNumber(
  value: unknown,
  maximum: number,
  minimum = 0,
): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? Math.round(value)
    : undefined;
}

export function readDiagnosticAssetName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const hash = value.match(
    /^[A-Za-z0-9_-]{1,96}-([A-Za-z0-9_-]{8})\.(?:js|css)$/,
  )?.[1];

  return hash !== undefined && /[A-Z0-9_-]/.test(hash) ? value : undefined;
}

export const SPLIT_ASSET_ATTEMPT_HEADER = "x-omnyo-asset-attempt";

export function isSplitDiagnosticAssetPath(path: string): boolean {
  return (
    path.startsWith("/assets/") &&
    readDiagnosticAssetName(path.slice("/assets/".length)) !== undefined
  );
}

export function readSplitAssetAttemptId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
    ? value
    : undefined;
}

function readSplitLoadDiagnosticContext(
  value: object,
): SplitLoadDiagnosticContext | undefined {
  const stage: unknown = Reflect.get(value, "stage");
  const kind: unknown = Reflect.get(value, "kind");
  const attempt = boundedNumber(Reflect.get(value, "attempt"), 1_000, 1);

  if (attempt === undefined || Reflect.get(value, "outcome") !== "terminal")
    return undefined;
  const assetName = readDiagnosticAssetName(Reflect.get(value, "assetName"));
  const online: unknown = Reflect.get(value, "online");

  const base = {
    operation: "split-load" as const,
    outcome: "terminal" as const,
    attempt,
    ...(assetName === undefined ? {} : { assetName }),
    ...(typeof online === "boolean" ? { online } : {}),
  };

  if (stage === "import" && kind === "module") {
    const preflight = allowed(Reflect.get(value, "preflight"), [
      "downloaded",
      "unlisted",
    ]);

    const importFailure = allowed(Reflect.get(value, "importFailure"), [
      "fetch",
      "css-preload",
      "syntax",
      "exception",
    ]);

    return {
      ...base,
      stage,
      kind,
      failureClass: "unknown",
      ...(preflight === undefined ? {} : { preflight }),
      ...(importFailure === undefined ? {} : { importFailure }),
    };
  }

  if (stage !== "download") return undefined;

  const downloadPhase = allowed(Reflect.get(value, "downloadPhase"), [
    "request",
    "body",
  ]);

  const download = {
    ...base,
    ...(downloadPhase === undefined ? {} : { downloadPhase }),
  };

  if (kind === "timeout") {
    const assetAttemptId =
      downloadPhase === "request"
        ? readSplitAssetAttemptId(Reflect.get(value, "assetAttemptId"))
        : undefined;

    return {
      ...download,
      stage,
      kind,
      failureClass: "timeout",
      ...(assetAttemptId === undefined ? {} : { assetAttemptId }),
    };
  }

  if (kind === "network")
    return { ...download, stage, kind, failureClass: "connection" };
  const status = boundedNumber(Reflect.get(value, "status"), 599, 100);

  return kind === "http" && status !== undefined
    ? { ...download, stage, kind, status, failureClass: "upstream-rejected" }
    : undefined;
}

export function readErrorDiagnosticContext(
  value: unknown,
): ErrorDiagnosticContext | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  if (Reflect.get(value, "operation") === "split-load")
    return readSplitLoadDiagnosticContext(value);

  if (
    Reflect.get(value, "operation") === "timeline-read" &&
    Reflect.get(value, "reason") === "missing-turn-start"
  )
    return readTimelineProjectionDiagnosticContext(value);
  const operation = allowed(Reflect.get(value, "operation"), operations);
  const stage = allowed(Reflect.get(value, "stage"), stages);

  const failureClass = allowed(
    Reflect.get(value, "failureClass"),
    failureClasses,
  );

  const outcome = allowed(Reflect.get(value, "outcome"), outcomes);

  if (!operation || !stage || !failureClass || !outcome) return undefined;

  const context: GeneralErrorDiagnosticContext = {
    operation,
    stage,
    failureClass,
    outcome,
  };

  const retryable: unknown = Reflect.get(value, "retryable");
  const operationId: unknown = Reflect.get(value, "operationId");

  if (typeof retryable === "boolean") context.retryable = retryable;

  if (typeof operationId === "string" && uuidPattern.test(operationId))
    context.operationId = operationId;
  const attempt = boundedNumber(Reflect.get(value, "attempt"), 1_000);

  const durationMs = boundedNumber(
    Reflect.get(value, "durationMs"),
    86_400_000,
  );

  const status = boundedNumber(Reflect.get(value, "status"), 599, 100);

  const transportCode = allowed(
    Reflect.get(value, "transportCode"),
    transportCodes,
  );

  const dependency = allowed(Reflect.get(value, "dependency"), dependencies);
  const itemCount = boundedNumber(Reflect.get(value, "itemCount"), 100_000);

  if (attempt !== undefined) context.attempt = attempt;

  if (durationMs !== undefined) context.durationMs = durationMs;

  if (status !== undefined) context.status = status;

  if (transportCode !== undefined) context.transportCode = transportCode;

  if (dependency !== undefined) context.dependency = dependency;

  if (itemCount !== undefined) context.itemCount = itemCount;

  return context;
}

function readTimelineProjectionDiagnosticContext(
  value: object,
): TimelineProjectionDiagnosticContext | undefined {
  const source = allowed(Reflect.get(value, "source"), [
    "turn/completed",
    "turn/input/accepted",
    "message",
  ]);

  const storedStart = allowed(Reflect.get(value, "storedStart"), [
    "unknown",
    "missing",
    "before-window",
    "in-window",
    "after-failure",
  ]);

  const eventsOrdered: unknown = Reflect.get(value, "eventsOrdered");

  const projectionEventCount = boundedNumber(
    Reflect.get(value, "projectionEventCount"),
    10_000_000,
  );

  const projectionMessageCount = boundedNumber(
    Reflect.get(value, "projectionMessageCount"),
    10_000_000,
  );

  const projectionStartSequence = boundedNumber(
    Reflect.get(value, "projectionStartSequence"),
    Number.MAX_SAFE_INTEGER,
  );

  const projectionEndSequence = boundedNumber(
    Reflect.get(value, "projectionEndSequence"),
    Number.MAX_SAFE_INTEGER,
  );

  const failureSequence = boundedNumber(
    Reflect.get(value, "failureSequence"),
    Number.MAX_SAFE_INTEGER,
  );

  const turnEventCount = boundedNumber(
    Reflect.get(value, "turnEventCount"),
    10_000_000,
  );

  const turnStartCount = boundedNumber(
    Reflect.get(value, "turnStartCount"),
    10_000_000,
  );

  const storedStartSequence = boundedNumber(
    Reflect.get(value, "storedStartSequence"),
    Number.MAX_SAFE_INTEGER,
  );

  if (
    !source ||
    !storedStart ||
    typeof eventsOrdered !== "boolean" ||
    projectionEventCount === undefined ||
    projectionMessageCount === undefined ||
    projectionStartSequence === undefined ||
    projectionEndSequence === undefined ||
    failureSequence === undefined ||
    turnEventCount === undefined ||
    turnStartCount === undefined ||
    Reflect.get(value, "stage") !== "execute" ||
    Reflect.get(value, "failureClass") !== "internal" ||
    Reflect.get(value, "outcome") !== "terminal"
  )
    return undefined;

  return {
    operation: "timeline-read",
    stage: "execute",
    failureClass: "internal",
    outcome: "terminal",
    reason: "missing-turn-start",
    source,
    storedStart,
    eventsOrdered,
    projectionEventCount,
    projectionMessageCount,
    projectionStartSequence,
    projectionEndSequence,
    failureSequence,
    turnEventCount,
    turnStartCount,
    ...(storedStartSequence === undefined ? {} : { storedStartSequence }),
  };
}

export function ownedErrorSource(value: string): string | undefined {
  if (value.length > 1_024) return undefined;
  const path = value.replaceAll("\\", "/").split(/[?#]/, 1)[0] ?? "";

  const source = path.match(
    /(?:^|\/)((?:apps\/(?:app|server|host-daemon)|packages\/[a-z][a-z0-9-]*)\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.[cm]?[jt]sx?)$/,
  )?.[1];

  const asset = path.match(
    /(?:^|\/)(assets\/[A-Za-z0-9_-]+\.(?:js|mjs))$/,
  )?.[1];

  const runtime = path.match(
    /(?:^|\/)((?:server|host-daemon)\/dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js|dist\/(?:start-server|omnyo-app|bb-app|host-daemon)\.js)$/,
  )?.[1];

  const owned = source ?? asset ?? runtime;

  return owned === undefined ? undefined : `app:///${owned}`;
}

function readPluginOverlayContext(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const pluginId: unknown = Reflect.get(value, "pluginId");
  const bundleHash: unknown = Reflect.get(value, "bundleHash");

  if (
    typeof pluginId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,95}$/.test(pluginId)
  )
    return undefined;

  return {
    pluginId,
    ...(typeof bundleHash === "string" && /^[a-f0-9]{16}$/.test(bundleHash)
      ? { bundleHash }
      : {}),
  };
}

function scrubFrame(
  frame: StackFrame,
  overlayAsset: { path: string; origin: string | undefined } | undefined,
): StackFrame | undefined {
  const source = frame.filename ?? frame.abs_path ?? "";

  const pluginSource =
    overlayAsset !== undefined && source.length <= 1_024
      ? source.split(/[?#]/, 1)[0]
      : undefined;

  const filename =
    overlayAsset !== undefined &&
    (pluginSource === overlayAsset.path ||
      pluginSource === `app://${overlayAsset.path}` ||
      (overlayAsset.origin !== undefined &&
        pluginSource === `${overlayAsset.origin}${overlayAsset.path}`))
      ? `app://${overlayAsset.path}`
      : ownedErrorSource(source);

  if (filename === undefined) return undefined;
  const result: StackFrame = { filename };
  const module = allowed(frame.module, modules);

  if (module !== undefined) result.module = module;
  const lineno = boundedNumber(frame.lineno, 100_000_000, 1);
  const colno = boundedNumber(frame.colno, 100_000_000);

  if (lineno !== undefined) result.lineno = lineno;

  if (colno !== undefined) result.colno = colno;

  if (typeof frame.in_app === "boolean") result.in_app = frame.in_app;

  return result;
}

function diagnosticSummary(context: ErrorDiagnosticContext): string {
  if (context.operation === "split-load") {
    return context.stage === "import"
      ? `Web feature import failed: ${context.importFailure ?? "unclassified"}`
      : `Web feature download failed: ${context.kind === "http" ? `HTTP ${context.status}` : context.kind}`;
  }

  if ("reason" in context && context.reason === "missing-turn-start")
    return "Timeline projection is missing a turn start";

  const labels = {
    request: "Request failed",
    "thread-startup": "Thread startup failed",
    "claude-model-confirmation": "Claude model confirmation failed",
    "timeline-read": "Timeline read failed",
    "provider-request": "Provider request failed",
    "voice-transcription": "Voice transcription failed",
    plugin: "Plugin operation failed",
    startup: "Process startup failed",
    "uncaught-exception": "Uncaught process failure",
  };

  return `${labels[context.operation]}: ${context.failureClass}`;
}

function scrubException(
  exception: Exception,
  context: ErrorDiagnosticContext | undefined,
  overlayAsset: Parameters<typeof scrubFrame>[1],
): Exception {
  const type = allowed(exception.type, exceptionTypes) ?? "Error";

  const result: Exception = {
    type,
    value: context === undefined ? type : diagnosticSummary(context),
  };

  const module = allowed(exception.module, modules);

  if (module !== undefined) result.module = module;
  const mechanismType = allowed(exception.mechanism?.type, mechanisms);

  if (mechanismType !== undefined) {
    result.mechanism = { type: mechanismType };

    if (typeof exception.mechanism?.handled === "boolean")
      result.mechanism.handled = exception.mechanism.handled;
  }

  const frames = exception.stacktrace?.frames?.slice(-80).flatMap((frame) => {
    const safe = scrubFrame(frame, overlayAsset);

    return safe === undefined ? [] : [safe];
  });

  if (frames !== undefined && frames.length > 0) result.stacktrace = { frames };

  return result;
}

export function scrubDiagnosticErrorEvent(
  event: Event,
  identity?: ErrorReportIdentity,
): ErrorEvent {
  const diagnostic = readErrorDiagnosticContext(event.contexts?.diagnostic);

  const overlay =
    identity?.service === "web"
      ? readPluginOverlayContext(event.contexts?.pluginOverlay)
      : undefined;

  const overlayAsset =
    overlay?.bundleHash === undefined
      ? undefined
      : {
          path: `/api/v1/plugin-app-assets/${overlay.bundleHash}/app.js`,
          origin: identity?.webOrigin,
        };

  const result: ErrorEvent = { type: undefined };

  if (
    typeof event.event_id === "string" &&
    /^[0-9a-f]{32}$/i.test(event.event_id)
  )
    result.event_id = event.event_id;

  if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp))
    result.timestamp = event.timestamp;
  result.level = event.level === "fatal" ? "fatal" : "error";

  if (identity !== undefined) {
    result.tags = { service: identity.service };
    result.platform = identity.service === "web" ? "javascript" : "node";

    const stage = allowed(event.tags?.stage, [
      "plugin",
      "request",
      "startup",
      "uncaught-exception",
    ]);

    if (stage !== undefined) result.tags.stage = stage;

    if (identity.release !== undefined) result.release = identity.release;
    result.environment = "production";

    if (identity.platform !== undefined)
      result.tags.platform = identity.platform;

    if (identity.arch !== undefined) result.tags.arch = identity.arch;

    if (identity.runtime !== undefined)
      result.contexts = { runtime: { ...identity.runtime } };

    if (
      identity.runtimeRelease !== undefined ||
      identity.sourceRevision !== undefined
    ) {
      result.contexts = {
        ...result.contexts,
        artifact: {
          ...(identity.runtimeRelease === undefined
            ? {}
            : { runtimeRelease: identity.runtimeRelease }),
          ...(identity.sourceRevision === undefined
            ? {}
            : { sourceRevision: identity.sourceRevision }),
        },
      };
    }
  }

  if (diagnostic !== undefined) {
    result.contexts = { ...result.contexts, diagnostic: { ...diagnostic } };
    result.fingerprint = [
      "{{ default }}",
      diagnostic.operation,
      diagnostic.failureClass,
    ];
  }

  if (overlay !== undefined)
    result.contexts = { ...result.contexts, pluginOverlay: overlay };

  if (event.exception?.values !== undefined)
    result.exception = {
      values: event.exception.values
        .slice(-8)
        .map((exception) =>
          scrubException(exception, diagnostic, overlayAsset),
        ),
    };
  else if (event.message !== undefined || event.logentry !== undefined)
    result.message =
      diagnostic === undefined ? "Error" : diagnosticSummary(diagnostic);

  const images = event.debug_meta?.images?.slice(0, 80).flatMap((image) => {
    if (
      image.type !== "sourcemap" ||
      typeof image.code_file !== "string" ||
      typeof image.debug_id !== "string" ||
      !uuidPattern.test(image.debug_id)
    )
      return [];
    const codeFile = ownedErrorSource(image.code_file);

    return codeFile === undefined
      ? []
      : [
          {
            type: "sourcemap" as const,
            code_file: codeFile,
            debug_id: image.debug_id,
          },
        ];
  });

  if (images !== undefined && images.length > 0) result.debug_meta = { images };

  return result;
}

export interface ErrorReportingEligibility {
  enabled: boolean;
  generation: number;
}

export function createErrorReportingBoundary(
  eligibility: () => ErrorReportingEligibility,
  scrub: (event: Event, hint?: EventHint) => Event,
): {
  integration: Integration;
  beforeSend: (event: ErrorEvent, hint: EventHint) => ErrorEvent | null;
  transport: (transport: Transport) => Transport;
} {
  const tokenKey = Symbol("capture eligibility");
  const snapshots = new WeakMap<object, ErrorReportingEligibility>();
  const pending = new Map<string, number>();

  const eligible = (snapshot: ErrorReportingEligibility | undefined) => {
    const current = eligibility();

    return (
      snapshot?.enabled === true &&
      current.enabled &&
      snapshot.generation === current.generation
    );
  };

  const mark = (hint: EventHint | undefined): EventHint => {
    const token = {};
    snapshots.set(token, { ...eligibility() });
    const marked = { ...hint, [tokenKey]: token };

    return marked;
  };

  const read = (hint: EventHint | undefined) => {
    const token: unknown =
      hint === undefined ? undefined : Reflect.get(hint, tokenKey);

    return typeof token === "object" && token !== null
      ? snapshots.get(token)
      : undefined;
  };

  const prepare = (event: Event, hint: EventHint | undefined): Event | null => {
    const snapshot = read(hint);

    if (!eligible(snapshot)) return null;
    const result = scrub(event, hint);
    const diagnostic = readErrorDiagnosticContext(result.contexts?.diagnostic);

    if (
      result.level !== "fatal" &&
      diagnostic !== undefined &&
      diagnostic.outcome !== "terminal"
    )
      return null;

    if (result.event_id !== undefined && snapshot !== undefined)
      pending.set(result.event_id, snapshot.generation);

    return result;
  };

  return {
    integration: {
      name: "OmnyoErrorReportingBoundary",
      setup(client: Client) {
        const captureException = client.captureException.bind(client);
        const captureMessage = client.captureMessage.bind(client);
        const captureEvent = client.captureEvent.bind(client);
        client.captureException = (error, hint, scope) =>
          eligibility().enabled
            ? captureException(error, mark(hint), scope)
            : "";
        client.captureMessage = (message, level, hint, scope) =>
          eligibility().enabled
            ? captureMessage(message, level, mark(hint), scope)
            : "";
        client.captureEvent = (event, hint, scope) =>
          eligibility().enabled ? captureEvent(event, mark(hint), scope) : "";
      },
      processEvent: (event, hint) =>
        event.type === "feedback"
          ? prepare(event, hint)
          : eligible(read(hint))
            ? event
            : null,
    },
    beforeSend: (event, hint) => {
      const prepared = prepare(event, hint);

      return prepared === null ? null : { ...prepared, type: undefined };
    },
    transport(transport) {
      return {
        flush: (timeout) => transport.flush(timeout),
        send(envelope: Envelope) {
          const items: EventItem[] = [];

          for (const [header, payload] of envelope[1]) {
            if (
              (header.type !== "event" && header.type !== "feedback") ||
              typeof payload !== "object" ||
              payload === null ||
              !("event_id" in payload) ||
              typeof payload.event_id !== "string"
            )
              continue;
            const generation = pending.get(payload.event_id);
            pending.delete(payload.event_id);

            if (
              !eligible(
                generation === undefined
                  ? undefined
                  : { enabled: true, generation },
              )
            )
              continue;

            if (
              !("type" in payload) ||
              (payload.type !== undefined && payload.type !== "feedback")
            )
              continue;
            items.push([{ type: header.type }, scrub(payload)]);
          }

          if (items.length === 0) return Promise.resolve({});
          const eventId = items[0]?.[1].event_id;

          if (eventId === undefined) return Promise.resolve({});

          const safeEnvelope: EventEnvelope = [
            { event_id: eventId, sent_at: new Date().toISOString() },
            items,
          ];

          return transport.send(safeEnvelope);
        },
      };
    },
  };
}
