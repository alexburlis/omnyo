# Omnyo account

Omnyo account links this omnyo server to an account on the Omnyo relay at
omnyo.link. It keeps the long-lived server credential (`omnyocred_`, or `bbcred_` when linked before the rename) in the
secret `credential` of `api.experimental_secrets`, sealed under the server's
vault key, and never returns or logs it. The cached profile stays in plugin KV
under `profile` and the status revision under `revision`. Builds before 1.0.127
kept the credential in plugin KV under `credential`; at start the plugin copies
such a row into the secret, reads it back and then deletes the row. A row that
is still present wins over the secret, because only an older build can have
written it. Other plugins reach the relay through its RPC methods.

## RPC contract

Call these with `api.sdk.plugins.callRpc({ pluginId: "omnyo-account", … })` and
keep your own copy of the Zod schemas (see `src/contract.ts`). Omnyo account
loads before most plugins but can be disabled or held, so call it lazily and
treat an HTTP 503 as signed out.

| Method                                 | Input                                      | Output                                                          |
| -------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `omnyo-account.v1.status`              | `{}`                                       | `{state, revision, account}`                                    |
| `omnyo-account.v1.waitForStatusChange` | `{afterRevision}`                          | the status once `revision > afterRevision`, or after 25 seconds |
| `omnyo-account.v1.fetch`               | `{target, method, path, body, timeoutMs?}` | `{status, body}`                                                |

`state` is `signed-in`, `signed-out`, or `profile-pending` (Omnyo holds a server
credential but hasn't loaded its account yet and keeps retrying). Treat every
state other than `signed-in` as not signed in; more may be added. `account`
is non-null only while signed in. It carries `userId`, `githubLogin`, `name`,
`avatarUrl`, `handle`, `serverId`, `serverLabel`, `serverUrl` (the gate
origin) and `baseUrl` (the relay origin). The revision increases on
sign-in, sign-out, credential rejection, and every profile refresh, and it
survives restarts.

`fetch` sends JSON to a fixed origin: `"api"` is `baseUrl` and `"gate"` is
`serverUrl`. Only the connect plugin may call it, for paths under
`/api/connect/` (the handler checks the rpc caller); every other path is
refused. A path may not contain `..`, `//`, a query, a fragment, or characters
other than letters, digits, and `-._~/`; anything else throws. `timeoutMs` is
an integer from 1000 to 65000 and defaults to 15000. Request bodies are capped
at 16 MB and response bodies at 1 MB, redirects are returned rather than
followed, and a non-JSON body comes back as `null`.
The credential goes in both `authorization: Bearer` and
`x-omnyo-connect-machine`. Without a stored credential, `fetch` answers
`{status: 401, body: {error: "signed-out"}}` without a request. After an
upstream 401, Omnyo account checks the credential with `GET /api/account/me` and
signs out only if omnyo.link rejects it there too.

The unlisted methods serve the plugin's own UI and CLI and connect:
`omnyo-account.v1.adoptConnectCredential`, `omnyo-account.v1.connectCredential`,
`omnyo-account.v1.confirmRefusedCredential`, `login.start`, `login.poll`,
`login.cancel`, `redeemCode`, and `signOut`. Only the connect plugin may call
the three `omnyo-account.v1.*` methods.

- `adoptConnectCredential` (`{credential, baseUrl, replaces}`) stores the
  pairing connect holds for older builds. It answers `changed` unless Omnyo
  account's current credential is still `replaces` (`null` for signed out),
  `rejected` when `GET /api/account/me` refuses the credential, and
  `adopted` once it is stored. It never revokes anything.
- `connectCredential` returns `{credential: {baseUrl, serverUrl, serverId,
credential} | null}`. Connect dials the tunnel with it and keeps its copy
  for older builds current.
- `confirmRefusedCredential` (`{credential}`) is how connect reports that the
  gate refused the credential. If it is still the current one, Omnyo account
  checks it with `GET /api/account/me` and signs out when omnyo.link answers 401. It returns the account status.

`signOut` returns `{revocation, status}`, where
`revocation` is `revoked`, `not-signed-in`, or `failed` with a `message` and
the `dashboardUrl` to remove the server from.

## Sign-in

`login.start` calls `POST /api/account/link/start` with the machine hostname
and keeps the secret device code on the server. A background poll calls
`POST /api/account/link/poll` every `intervalMs`, adds five seconds after each
`slow-down`, and stops on approval, denial, expiry, or cancellation. Codes
from the dashboard go through `POST /api/connect/redeem`. Both paths then load
the profile from `GET /api/account/me`, which is refreshed at start and every
six hours. Sign-out posts `/api/connect/disconnect` to the gate before
clearing the credential.

Only one sign-in can finish. Starts are serialized and a new browser sign-in
cancels the pending one; cancelling, signing out, or a newer sign-in finishing
first stops an older one from saving its credential, and Omnyo account revokes
the credential that older sign-in was issued. Signing in to a different
server revokes the previous one.

The base URL is `https://omnyo.link`. In development, `OMNYO_DEV_CONNECT_BASE_URL`
may name an `http://omnyo.localhost:<port>` origin or `https://stg.omnyo.link`.
`--base-url` and the rpc `baseUrl` override it per command but accept only
`https://omnyo.link` and `https://stg.omnyo.link`, plus
`http://omnyo.localhost:<port>` in a development build.

## Relay cutover

The operator runs `omnyo account rebind-relay` against the coordinator's
loopback address with `--from-base-url`, `--from-server-url`, `--user-id`,
`--server-id` and `--server-label` from the pre-cutover checkpoint. Only the
production and staging slashnew.com origins map to their omnyo.link equivalents.
`--check --json` verifies the existing credential at the new apex without writing.
Omit `--check` to apply the same verified identity. The response contains status,
never the credential. Repeating the command repairs an interrupted profile mirror
write without creating another server or credential.

The account secret stores the profile with its credential in one atomic write.
The profile KV entry remains a compatibility mirror; reads prefer the profile
in the secret. A failed mirror write reports failure but preserves the committed
identity, so the operator must read status before retrying. Connect follows the
account revision and updates its saved URL even when the credential is unchanged.
Verify `omnyo connect status --json` shows the new URL and a connected tunnel
before proceeding with client delivery.
