export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const GATE_STYLE = `
  :root{--canvas:oklch(1 0 0);--ink:oklch(0.3211 0 0);
    --muted:color-mix(in oklch,var(--ink) 55%,var(--canvas));
    --subtle:color-mix(in oklch,var(--ink) 40%,var(--canvas));
    --border:color-mix(in oklch,var(--ink) 14%,var(--canvas));
    --card:color-mix(in oklch,var(--ink) 2%,var(--canvas));
    --warn:oklch(0.72 0.15 66);
    --warn-bg:color-mix(in oklch,var(--warn) 14%,var(--canvas));
    --warn-border:color-mix(in oklch,var(--warn) 38%,var(--canvas));}
  @media (prefers-color-scheme:dark){:root{--canvas:oklch(0.195 0 0);--ink:oklch(0.81 0 0)}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
    background:var(--canvas);color:var(--ink);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{width:100%;max-width:420px;padding:24px 16px}
  .brand{margin-bottom:18px;font-weight:600;font-size:15px;letter-spacing:-.01em}
  .card{border:1px solid var(--border);background:var(--card);border-radius:12px;padding:22px 24px}
  h1{margin:0 0 4px;font-size:18px;font-weight:600;letter-spacing:-.01em}
  p{margin:0 0 16px;color:var(--muted);font-size:14px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
  .btn{display:flex;align-items:center;justify-content:center;width:100%;padding:11px 16px;
    border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--ink);
    font:500 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;text-decoration:none;cursor:pointer}
  .btn.primary{background:var(--ink);border-color:var(--ink);color:var(--canvas)}
`;

export interface GatePageOptions {
  status: number;
  refreshSeconds?: number;
  headers?: Record<string, string>;
}

export function gatePage(cardBody: string, options: GatePageOptions): Response {
  const refresh =
    options.refreshSeconds === undefined
      ? ""
      : `<meta http-equiv="refresh" content="${options.refreshSeconds}">`;

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}<title>Omnyo</title><style>${GATE_STYLE}</style></head>
<body><div class="wrap"><div class="brand">Omnyo</div><div class="card">${cardBody}</div></div></body></html>`,
    {
      status: options.status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        ...options.headers,
      },
    },
  );
}

export function relativeTime(date: Date, now: number): string {
  const minutes = Math.floor(Math.max(0, now - date.getTime()) / 60_000);

  if (minutes < 1) return "just now";

  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function offlinePage(
  lastSeenAt: Date | null,
  kind: "server" | "machine",
  now: number,
  headers: Record<string, string>,
): Response {
  const heading =
    kind === "machine" ? "This machine is offline" : "Your Omnyo is offline";

  const lastSeen =
    lastSeenAt === null ? "" : `Last seen ${relativeTime(lastSeenAt, now)}. `;

  return gatePage(
    `<h1>${heading}</h1>
<p>${lastSeen}Usually the computer is asleep or Omnyo isn't running. This page retries on its own.</p>`,
    { status: 503, refreshSeconds: 10, headers },
  );
}

export function notYourServerPage(label: string): Response {
  return gatePage(
    `<h1>This isn't your server</h1>
<p><code>${escapeHtml(label)}</code> belongs to another account. Sign in with the account that owns it.</p>`,
    { status: 403 },
  );
}

export function machinePage(
  label: string,
  accountOrigin: string,
  baseHost: string,
): Response {
  return gatePage(
    `<h1><code>${escapeHtml(label)}</code> is a machine</h1>
<p>Its shares open at <code>${escapeHtml(label)}--&lt;port&gt;.${escapeHtml(baseHost)}</code>.</p>
<a class="btn primary" href="${escapeHtml(accountOrigin)}">Open your account</a>`,
    { status: 200 },
  );
}

export function egressCapPage(
  capBytes: number,
  resetsAt: Date,
  now: number,
): Response {
  const gigabytes = Math.round(capBytes / 1_000_000_000);

  const resets = resetsAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  return gatePage(
    `<h1>Monthly relay traffic used up</h1>
<p>This account has used its ${gigabytes} GB for this month. Access returns on ${escapeHtml(resets)}.</p>`,
    {
      status: 429,
      headers: {
        "retry-after": String(
          Math.max(0, Math.ceil((resetsAt.getTime() - now) / 1000)),
        ),
      },
    },
  );
}

export function signInLinkExpiredPage(): Response {
  return gatePage(
    `<h1>This sign-in link has expired</h1>
<p>Open your server's address again to sign in.</p>`,
    { status: 400 },
  );
}

export function gateErrorPage(): Response {
  return gatePage(
    `<h1>The relay hit a temporary problem</h1>
<p>This page retries in a few seconds.</p>`,
    { status: 502, refreshSeconds: 5 },
  );
}
