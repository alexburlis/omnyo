import type {
  AccountState,
  IssuedCode,
  MachineSummary,
  ServerSummary,
} from "./api.js";
import { type LinkRequestSummary, type LinkRequestView } from "./account.js";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ESCAPES[character] ?? "");
}

export const MESSAGES: Readonly<Record<string, string>> = {
  "sign-in-failed": "Sign-in didn't finish. Try again.",
  "already-claimed": "You already have an address.",
  taken: "That name is taken. Try another.",
  "too-short": "Use at least 5 characters.",
  "too-long": "That name is too long.",
  "invalid-format":
    "Use lowercase letters, numbers and single hyphens between them, with at least one letter.",
  reserved: "That name is reserved. Try another.",
  "label-limit":
    "This account can't take new addresses. Pick one you used before.",
  "no-handle": "Pick your address first.",
  "server-limit": "You've reached the server limit.",
  "no-server": "That server doesn't exist.",
  "not-found": "That item doesn't exist.",
  "is-primary": "Your main address can't be removed.",
  connected: "Disconnect this server before you remove it.",
  "tunnel-close-failed": "Couldn't reach that device. Try again.",
  invalid: "This code isn't valid.",
  expired: "This code has expired. Start again on your computer.",
  used: "This code was already used.",
  denied: "This request was denied.",
  "reconnect-from-dashboard": "Reconnect that server from your dashboard.",
  "label-retired":
    "You used that name before. Add it from your dashboard first, then connect.",
  "server-claimed": "Address claimed.",
  "server-added": "Server added.",
  "server-disconnected": "Server disconnected.",
  "server-removed": "Server removed.",
  "machine-revoked": "Device revoked.",
  "link-denied": "Request denied.",
};

export function messageFor(key: string | null | undefined): string | null {
  if (key === null || key === undefined) return null;

  return Object.hasOwn(MESSAGES, key) ? (MESSAGES[key] ?? null) : null;
}

const STYLE = `
:root { color-scheme: light dark; --ink: #1d1d1f; --canvas: #fbfbfd; --surface: #ffffff; --line: #d9d9de; --muted: #6e6e73; --accent: #2f5bea; --danger: #c4321b; --focus: #2f5bea; }
@media (prefers-color-scheme: dark) { :root { --ink: #f2f2f5; --canvas: #141416; --surface: #1c1c1f; --line: #34343a; --muted: #a1a1a8; --accent: #7c9bff; --danger: #ff7a66; --focus: #7c9bff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 16px; }
h2 { font-size: 18px; margin: 32px 0 8px; }
p { margin: 8px 0; }
.muted { color: var(--muted); }
.notice { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin: 16px 0; }
.code { font: 600 22px ui-monospace, monospace; letter-spacing: 1px; }
ul.rows { list-style: none; padding: 0; margin: 0; }
ul.rows li { border-top: 1px solid var(--line); padding: 12px 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
form.inline { display: inline; }
form.stack { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
input[type=text] { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; min-width: 0; flex: 1 1 200px; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
header { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
footer.legal { margin-top: 48px; font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 16px; }
footer.legal a, p.terms a { color: inherit; }
body.auth { min-height: 100vh; min-height: 100dvh; display: flex; background: radial-gradient(120% 70% at 50% -10%, color-mix(in srgb, #ff4f17 7%, transparent), transparent 60%), var(--canvas); -webkit-font-smoothing: antialiased; }
body.auth main { width: 100%; max-width: 400px; margin: auto; padding: 48px 20px 32px; display: flex; flex-direction: column; align-items: center; }
.auth-card { width: 100%; padding: 40px 32px 28px; border: 1px solid var(--line); border-radius: 20px; background: var(--surface); box-shadow: 0 1px 2px rgb(0 0 0 / 4%), 0 12px 32px -12px rgb(0 0 0 / 14%); text-align: center; }
.brand-mark { display: block; width: 52px; height: 50px; margin: 0 auto 24px; color: var(--ink); }
.auth-card h1 { font-size: 22px; line-height: 1.25; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 6px; }
.auth-card .lede { margin: 0 0 28px; color: var(--muted); font-size: 15px; }
.auth-card .notice { margin: 0 0 20px; padding: 10px 12px; font-size: 14px; text-align: left; color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); border-color: color-mix(in srgb, var(--danger) 28%, transparent); border-radius: 10px; }
button.github { display: flex; width: 100%; align-items: center; justify-content: center; gap: 10px; padding: 12px 16px; font-size: 15px; font-weight: 600; line-height: 20px; border-radius: 10px; border: 1px solid #1f2328; background: #1f2328; color: #fff; transition: background-color 150ms cubic-bezier(0.25, 0.1, 0.25, 1), transform 150ms cubic-bezier(0.25, 0.1, 0.25, 1); }
button.github:hover { background: #32383f; border-color: #32383f; }
button.github:active { transform: scale(0.98); }
button.github:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
button.github svg { width: 20px; height: 20px; flex: none; fill: currentColor; }
.auth-card .fine { margin: 16px 0 0; font-size: 13px; line-height: 1.45; color: var(--muted); }
.auth-card .terms { margin: 20px 0 0; padding-top: 18px; border-top: 1px solid var(--line); font-size: 12.5px; }
body.auth footer.legal { margin-top: 24px; justify-content: center; font-size: 12.5px; }
body.auth footer.legal a { text-decoration: none; }
body.auth footer.legal a:hover { color: var(--ink); text-decoration: underline; }
@media (prefers-color-scheme: dark) { button.github { background: #f6f8fa; border-color: #f6f8fa; color: #1f2328; } button.github:hover { background: #ffffff; border-color: #ffffff; } .auth-card { box-shadow: 0 12px 32px -12px rgb(0 0 0 / 60%); } }
@media (prefers-reduced-motion: reduce) { button.github { transition: none; } button.github:active { transform: none; } }
@media (max-width: 420px) { .auth-card { padding: 32px 20px 24px; border-radius: 16px; } }
`;

