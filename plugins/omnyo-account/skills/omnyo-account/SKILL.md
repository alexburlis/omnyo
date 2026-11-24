---
name: omnyo-account
description: "Sign this Omnyo in to or out of its omnyo.link account with omnyo account, and check which account remote access uses."
---

# Omnyo account

The builtin Omnyo account plugin links this omnyo server to an omnyo.link account and
holds the server credential. Remote access (`omnyo connect`) reaches
omnyo.link through it and never sees the credential.

## Check the account

`omnyo account status [--json]` prints the signed-in name, GitHub login, handle,
and this server's label and URL, or `Not signed in`. An Omnyo that holds a
pairing but couldn't load its account yet says so; it keeps retrying, and
remote access starts once it succeeds. With `--json` it
prints `{state, revision, account, login}`: `state` is `signed-in`,
`signed-out`, or `profile-pending`, and `login` is the pending browser
sign-in, if any.

## Sign in

- `omnyo account login [--json]` starts a browser sign-in. It prints a
  `https://omnyo.link/link?code=XXXX-XXXX` link and the code, then returns.
  Open the link on any device, sign in with GitHub, pick an address if asked,
  and approve. Omnyo finishes signing in on its own; the code expires after 10
  minutes.
- `omnyo account login --wait [--json]` waits for that sign-in to be approved,
  denied, or expire, and exits non-zero unless it signed in.
- `omnyo account login --code XXXX-XXXX [--json]` pairs with a one-time code from
  the omnyo.link dashboard. `omnyo connect --code <code>` is an alias.
- `--base-url <url>` points sign-in at `https://omnyo.link` or
  `https://stg.omnyo.link` (staging); a development build also accepts
  `http://omnyo.localhost:<port>`. Any other origin is refused. In a source
  checkout, `pnpm dev --staging` sets `OMNYO_DEV_CONNECT_BASE_URL` so sign-in
  uses the staging relay; plain `pnpm dev` points it at the worktree's
  `omnyo.localhost` origin, which needs a locally run relay.

Signing in again replaces the account this Omnyo is signed in to, and revokes the
previous server on omnyo.link when the new sign-in is for a different one.
Starting a new sign-in cancels one that is still waiting for approval.

## Sign out

`omnyo account logout [--json]` revokes this server's credential on omnyo.link,
forgets it locally, and cancels a sign-in still waiting for approval. Remote
access stops until you sign in again. If omnyo.link can't be
reached, Omnyo still signs out locally and says the server wasn't revoked; remove
it from the omnyo.link dashboard. `--json` prints `{revocation, status}`. To
stop remote access but stay signed in, use `omnyo connect off`.

Settings → Plugins → Omnyo account shows the same account, a Sign in button that
opens omnyo.link, a pairing-code field, and Sign out.

## Imported servers

A server imported with `omnyo server import` starts with Omnyo account and Omnyo
connect held off, so a copy can't use the original server's account. Stop
the original server, run `omnyo server allow-connect`, then restart Omnyo.

## Operator relay migration

Run against the intended coordinator over loopback. From its identity checkpoint:

```sh
omnyo account rebind-relay --from-base-url https://slashnew.com --from-server-url https://LABEL.slashnew.com --user-id USER_ID --server-id SERVER_ID --server-label LABEL --check --json
```

The staging equivalents use `stg.slashnew.com`. Only these fixed old-to-new maps
are accepted. After the identity check succeeds, repeat without `--check` to
update the pairing. No credential is printed and no server is created or revoked.
A concurrent sign-out or changed pairing cancels the operation. If a write fails,
read account status and retry the same checkpoint; the secret owns the committed
profile. Verify Connect is connected at the matching omnyo.link URL before
continuing the cutover.
