# RF-077 — Delete the relay's unused `typed-token.ts` token format and the dead `gate`/`desktop` derivations in `auth/keys.ts`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** confirmed, with the line counts adjusted upward (see Expected gain).
- **Potential:** low to medium. The change is small, but it removes a real wrong-key hazard in security-critical code: two HKDF schemes use the same purpose labels with different salts, so they produce different key bytes.
- **Confidence:** high. Every symbol was traced at the snapshot. Nothing in production reads the dead half.
- **Readiness:** ready. No owner decision is needed, because no supported capability, persisted format or wire format changes.
- **Effort:** small, about 1 hour including the relay typecheck, lint and the auth and gate vitest suites.
- **Risk:** low if the Better Auth secret derivation stays byte-identical. A known-answer test (step 2) pins it before any edit.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-079 ("Delete small orphaned helpers kept alive only by their own tests") could also claim `apps/relay/src/auth/typed-token.ts`. RF-077 owns that file; RF-079 should exclude it so the two cards do not edit the same files. RF-111 (relay base-URL policy into `@omnyo/connect-client`) touches the relay but not these files.
- **Why it deserves its place:** this is verified dead code in the relay's authentication path. The relay is the public `omnyo.link` service, and its gate cookies, desktop sessions and Better Auth sessions all derive from one root secret. The surviving code would leave one token module (`gate/signed-token.ts`) and one Better Auth secret derivation, so a maintainer can no longer pick a key that looks right but has the wrong bytes.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the audit brief was absent when this card was written, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` and searched with `git grep` at that commit.

*How the relay keys work today.* The relay (`apps/relay`, package `@omnyo/relay`, `"private": true`, no `exports`) reads one root secret, `BETTER_AUTH_SECRET`, in `apps/relay/src/config.ts:275` (validated with a minimum length) and `:501` (`betterAuthSecret`). Two separate modules derive keys from it.

1. **Live gate and desktop tokens.** `apps/relay/src/gate/signed-token.ts:10-33` defines `GATE_KEY_LABEL = "omnyo-relay gate v1"`, `DESKTOP_KEY_LABEL = "omnyo-relay desktop v1"` and `derivePurposeKey(secret, label)`, which runs HKDF-SHA256 with an **empty salt** (`Buffer.alloc(0)`). `signToken` and `verifyToken` (`:61-92`) produce and check the gate cookie and desktop session tokens. `apps/relay/src/gate/gate.ts:460-465` in `createGate` builds `gateKey` and `desktopKey` this way. Proven by inspection.
2. **Live Better Auth secret.** `apps/relay/src/auth/keys.ts:40-48` `deriveRelayKeys` returns `{ gate, desktop, betterAuthSecret }`. `deriveRelayKey` (`:21-38`) runs HKDF-SHA256 with salt `"omnyo-relay"` (`HKDF_SALT`, `:13`), info from `RELAY_KEY_LABELS` (`:3-7`), 32 bytes (`RELAY_KEY_BYTES`, `:11`), and throws `"BETTER_AUTH_SECRET is required to derive relay keys"` on an empty root (`:25-27`). `apps/relay/src/auth/index.ts:17-24` `createRelayAuth` passes only `keys.betterAuthSecret` (base64url) to `createRelayBetterAuth` (`apps/relay/src/auth/better-auth.ts:169-175`, `secret: options.secret`). Proven by inspection.
3. **Dead gate and desktop keys.** `RELAY_KEY_LABELS.gate` and `.desktop` in `auth/keys.ts:4-5` are the same strings as `GATE_KEY_LABEL` and `DESKTOP_KEY_LABEL`, but with salt `"omnyo-relay"` instead of an empty salt, so the bytes differ. `deriveRelayKeys` computes them, and `createRelayAuth` returns them as `RelayAuth.keys` (`auth/index.ts:8`, `:27`). No code reads `RelayAuth.keys`. Proven by inspection.
4. **Dead typed-token format.** `apps/relay/src/auth/typed-token.ts` (68 lines) defines a versioned `v1.<body>.<mac>` format with `signTypedToken`, `verifyTypedToken`, `TYPED_TOKEN_VERSION` and `TokenType`. Only `apps/relay/src/auth/keys.test.ts:4` imports it. Proven by inspection.

*Decisive searches (all at the snapshot, whole repository):*