export const LEGAL_SITE_ORIGIN = "https://omnyohq.com";

const LEGAL_LINKS = [
  ["Terms", "/terms"],
  ["Privacy", "/privacy"],
  ["Imprint", "/imprint"],
  ["Report abuse", "/abuse"],
] as const;

const SECURITY_TXT_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

export const SECURITY_TXT_PATH = "/.well-known/security.txt";

export function securityTxt(input: {
  appUrl: string;
  contact: string;
  at: number;
}): string {
  return [
    `Contact: mailto:${input.contact}`,
    `Expires: ${new Date(input.at + SECURITY_TXT_LIFETIME_MS).toISOString()}`,
    "Preferred-Languages: en, de",
    `Canonical: ${new URL(SECURITY_TXT_PATH, input.appUrl).toString()}`,
    `Policy: ${LEGAL_SITE_ORIGIN}/abuse`,
    "",
  ].join("\n");
}

function legalFooter(): string {
  return `<footer class="legal">${LEGAL_LINKS.map(
    ([label, path]) => `<a href="${LEGAL_SITE_ORIGIN}${path}">${label}</a>`,
  ).join("")}</footer>`;
}

export function page(
  title: string,
  body: string,
  layout: "default" | "auth" = "default",
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body${layout === "auth" ? ' class="auth"' : ""}><main>${body}${legalFooter()}</main></body>
</html>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function notice(text: string | null): string {
  return text === null
    ? ""
    : `<p class="notice" role="status">${escapeHtml(text)}</p>`;
}

export const OMNYO_MARK = `<svg class="brand-mark" viewBox="3 5 56 54" aria-hidden="true" focusable="false"><path d="M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z" fill="currentColor"/><circle cx="49.5" cy="14.5" r="6.5" fill="#ff4f17"/></svg>`;

export const GITHUB_MARK = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>`;

export function signInPage(next: string, message: string | null): string {
  return page(
    "Sign in to Omnyo",
    `<div class="auth-card">${OMNYO_MARK}
<h1>Sign in to Omnyo</h1>
<p class="lede">Open your Omnyo from anywhere.</p>
${notice(message)}
<form method="post" action="/sign-in">${hidden("next", next)}<button class="github" type="submit">${GITHUB_MARK}<span>Continue with GitHub</span></button></form>
<p class="fine">Signing in never gives Omnyo access to your repositories.</p>
<p class="muted terms">By signing in you accept the <a href="${LEGAL_SITE_ORIGIN}/terms">Terms</a>. See <a href="${LEGAL_SITE_ORIGIN}/privacy">Privacy</a>.</p></div>`,
    "auth",
  );
}

function signOutForm(): string {
  return `<form class="inline" method="post" action="/sign-out"><button type="submit">Sign out</button></form>`;
}

function accountHeader(githubLogin: string | null): string {
  const who =
    githubLogin === null
      ? "Signed in"
      : `Signed in as @${escapeHtml(githubLogin)}`;

  return `<header><span class="muted">${who}</span>${signOutForm()}</header>`;
}

function addressPreview(template: string, label: string): string {
  return template.replace("{label}", label);
}

function claimHandleForm(
  action: string,
  suggested: string,
  template: string,
  extra: string,
): string {
  return `<p class="muted">Your Omnyo will live at ${escapeHtml(addressPreview(template, "NAME"))}.</p>
<form class="stack" method="post" action="${escapeHtml(action)}">${extra}<input type="text" name="handle" required autocomplete="off" aria-label="Address name" value="${escapeHtml(suggested)}"><button class="primary" type="submit">Claim</button></form>`;
}

function serverStatus(srv: ServerSummary): string {
  if (!srv.connected) return "Not connected";

  return srv.online ? "Online" : "Offline";
}

function serverRow(srv: ServerSummary): string {
  const id = encodeURIComponent(srv.id);

  const actions = [
    `<form class="inline" method="post" action="/dashboard/servers/${id}/code"><button type="submit">Get connect code</button></form>`,
  ];

  if (srv.connected) {
    actions.push(
      `<form class="inline" method="post" action="/dashboard/servers/${id}/disconnect"><button type="submit">Disconnect</button></form>`,
    );
  } else if (!srv.isPrimary) {
    actions.push(
      `<form class="inline" method="post" action="/dashboard/servers/${id}/remove"><button type="submit">Remove</button></form>`,
    );
  }

  return `<li><span><strong>${escapeHtml(srv.subdomain)}</strong><br><a href="${escapeHtml(srv.serverUrl)}">${escapeHtml(srv.serverUrl)}</a> <span class="muted">${serverStatus(srv)}</span></span><span>${actions.join(" ")}</span></li>`;
}

function machineRow(item: MachineSummary): string {
  const id = encodeURIComponent(item.id);
  const name = item.name ?? "Unnamed device";

  return `<li><span><strong>${escapeHtml(name)}</strong> <span class="muted">${item.online ? "Online" : "Offline"}</span></span><form class="inline" method="post" action="/dashboard/machines/${id}/revoke"><button type="submit">Revoke</button></form></li>`;
}

function issuedCodePanel(issued: IssuedCode): string {
  const minutes = Math.max(1, Math.round(issued.expiresInMs / 60_000));

  const replaces = issued.replacesConnectedServer
    ? `<p class="muted">Use it only on your own computer. It takes over this connected server's address and the devices paired with it.</p>`
    : issued.takesOverDevices > 0
      ? `<p class="muted">Use it only on your own computer. It takes over this server's address and the ${issued.takesOverDevices === 1 ? "1 device" : `${issued.takesOverDevices} devices`} paired with it. Revoke any device you don't recognize first.</p>`
      : "";

  return `<div class="notice" role="status"><p>Connect code</p><p class="code">${escapeHtml(issued.code)}</p><p class="muted">Run <code>omnyo connect --code ${escapeHtml(issued.code)}</code> on that computer within ${minutes} minutes.</p>${replaces}</div>`;
}

