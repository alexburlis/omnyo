---
name: quiet-notifications
description: Inspect or configure the local Quiet Notifications sender when the user asks about Omnyo notifications.
---

# Quiet Notifications

Run `omnyo quiet-notifications status --json` for delivery state and `omnyo quiet-notifications list --json` for redacted device summaries. Settings live under `omnyo plugin config quiet-notifications`; available keys are `mobileEnabled`, `webEnabled`, `desktopEnabled` and `expoPushUrl`.

The built-in `push-notifications` plugin must remain enabled for native phone registration, with its three delivery channels off. The replacement automatically preserves registrations and checks live thread and descendant activity before completion delivery. Do not reinstall devices or expose their tokens.

For local source changes work in this plugin's source directory. Run `pnpm verify`, `omnyo plugin build .` and `omnyo plugin reload quiet-notifications`. Do not modify `/Applications/Omnyo.app`. The local plugin currently targets Omnyo 0.45.x; verify the registration schema and SDK before extending compatibility.
