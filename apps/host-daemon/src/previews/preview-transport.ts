import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { WebSocket, type RawData } from "ws";
import {
  PREVIEW_HTTP_MAX_BYTES,
  PREVIEW_REQUEST_HEADER_NAMES,
  PREVIEW_SOCKET_MAX_BYTES,
  type PreviewTransportCommandByType,
  type PreviewTransportResultByType,
} from "@omnyo/host-daemon-contract";

interface PreviewTarget {
  hostname: "127.0.0.1" | "::1";
  port: number;
  protocol: "http:" | "https:";
}

interface PreviewHostTransportOptions {
  logger?: Pick<import("../logger.js").HostDaemonLogger, "info">;
  getTarget(previewId: string, runId: string): Promise<PreviewTarget>;
  validateRun(previewId: string, runId: string): Promise<void>;
}

type SocketTarget = Pick<
  PreviewTransportCommandByType["preview.socket.open"],
  "previewId" | "runId" | "accessId" | "connectionId"
>;

type SocketMessage =
  PreviewTransportResultByType["preview.socket.read"]["messages"][number];

interface SocketState {
  target: SocketTarget;
  socket: WebSocket;
  messages: SocketMessage[];
  bytes: number;
  closed: boolean;
  touchedAt: number;
  notify: (() => void) | null;
  reading: boolean;
}

interface StoredCookie {
  name: string;
  value: string;
  path: string;
  expiresAt: number;
}

interface CookieSession {
  cookies: StoredCookie[];
  touchedAt: number;
}

const REQUEST_HEADERS: ReadonlySet<string> = new Set(
  PREVIEW_REQUEST_HEADER_NAMES,
);

const RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "accept-ranges",
  "content-range",
  "location",
  "vary",
  "content-security-policy",
  "content-encoding",
]);

function targetUrl(target: PreviewTarget, path: string): URL {
  const hostname = target.hostname === "::1" ? "[::1]" : target.hostname;
  const base = new URL(`${target.protocol}//${hostname}:${target.port}/`);
  const url = new URL(path, base);

  if (
    url.origin !== base.origin ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/u.test(path)
  )
    throw new Error("Invalid preview request path");

  return url;
}

function sessionKey(
  target: Pick<SocketTarget, "previewId" | "runId" | "accessId">,
): string {
  return JSON.stringify([target.previewId, target.runId, target.accessId]);
}

function sameSocketTarget(a: SocketTarget, b: SocketTarget): boolean {
  return a.connectionId === b.connectionId && sessionKey(a) === sessionKey(b);
}

