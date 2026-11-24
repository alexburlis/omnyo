Notify when a chat finishes, needs input (even mid-turn) or errors. Choose delivery in Settings → Push notifications.

## Delivery

Mobile gets Expo push with the app closed; failures reach `status` and Sentry. Focused windows show input/error cards without OS permission. Cards stay beside the sidebar until opened, resolved or deferred with **Later**. In narrow windows one card overlays content for 8 s, paused on hover/focus. Questions with 2–4 choices answer in one tap. Finished chats light their row and, unless open, notify the system, never the bell. Finished-turn notices wait up to 30 s for the reply suggestion (5 s for it to start).

Hover, focus or touch for **Open chat**/**Later**; questions and **Continue** act in place.

Background web needs an open HTTPS or localhost tab and permission. Desktop needs the app running; the last window closing quits on Windows/Linux. Mobile WebViews use mobile push only.

Thread levels are `all`, `input-only` (no finished turns) and `muted`. Threads inherit `childLevel` or `defaultLevel` unless overridden; every ancestor caps descendants.

A click opens its thread. Events combine, questions first; read, archived, deleted and hidden threads stay silent; same-origin tabs dedupe.

## Thread menu

Unarchived threads have a **Notifications** menu (Default, All activity, Needs input only, Muted). Only the override persists, `{ "notifications": { "own" } }`; parent limits stay live.

## Settings

- `mobileEnabled`, `webEnabled`, `desktopEnabled`, `mobileOnlyWhenAway` (wait for desktop inactivity): default true.
- `defaultLevel`: any level; default `all`.
- `childLevel`: `inherit` or any level; default `input-only`.
- `expoPushUrl`: mobile relay, default `https://exp.host/--/api/v2/push/send`.

Switches save per server. **Allow notifications** grants permission; **Send test notification** confirms queueing only.

## CLI and SDK

Use `omnyo push-notifications` with:

- `list`: registered mobile devices (redacted tokens).
- `add --token <expo-push-token> --platform <ios|android> --label <label>`: register or refresh a device.
- `remove <id>`: remove a device.
- `status`: settings, device count and last mobile send.
- `test <web|desktop>`: queue a test; fails if the channel is off.
- `thread <thread> [--level inherit|all|input-only|muted]`: resolved level and source; `--level` sets it.

All commands accept `--json`.

SDK settings match; `sdk.plugins.callRpc` supports `notifications.test` (`{ channel }`), `threadNotifications.list` (`{ threadIds }`, ≤200) and `threadNotifications.set` (`{ threadId, level }`).

## Durable script notifications

Automation stdout never notifies; scripts queue a notice. Automations queues `automation-failure:<runId>` on first failure or auto-pause:

```sh
omnyo plugin rpc call push-notifications notifications.send --input-file notice.json --json
```

Input: `{ "id": "upstream:<id>", "title": "Update", "body": "Review it." }`. IDs accept letters, digits and `._:-` (≤200 chars); title ≤80, body ≤500. Reusing an ID requires identical content.

Receipt: `{ "id", "status": "queued" | "dispatched" | "expired", "duplicate", "durable": true, "acceptedTargetCount" }`. Notices wait 24 h for an enabled web/desktop client and use the Notification API, never mobile push. Offline clients, disabled channels, denied permission and API errors leave notices pending. Dispatched means client acknowledgement, not OS display. Clients drain on mount, reconnect, focus, visibility and notification signals.

`notifications.pending({ channel })` lists that channel's pending notices; `{}` lists legacy unaccepted ones. Clients call `notifications.ack` after acceptance; scripts never fake it.

Receipts last two days, then a 15-minute drain deletes them.

## Credits

Thanks to Michael Yong and contributors for the original [bb plugin](https://github.com/get-bb/bb/tree/main/plugins/push-notifications), [MIT licensed](https://github.com/get-bb/bb/blob/main/LICENSE), copyright (c) 2026 Michael Yong.
