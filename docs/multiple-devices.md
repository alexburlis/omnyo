# Using Omnyo on multiple devices

There are two separate ways to use more than one device with Omnyo:

- A browser device is a control surface for one Omnyo server. It can view projects,
  send prompts, and manage threads, but it does not execute them.
- An execution machine runs a host daemon. One Omnyo server can dispatch project
  sources and thread environments across several enrolled machines.

You can use either story independently or combine them.

In both stories one computer runs the Omnyo server. It stores your threads, the
database, and settings, and every browser and execution machine connects to it.
Pick a computer that stays on, such as a desktop, home server, or VM: while the
server machine is asleep or off, nothing can reach Omnyo and running threads may
stop. Settings → Machines badges it `server` once several machines are
connected, `omnyo machine list` shows `server` in its Role column, and the server
machine cannot be removed.

## Open Omnyo from another browser

The simplest managed route is **Omnyo connect**, which runs through the
self-hosted Omnyo relay at `omnyo.link`. Sign the server in to your Omnyo account from Settings →
Omnyo connect (or `omnyo account login`, or `omnyo connect --code ...` with a
code from the account dashboard at `https://omnyo.link`), then open its
`https://<label>.omnyo.link` URL. The server owns the tunnel and reconnects
after restart.

The relay terminates TLS, so its operator can technically read the traffic
between a browser and your server. It stores no request bodies and does not
log the paths of requests to your server. Use the Tailscale Serve route below when traffic must not pass through
the relay.

For a private tailnet route, keep Omnyo on its loopback default and publish it
through Tailscale Serve:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:38886
omnyo-app config set OMNYO_APP_URL https://<machine>.<tailnet>.ts.net
```

Start Omnyo with `omnyo-app` and open the HTTPS URL. Tailscale ACLs are the access
boundary for this route; do not expose the server through Funnel or the public
internet. Omnyo connect URLs require the paired account owner's session.

Existing remote host daemons that target a direct tailnet IP or
`http://<machine>.<tailnet>.ts.net:38886` must migrate before restarting an
upgraded server. Prefer pairing Omnyo connect and re-adding the machine from
Settings → Machines so its installer records the account-gated route. The
private alternative is to open Omnyo through the Tailscale Serve URL and re-run
the Add machine installer from there.

For compatibility only, `omnyo-app --server-bind-host 0.0.0.0` restores direct
IPv4 network access. The public API is unauthenticated and permits command
execution and file reads, so use wildcard binding only behind a trusted network
boundary and never through Funnel or the public internet.

Inside a container, `0.0.0.0` listens on the container's IPv4 interfaces; the
container runtime must still publish that port to the host (for example,
`docker run -p 3000:3000 ...`). Host firewall and upstream network rules also
remain separate from Omnyo's bind setting.

### Use editors installed on the browser device

Local editor integration is optional. It connects the remote Omnyo page to the
loopback-only helper started by the Omnyo desktop app or `omnyo-app` on the
computer running the browser. The helper discovers installed editors and opens
paths without exposing its API to the network.

If that browser should open work-host files in its local editor, first make
sure Omnyo is running on the browser device. Verify `ssh <work-host>` succeeds
there, then map the server/work-host to that SSH target:

```bash
omnyo-app client ssh-target set <omnyo-server-origin> <ssh-target> --host-id <work-host-id>
```

Copy the work-host ID from `omnyo machine list`. `--host-id` may be omitted when
the server has exactly one machine. A browser running on an enrolled execution
machine needs no SSH mapping for that same machine: connected daemons report
their helper ports to the server, and the browser discovers the matching local
helper after you enable integration.

Then open Settings → Files in that browser and enable **Local editor
integration**. The browser may ask once for permission to connect to software
on the computer. Omnyo does not request that permission during normal remote page
loads; it is only needed for discovering and launching local editors.

If Settings reports that it cannot connect to the helper:

1. Confirm the Omnyo desktop app or `omnyo-app` is running on the browser device.
2. Confirm the browser allows local network access for the Omnyo page.
3. A helper enrolled with this exact server trusts its origin automatically.
   For a separate local Omnyo helper serving a custom HTTPS or Tailscale browser,
   configure that exact origin with
   `omnyo-app config set OMNYO_APP_URL <origin>` and restart Omnyo.
4. Return to Settings → Files and choose **Retry**.

Phones and tablets need no helper; editor-launch actions are simply unavailable.

## Use the Omnyo mobile app

The Omnyo mobile app is a client for an Omnyo server; it runs nothing itself. Over
Omnyo connect it pairs the same way the desktop app does: the phone enrolls as a
connect machine with its own credential, which the account dashboard at
`https://omnyo.link` lists and can revoke.

