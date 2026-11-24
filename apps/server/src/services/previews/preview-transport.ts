import { randomBytes, randomUUID } from "node:crypto";
import {
  createPreviewShell,
  createPreviewFrameFailure,
} from "./preview-shell.js";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { createNodeWebSocket } from "@hono/node-ws";
import type { Context, Hono } from "hono";
import {
  PREVIEW_HTTP_MAX_BYTES,
  PREVIEW_REQUEST_HEADER_NAMES,
  PREVIEW_SOCKET_MAX_BYTES,
  previewTransportPathSchema,
  previewTransportResultSchemas,
  type PreviewTransportCommand,
} from "@omnyo/host-daemon-contract";
import { ApiError } from "../../errors.js";
import {
  previewContentUrl,
  rewritePreviewCss,
  rewritePreviewHtml,
  rewritePreviewJavaScript,
} from "./preview-runtime.js";

export interface PreviewTransportBinding {
  id: string;
  hostId: string;
  sessionId: string;
  runId: string;
  localUrl: string;
}

interface PreviewTransportOptions {
  logger?: Pick<import("../../types.js").ServerLogger, "warn" | "info">;
  resolveBinding(id: string): Promise<PreviewTransportBinding>;
  validateBinding(expected: PreviewTransportBinding): Promise<void>;
  call(
    binding: PreviewTransportBinding,
    command: PreviewTransportCommand,
    timeoutMs: number,
  ): Promise<unknown>;
  browserProblem(context: {
    req: {
      url: string;
      method: string;
      header(name: string): string | undefined;
    };
  }): { status: 403 | 415; error: string } | null;
  accessTtlMs?: number;
}

interface AccessGrant {
  binding: PreviewTransportBinding;
  accessId: string;
  expiresAt: number;
}

const REQUEST_HEADERS: ReadonlySet<string> = new Set(
  PREVIEW_REQUEST_HEADER_NAMES,
);

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

const CONTENT_HEADERS = new Set([
  "content-type",
  "last-modified",
  "accept-ranges",
  "content-range",
]);

function sameBinding(
  a: PreviewTransportBinding,
  b: PreviewTransportBinding,
): boolean {
  return (
    a.id === b.id &&
    a.hostId === b.hostId &&
    a.sessionId === b.sessionId &&
    a.runId === b.runId &&
    new URL(a.localUrl).origin === new URL(b.localUrl).origin
  );
}

function safePath(value: string): string {
  return previewTransportPathSchema.parse(value);
}

