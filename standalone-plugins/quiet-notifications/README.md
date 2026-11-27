# Quiet Notifications

Private Omnyo notification sender for versions 0.46.246 through 0.46.x. Completion alerts wait until the chat and every descendant have no running or queued work. Questions, approvals and errors follow the current thread notification level. Completion also waits for registered callbacks.

The Omnyo sender originally treated the end of an individual turn as completion even when a workflow, goal, command or child chat was still working. This fork checks the current thread activity at delivery time, including hidden and paginated descendants. It does not infer completion from the text of an answer.

## Installation

```sh
pnpm install --frozen-lockfile
pnpm verify
omnyo plugin build .
omnyo plugin install .
```

On first startup, Quiet Notifications copies the built-in plugin's mobile, web, desktop and Expo relay settings. It then disables the built-in delivery channels. The built-in `push-notifications` plugin must stay enabled: Omnyo's native clients still use it to register and refresh devices. This sender reads those canonical registrations with a query-only SQLite connection, so device updates do not require a restart and no second token store is created. Enrollment changes use the built-in RPC. This version requires the built-in plugin's authenticated `threadNotifications.get` RPC. It reads the current effective notification level before delivery: muted threads do not notify; input-only threads notify for input and errors. An unavailable, denied or invalid preference response stops delivery and appears in status. The query-only registration adapter remains version-bounded below 0.47; no private core packages are imported.

The installed local path, its runtime dependencies and `dist/` app bundle must remain available. Omnyo stores the enabled plugin and its settings on disk and runs the same startup handoff on reload or restart.

## Settings and commands

```sh
omnyo quiet-notifications status --json
omnyo quiet-notifications list --json
omnyo plugin config quiet-notifications
omnyo plugin config quiet-notifications set mobileEnabled false
omnyo quiet-notifications test desktop
```

Change delivery settings on **Quiet Notifications**. The original plugin's delivery switches are kept off when the replacement starts. Each browser still needs its own notification permission. No permission prompt runs automatically. Device lists and status omit the full device token.

To revert, disable Quiet Notifications and restore the original plugin's three switches from the installation receipt. Disabling the replacement alone leaves delivery off.

## Verification and provenance

`pnpm verify` runs strict lint, formatting, typechecking and integration tests. The tests cover activity filtering, hidden and paginated child chats, pending input, enrollment refresh, query-only access, settings transfer, reload persistence, client permissions, canonical effective levels, callback waits and refused preference reads.

`scripts/verify-live.mjs` accepts a proof JSON path and an active chat ID. It reads the running local Omnyo server and canonical phone registrations, then compares the active chat with an idle, unarchived chat without descendants. All mobile and client delivery uses isolated sinks; no test alert reaches a device. The proof records the observed state and SDK reads. Idle chats with continuing workflows are covered by the baseline-failing regression tests, because that live transition is temporary.

Sender, RPC and client code derive from the MIT-licensed `plugins/push-notifications` in the BB project (`get-bb/bb`), commit `490ca09beeeac469ad332ebd6741858474ededcd`. That commit contains the upstream sender repair and its baseline-failing regression tests. This local fork changes identity, installation handoff, enrollment access and client input decoding. The original license is retained in `LICENSE`. Repo-owned lint provenance is recorded in `tools/oxlint/anti-slop/UPSTREAM.md`.
