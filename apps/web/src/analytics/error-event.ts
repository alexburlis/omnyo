import type { ErrorEvent, Event, Exception, StackFrame } from "@sentry/core";

import { SENTRY_RUNTIME } from "./config";

export type ErrorReportService = "website-browser" | "website-server";

export interface ErrorReportIdentity {
  service: ErrorReportService;
  environment: "production" | "development";
  platform: "javascript" | "node";
  ownFrame: (filename: string) => string | undefined;
  contexts?: ErrorEvent["contexts"];
}

const MAX_EXCEPTIONS = 6;

const MAX_FRAMES = 60;

const MAX_TEXT_CHARS = 300;

const EXCEPTION_TYPE = /^[A-Za-z_$][\w$.]{0,63}$/;

const MECHANISM_TYPE = /^[a-z][\w.:-]{0,63}$/i;

const URL_IN_TEXT = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>`]+/gi;

const EMAIL_IN_TEXT = /[^\s@"'<>()[\]]+@[^\s@"'<>()[\]]+\.[a-z]{2,}/gi;

const LONG_TOKEN = /[A-Za-z0-9_+/=-]{32,}/g;

const ROUTE_SECTIONS = new Set([
  "abuse",
  "api",
  "compare",
  "explore",
  "features",
  "guides",
  "imprint",
  "lab",
  "plugin-guide",
  "privacy",
  "terms",
  "workflows",
]);

export function routeSection(pathname: string): string {
  if (pathname === "/" || pathname === "") return "home";
  const section = pathname.split("/", 2)[1] ?? "";

  return ROUTE_SECTIONS.has(section) ? section : "other";
}

function scrubUrl(value: string): string {
  try {
    const url = new URL(value);

    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? "";
  }
}

export function scrubErrorText(text: string): string {
  const scrubbed = text
    .replace(URL_IN_TEXT, scrubUrl)
    .replace(EMAIL_IN_TEXT, "[email]")
    .replace(LONG_TOKEN, "[redacted]");

  return scrubbed.length > MAX_TEXT_CHARS
    ? `${scrubbed.slice(0, MAX_TEXT_CHARS)}…`
    : scrubbed;
}

function boundedLine(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 100_000_000
    ? value
    : undefined;
}

function rebuildFrame(
  frame: StackFrame,
  ownFrame: ErrorReportIdentity["ownFrame"],
): StackFrame | undefined {
  const source = frame.filename ?? frame.abs_path;

  if (source === undefined || source.length > 2_048) return undefined;
  const filename = ownFrame(source);

  if (filename === undefined) return undefined;
  const result: StackFrame = { filename, in_app: true };

  if (
    frame.function !== undefined &&
    /^[\w$.<>[\] ]{1,80}$/.test(frame.function)
  )
    result.function = frame.function;
  const lineno = boundedLine(frame.lineno);
  const colno = boundedLine(frame.colno);

  if (lineno !== undefined) result.lineno = lineno;

  if (colno !== undefined) result.colno = colno;

  return result;
}

function rebuildException(
  exception: Exception,
  ownFrame: ErrorReportIdentity["ownFrame"],
): Exception {
  const type =
    exception.type !== undefined && EXCEPTION_TYPE.test(exception.type)
      ? exception.type
      : "Error";

  const result: Exception = {
    type,
    value:
      exception.value === undefined ? type : scrubErrorText(exception.value),
  };

  if (
    exception.mechanism?.type !== undefined &&
    MECHANISM_TYPE.test(exception.mechanism.type)
  ) {
    result.mechanism = { type: exception.mechanism.type };

    if (exception.mechanism.handled !== undefined)
      result.mechanism.handled = exception.mechanism.handled;
  }

  const frames = exception.stacktrace?.frames
    ?.slice(-MAX_FRAMES)
    .flatMap((frame) => rebuildFrame(frame, ownFrame) ?? []);

  if (frames !== undefined && frames.length > 0) result.stacktrace = { frames };

  return result;
}

export function rebuildErrorEvent(
  event: Event,
  identity: ErrorReportIdentity,
  tags: Record<string, string>,
): ErrorEvent | null {
  const exceptions = event.exception?.values
    ?.slice(-MAX_EXCEPTIONS)
    .map((exception) => rebuildException(exception, identity.ownFrame));

  if (
    exceptions === undefined ||
    !exceptions.some((exception) => exception.stacktrace !== undefined)
  )
    return null;

  const result: ErrorEvent = {
    type: undefined,
    level: event.level === "fatal" ? "fatal" : "error",
    platform: identity.platform,
    environment: identity.environment,
    exception: { values: exceptions },
    tags: { runtime: SENTRY_RUNTIME, service: identity.service, ...tags },
  };

  if (event.event_id !== undefined && /^[a-f0-9]{32}$/i.test(event.event_id))
    result.event_id = event.event_id;

  if (event.timestamp !== undefined && Number.isFinite(event.timestamp))
    result.timestamp = event.timestamp;

  if (identity.contexts !== undefined) result.contexts = identity.contexts;

  return result;
}
