# Anti-slop provenance

- **Source:** the `install-anti-slop` skill's `assets/anti-slop` directory,
  clean at commit `facc870ad50f48f91523e6d59ae8c7eba289984f` (2026-10-06).
- **Installed:** 7 October 2026 with `node scripts/install.mjs` into
  `tools/oxlint/anti-slop/`: 38 files. The SHA-256 of their sorted per-file
  SHA-256 list is `9823144c60c14e15…`.
- **Dependencies:** `oxlint` and `@oxlint/plugins` both pinned exactly at
  `1.87.0`, the current release on that date.
- **Configuration:** `.oxlintrc.json` registers the generic plugin and every
  generic rule at `error`. The Effect plugin is not enabled, because this
  package does not depend on `effect`.
- **Deviations:** none in the copied rules. The configuration additionally
  ignores the shadcn components that `omnyo plugin new` vendors from the
  upstream BB registry (`components/ui/**`, `hooks/**`, `lib/utils.ts`,
  `lib/portal-scope.ts`). They are third-party copies refreshed with
  `npx shadcn add`, and editing them would be overwritten on the next refresh.
  The plugin's own source (`server.ts`, `app.tsx`) is linted without
  exceptions.