export interface DashboardExtras {
  message: string | null;
  issued: IssuedCode | null;
}

export function dashboardPage(
  state: AccountState,
  extras: DashboardExtras,
): string {
  const parts = [
    accountHeader(state.githubLogin),
    "<h1>Omnyo</h1>",
    '<p><a href="/dashboard/workflows">Existing workflow links</a></p>',
    notice(extras.message),
  ];

  if (extras.issued !== null) parts.push(issuedCodePanel(extras.issued));

  if (state.handle === null) {
    parts.push(
      "<h2>Pick your address</h2>",
      claimHandleForm(
        "/dashboard/claim-handle",
        state.suggestedHandle ?? "",
        state.serverUrlTemplate,
        "",
      ),
    );

    return page("Omnyo", parts.join("\n"));
  }

  parts.push(
    "<h2>Servers</h2>",
    `<ul class="rows">${state.servers.map(serverRow).join("")}</ul>`,
  );

  if (state.servers.length < state.maxServers) {
    parts.push(
      `<form class="stack" method="post" action="/dashboard/servers"><input type="text" name="label" required autocomplete="off" aria-label="New server name" placeholder="${escapeHtml(`${state.handle}-laptop`)}"><button type="submit">Add server</button></form>`,
    );
  }

  if (state.machines.length > 0) {
    parts.push(
      "<h2>Devices</h2>",
      `<ul class="rows">${state.machines.map(machineRow).join("")}</ul>`,
    );
  }

  return page("Omnyo", parts.join("\n"));
}

