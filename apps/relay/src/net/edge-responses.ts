import {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import {
  type Http2ServerRequest,
  Http2ServerResponse,
  type ServerHttp2Stream,
} from "node:http2";
import { RELAY_STRICT_TRANSPORT_SECURITY } from "../contracts.js";

const STRICT_TRANSPORT_SECURITY = "strict-transport-security";

export const HTTP2_FORBIDDEN_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
  "http2-settings",
  "te",
]);

export type EdgeRequest = IncomingMessage | Http2ServerRequest;

export type EdgeResponse = ServerResponse | Http2ServerResponse;

export interface PlainResponse {
  writeHead(statusCode: number, headers: OutgoingHttpHeaders): unknown;
  end(): unknown;
  end(body: string): unknown;
}

export function writeBadRequest(response: PlainResponse): void {
  response.writeHead(400, {
    "content-type": "text/plain; charset=utf-8",
    connection: "close",
  });
  response.end("Bad request\n");
}

export function badRequestResponse(): Response {
  return new Response("Bad request\n", {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function fieldName(name: string): string {
  return name.trim().toLowerCase();
}

function isStrictTransportSecurity(name: string): boolean {
  return fieldName(name) === STRICT_TRANSPORT_SECURITY;
}

function isForbiddenOverHttp2(name: string): boolean {
  return HTTP2_FORBIDDEN_RESPONSE_HEADERS.has(fieldName(name));
}

export class RelayServerResponse extends ServerResponse {
  constructor(...args: ConstructorParameters<typeof ServerResponse>) {
    super(...args);
    super.setHeader(STRICT_TRANSPORT_SECURITY, RELAY_STRICT_TRANSPORT_SECURITY);
  }

  override setHeader(
    name: string,
    value: number | string | readonly string[],
  ): this {
    return super.setHeader(
      name,
      isStrictTransportSecurity(name) ? RELAY_STRICT_TRANSPORT_SECURITY : value,
    );
  }

  override appendHeader(name: string, value: string | readonly string[]): this {
    if (isStrictTransportSecurity(name)) {
      return super.setHeader(
        STRICT_TRANSPORT_SECURITY,
        RELAY_STRICT_TRANSPORT_SECURITY,
      );
    }

    return super.appendHeader(name, value);
  }

  override removeHeader(name: string): void {
    if (!isStrictTransportSecurity(name)) super.removeHeader(name);
  }
}

export class RelayHttp2ServerResponse extends Http2ServerResponse {
  constructor(stream: ServerHttp2Stream) {
    super(stream);
    super.setHeader(STRICT_TRANSPORT_SECURITY, RELAY_STRICT_TRANSPORT_SECURITY);
    Object.defineProperty(this, "writableFinished", {
      get: () => !stream.aborted && stream.writableFinished,
    });
  }

  override setHeader(
    name: string,
    value: number | string | readonly string[],
  ): void {
    if (isForbiddenOverHttp2(name)) return;

    super.setHeader(
      name,
      isStrictTransportSecurity(name) ? RELAY_STRICT_TRANSPORT_SECURITY : value,
    );
  }

  override appendHeader(name: string, value: string | string[]): void {
    if (isForbiddenOverHttp2(name)) return;

    if (isStrictTransportSecurity(name)) {
      super.setHeader(
        STRICT_TRANSPORT_SECURITY,
        RELAY_STRICT_TRANSPORT_SECURITY,
      );

      return;
    }

    super.appendHeader(name, value);
  }

  override removeHeader(name: string): void {
    if (!isStrictTransportSecurity(name)) super.removeHeader(name);
  }

  override writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders,
    headers?: OutgoingHttpHeaders,
  ): this {
    const fields =
      typeof statusMessageOrHeaders === "string"
        ? headers
        : statusMessageOrHeaders;

    const allowed: OutgoingHttpHeaders = {};

    for (const [name, value] of Object.entries(fields ?? {})) {
      if (isForbiddenOverHttp2(name) || isStrictTransportSecurity(name)) {
        continue;
      }

      allowed[name] = value;
    }

    return super.writeHead(statusCode, allowed);
  }
}
