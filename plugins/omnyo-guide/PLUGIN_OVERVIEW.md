# Omnyo guide

Control the Omnyo introduction and bundled agent skills in Settings → Installed
plugins → Omnyo guide. The plugin and all five settings default to enabled.

- `introduction`: send the Omnyo CLI, thread, and link instructions.
- `skills`: make the selected bundled skills available.
- `omnyoCli`: include `omnyo-cli`.
- `pluginAuthoring`: include `omnyo-plugin-authoring`.
- `skillCreator`: include `skill-creator`.

Use `omnyo plugin config omnyo-guide set <key> true|false` from the CLI, or
`api.sdk.plugins.updateSettings({ pluginId: "omnyo-guide", values: { ... } })`
through the SDK. Changes apply when agent configuration is next assembled;
they do not erase instructions from an existing conversation.

Disabling the plugin removes its introduction and all three skills. The
settings affect this plugin's copies, not independently installed user or
provider skills. Other plugins keep their own skills. The generated
`plugin-commands` skill continues to describe enabled plugin commands.