1. Sign the Omnyo server in to your Omnyo account first (Settings → Omnyo account, `omnyo account login`, or `omnyo connect --code …`).
2. Mint a pairing code for the phone: Settings → Mobile → **Add mobile device** (QR code plus the code as text, with a countdown), or run
   `omnyo connect machine-code` (`--json` prints
   `{code, serverUrl, apex, expiresAt}`).
3. In the mobile app, add a server over Omnyo connect and scan the QR code or type
   the code. Codes last 10 minutes and work once.

The phone keeps its credential in the device keychain and mints sessions from
it; it never holds the server's pairing secret. A session lasts seven days and
renews while the phone is in use. To cut a phone off, revoke it in the
account dashboard's machine list: its next request fails at once, and open
connections close within about 20 seconds. Every phone takes one of
the account's machine slots, so a machine-limit error means an unused device
should be revoked first. On a trusted network the app can also use a direct
server URL (Tailscale Serve or `--server-bind-host 0.0.0.0`) with the same
caveats as a browser. Platforms (iOS first) and what the phone cannot do are
listed in [platform-support.md](platform-support.md).

### Push notifications on a self-hosted server

The built-in Push notifications plugin sends messages through Expo. A
self-hosted server must reach `https://exp.host`. The server needs no Apple or
Google key.

An Expo push token lets its holder send a notification to one app installation.
The token cannot read notifications. It cannot access the phone or authenticate
to the Omnyo server. Treat the token as private because a leak can cause unwanted
notifications.

The server sends a thread title and a short plain-text preview. Use these commands to
manage device registrations and inspect the sender:

```bash
omnyo push-notifications list
omnyo push-notifications add --token <expo-push-token> --platform ios --label <device-name>
omnyo push-notifications remove <id>
omnyo push-notifications status
omnyo push-notifications thread <thread> [--level inherit|all|input-only|muted]
```

`thread` prints a thread's resolved notification level and where it comes from;
with `--level` it sets the thread's own level. A thread uses its own level,
else the `childLevel` setting if it has a parent (default `input-only`), else
`defaultLevel` (default `all`). A thread's level also limits its child
threads: every ancestor's own level caps the result.

Expo accepting a message does not prove delivery. Fifteen minutes after a send,
the server asks Expo for the delivery receipts. A device that Apple or Google
no longer knows is removed. Any other receipt error sets the last send in
`status` to `delivery failed: <code>`, for example `InvalidCredentials` when
the Expo project's Apple push key stops working. Receipt checks still waiting
at a server restart are dropped.

Failed sends, rejected tickets and failed receipts are reported to Omnyo's
error reporting (Sentry) with the tags `plugin:push-notifications`,
`operation` (`expo.send`, `expo.ticket`, `expo.receipts` or `expo.receipt`)
and `code`, at most once an hour for each operation and code. Reports follow
the crash reports setting. Server logs and the plugin log keep a line for each
failure.

Turn delivery off with `omnyo plugin disable push-notifications`. The plugin keeps
registrations in its private storage. Enable the plugin to resume delivery.

The `expoPushUrl` plugin setting changes the Expo endpoint. Use it only for a
controlled test service or a compatible relay:

```bash
omnyo plugin config push-notifications set expoPushUrl <url>
```

The Expo request supports `HTTPS_PROXY` and `NO_PROXY`.

## Point the desktop app at another Omnyo

The desktop app's Server menu lists "This Mac", every Omnyo connect server on the
account, and a custom URL. When you select a remote server, the app stops
starting an Omnyo server on this Mac. It starts one again only when you select
"This Mac".

To reach Omnyo connect without a local server, the app enrolls itself once as a
connect machine. That step needs the local server, so the first switch to a
remote server still starts it. The app keeps its own credential, encrypted with
the OS keychain, and never holds the server's pairing secret. The app appears in
the account dashboard's machine list, where you can revoke it. After a revoke,
the app drops the credential and asks the local server again.

A remote server has no realtime link for keybindings and theme. The app re-reads
them when it starts, when it becomes active, and every five minutes.

## Add an execution machine

Open Settings → Machines and choose Add a machine. Run the generated one-line
installer on the computer that should
execute work. Choose Windows in the dialog for a PowerShell command; a Windows
machine needs Node.js 22.19 or newer and Git for Windows, and its daemon starts
when you sign in to Windows. It installs and enrolls a host daemon; when Omnyo connect is paired,
the installer also configures the machine credential used to reach the server
through the account gate. Without Omnyo connect, open the server through a
Tailscale Serve URL before generating the installer; the loopback listener is
not directly reachable from another machine. When Omnyo connect is not paired and
the server URL is a loopback or unspecified address, the dialog does not show an
installer. It asks you to set up machine access first by choosing the address
machines should use. Once access is ready, the dialog also names the server
machine the new machine will depend on.

