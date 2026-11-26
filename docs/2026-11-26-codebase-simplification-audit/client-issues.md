# Client incidental findings

This is a separate backlog from the refactor cards. The inspected snapshot is `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. No product changes or runtime reproduction were performed.

Priority meanings used here: P0 is immediate confirmed severe impact. P1 is urgent high-impact core failure or serious exposure. P2 is a normal bounded defect with meaningful impact. P3 is low impact or a limited diagnostic/maintenance concern. Confidence is stated separately from priority.

## ISS-100 — Desktop invalid-channel error omits a supported channel

**P3. Proven by inspection.** `apps/desktop/src/desktop-update-provider.ts`, `resolveBuiltDesktopReleaseChannel`, accepts `latest`, `nightly` and `public-beta`, then says an invalid value “must be latest or nightly”. Packaging's parser in `apps/desktop/scripts/desktop-release-channel.mjs` correctly lists all three. The error affects a developer/operator who launches a desktop build with an invalid channel. It does not reject a valid public-beta channel.

Expected behavior is that the invalid-value diagnostic describes the accepted set in the immediately preceding predicate. Actual behavior omits public-beta. Confirm with a dynamic import in an isolated test process using a deliberately invalid synthetic channel value. No launch of the real desktop, environment dump or release operation is needed.

The likely root cause is the separately maintained runtime/build channel vocabulary. RF-104 removes the identity duplication, but preserving behavior during that refactor means this diagnostic correction should be explicit and separately reviewed. A minimal fix updates the message and adds an invalid-value assertion without changing trimming/default behavior. Risk is low. Verify all three accepted channels, undefined/empty default and invalid input in `apps/desktop/test/desktop-update-provider.test.ts` or an adjacent isolated-import test. Existing focused command:

```sh
pnpm --filter @omnyo/desktop exec vitest run --config vitest.config.ts test/desktop-update-provider.test.ts test/public-beta.test.ts
```

The command is a future verification target and was not run during this audit.

## ISS-101 — Canonical source checkout is classified as a fork

**P3 provisional. The mapping is proven by inspection. Whether it is a defect needs an explicit meaning for “official” in the fork.** `README.md:22` tells users to clone `https://github.com/alexburlis/omnyo.git`. `packages/omnyo-app/src/app-install.ts`, `OFFICIAL_SOURCE_REMOTE_PATTERN` / `isOfficialSourceRemote`, recognizes only `get-bb/bb`. `resolveAppInstall` therefore returns `{kind:"source",origin:"fork"}` for the documented canonical Omnyo clone. `packages/config/src/app-install.ts`, `appInstallEnv`, includes the source commit only for origin `official`. `launcher.ts`, `createServerEnv`, removes inherited source metadata before adding that classification.

The confirmed effect is source classification and omission of commit metadata for the documented Omnyo origin. This audit did not establish a broken updater, user-visible failure or production exposure. Existing `packages/omnyo-app/test/app-install.test.ts` explicitly tests recognition of upstream `get-bb/bb` and exclusion of other repositories, which is meaningful counterevidence that the distinction may be intentional.

Confirm the intended contract before changing behavior. If “official” means this Omnyo distribution, update the recognized origin with exact HTTPS/SSH/scp-style cases and preserve fork lookalike rejection. If “official” deliberately means the original BB upstream, retain the mapping and clarify the naming/metadata expectation separately. Do not silently extend trust to arbitrary remotes. No network operation is required to characterize the pure predicate and mocked Git runner.

Verification targets are `packages/omnyo-app/test/app-install.test.ts` and its server-environment assertions in `test/index.test.ts`. Run from root after a scoped implementation:

```sh
pnpm --filter omnyo-app exec vitest run --config vitest.config.ts test/app-install.test.ts test/index.test.ts
pnpm --filter omnyo-app typecheck
```

These commands were not run. RF-104 is related only as another identity-ownership example. No saving is counted twice and neither issue is a prerequisite for the client refactor cards.

## Investigated leads that are not established defects

- The native Android clipboard request is handled by `patches/react-native-webview@13.16.1.patch`, whose `RNCWebViewClipboard.receive` intercepts `clipboard` and `clipboard-html` before JavaScript `onMessage`. The share-only request handler in `apps/mobile/src/screens/webview/useShellBridge.ts` does not establish a missing clipboard implementation.
- Desktop New Tab sends both `OMNYO_DESKTOP_OPEN_NEW_TAB_CHANNEL` and `panel.newTab` in `apps/desktop/src/main.ts:1072`. The detail view subscribes to the older event and to the command. Root uses the command. Fixed New Tab identity and repeated-focus behavior need a dedicated behavioral proof before alleging duplicate visible tabs. Keep compatibility until supported old renderer/native pairings are established. This audit makes no bug claim and recommends no bridge deletion.
- `buildSideChatSubmitMode` has a nullable child-ID branch, but the observed production caller in `EmbeddedThreadChat` supplies a required string. Tests still exercise the branch. This small internal special case is a low-value cleanup lead rather than a material refactor or confirmed defect.