- `git grep -n -E 'deriveRelayKey|signTypedToken|verifyTypedToken|RELAY_KEY_LABELS|RELAY_KEY_BYTES|RelayKeys|RelayKeyPurpose|typed-token|TYPED_TOKEN_VERSION|auth/keys|"\./keys' <commit> -- .` finds hits only in `apps/relay/src/auth/index.ts`, `keys.ts`, `keys.test.ts` and `typed-token.ts`.
- `git grep -n -E 'relayAuth\.|createRelayAuth|RelayAuth\b' <commit> -- apps/relay packages` shows every consumer of `createRelayAuth`. They read only `.service` (`apps/relay/src/main.ts:500-534`, `apps/relay/src/gate/gate-test-harness.ts:376`, and the account and auth tests) and `.betterAuth` (`apps/relay/src/auth/production-auth.test.ts:158`). No consumer reads `.keys`.
- `git grep -n -E 'omnyo-relay (gate|desktop|better-auth)|GATE_KEY_LABEL|DESKTOP_KEY_LABEL|derivePurposeKey|"omnyo-relay"' <commit> -- .` shows that the gate path and its tests (`gate-auth.test.ts`, `renewal.test.ts`, `revocation.test.ts`, `edge-tls.test.ts` and others) use only `derivePurposeKey`. The `"omnyo-relay better-auth v1"` label appears only in `auth/keys.ts`.
- `git grep` over `*.md` and `docs/` for `typed.token`, `keys.ts` and `deriveRelay` returns nothing, so no documentation describes the dead scheme.
- Non-obvious consumers checked: the relay has no package `exports`, so no other workspace package or external plugin can import these modules. The only relay build entries are `src/main.ts` and `src/usage/main.ts` (`apps/relay/package.json` `build`). No migration or persisted row stores a typed token. These are in-process HMAC keys, not stored data. The public history at the snapshot holds only the squashed `060950255 Publish Omnyo source` commit for these files, so the public history cannot show the code's origin. The sweep report says it dates from private commit `be6b7bccb2` (2026-11-08), before the gate adopted `signed-token.ts`. This card did not verify that.

*Counterevidence considered.* `typed-token.ts` may have been meant as the next gate token format, because it binds a `typ` into the MAC. Nothing at the snapshot adopts it, and adopting it later would be a migration of live cookies in its own right, which git history can restore if wanted. The empty-secret guard in `deriveRelayKey` duplicates the config minimum length, but tests call `createRelayAuth` directly, so the guard stays.

*Maintenance cost today.* Anyone who changes gate or desktop token claims has to work out which of `signToken` or `signTypedToken`, and which of `relayAuth.keys.gate` or `derivePurposeKey(..., GATE_KEY_LABEL)`, production uses. The same label strings make the wrong choice look correct. Using `relayAuth.keys.gate` would invalidate every live gate cookie, or would mint tokens that the gate rejects.

**Proposed end state and preservation argument**

- **Removed:** `apps/relay/src/auth/typed-token.ts` (the whole file), `RELAY_KEY_LABELS.gate`, `RELAY_KEY_LABELS.desktop`, `RelayKeyPurpose`, `RelayKeys`, `deriveRelayKey`, `deriveRelayKeys` and the exported `RELAY_KEY_BYTES` in `auth/keys.ts`, plus the `keys` field of `RelayAuth` in `auth/index.ts`.
- **Kept (canonical owners):** `apps/relay/src/gate/signed-token.ts` stays the only gate and desktop key and token module and does not change. `apps/relay/src/auth/keys.ts` keeps one function:

  ```ts
  import { hkdfSync } from "node:crypto";

  // Changing any HKDF input changes the Better Auth secret: every Connect
  // session ends and encrypted OAuth tokens in the database become unreadable.
  const BETTER_AUTH_KEY_INFO = "omnyo-relay better-auth v1";
  const HKDF_SALT = Buffer.from("omnyo-relay", "utf8");
  const KEY_BYTES = 32;

  export function deriveBetterAuthSecret(rootSecret: string): string {
    if (rootSecret.length === 0) {
      throw new Error("BETTER_AUTH_SECRET is required to derive relay keys");
    }
    return Buffer.from(
      hkdfSync("sha256", Buffer.from(rootSecret, "utf8"), HKDF_SALT,
        Buffer.from(BETTER_AUTH_KEY_INFO, "utf8"), KEY_BYTES),
    ).toString("base64url");
  }
  ```

  `createRelayAuth` calls `createRelayBetterAuth({ ..., secret: deriveBetterAuthSecret(config.betterAuthSecret) })` and returns `{ betterAuth, service }`.
