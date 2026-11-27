# Needs You compatibility

Needs You is now part of Omnyo's built-in `ask-user-question` plugin, displayed as **Needs You**. The built-in plugin combines questions, sidebar highlights and callback relationships. This companion retains its existing settings and native attention adoption but registers no UI, tools, commands or callback owner.

Update the built-in plugin to its merged version before updating this companion. An older companion must be updated or disabled before the merged UI is enabled, because it also decorates the sidebar. No installation is disabled automatically.

On hosts with the settings migration, the built-in plugin adopts valid legacy preferences once, copying only settings it does not already have. The companion's settings and legacy data remain intact. Native question IDs, revisions, pending interactions, callback IDs and completion markers keep their existing owners.

Use **Settings → Plugins → Needs You** or `omnyo plugin config ask-user-question` for new settings. The legacy `needs-you` entry is retained for compatibility and is no longer a separate store feature.

The shared features and their focused tests now live in `plugins/ask-user-question` in the Omnyo core repository. The companion's adoption regression remains in `callback.test.ts`.
