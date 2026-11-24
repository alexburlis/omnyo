import { MACOS_DOWNLOAD_URL } from "./landing/site";

export const WORKFLOW_RELAY_ORIGIN = "https://omnyo.link";

const SHARE_ID = /^[a-f0-9]{32}$/u;

const MAX_METADATA = 8192;

let available = 60;

let lastRefill = Date.now();

function admit(): boolean {
  const now = Date.now();
  available = Math.min(60, available + (now - lastRefill) / 1000);
  lastRefill = now;

  if (available < 1) return false;
  available -= 1;

  return true;
}

function escape(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}

const headers = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
};

function page(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><title>Shared workflow — Omnyo</title><meta property="og:title" content="Shared workflow — Omnyo"><meta name="description" content="Review a shared workflow in Omnyo."><style>body{font:18px/1.6 system-ui;margin:0;background:#f8f8f5;color:#20221e}main{max-width:640px;margin:8vh auto;padding:24px}a{color:inherit}nav{display:flex;gap:20px;flex-wrap:wrap}p{white-space:pre-wrap}</style></head><body><main><a href="/">Omnyo</a>${body}</main></body></html>`,
    { status, headers },
  );
}

export async function workflowSharePage(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!SHARE_ID.test(id)) return page("<h1>Workflow unavailable</h1>", 404);

  if (!admit())
    return page("<h1>Too many requests</h1><p>Try again shortly.</p>", 429);

  try {
    const response = await fetcher(
      `${WORKFLOW_RELAY_ORIGIN}/api/workflow-shares/${id}`,
      {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!response.ok)
      return page(
        "<h1>Workflow unavailable</h1><p>The link may have expired or been revoked.</p>",
        response.status === 429 ? 429 : response.status === 404 ? 404 : 503,
      );
    const reader = response.body?.getReader();

    if (!reader) throw new Error("Empty metadata");
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;
        size += value.byteLength;

        if (size > MAX_METADATA) throw new Error("Metadata too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const metadata: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );

    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("id" in metadata) ||
      metadata.id !== id ||
      !("title" in metadata) ||
      typeof metadata.title !== "string" ||
      metadata.title.length > 200 ||
      !("description" in metadata) ||
      typeof metadata.description !== "string" ||
      metadata.description.length > 2000 ||
      !("capabilities" in metadata) ||
      !Array.isArray(metadata.capabilities) ||
      metadata.capabilities.length > 8 ||
      !metadata.capabilities.every(
        (x: unknown) => typeof x === "string" && x.length < 80,
      )
    )
      throw new Error("Invalid metadata");

    return page(
      `<h1>${escape(metadata.title)}</h1><p>${escape(metadata.description)}</p><p>Shared content is unverified. Review its instructions in Omnyo before saving a disabled copy. Confirm your setup in Omnyo before running. For text workflows, use Omnyo 1.0.140 or later. Choose a connected Codex or Claude Code model in Setup. Omnyo sends your workflow inputs to that model.</p><p>Workflow actions: ${metadata.capabilities.map((x: string) => escape(x)).join(", ")}</p><nav><a href="omnyo://workflows/import/${id}">Open in Omnyo</a><a href="${MACOS_DOWNLOAD_URL}">Download Omnyo</a><a href="${WORKFLOW_RELAY_ORIGIN}/api/workflow-shares/${id}/file">Download workflow file</a></nav><p><a href="/abuse">Report this link</a> · <a href="/privacy">Privacy</a> · <a href="/imprint">Imprint</a></p>`,
    );
  } catch {
    return page(
      "<h1>Workflow unavailable</h1><p>The sharing service could not be reached. Try again later.</p>",
      503,
    );
  }
}