- **Why the behavior survives:** the hash, input encoding, salt, info, length and output encoding of the Better Auth secret stay byte-identical, and a fixed-vector test proves it. The gate code does not change. `RelayAuth.betterAuth` and `RelayAuth.service` keep their types. The only removed field, `keys`, has no reader. No HTTP route, cookie name, cookie format, database row or configuration variable changes.
- **Why the stakes matter:** `createRelayBetterAuth` sets `encryptOAuthTokens: true` (`apps/relay/src/auth/better-auth.ts`, `account` block). A different derived secret would sign every user out, and stored GitHub OAuth tokens could no longer be decrypted. The known-answer test protects against this.
- **Non-goals:** do not merge the two HKDF schemes, and do not change either salt or label. Either change alters live key bytes and invalidates gate cookies, desktop sessions or Better Auth sessions. Do not adopt the typed-token format for the gate.
- **Remaining uncertainty:** none found for in-repository consumers. The relay is a private app with no package exports, so no external consumer can exist.

**Expected gain and cost**

Line counts come from `git show <commit>:<path> | wc -l` at the snapshot. Projected counts are estimates.

| Item | Before (observed) | After (projected) |
|---|---|---|
| `apps/relay/src/auth/typed-token.ts` | 68 | 0 (deleted) |
| `apps/relay/src/auth/keys.ts` | 48 | about 22 |
| `apps/relay/src/auth/index.ts` | 35 | about 32 |
| Handwritten production lines | 151 | about 54, so about 95 removed |
| `apps/relay/src/auth/keys.test.ts` (test) | 121 | about 20, so about 100 removed |
| Key-derivation schemes in the relay | 2 (empty salt, and salt `"omnyo-relay"`) | 2, but each label now exists in only one scheme: gate and desktop in `signed-token.ts`, Better Auth in `keys.ts` |
| Token formats | 2 (`signToken`, `signTypedToken`) | 1 |

The sweep estimate of 75-85 production lines was low, because `keys.ts` shrinks by about 26 lines, not about 10. Most of the benefit is not the line count. One mechanism disappears: the second token format and a second derivation for the gate and desktop purposes. After the change, a search for a gate or desktop key label leads only to the live code. Performance: two fewer HKDF calls each time `createRelayAuth` runs (once per process start), which is negligible. Cost: one new fixed-vector test.

**Execution steps**

1. **Reconfirm.** In a fresh worktree on current `main`, confirm that `apps/relay/src/auth/typed-token.ts` still exists and that `git grep -n -E 'deriveRelayKey|signTypedToken|verifyTypedToken|RELAY_KEY_LABELS|RELAY_KEY_BYTES|RelayKeys|RelayKeyPurpose|typed-token|relayAuth\.keys|\.keys\.(gate|desktop|betterAuthSecret)'` finds hits only in `apps/relay/src/auth/`. Re-plan if any new non-test consumer of `RelayAuth.keys`, `deriveRelayKeys` or `typed-token.ts` has appeared, or if the gate has moved to `typed-token.ts`.
2. **Pin the live secret first (characterization test).** Before any production edit, add a test to `apps/relay/src/auth/keys.test.ts` that asserts the current derivation for the existing `ROOT` constant (`"keys-root-material-for-tests-only-0123456789abcd"`):
   `expect(deriveRelayKeys(ROOT).betterAuthSecret).toBe("DAbHZZovpdeFdCF_UXxrRE3b9ZVwaXJyQ87_X9i17rY")`.
   The expected value was computed independently (Reproduced, Node 24.22.1) with `node -e` running `hkdfSync("sha256", ROOT, "omnyo-relay", "omnyo-relay better-auth v1", 32)` and base64url encoding. Run the relay tests and confirm the new test passes against the unchanged code. If the test fails, stop: the derivation is not what this card describes.
