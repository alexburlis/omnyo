import { createHash } from "node:crypto";
import {
  BOOT_PART_PATHS,
  parseBootPartList,
  publicApiRoutes,
  typedRoutes,
  type BootPartName,
  type BootPartResult,
  type BootResponse,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { readPrimaryHostIdFromDataDir } from "../services/hosts/primary-host.js";

const FORWARDED_HEADER_EXCLUSIONS = [
  "accept-encoding",
  "content-length",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "range",
] as const;

export type BootPartDispatch = (
  request: Request,
  env: unknown,
) => Response | Promise<Response>;

interface BootRouteDeps {
  dataDir: string;
  dispatch: BootPartDispatch;
}

export function bootServerIdentity(dataDir: string): string {
  const primaryHostId = readPrimaryHostIdFromDataDir({ dataDir });

  return createHash("sha256")
    .update(
      `omnyo-boot-identity-v1\u0000${dataDir}\u0000${primaryHostId ?? ""}`,
    )
    .digest("hex");
}

function parseRequestedParts(value: string | undefined): BootPartName[] {
  try {
    return parseBootPartList(value);
  } catch {
    throw new ApiError(
      400,
      "invalid_request",
      "parts must list known boot parts separated by commas",
    );
  }
}

async function readPartResponse(response: Response): Promise<BootPartResult> {
  const text = await response.text();

  const isJson =
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "application/json";

  if (isJson && text.length > 0) {
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {}
  }

  return {
    status: response.ok ? 502 : response.status,
    body: {
      code: "boot_part_not_json",
      message: "This startup read did not return JSON",
    },
  };
}

export function registerBootRoutes(app: Hono, deps: BootRouteDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  get(publicApiRoutes.system.boot, async (context, query) => {
    const names = parseRequestedParts(query.parts);
    const headers = new Headers(context.req.raw.headers);

    for (const name of FORWARDED_HEADER_EXCLUSIONS) headers.delete(name);
    const origin = new URL(context.req.url).origin;

    const parts = await Promise.all(
      names.map(async (name) => {
        const response = await deps.dispatch(
          new Request(`${origin}/api/v1${BOOT_PART_PATHS[name]}`, {
            headers,
            signal: context.req.raw.signal,
          }),
          context.env,
        );

        context.req.raw.signal.throwIfAborted();

        return [name, await readPartResponse(response)] as const;
      }),
    );

    const body: BootResponse = {
      version: 1,
      serverIdentity: bootServerIdentity(deps.dataDir),
      parts: Object.fromEntries(parts),
    };

    return context.json(body);
  });
}