function requestSummary(request: LinkRequestSummary): string {
  const from =
    request.location === null
      ? ""
      : ` <span class="muted">from ${escapeHtml(request.location)}</span>`;

  return `<p><strong>${escapeHtml(request.clientName)}</strong> wants to connect${from}.</p>
<p>Only approve if your own computer shows <span class="code">${escapeHtml(request.userCode)}</span>, because it gets an address in your account.</p>`;
}

function denyForm(code: string): string {
  return `<form class="inline" method="post" action="/link/deny">${hidden("code", code)}<button type="submit">Deny</button></form>`;
}

function freeServerChoice(code: string, srv: ServerSummary): string {
  const fields = [
    hidden("code", code),
    hidden("kind", "existing"),
    hidden("serverId", srv.id),
  ];

  return `<li><span><strong>${escapeHtml(srv.subdomain)}</strong> <span class="muted">Free</span></span><form class="stack" method="post" action="/link/approve">${fields.join("")}<button type="submit">Use this server</button></form></li>`;
}

const RECONNECT_HINT =
  '<p class="muted">Reconnect a server you used before from your <a href="/dashboard">dashboard</a>.</p>';

export function linkPage(
  view: LinkRequestView,
  githubLogin: string | null,
  message: string | null,
): string {
  const parts = [accountHeader(githubLogin), "<h1>Connect your Omnyo</h1>"];
  parts.push(notice(message));

  switch (view.state) {
    case "invalid":
    case "expired":
    case "used":
    case "denied":
      parts.push(`<p>${escapeHtml(MESSAGES[view.state] ?? "")}</p>`);
      break;
    case "approved":
      parts.push(
        `<p>Connected. Your Omnyo is at <a href="${escapeHtml(view.serverUrl)}">${escapeHtml(view.serverUrl)}</a>.</p>`,
      );
      break;
    case "claim-handle":
      parts.push(
        requestSummary(view.request),
        "<h2>First, pick your address</h2>",
        claimHandleForm(
          "/link/claim-handle",
          view.suggestedHandle,
          view.serverUrlTemplate,
          hidden("code", view.request.userCode),
        ),
        denyForm(view.request.userCode),
      );
      break;
    case "choose-server": {
      const code = view.request.userCode;
      parts.push(
        requestSummary(view.request),
        "<h2>Where should this Omnyo live?</h2>",
      );

      if (view.servers.length + view.usedServers < view.maxServers) {
        parts.push(
          `<form class="stack" method="post" action="/link/approve">${hidden("code", code)}${hidden("kind", "new")}<input type="text" name="label" required autocomplete="off" aria-label="New server name" value="${escapeHtml(view.suggestedLabel)}"><button class="primary" type="submit">Create and connect</button></form>`,
        );
      }

      parts.push(
        `<ul class="rows">${view.servers.map((srv) => freeServerChoice(code, srv)).join("")}</ul>`,
      );

      if (view.usedServers > 0) parts.push(RECONNECT_HINT);
      parts.push(denyForm(code));
      break;
    }
  }

  return page("Connect your Omnyo", parts.join("\n"));
}

export function errorPage(status: number): string {
  const text =
    status === 403
      ? "This request was blocked."
      : status === 429
        ? "Too many attempts. Wait a minute and try again."
        : status === 400
          ? "This request isn't valid."
          : status === 404
            ? "Page not found."
            : "Something went wrong. Try again.";

  return page("Omnyo", `<h1>Omnyo</h1><p>${escapeHtml(text)}</p>`);
}
