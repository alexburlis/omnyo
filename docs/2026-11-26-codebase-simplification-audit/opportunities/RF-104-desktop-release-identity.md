# RF-104 — Give desktop channel identity one lookup

## Rank and disposition

**Potential: medium. Confidence: high. Readiness: ready. Effort: small (roughly one engineering day including bundling checks). Risk: medium because profile and update-channel identity are sensitive.** Rechecks prior §17. This is local refactoring only. Building, signing, publishing or deploying a release is not authorized by the audit. See ISS-100 for the separate stale diagnostic string.

## Context and evidence

Snapshot: `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`.

- `apps/desktop/scripts/desktop-release-channel.mjs`: `resolveDesktopReleaseChannel` and `createDesktopReleaseConfig` independently select `latest`, `nightly` and `public-beta`. Identity includes application/profile/icon/release tag plus installer/platform configuration.
- `apps/desktop/scripts/desktop-release-channel.d.mts`: `DesktopReleaseChannel` and `DesktopReleaseConfig` supply the typed declaration for the existing script module.
- `apps/desktop/src/desktop-update-provider.ts:3–53`: another `DesktopReleaseChannel`, `DesktopReleaseInfo`, `createDesktopReleaseInfo` and runtime channel parser select the same application/profile/icon/release-tag identity.
- `apps/desktop/test/public-beta.test.ts:122` asserts beta identity through both functions. `desktop-update-provider.test.ts` covers latest/nightly names and retained private profile paths. `app-paths.test.ts`, `electron-builder-config.test.ts` and `electron-builder-windows-config.test.ts` cover consumers of those identities.

Counterevidence: packaging adds installer IDs, artifact names, metadata filenames and macOS-only public-beta restrictions. Runtime adds feed-dependent update support, and its parser does not trim whitespace whereas the build parser does. Public beta intentionally displays “Omnyo” with profile “Omnyo”. Private latest displays “Omnyo” while retaining “Omnyo Private”. These differences are required, not stale naming to clean up.

## End state and preservation

Add `desktopReleaseIdentity(channel)` (or an equivalent readonly lookup) to the existing `.mjs` release-channel module and expose its exact type through the adjacent `.d.mts`. It returns only channel, applicationName, profileName, iconFileName and releaseTag. `createDesktopReleaseConfig` adds platform/installer fields around that identity. `createDesktopReleaseInfo` becomes a direct delegating function or alias preserving its export and return shape. Runtime/build parsers can keep separate input policies. Share the accepted-channel vocabulary only if it does not change trimming or diagnostics.

Do not move Electron/runtime dependencies into the build module. No profile rename, app ID change, installer change, feed change, release selection or new dependency is part of this refactor. Fixing the diagnostic in ISS-100 is a distinct behavior/copy change, not silently bundled equivalence.

## Expected gain and cost

Projection over identity mapping and repeated channel/type declarations: remove 40–65 production lines. Add 15–30 shared lookup/declaration/wiring lines. **net 15–40 lines**. The durable gain is three channel identities with one definition rather than two. A new channel still needs separate platform packaging and runtime feed policy, but its profile/name/icon/tag agreement is automatic. Tests add a small three-row table and retain platform restrictions. No performance improvement is claimed. Lookup replaces equivalent branch selection during startup/build preparation.

## Execution steps

1. Reconfirm all three identity objects and build/runtime consumers, including public-beta exclusion and private continuity. Capture exact existing objects for all three channels and current missing/empty/invalid parser behavior. Stop if one caller now intentionally diverges on an identity field.
2. Add the common identity lookup to the existing script module and matching declaration. Use literals matching current output exactly. Do not derive profile names from display names.
3. Make `createDesktopReleaseConfig` spread the common identity while retaining app IDs, per-platform metadata filenames, Windows install identities and macOS-only beta validation. Keep the beta latest-config inheritance behavior for platform fields.
4. Delegate `createDesktopReleaseInfo` to the lookup, preserving exports and import-time environment parsing. Remove the duplicate runtime type union/object branches. Verify `apps/desktop/scripts/build.mjs` bundles/resolves the imported `.mjs` from its existing source route. Do not run packaging or release tasks.
5. Add all-channel identity parity assertions to the current tests, retain parser policy tests and private/beta boundaries, then run focused tests/typecheck. Inspect the complete diff for any changed product identity string and recount the actual net deletion.

## Verification and acceptance

Not run in this audit. From repository root:

```sh
pnpm --filter @omnyo/desktop exec vitest run --config vitest.config.ts test/desktop-update-provider.test.ts test/public-beta.test.ts test/app-paths.test.ts test/electron-builder-config.test.ts test/electron-builder-windows-config.test.ts test/preload-build.test.ts
pnpm --filter @omnyo/desktop typecheck
```

Acceptance: latest/nightly/public-beta have byte-equal identity fields before/after. Existing update support still enables configured macOS/Windows only and disables JSON version checks. Beta still refuses Windows/Linux packaging. All profile/app-ID/artifact/metadata paths remain unchanged. Runtime undefined/empty/default/invalid and build whitespace input behavior must match baseline. Test local bundling resolution through existing build tests. No release build or live updater run is needed for this bounded lookup extraction.

The identity is selected once, so no representative performance benchmark is warranted. Confirm no new runtime I/O/import side effects enter the lookup. There is no UI visual change to approve: About text, app name and icon selection must remain the existing values.

## Rollback and stop

Revert only the identity extraction's exact diff. No data migration or release rollback is involved. Stop if source-module resolution differs in packaged builds, any profile/install/feed identity changes, or public beta starts inheriting private identity accidentally. Retain separate input parsers rather than changing whitespace/error semantics to force a shared parser.
