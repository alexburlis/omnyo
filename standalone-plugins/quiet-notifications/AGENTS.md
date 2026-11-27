# Quiet Notifications

Omnyo notification sender for 0.46.246 through 0.46.x. Use only the public Plugin SDK. Resolve notification levels through the enabled built-in plugin's authenticated RPC; never guess when that authority is unavailable.

Omnyo's built-in push-notifications plugin remains enabled for native device registration; its three delivery channels stay disabled. This plugin reads its canonical subscription rows through a read-only SQLite attachment and uses the built-in RPC for enrollment changes. Never log or persist device tokens outside the canonical store.

Keep the app bundle and dependencies while this path is installed. Use pnpm. Run pnpm verify and omnyo plugin build before reloading. Integration tests own sender, registration and reload behavior; write failure cases and tests before production changes.
