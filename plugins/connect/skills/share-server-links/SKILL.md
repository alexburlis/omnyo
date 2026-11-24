---
name: share-server-links
description: "Create a Connect port share when the user asks to open a local server outside Omnyo."
---

# Share local server links via Omnyo connect

For previews shared in Omnyo chat, follow `omnyo guide previews`. Register and
start the managed preview, then post its original loopback URL with the intended
page path. Omnyo opens the link directly on the server's machine and uses a
private preview route on other devices.

Use the steps below when the user asks to open a server outside Omnyo. Connect
port shares work from threads running on any enrolled host. The command resolves
the thread's host automatically.

1. Check remote access: run `omnyo connect status --json`. If `paired` is
   false, give the localhost URL and mention that remote URLs work once this
   Omnyo is signed in to its Omnyo account (`omnyo account login`). If `enabled` is
   false, the user turned remote access off with `omnyo connect off`; give the
   localhost URL and mention `omnyo connect on`. Don't turn it on or sign in
   yourself unless the user asks.
2. From the thread that started the HTTP server, run `omnyo connect expose
<port>`. It prints that host's share URL. Use `--host <name-or-id>` only
   when you intentionally need another enrolled host; outside a thread,
   sharing defaults to the machine running the Omnyo server.
3. Give the returned URL to the user as a markdown link. It works for viewers
   who have the owner's omnyo.link session; it is not a public internet link.
4. When the server stops, run `omnyo connect unexpose <port>` from the same
   thread (or with the same `--host`) so the share is cleaned up. Use
   `omnyo connect shares [--host <name-or-id>]` to inspect that host's shares.

Use `omnyo connect unexpose-all [--host <id>] [--json]` to revoke all shared ports
on one machine, including an unavailable machine. It defaults to the thread's
machine, or the server machine outside a thread, and keeps machine pairing intact.
Each collapsible machine group in settings offers **Revoke all** for that machine.
The typed plugin RPC is `unexposeAll` with `{ hostId: string }` input and a
`{ removed: number }` result. Bulk revocation attempts every share on that
machine; any failures report partial progress and can be retried.

`omnyo connect --help` and `omnyo connect <command> --help` print the commands and
their flags and exit 0. Unknown commands and flags fail with a suggestion —
`omnyo connect list` points at `omnyo connect shares` — and with `--json` a failure
prints `{"ok":false,"error":{"code":…,"message":…}}` on stdout while the same
message stays on stderr.

Server-host shares use `https://<server-label>--<port>.<base-domain>` through
the server tunnel. Other enrolled hosts use
`https://<machine-label>--<port>.<base-domain>` through their daemon. If a
machine was not enrolled through Connect, expose fails with instructions to
remove and re-add it under Settings > Machines.

## Remote access and the Omnyo account

Remote access runs through the Omnyo account plugin, which holds the omnyo.link
pairing. `omnyo connect off` turns remote access off and keeps the account
signed in; `omnyo connect on` turns it back on. Both set the connect
`remoteAccess` setting (`omnyo plugin config connect set remoteAccess false`).
`omnyo account logout` forgets the
pairing, and `omnyo account status` shows which account is signed in.
`omnyo connect --code <code>` still pairs with a dashboard code like
`omnyo account login --code <code>`, and also turns remote access back on if it
was off. `--server` takes the dashboard's `https://<handle>.omnyo.link` (or
`https://<handle>.stg.omnyo.link`) URL; other origins are refused.

## Agent instructions setting

Settings → Installed plugins → Connect has a "Tell agents about remote access"
toggle, enabled by default. Use
`omnyo plugin config connect set sendRemoteInstructions false` to suppress the
remote-access message, or `true` to restore it. This controls only the message;
sharing still works. The message otherwise requires active or recent remote
usage. Changes apply when session instructions are next assembled.
