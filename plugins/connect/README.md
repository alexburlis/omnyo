# Connect

The hosted side is the Omnyo relay (`apps/relay`) at `https://omnyo.link`,
with staging at `https://stg.omnyo.link`. Omnyo account owns this server's
relay credential. Every hosted request goes through the Omnyo account plugin's
`omnyo-account.v1.fetch` RPC, which serves `/api/connect/` paths only to the
connect plugin, and connect follows sign-in changes with
`omnyo-account.v1.waitForStatusChange`. While Omnyo account reports any state
other than `signed-in`, or is stopped or held, connect treats this Omnyo as
signed out.

## Tunnel

Before each dial, connect reads the server credential from Omnyo account's
connect-only `omnyo-account.v1.connectCredential` RPC and dials
`wss://<handle>.omnyo.link/__tunnel` with `authorization: Bearer <credential>`,
as Omnyo builds from before Omnyo account do.

When the gate refuses the credential (401 or 403), connect retries with
backoff and passes the credential to Omnyo account's connect-only
`omnyo-account.v1.confirmRefusedCredential`. Omnyo account checks it with
`GET /api/account/me` and signs out if the relay no longer accepts it, which
tears the tunnel down. Omnyo account being briefly unavailable also retries with
backoff.

The `remoteAccess` setting (`omnyo connect off` and `omnyo connect on`) closes and
reopens the tunnel and machine shares without signing out.

## Copy of the pairing for older builds

Omnyo builds from before Omnyo account keep `{serverUrl, handle, credential}` under
connect's KV key `credential`. Connect keeps that record, since 1.0.127 as the
secret `credential` of `api.experimental_secrets`. At start connect moves a KV
row into the secret, reads it back and deletes the row; a row that is still
present wins, because only an older build can have written it. Builds before
1.0.127 cannot read the moved record, so after a downgrade past that release
they see no pairing until they are signed in again.
`credentialCopyOf` holds the SHA-256 of the credential connect last shared
with Omnyo account. On every Omnyo account change connect reconciles the two:

- Omnyo account signed in: connect writes its credential to the `credential` secret. If the
  stored record isn't the one connect last shared (an older build re-paired
  after a downgrade), connect first offers it to
  `omnyo-account.v1.adoptConnectCredential` with `replaces` set to Omnyo account's
  current credential.
- Omnyo account signed out: a record connect shared is removed, so older builds
  see the sign-out too. A record connect never shared (the upgrade from an
  older build) is offered with `replaces: null`.

Adoption copies. Neither side deletes or revokes a pairing while adopting. A
record the relay rejects stays for older builds to clear, and connect doesn't
offer it again until it restarts. While Omnyo account is unavailable or can't
reach the relay, connect leaves the record alone and tries again later. Keep
this copy for at least two releases after the first release with Omnyo account.

## Server access

Connect redeems machine codes on the server and returns the grant's server URL
and authentication headers. It stores one record per machine as the secret
`server-access-grant/<hostId>` of `api.experimental_secrets`, outside settings
descriptors and the UI. Builds before 1.0.127 kept the record in plugin KV under
`server-access-grant:<hostId>`; connect moves those rows into secrets at start
and before each read, with the same rule as the pairing copy.

The record contains either a pending redemption (code and expiry) or a completed
grant (credentials and Cloud device ID). Connect persists the pending record
before redeeming and the completed grant before returning it to core.

If a redemption response is lost, acquire and release look up the original code
through the authenticated Cloud machine-code lookup. If consumed, Connect
revokes its device before issuing a replacement. If unconsumed, a valid code can
be reused; an expired code is replaced. An unavailable or ambiguous lookup keeps
the pending record and reports that dashboard revocation may be needed. It does
not silently issue another grant. Acquire reports this recoverable state with a
typed failed result; unexpected thrown errors remain private at the plugin boundary.

Release revokes the completed grant's device even if enrollment never finished.
The record is deleted only after successful cleanup; failures keep it for retry.

### Paired devices

Settings → Mobile lists devices paired with this server, with their pairing date and last recorded activity. Refresh reads the relay again; a failed read is shown as an error, never as an empty list. Devices revoked at the relay are excluded. The list uses the same server ownership rule as device revocation, including older pairings. It does not infer a live connection from recent activity.

Agents use `omnyo connect devices --json` or the Connect `listPairedDevices` RPC. The relay exposes `GET /api/connect/devices` to the existing server credential and returns only device IDs, names and timestamps.