export class PreviewHostTransport {
  private readonly sockets = new Map<string, SocketState>();
  private readonly cookies = new Map<string, CookieSession>();
  private readonly expiryTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: PreviewHostTransportOptions) {
    this.expiryTimer = setInterval(() => this.expire(), 10_000);
    this.expiryTimer.unref();
  }

  async http(
    input: PreviewTransportCommandByType["preview.http"],
  ): Promise<PreviewTransportResultByType["preview.http"]> {
    const target = await this.options.getTarget(input.previewId, input.runId);
    const url = targetUrl(target, input.path);

    const headers: Record<string, string> = {
      "accept-encoding": "identity",
      origin: url.origin,
    };

    for (const [name, value] of input.headers) {
      const key = name.toLowerCase();

      if (REQUEST_HEADERS.has(key) && !/[\r\n]/u.test(value))
        headers[key] = value;
    }

    const key = sessionKey(input);
    const cookies = this.cookieHeader(key, url.pathname);

    if (cookies) headers.cookie = cookies;
    const body = Buffer.from(input.bodyBase64, "base64");

    if (body.byteLength > PREVIEW_HTTP_MAX_BYTES)
      throw new Error("Preview request is too large");

    if (body.length) headers["content-length"] = String(body.length);

    return new Promise((resolve, reject) => {
      const request = (
        target.protocol === "https:" ? httpsRequest : httpRequest
      )(url, { method: input.method, headers }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;

        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;

          if (bytes > PREVIEW_HTTP_MAX_BYTES)
            request.destroy(new Error("Preview response is too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("aborted", () =>
          reject(new Error("Preview response was interrupted")),
        );
        response.on("end", () => {
          this.storeCookies(
            key,
            url.pathname,
            response.headers["set-cookie"] ?? [],
          );
          const responseHeaders: [string, string][] = [];

          for (const [name, value] of Object.entries(response.headers)) {
            if (!RESPONSE_HEADERS.has(name) || value === undefined) continue;

            for (const entry of Array.isArray(value) ? value : [value])
              responseHeaders.push([name, entry]);
          }

          resolve({
            status: response.statusCode ?? 502,
            headers: responseHeaders,
            bodyBase64: Buffer.concat(chunks).toString("base64"),
          });
        });
      });

      request.setTimeout(20_000, () =>
        request.destroy(new Error("Preview request timed out")),
      );
      request.on("error", () => reject(new Error("Preview request failed")));
      request.end(body);
    });
  }

  async open(
    input: PreviewTransportCommandByType["preview.socket.open"],
  ): Promise<PreviewTransportResultByType["preview.socket.open"]> {
    const existing = this.sockets.get(input.connectionId);

    if (existing) {
      if (!sameSocketTarget(existing.target, input) || existing.closed)
        throw new Error("Preview connection is unavailable");

      return { protocol: existing.socket.protocol };
    }

    if (this.sockets.size >= 128)
      throw new Error("Too many preview connections");
    const target = await this.options.getTarget(input.previewId, input.runId);
    const url = targetUrl(target, input.path);
    const origin = url.origin;
    url.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const cookie = this.cookieHeader(sessionKey(input), url.pathname);

    const socket = new WebSocket(url, input.protocols, {
      handshakeTimeout: 5_000,
      maxPayload: PREVIEW_SOCKET_MAX_BYTES,
      headers: { origin, ...(cookie ? { cookie } : {}) },
    });

    const state: SocketState = {
      target: input,
      socket,
      messages: [],
      bytes: 0,
      closed: false,
      touchedAt: Date.now(),
      notify: null,
      reading: false,
    };

    this.sockets.set(input.connectionId, state);

    socket.on("message", (data: RawData, binary: boolean) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(
            data instanceof ArrayBuffer ? new Uint8Array(data) : data,
          );

      state.bytes += bytes.byteLength;

      if (
        state.bytes > PREVIEW_SOCKET_MAX_BYTES ||
        state.messages.length >= 64
      ) {
        socket.terminate();
        this.endSocket(state);

        return;
      }

      state.messages.push({ dataBase64: bytes.toString("base64"), binary });
      state.notify?.();
    });
    socket.on("close", (code: number) => {
      this.options.logger?.info(
        {
          previewId: input.previewId,
          runId: input.runId,
          connectionId: input.connectionId,
          upstreamCloseCode: code,
        },
        "Preview upstream socket closed",
      );
      this.endSocket(state);
    });
    socket.on("error", () => this.endSocket(state));

    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve({ protocol: socket.protocol }));
      socket.once("error", () =>
        reject(new Error("Preview WebSocket connection failed")),
      );
      socket.once("close", () =>
        reject(new Error("Preview WebSocket closed before opening")),
      );
    });
  }

  async read(
    input: PreviewTransportCommandByType["preview.socket.read"],
  ): Promise<PreviewTransportResultByType["preview.socket.read"]> {
    const state = this.requireSocket(input);

    if (state.reading)
      throw new Error("Preview connection already has a reader");
    state.reading = true;

    try {
      await this.options
        .validateRun(input.previewId, input.runId)
        .catch((error) => {
          this.close(input);
          throw error;
        });

      if (!state.closed && state.messages.length === 0) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            state.notify = null;
            resolve();
          };

          const timer = setTimeout(finish, 1_000);
          state.notify = finish;
        });
      }

      const messages = state.messages.splice(0);
      state.bytes = 0;

      if (state.closed) this.sockets.delete(input.connectionId);

      return { messages, closed: state.closed };
    } finally {
      state.reading = false;
    }
  }

  async write(
    input: PreviewTransportCommandByType["preview.socket.write"],
  ): Promise<PreviewTransportResultByType["preview.socket.write"]> {
    const state = this.requireSocket(input);
    await this.options
      .validateRun(input.previewId, input.runId)
      .catch((error) => {
        this.close(input);
        throw error;
      });
    const bytes = Buffer.from(input.dataBase64, "base64");

    if (
      state.closed ||
      state.socket.readyState !== WebSocket.OPEN ||
      bytes.length > PREVIEW_SOCKET_MAX_BYTES ||
      state.socket.bufferedAmount > PREVIEW_SOCKET_MAX_BYTES
    )
      throw new Error("Preview connection is unavailable");
    await new Promise<void>((resolve, reject) =>
      state.socket.send(bytes, { binary: input.binary }, (error) =>
        error ? reject(new Error("Preview WebSocket write failed")) : resolve(),
      ),
    );

    return {};
  }

  close(
    input: SocketTarget,
  ): PreviewTransportResultByType["preview.socket.close"] {
    const state = this.sockets.get(input.connectionId);

    if (state && sameSocketTarget(state.target, input)) {
      state.socket.terminate();
      this.endSocket(state);
      this.sockets.delete(input.connectionId);
    }

    return {};
  }

  dispose(): void {
    clearInterval(this.expiryTimer);

    for (const state of this.sockets.values()) {
      state.socket.terminate();
      this.endSocket(state);
    }

    this.sockets.clear();
    this.cookies.clear();
  }

  private requireSocket(input: SocketTarget): SocketState {
    const state = this.sockets.get(input.connectionId);

    if (!state || !sameSocketTarget(state.target, input))
      throw new Error("Preview connection is unavailable");
    state.touchedAt = Date.now();

    return state;
  }

  private endSocket(state: SocketState): void {
    state.closed = true;
    state.notify?.();
  }

  private cookieHeader(key: string, path: string): string {
    const session = this.cookies.get(key);

    if (!session) return "";
    session.touchedAt = Date.now();
    session.cookies = session.cookies.filter(
      (cookie) => cookie.expiresAt > Date.now(),
    );

    return session.cookies
      .filter(
        (cookie) =>
          path === cookie.path ||
          path.startsWith(
            cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`,
          ),
      )
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  private storeCookies(key: string, path: string, values: string[]): void {
    if (!values.length) return;

    if (this.cookies.size >= 256 && !this.cookies.has(key)) return;

    const session = this.cookies.get(key) ?? {
      cookies: [],
      touchedAt: Date.now(),
    };

    session.touchedAt = Date.now();

    for (const value of values) {
      if (value.length > 4096 || /[\r\n]/u.test(value)) continue;
      const [pair = "", ...attributes] = value.split(";");
      const split = pair.indexOf("=");

      if (split < 1) continue;

      const cookie: StoredCookie = {
        name: pair.slice(0, split).trim(),
        value: pair.slice(split + 1).trim(),
        path: path.slice(0, path.lastIndexOf("/") + 1) || "/",
        expiresAt: Date.now() + 8 * 60 * 60_000,
      };

      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(cookie.name)) continue;

      for (const attribute of attributes) {
        const boundary = attribute.indexOf("=");

        const name = (
          boundary === -1 ? attribute : attribute.slice(0, boundary)
        )
          .trim()
          .toLowerCase();

        const content =
          boundary === -1 ? "" : attribute.slice(boundary + 1).trim();

        if (name === "path" && content.startsWith("/")) cookie.path = content;

        if (name === "max-age" && /^-?\d+$/u.test(content))
          cookie.expiresAt = Date.now() + Number(content) * 1_000;

        if (name === "expires" && Number.isFinite(Date.parse(content)))
          cookie.expiresAt = Date.parse(content);
      }

      session.cookies = session.cookies.filter(
        (stored) => stored.name !== cookie.name || stored.path !== cookie.path,
      );

      if (cookie.expiresAt > Date.now() && session.cookies.length < 32)
        session.cookies.push(cookie);
    }

    this.cookies.set(key, session);
  }

  private expire(): void {
    const now = Date.now();

    for (const state of this.sockets.values())
      if (now - state.touchedAt > 30_000) this.close(state.target);

    for (const [key, session] of this.cookies)
      if (now - session.touchedAt > 8 * 60 * 60_000) this.cookies.delete(key);
  }
}