async function readBody(request: Request): Promise<Buffer> {
  if (request.body === null) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const result = await reader.read();

      if (result.done) break;
      bytes += result.value.byteLength;

      if (bytes > PREVIEW_HTTP_MAX_BYTES)
        throw new ApiError(
          413,
          "preview_too_large",
          "Preview request is too large",
        );
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

function decodeBody(body: Buffer, encoding: string | null): Buffer {
  const options = { maxOutputLength: PREVIEW_HTTP_MAX_BYTES };

  if (encoding === null || encoding === "identity") return body;

  if (encoding === "gzip") return gunzipSync(body, options);

  if (encoding === "br") return brotliDecompressSync(body, options);

  if (encoding === "deflate") return inflateSync(body, options);
  throw new ApiError(
    502,
    "preview_encoding_unsupported",
    "The preview returned an unsupported response encoding",
  );
}

export function registerPreviewTransport(
  app: Hono,
  options: PreviewTransportOptions,
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"],
): { dispose(): Promise<void> } {
  const grants = new Map<string, AccessGrant>();
  const sockets = new Set<() => Promise<void>>();
  let disposed = false;

  function authorize(context: Context): void {
    const problem = options.browserProblem(context);

    if (problem)
      throw new ApiError(
        problem.status,
        "forbidden_preview_origin",
        problem.error,
        false,
      );
  }

  async function access(
    context: Context,
  ): Promise<{ grant: AccessGrant; contentBase: string; path: string }> {
    const token = context.req.param("cap");
    const id = context.req.param("id");

    if (token === undefined || id === undefined)
      throw new ApiError(
        400,
        "invalid_preview_access",
        "Invalid preview access",
        false,
      );
    const grant = token === undefined ? undefined : grants.get(token);

    if (
      disposed ||
      grant === undefined ||
      grant.expiresAt <= Date.now() ||
      grant.binding.id !== id
    ) {
      if (token) grants.delete(token);
      throw new ApiError(
        403,
        "preview_access_expired",
        "Preview access expired. Reopen the preview from Omnyo.",
        false,
      );
    }

    const current = await options.resolveBinding(grant.binding.id);

    if (!sameBinding(grant.binding, current)) {
      grants.delete(token);
      throw new ApiError(
        409,
        "preview_run_changed",
        "The preview server changed. Reopen the preview from Omnyo.",
        false,
      );
    }

    const contentBase = `/preview-content/${encodeURIComponent(id)}/${token}`;
    const url = new URL(context.req.url);

    const path = safePath(
      (url.pathname.slice(contentBase.length) || "/") + url.search,
    );

    return { grant, contentBase, path };
  }

  app.post("/preview/:id/access", async (context) => {
    authorize(context);

    if (
      context.req.header("origin") === undefined ||
      context.req.header("origin") === "null"
    )
      throw new ApiError(
        403,
        "forbidden_preview_origin",
        "Open this preview from Omnyo",
        false,
      );
    const requestBody = await readBody(context.req.raw);

    if (requestBody.length > 32 || requestBody.toString().trim() !== "{}")
      throw new ApiError(
        400,
        "invalid_preview_access",
        "Preview access takes no launch parameters",
        false,
      );

    for (const [token, grant] of grants)
      if (grant.expiresAt <= Date.now()) grants.delete(token);

    if (grants.size >= 256)
      throw new ApiError(
        429,
        "preview_access_limit",
        "Too many active previews",
        false,
      );
    const binding = await options.resolveBinding(context.req.param("id"));
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + (options.accessTtlMs ?? 30 * 60_000);
    grants.set(token, { binding, accessId: randomUUID(), expiresAt });
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");

    return context.json({
      contentBase: `/preview-content/${encodeURIComponent(binding.id)}/${token}`,
      expiresAt,
      hostPort: new URL(binding.localUrl).host,
    });
  });

  for (const route of ["/preview/:id", "/preview/:id/*"])
    app.get(route, async (context) => {
      authorize(context);

      const id = context.req.param("id");

      if (id === undefined)
        throw new ApiError(
          400,
          "invalid_preview_access",
          "Invalid preview access",
          false,
        );

      return createPreviewShell(id);
    });
  app.get(
    "/preview-content/:id/:cap/*",
    upgradeWebSocket(async (context) => {
      if (context.req.header("upgrade")?.toLowerCase() !== "websocket")
        return {};
      const { grant, path } = await access(context);
      const origin = context.req.header("origin");

      if (origin !== "null") {
        authorize(context);
      }

      const connectionId = randomUUID();

      const target = {
        previewId: grant.binding.id,
        runId: grant.binding.runId,
        accessId: grant.accessId,
        connectionId,
      };

      const protocols = (context.req.header("sec-websocket-protocol") ?? "")
        .split(",")
        .map((protocol) => protocol.trim())
        .filter(Boolean);

      if (protocols.length > 1)
        throw new ApiError(
          400,
          "preview_protocol_unsupported",
          "This preview uses unsupported WebSocket protocol negotiation",
          false,
        );

      const opened = previewTransportResultSchemas["preview.socket.open"].parse(
        await options.call(
          grant.binding,
          { type: "preview.socket.open", ...target, path, protocols },
          7_000,
        ),
      );

      if (opened.protocol !== (protocols[0] ?? "")) {
        await options.call(
          grant.binding,
          { type: "preview.socket.close", ...target },
          3_000,
        );
        throw new ApiError(
          502,
          "preview_protocol_mismatch",
          "The preview could not negotiate its WebSocket protocol",
          false,
        );
      }

      let closed = false;
      let writes = Promise.resolve();
      let queuedBytes = 0;

      const stop = async () => {
        if (closed) return;
        closed = true;
        sockets.delete(stop);
        await options
          .call(
            grant.binding,
            { type: "preview.socket.close", ...target },
            3_000,
          )
          .catch(() => {});
      };

      sockets.add(stop);

      return {
        onOpen(_event, socket) {
          void (async () => {
            let phase = "capability";
            let phaseStartedAt = performance.now();
            let outcome = "client-closed";

            try {
              while (!closed && socket.readyState === 1) {
                phase = "capability";
                phaseStartedAt = performance.now();

                if (grant.expiresAt <= Date.now()) {
                  outcome = "grant-expired";
                  break;
                }

                phase = "binding";
                await options.validateBinding(grant.binding);

                phase = "read-rpc";
                phaseStartedAt = performance.now();

                const result = previewTransportResultSchemas[
                  "preview.socket.read"
                ].parse(
                  await options.call(
                    grant.binding,
                    { type: "preview.socket.read", ...target },
                    5_000,
                  ),
                );

                phase = "client-send";
                phaseStartedAt = performance.now();

                for (const message of result.messages) {
                  const bytes = Buffer.from(message.dataBase64, "base64");
                  socket.send(
                    message.binary
                      ? new Uint8Array(bytes)
                      : bytes.toString("utf8"),
                  );
                }

                if (result.closed) {
                  outcome = closed ? "client-closed" : "upstream-closed";
                  break;
                }
              }
            } catch (error) {
              outcome = "failed";
              options.logger?.warn(
                {
                  previewId: grant.binding.id,
                  runId: grant.binding.runId,
                  hostId: grant.binding.hostId,
                  sessionId: grant.binding.sessionId,
                  connectionId,
                  phase,
                  elapsedMs: Math.round(performance.now() - phaseStartedAt),
                  errorCode:
                    error instanceof ApiError ? error.body.code : "unexpected",
                  expired: grant.expiresAt <= Date.now(),
                },
                "Preview socket read failed",
              );
            } finally {
              if (outcome !== "failed")
                options.logger?.info(
                  {
                    previewId: grant.binding.id,
                    runId: grant.binding.runId,
                    hostId: grant.binding.hostId,
                    sessionId: grant.binding.sessionId,
                    connectionId,
                    phase,
                    outcome,
                    elapsedMs: Math.round(performance.now() - phaseStartedAt),
                    expired: grant.expiresAt <= Date.now(),
                  },
                  "Preview socket read ended",
                );
              socket.close(1001, "Preview connection ended");
              await stop();
            }
          })();
        },
        onMessage(event, socket) {
          let phase = "message-validation";
          let phaseStartedAt = performance.now();
          const binary = typeof event.data !== "string";

          if (
            typeof event.data !== "string" &&
            !(event.data instanceof ArrayBuffer)
          ) {
            socket.close(1003, "Unsupported preview message");
            void stop();

            return;
          }

          const bytes =
            typeof event.data === "string"
              ? Buffer.from(event.data)
              : Buffer.from(event.data);

          queuedBytes += bytes.byteLength;

          if (queuedBytes > PREVIEW_SOCKET_MAX_BYTES) {
            socket.close(1009, "Preview message is too large");
            void stop();

            return;
          }

          writes = writes
            .then(async () => {
              if (closed) return;

              phase = "write-binding";
              phaseStartedAt = performance.now();

              if (grant.expiresAt <= Date.now())
                throw new Error("Preview expired");
              await options.validateBinding(grant.binding);
              phase = "write-rpc";
              phaseStartedAt = performance.now();
              await options.call(
                grant.binding,
                {
                  type: "preview.socket.write",
                  ...target,
                  binary,
                  dataBase64: bytes.toString("base64"),
                },
                5_000,
              );
            })
            .catch((error) => {
              options.logger?.warn(
                {
                  previewId: grant.binding.id,
                  runId: grant.binding.runId,
                  hostId: grant.binding.hostId,
                  sessionId: grant.binding.sessionId,
                  connectionId,
                  phase,
                  elapsedMs: Math.round(performance.now() - phaseStartedAt),
                  errorCode:
                    error instanceof ApiError ? error.body.code : "unexpected",
                  expired: grant.expiresAt <= Date.now(),
                },
                "Preview socket write failed",
              );
              socket.close(1001, "Preview connection ended");

              return stop();
            })
            .finally(() => {
              queuedBytes -= bytes.byteLength;
            });
        },
        onClose() {
          void stop();
        },
        onError() {
          void stop();
        },
      };
    }),
  );
  app.all("/preview-content/:id/:cap/*", async (context) => {
    let phase = "content-access";
    const startedAt = performance.now();
    let previewId: string | null = null;

    try {
      const { grant, contentBase, path } = await access(context);
      previewId = grant.binding.id;
      const method = context.req.method.toUpperCase();

      if (!METHODS.has(method))
        throw new ApiError(
          405,
          "preview_method_unsupported",
          "Unsupported preview request",
          false,
        );

      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "null",
            "access-control-allow-methods": [...METHODS].join(", "),
            "access-control-allow-headers":
              "content-type, accept, range, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, next-url, rsc, next-action, x-nextjs-data, x-requested-with",
            "access-control-max-age": "60",
            "cache-control": "no-store",
          },
        });
      }

      const body = await readBody(context.req.raw);

      phase = "http-rpc";

      const result = previewTransportResultSchemas["preview.http"].parse(
        await options.call(
          grant.binding,
          {
            type: "preview.http",
            previewId: grant.binding.id,
            runId: grant.binding.runId,
            accessId: grant.accessId,
            path,
            method: method as
              | "GET"
              | "HEAD"
              | "POST"
              | "PUT"
              | "PATCH"
              | "DELETE",
            headers: [...context.req.raw.headers].filter(([name]) =>
              REQUEST_HEADERS.has(name),
            ),
            bodyBase64: body.toString("base64"),
          },
          25_000,
        ),
      );

      const headers = new Headers({
        "access-control-allow-origin": "null",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox allow-scripts allow-forms",
      });

      const upstreamHeaders = new Headers(result.headers);

      for (const [name, value] of upstreamHeaders)
        if (CONTENT_HEADERS.has(name)) headers.set(name, value);
      const localUrl = new URL(grant.binding.localUrl);
      const sourceUrl = new URL(path, localUrl);
      const rewriteContext = { contentBase, localUrl, sourceUrl };
      const location = upstreamHeaders.get("location");

      if (location !== null) {
        const target = new URL(location, sourceUrl);

        if (
          target.origin !== localUrl.origin &&
          !(
            ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) &&
            target.protocol === localUrl.protocol &&
            target.port === localUrl.port
          )
        )
          throw new ApiError(
            502,
            "preview_redirect_outside_server",
            "The preview redirected outside its registered server",
            false,
          );
        headers.set("location", previewContentUrl(target.href, rewriteContext));
      }

      let bytes = decodeBody(
        Buffer.from(result.bodyBase64, "base64"),
        upstreamHeaders.get("content-encoding"),
      );

      const contentType = upstreamHeaders
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();

      if (contentType === "text/html")
        bytes = Buffer.from(
          rewritePreviewHtml(bytes.toString("utf8"), rewriteContext),
        );
      else if (contentType === "text/css")
        bytes = Buffer.from(
          rewritePreviewCss(bytes.toString("utf8"), rewriteContext),
        );
      else if (
        contentType === "text/javascript" ||
        contentType === "application/javascript"
      )
        bytes = Buffer.from(
          rewritePreviewJavaScript(bytes.toString("utf8"), rewriteContext),
        );
      const upstreamCsp = upstreamHeaders.get("content-security-policy");

      if (upstreamCsp)
        headers.append(
          "content-security-policy",
          upstreamCsp
            .split(";")
            .filter(
              (directive) => !/^\s*frame-ancestors(?:\s|$)/iu.test(directive),
            )
            .join(";"),
        );

      return new Response(
        method === "HEAD" || [204, 205, 304].includes(result.status)
          ? null
          : new Uint8Array(bytes),
        { status: result.status, headers },
      );
    } catch (error) {
      options.logger?.warn(
        {
          previewId,
          phase,
          elapsedMs: Math.round(performance.now() - startedAt),
          errorCode: error instanceof ApiError ? error.body.code : "unexpected",
        },
        "Preview content failed",
      );

      if (context.req.header("sec-fetch-dest") === "iframe")
        return createPreviewFrameFailure(
          error instanceof ApiError ? error.status : 502,
        );
      throw error;
    }
  });

  return {
    async dispose() {
      disposed = true;
      grants.clear();
      await Promise.all([...sockets].map((stop) => stop()));
    },
  };
}