The installer always installs the exact host-only `omnyo-app` package exposed by
that server at `/install/omnyo-app.tgz`. The package contains the host daemon,
provider/plugin workers, native host dependencies, and bundled `omnyo` CLI, but no
web app or server. When the server provides no package, the installer stops; it
never reuses an `omnyo-app` on PATH or consults the npm registry. Version strings cannot
distinguish unpublished builds, so the route also publishes a SHA-256 digest.
The installer verifies that digest and uses a conditional request on later runs
to skip an identical installed artifact. The package route is public like
`/install.sh`: `omnyo-app` is public software, and exposing an unpublished build
slightly early through a paired tunnel is an accepted tradeoff. npm installs
the package into the machine's Omnyo data directory, not its system-wide global
prefix, so enrollment needs neither `sudo` nor a PATH change.

The relay gate consumes platform authentication cookies without forwarding
them to tunnels, including public installer requests and port shares. Tenant
responses may set host-only cookies outside the `__Host-omnyo*`,
`__Secure-omnyo*`, `better-auth.*`, `omnyo-connect.*` and `bb-connect.*`
namespaces (including their `__Secure-` and `__Host-` variants); cookies with a
`Domain` attribute are dropped. The relay writes its device session cookie as
`__Secure-omnyo-connect.desktop_session`. It still accepts the earlier
`__Secure-bb-connect.desktop_session` name and replaces it with the new one on
the next request. New server and machine credentials start with `omnyocred_`
and `omnyocm_`; credentials issued earlier as `bbcred_` and `bbcm_` stay valid
until revoked. The desktop and phone apps and the host daemon take the
cookie name from the relay's answer and treat credentials as opaque strings, so
these renames need no app or daemon change and no new app build. Only the gate can renew platform
cookies. Public installer responses are served as sandboxed plain text, or
as an attachment for `/install/omnyo-app.tgz`, with content sniffing disabled.

Each joined server gets its own daemon instance, data directory
(`~/.omnyo-machines/<server-host>`, override with `OMNYO_DATA_DIR` when running the
installer), local API port, and launchd/systemd service. The installer persists
the selected port in that data directory. Subsequent runs reuse it; pass
`--host-daemon-port <port>` to the installer to override the selection. One machine can therefore
serve several Omnyo servers at once, and joining never touches a full local Omnyo
install's `~/.omnyo`. Each instance keeps its own `omnyo-app` under that data
directory and self-updates against its own server, so servers running different
Omnyo versions on one machine remain isolated.

On Linux, the installer uses the current user's systemd manager (or a system
unit when run as root on a non-container systemd host). If the user bus is not
reachable from the installer's environment, it retries using the current
user's runtime path reported by `loginctl`. If the bus remains unavailable on
a systemd host, installation fails before enrolling or creating a unit; rerun
it from a systemd user session. In containers and on machines without systemd
as init, the installer runs a detached daemon instead. Set
`OMNYO_INSTALL_SKIP_SERVICE=1` only when a detached daemon is acceptable: no
service starts it after a reboot. The temporary daemon used
for a first join is not supervised. When the installer starts a previously
joined daemon without a service, its launcher restarts it after crashes and
self-updates while the launcher remains running.

The installed launchd/systemd service enables `--auto-update`. If session open
reports a newer server protocol, the daemon downloads the server artifact,
verifies its SHA-256 digest, updates its private install, then exits so the
service manager restarts it. If the identical artifact is already installed,
the server returns `304` and the daemon restarts without downloading or running
npm again.
Failed attempts fall back to normal reconnect behavior with a persisted
exponential retry backoff from 5 seconds to 5 minutes. Settings → Machines and
`omnyo machine retry-update <id-or-name>` can bypass the current backoff. A daemon
never downgrades itself to an older server protocol. To opt out, remove
`--auto-update` from
`~/Library/LaunchAgents/app.omnyo.host-daemon.<server>-<host-id>.plist` or
`~/.config/systemd/user/omnyo-host-daemon-<server>-<host-id>.service`, then reload the
service.

After it connects:

1. To create a project from that machine, choose New project, select the
   machine, and browse to its folder. To map an existing project there instead,
   add its path or clone source in project settings.
2. Select the machine when creating a thread, or use `omnyo thread spawn --machine
<id-or-name> ...`.
3. Inspect enrolled machines with `omnyo machine list`.

Machine names are conveniences and may be duplicated; CLI targeting by name
requires an unambiguous match. IDs are always accepted. Removing a machine from
Settings stops Omnyo from dispatching new work to it; revoke a lost machine's Omnyo
connect access from the account dashboard at `https://omnyo.link` as well.

Browser access and execution remain independent: opening Omnyo on a laptop does
not enroll that laptop, and enrolling it as a machine does not expose the Omnyo UI.
