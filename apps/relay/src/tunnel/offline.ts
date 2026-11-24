import type { HeaderPair } from "@omnyo/tunnel-contract";
import { TUNNEL_OFFLINE_HEADER } from "./protocol-headers.js";

export const OFFLINE_REFRESH_SECONDS = 10;

const OFFLINE_TEXT =
  "omnyo relay: this server is offline (no tunnel connected)\n";

const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${OFFLINE_REFRESH_SECONDS}">
<meta name="robots" content="noindex">
<title>Server offline</title>
<style>
:root { color-scheme: light dark; --canvas: #f7f7f5; --ink: #1c1c1a; --muted: #5f5f5a; }
@media (prefers-color-scheme: dark) { :root { --canvas: #161615; --ink: #ececea; --muted: #a3a39e; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--canvas); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 28rem; padding: 0 16px; text-align: center; }
h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>This server is offline</h1>
<p>Start Omnyo on that computer. This page checks again every ${OFFLINE_REFRESH_SECONDS} seconds.</p>
</main>
</body>
</html>
`;

function acceptsHtml(headers: readonly HeaderPair[]): boolean {
  return headers.some(
    ([name, value]) =>
      name.toLowerCase() === "accept" &&
      value.toLowerCase().includes("text/html"),
  );
}

export function tunnelOfflineResponse(
  requestHeaders: readonly HeaderPair[],
): Response {
  const html = acceptsHtml(requestHeaders);

  return new Response(html ? OFFLINE_PAGE : OFFLINE_TEXT, {
    status: 503,
    headers: {
      "content-type": html
        ? "text/html; charset=utf-8"
        : "text/plain; charset=utf-8",
      "cache-control": "no-store",
      refresh: String(OFFLINE_REFRESH_SECONDS),
      "retry-after": String(OFFLINE_REFRESH_SECONDS),
      [TUNNEL_OFFLINE_HEADER]: "1",
    },
  });
}

export function relayTextResponse(message: string, status: number): Response {
  return new Response(`omnyo relay: ${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