3. **Edit `apps/relay/src/auth/keys.ts`.** Replace the module with `deriveBetterAuthSecret(rootSecret: string): string`, as shown in the end state. Keep salt `"omnyo-relay"`, info `"omnyo-relay better-auth v1"`, 32 bytes, UTF-8 inputs, base64url output and the exact empty-secret error message. Remove `RELAY_KEY_LABELS`, `RelayKeyPurpose`, `RELAY_KEY_BYTES` (as an export), `RelayKeys`, `deriveRelayKey` and `deriveRelayKeys`.
4. **Edit `apps/relay/src/auth/index.ts`.** Change the import to `import { deriveBetterAuthSecret } from "./keys.js";`. Remove `keys: RelayKeys;` from `interface RelayAuth`, replace `const keys = deriveRelayKeys(...)` with `secret: deriveBetterAuthSecret(config.betterAuthSecret)` in the `createRelayBetterAuth` call, and drop `keys,` from the returned object.
5. **Delete `apps/relay/src/auth/typed-token.ts`.** It is a clean tracked file. Name it in the commit and report.
6. **Rewrite `apps/relay/src/auth/keys.test.ts`.** Keep these tests: (a) the fixed vector from step 2, now calling `deriveBetterAuthSecret(ROOT)` with the same expected string; (b) `deriveBetterAuthSecret("")` throws `"BETTER_AUTH_SECRET"`; (c) the result differs from `ROOT` and from `deriveBetterAuthSecret(`${ROOT}x`)`. Delete the `typed tokens` describe block and the gate and desktop distinctness assertions, because they test only deleted code. The gate token behavior they resemble is already covered by `apps/relay/src/gate/gate-auth.test.ts`, `revocation.test.ts`, `renewal.test.ts` and others, which use `derivePurposeKey`. Do not change the expected vector string.
7. **Clean up and check.** Run the formatter and lint on the changed files, then the checks below. Inspect `git diff --stat` to confirm that only the four relay files changed. Recount the lines with `wc -l apps/relay/src/auth/keys.ts apps/relay/src/auth/index.ts apps/relay/src/auth/keys.test.ts`.

**Verification and acceptance criteria**

Commands come from `apps/relay/package.json` and the root `package.json` at the snapshot. They could not be run for this card, because the snapshot has no `node_modules`.

- `cd apps/relay && pnpm typecheck` (script `tsc --noEmit`, which includes `src` and `scripts`) passes. A leftover reader of `RelayAuth.keys` or of a removed export would fail here.
- `cd apps/relay && pnpm lint` (script `oxlint --deny-warnings src scripts`) passes.
- `cd apps/relay && pnpm test` (script `vitest run --config vitest.config.ts`) passes. For a faster loop, use `cd apps/relay && pnpm exec vitest run --config vitest.config.ts src/auth src/gate`. That path filter is standard vitest behavior, but this card did not confirm it works with the `sharedWorkerProjects` configuration.
- The fixed-vector test passes both before the edit (step 2) and after it (step 6) with the same expected string. This is the key acceptance criterion: it proves that live Better Auth sessions and encrypted OAuth tokens remain valid.
- The existing gate suites (`gate-auth.test.ts`, `revocation.test.ts`, `renewal.test.ts`, `anonymous-forwarding.test.ts`, `edge-tls.test.ts`) and auth suites (`production-auth.test.ts`, `auth-cookies.test.ts`, `sign-in.test.ts`) pass without edits.
- Formatting: from the repository root, run `pnpm exec oxfmt apps/relay/src/auth/keys.ts apps/relay/src/auth/index.ts apps/relay/src/auth/keys.test.ts`, then `pnpm format:check` (root script `oxfmt . --check`).
- Structural completion: `git grep -n -E 'typed-token|signTypedToken|verifyTypedToken|deriveRelayKey|RELAY_KEY_LABELS|RelayKeys'` returns nothing. `"omnyo-relay gate v1"` and `"omnyo-relay desktop v1"` appear only in `apps/relay/src/gate/signed-token.ts`.
- No UI is affected, and there is no performance-sensitive path.

**Rollback and stop conditions**

- **Rollback:** the change consists of four relay files and no data. `git revert` of the commit restores the old code. There is no data or compatibility impact, provided the fixed-vector test passed before the relay was deployed.
- **Stop if:** the step-2 vector test fails against unchanged code; a new consumer of `RelayAuth.keys`, `deriveRelayKeys` or `typed-token.ts` appears; a design note or open branch plans to move gate or desktop tokens to the typed format (in that case, ask the owner whether to keep `typed-token.ts` as the planned successor); or any existing gate or auth suite needs an edited expectation to pass. That last case means behavior changed. Do not adjust those expectations.
- **Safer smaller alternative:** if `keys.ts` has to stay unchanged for some reason, delete only `typed-token.ts` and its describe block in `keys.test.ts`. That removes the second token format but leaves the duplicate labels in place.
- **Deployment:** this card authorizes only a local change. Deploying the relay to `omnyo.link` needs the owner's separate authorization.
