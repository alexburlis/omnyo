Notify when a chat finishes, needs input (even mid-turn) or errors. Choose mobile, web and desktop delivery in Settings → Push notifications.

## Delivery

Mobile gets Expo push with the app closed; failures reach `status` and Sentry. Focused windows show cards for chats that need you or failed, without OS permission. Cards stay beside the sidebar until the chat opens, stops needing you or you choose **Later**. In narrow windows one card covers content for 8 s, paused on hover or focus. Questions with 2–4 choices answer in one tap. Finished chats light their sidebar row and, unless open, notify the system; notices never reach the bell. Finished-turn notices wait up to 30 s for the reply suggestion (5 s for it to start).

Hover, focus or touch a card for **Open chat** and **Later**; questions and **Continue** act in place.

Background web needs an open HTTPS or localhost tab and permission. Desktop needs the app running; closing its last window quits on Windows and Linux. Mobile WebViews use mobile push only.

Thread levels are `all`, `input-only` (no finished turns) and `muted`. Threads inherit `childLevel` or `defaultLevel` unless overridden; every ancestor caps descendants.

A click opens its thread. Events combine, questions first; read, archived, deleted and hidden threads stay silent; same-origin tabs dedupe.

## Thread menu

Unarchived threads have a **Notifications** menu (Default, All activity, Needs input only, Muted). Only the override persists, `{ "notifications": { "own" } }`; parent limits stay live.

## Settings

- `mobileEnabled`, `webEnabled`, `desktopEnabled`, `mobileOnlyWhenAway` (mobile waits while a desktop is in use): switches, default true.
- `defaultLevel`: any level; default `all`.
- `childLevel`: `inherit` or any level; default `input-only`.
- `expoPushUrl`: mobile relay, default `https://exp.host/--/api/v2/push/send`.

Switches save per server. **Allow notifications** grants permission; **Send test notification** confirms queueing only.

## CLI and SDK

- `omnyo push-notifications list`: registered mobile devices (redacted tokens).
- `omnyo push-notifications add --token <expo-push-token> --platform <ios|android> --label <label>`: register or refresh a device.
- `omnyo push-notifications remove <id>`: remove a device.
- `omnyo push-notifications status`: settings, device count and last mobile send.
- `omnyo push-notifications test <web|desktop>`: queue a test; fails if the channel is off.
- `omnyo push-notifications thread <thread> [--level inherit|all|input-only|muted]`: resolved level and source; `--level` sets it.

Every command accepts `--json`.

SDK settings match; `sdk.plugins.callRpc` supports `notifications.test` (`{ channel }`), `threadNotifications.list` (`{ threadIds }`, ≤200) and `threadNotifications.set` (`{ threadId, level }`).

## Durable script notifications

Automation stdout never notifies; scripts queue a notice. Automations queues `automation-failure:<runId>` on first failure or auto-pause:

```sh
omnyo plugin rpc call push-notifications notifications.send --input-file notice.json --json
```

Input: `{ "id": "upstream:<id>", "title": "Update", "body": "Review it." }`. IDs accept letters, digits and `._:-` (≤200 chars); title ≤80, body ≤500. Reusing an ID requires identical content.

Receipt: `{ "id", "status": "queued" | "dispatched" | "expired", "duplicate", "durable": true, "acceptedTargetCount" }`. Notices wait 24 h for an enabled web/desktop client. Scripts use the Notification API, never mobile push. Offline clients, off channels, denied permission and API failures keep them pending. Dispatched means client acknowledgement, not OS display. Clients drain on mount, reconnect, focus, visibility and notification signals.

`notifications.pending({ channel })` lists that channel's pending notices; `{}` lists legacy unaccepted ones. Clients call `notifications.ack` after acceptance; scripts never fake it.

Receipts answer retries for two days; a 15-minute drain then deletes them.
