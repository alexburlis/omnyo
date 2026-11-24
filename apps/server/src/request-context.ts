import { getConnInfo } from "@hono/node-server/conninfo";
import {
  APP_SURFACE_API,
  APP_SURFACE_HEADER_NAME,
  parseRequestAppSurface,
  type RequestAppSurface,
} from "@omnyo/config/app-surface";
import type { Context, MiddlewareHandler } from "hono";
import { ApiError } from "./errors.js";

export const TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY = "omnyoTrustedRemoteAddress";

const GATE_AUTH_HEADER_NAME = "x-omnyo-gate-auth";

const GATE_MACHINE_ID_HEADER_NAME = "x-omnyo-gate-machine-id";

type GateAuthKind = "anonymous" | "machine" | "session";

const GATE_ANONYMOUS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const GATE_ANONYMOUS_INSTALLER_PATHS: ReadonlySet<string> = new Set([
  "/install.sh",
  "/install.ps1",
  "/install/version",
  "/install/omnyo-app.tgz",
]);

const GATE_ANONYMOUS_SHORT_ENROLLMENT_PATH = /^\/m\/[^/]+$/u;

const GATE_ANONYMOUS_PREVIEW_PATH =
  /^\/preview-content\/[^/]+\/[^/]+(?:\/.*)?$/su;

export interface GateAuthHeaderReader {
  req: { header(name: string): string | undefined };
}

interface TrustedRemoteAddressReader {
  get(key: typeof TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY): string | undefined;
}

declare module "hono" {
  interface ContextVariableMap {
    [TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY]: string | undefined;
  }
}

export function captureTrustedRemoteAddress(context: Context): void {
  try {
    context.set(
      TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY,
      getConnInfo(context).remote.address,
    );
  } catch {
    context.set(TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY, undefined);
  }
}

export function getTrustedRemoteAddress(
  context: TrustedRemoteAddressReader,
): string | undefined {
  return context.get(TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY);
}

export function getGateAuthKind(
  context: GateAuthHeaderReader,
): GateAuthKind | null {
  const value = context.req.header(GATE_AUTH_HEADER_NAME);

  if (value === undefined) return null;

  return value === "machine" || value === "session" ? value : "anonymous";
}

function gateAnonymousRequestPermitted(
  method: string,
  path: string,
  rawPath: string,
): boolean {
  if (
    method === "POST" &&
    path === "/api/v1/plugins/sentry/http/webhook" &&
    rawPath === path
  )
    return true;

  return (
    GATE_ANONYMOUS_METHODS.has(method) &&
    (GATE_ANONYMOUS_INSTALLER_PATHS.has(path) ||
      GATE_ANONYMOUS_SHORT_ENROLLMENT_PATH.test(path) ||
      GATE_ANONYMOUS_PREVIEW_PATH.test(path))
  );
}

export const guardAnonymousGateRequests: MiddlewareHandler = async (
  context,
  next,
) => {
  if (
    getGateAuthKind(context) === "anonymous" &&
    !gateAnonymousRequestPermitted(
      context.req.method,
      context.req.path,
      new URL(context.req.url).pathname,
    )
  )
    throw new ApiError(404, "not_found", "Not found");

  await next();
};

export function getGateMachineId(context: GateAuthHeaderReader): string | null {
  const value = context.req.header(GATE_MACHINE_ID_HEADER_NAME)?.trim();

  return value ? value : null;
}

export function resolveRequestAppSurface(context: Context): RequestAppSurface {
  return (
    parseRequestAppSurface(context.req.header(APP_SURFACE_HEADER_NAME)) ??
    APP_SURFACE_API
  );
}
