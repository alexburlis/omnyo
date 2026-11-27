---
name: needs-you-sidebar-highlights
description: Explain the merged Needs You features and legacy compatibility entry.
---

# Needs You

The built-in `ask-user-question` plugin now owns the Needs You question adapter, sidebar attention visuals and callback relationship display. Use `omnyo plugin config ask-user-question` for its settings. The separate `needs-you` companion is a compatibility entry with no UI.

Omnyo owns questions, pending interactions, callbacks, completion matching and status priority. Do not recreate these records or infer completion from a visual state. Existing CLI and SDK attention operations continue to target native records.

For an older installation, update the built-in plugin before updating or disabling the legacy companion. Do not enable two sidebar overlays. Legacy settings are copied once into missing built-in settings by supported hosts; their original values remain intact.
