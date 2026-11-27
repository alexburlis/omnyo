# Quiet Notifications

The server coalesces notification events for two seconds and rechecks the live chat. A completion requires an idle root, idle runtime, no queued messages or work, no pending interaction, no active workflow, goal, plan mode, command or agent, and no busy visible or hidden descendant. Questions and errors keep their existing priority. Missing activity suppresses completion and logs the cause. There is no polling loop or alternate provider.

`server.ts` owns settings, CLI, RPC, event listeners and the sender service. `sender.ts` owns notification policy and Expo/client delivery. `subscriptions.ts` owns the one-time settings handoff and canonical enrollment adapter. It attaches the existing Omnyo database only after checking that it exists and enables SQLite query-only mode before attachment. All enrollment mutations go through the built-in plugin's RPC. `app.tsx` validates realtime messages and exposes permission controls; `client.ts` owns browser delivery and deduplication.

The built-in plugin stays enabled for the native registration contract. Its delivery channels stay disabled. Replacement settings and the completed-handoff marker are stored in the replacement's SDK namespace, which survives reloads and restarts. Dispose stops timers, waits for in-flight delivery, closes the network dispatcher and releases host-owned SQLite handles.

Compatibility: Omnyo 0.45.x, Plugin SDK 0.6.15. This plugin is private and installed from a local path. No signed application file is modified.
