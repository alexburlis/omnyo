# RF-135 — Build the Connect share-origin host format once, in `@omnyo/connect-client`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and exactly as the sweep described, but the line saving is smaller than reported: about 0 to 4 net handwritten production lines, not 5 to 10. The value is one definition of a wire format, not size.
- **Potential:** low. Three hand-written copies of one host format collapse into one builder.
- **Confidence:** high. Every copy, caller and test was re-read at the snapshot.
- **Readiness:** ready. No owner decision is needed, and no behavior changes.
- **Effort:** small, about one hour including tests.
- **Risk:** low. The builders are pure string functions, and end-to-end tests already pin their output.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-111 ("Move the relay base-URL policy into `@omnyo/connect-client`") edits the same file, `packages/connect-client/src/urls.ts`. RF-134 ("One tunnel socket dial lifecycle in tunnel-client") edits the same two consumer files, `plugins/connect/src/tunnel.ts` and `apps/host-daemon/src/connect-tunnel/index.ts`. Neither one blocks this item. Whichever change lands second must rebase onto the first. No alternative opportunity competes with this one.
- **Why it keeps a place in the audit:** the relay parses this host format to route visitors to shared ports. Today a change to the separator or the port encoding needs three matching edits, in a plugin and in the daemon, and no test checks that the copies agree. The item is kept as a low-potential consolidation of duplicated wire knowledge. Line count alone would not justify it.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The worktree that held the snapshot had already been removed, so the evidence below was read with `git show <commit>:<path>` and `git grep <commit>` from `$OMNYO_CHECKOUT`. Current `main` may have moved since then, so re-check the anchors (step 1 below).

What the subsystem does: Omnyo Connect publishes a local port at a public origin of the form `<label>--<port>.<baseDomain>`. For a share on the server host, `<label>` is the server handle. For a share on another machine, `<label>` is that machine's label. The relay gate splits incoming visitor hosts with `parseVisitorHost` and routes them on the result.

Observed facts (Proven by inspection unless stated otherwise):

- **Parser, which stays unchanged:** `packages/connect-db/src/constants.ts:147` `parseVisitorHost` splits the label at the first `--` and accepts a port of 1 to 65535 (`SHARE_PORT_TARGET`, `isValidShareTarget`, lines 133-138). `validateLabel` (line 124) and `packages/host-daemon-contract/src/commands.ts:133` reject labels that contain `--`, which keeps the split unambiguous. The parser's only production consumer is `apps/relay/src/gate/host.ts:48`.
- **Copy 1:** `plugins/connect/src/shares.ts:69` `sharePublicUrl(identity: ShareIdentity, port)` calls `deriveConnectBaseUrl(identity.serverUrl)`, parses the result with `new URL`, and returns `` `${url.protocol}//${identity.handle}--${port}.${url.host}` ``. Its callers are `ShareRegistry.serverUrl` at `shares.ts:627` and the plugin tunnel's origin resolver at `plugins/connect/src/tunnel.ts:384`, which wraps the call in `new URL(...).origin`.
- **Copy 2:** `plugins/connect/src/shares.ts:76` `machineSharePublicUrl({ label, baseDomain }, port)` returns `` `${connectPublicProtocol(identity.baseDomain)}//${identity.label}--${port}.${identity.baseDomain}` ``. Its only caller is `ShareRegistry.urlFor` at `shares.ts:602`.
- **Copy 3:** `apps/host-daemon/src/connect-tunnel/index.ts:112` `buildMachineSharePublicOrigin(identity, port)` has a body that is character-for-character identical to copy 2. Its only caller is `ConnectTunnelClient.resolveOrigin` at `index.ts:535`.
- **The owner already exists.** `packages/connect-client/src/urls.ts` (19 lines) owns the neighbouring helpers `connectPublicProtocol`, `deriveConnectBaseUrl` and `serverUrlForHandle` (`` `${url.protocol}//${handle}.${url.host}` ``). `packages/connect-client/src/index.ts` re-exports them. `plugins/connect/package.json` and `apps/host-daemon/package.json` both already list `@omnyo/connect-client` under `dependencies` (`workspace:*`), and both consumer files already import from it (`shares.ts:12-16` and `index.ts:18`).
- **The forkable-plugin rule does not apply.** `scripts/forkable-plugins.json` does not list the Connect plugin, so the rule in `docs/forkable-plugins.md` that rejects imports of workspace packages does not cover `plugins/connect`. The plugin already imports `@omnyo/connect-client` in six files.
- **Tests that pin the format:**
  - `plugins/connect/src/connect.test.ts:197-206` `describe("machineSharePublicUrl")` expects `http://sawyer-air--8000.omnyo.localhost:42745`.
  - `apps/host-daemon/src/connect-tunnel/connect-tunnel.test.ts:148-152` expects `http://sawyer-air--4173.omnyo.localhost:42745` from `buildMachineSharePublicOrigin`. This assertion duplicates the plugin test.
  - Server-share output is pinned end to end: `connect.test.ts:179-184` checks `publicOrigin: "https://sawyer--8000.omnyo.link"`, and lines 280, 301, 356, 470 and 742 check `url: "https://sawyer--…"`. `plugins/connect/app.test.tsx:417-528` uses literal share URLs as fixtures and does not call a builder.
  - `packages/connect-client/test/connect-client.test.ts:22-38` covers the neighbouring URL helpers but not share origins.
- **Searches run at the snapshot:**
  - `` git grep -n -E -e '--\$\{' -e "\+ ?['\"]--['\"] ?\+" <commit> -- apps packages plugins `` finds exactly two production template builders, at `shares.ts:80` and `connect-tunnel/index.ts:116`. The sweep's narrower pattern, `` \}--\$\{ ``, also finds `shares.ts:73`, which writes `${identity.handle}--${port}`. Every other hit is a CLI flag, a CSS variable or a test.
  - `git grep -n -E 'sharePublicUrl|machineSharePublicUrl|buildMachineSharePublicOrigin' <commit>` finds only the callers and tests listed above. Neither the app, mobile, the relay nor the SDK imports these functions.
  - A search for `parseVisitorHost` finds only connect-db, its test and the relay.
  - Searches cannot prove absence. The check that would show another builder, a template that writes `--` through a variable, is covered by the second pattern above, and it found nothing more.
- **Documentation of the format** (prose only, unchanged by this item): `docs/configuration.md:1953-1954`, `packages/templates/src/templates/omnyo-guide-environments.md:266-267` and `plugins/connect/skills/share-server-links/SKILL.md:47-49`.
- **Production line count**, measured with `git show <commit>:<file> | sed -n '<range>p' | grep -c -v '^\s*$'`: `shares.ts:67-81` has 12 non-blank lines (two builders plus the `ShareIdentity` type, which stays), and `connect-tunnel/index.ts:112-117` has 6. `urls.ts` has 19 lines in total.
- **Counterevidence and limits:** the two plugin builders take different inputs. The server-host builder starts from a server URL, normalizes it through `new URL` and takes the protocol from the URL. The machine-host builder starts from a raw `baseDomain` and derives the protocol with `connectPublicProtocol`. A consolidation must keep each normalization exactly as it is (see the preservation argument below). The saving is small.

Maintenance cost today: changing the share separator, the port encoding or the protocol rule for share hosts needs matching edits in `shares.ts` (twice) and in the daemon, with nothing that checks the copies against the relay parser. The daemon copy has already been duplicated verbatim from the plugin.

**Proposed end state and preservation argument**

End state:

- `packages/connect-client/src/urls.ts` becomes the single owner of the share-origin format. It gains one private formatter and two exported builders:

  ```ts
  function formatShareOrigin(protocol: string, host: string, label: string, port: number): string {
    return `${protocol}//${label}--${port}.${host}`;
  }

  // Server-host share: label is the server handle; base derived from the server URL.
  export function serverShareOrigin(
    identity: { serverUrl: string; handle: string },
    port: number,
  ): string {
    const url = new URL(deriveConnectBaseUrl(identity.serverUrl));
    return formatShareOrigin(url.protocol, url.host, identity.handle, port);
  }

  // Machine-host share: label is the machine label; baseDomain used verbatim.
  export function machineShareOrigin(
    identity: { label: string; baseDomain: string },
    port: number,
  ): string {
    return formatShareOrigin(
      connectPublicProtocol(identity.baseDomain),
      identity.baseDomain,
      identity.label,
      port,
    );
  }
  ```

- `packages/connect-client/src/index.ts` re-exports `serverShareOrigin` and `machineShareOrigin` next to `serverUrlForHandle`.
- The two builders are removed from `plugins/connect/src/shares.ts` (`sharePublicUrl`, `machineSharePublicUrl`) and from `apps/host-daemon/src/connect-tunnel/index.ts` (`buildMachineSharePublicOrigin`). The four call sites call the connect-client builders directly.
- `ShareIdentity` (`shares.ts:67`) stays, because `ShareRegistryOptions.getIdentity` (`shares.ts:104`) uses it. It is structurally compatible with the `serverShareOrigin` parameter.

Preservation argument:

- **Server-host shares:** the output is unchanged character for character. `serverShareOrigin` runs the same `deriveConnectBaseUrl` and `new URL` steps and uses `url.protocol` and `url.host` exactly as `sharePublicUrl` does today. `tunnel.ts:384` keeps its outer `new URL(...).origin` wrapper, so its normalization does not change either.
- **Machine-host shares:** the output is unchanged character for character. The raw `baseDomain` is still used, without `new URL` normalization, and `connectPublicProtocol(baseDomain)` still chooses `http:` for `*.localhost` and `https:` for everything else. Do not route the machine builder through `new URL`: that would lowercase the host and drop default ports, which is a behavior change.
- **Loopback fallback:** `ShareRegistry.serverUrl` (`shares.ts:623-628`) keeps its `http://127.0.0.1:${port}` fallback when there is no identity.
- **Unchanged contracts:** `parseVisitorHost`, the relay gate, the share listing `url` field, the tunnel `publicOrigin` field, the persisted share records and the documentation do not change.

Why this is the simplest sufficient option: connect-client already owns the sibling format `<handle>.<base>`, and both consumers already depend on it. Moving the builder next to the parser in `@omnyo/connect-db` would make the plugin and the daemon depend on a database package, so connect-client is the right owner. A single generic function that takes `(protocol, host, label, port)` at every call site would push the two normalization rules back out to the callers. That is why the end state has one private formatter and two named builders.

Non-goals:

- Do not change `parseVisitorHost` or label validation.
- Do not consolidate the loopback helpers. `shareLoopbackOrigin` and `shareLoopbackHost` in `shares.ts:83-89` duplicate the `http://127.0.0.1:${port}` literals in the daemon's `resolveOrigin` (`index.ts:534-536`), but those values are not part of the relay wire contract. That merge is optional, with marginal value.
- Do not remove the outer `new URL(...).origin` wrapper in `tunnel.ts:384`.
- Do not change the prose documentation.

**Expected gain and cost**

These are projections, not measurements:

- **Removed:** about 18 handwritten production lines, counting the bodies and signatures of `sharePublicUrl` and `machineSharePublicUrl` (about 12 lines, blank lines included) and `buildMachineSharePublicOrigin` (6 lines).
- **Added:** about 16 to 20 lines in `urls.ts` (the formatter and two builders, blank lines included) plus 2 export lines in `index.ts`.
- **Net:** about 0 to 4 production lines. Import lines change but do not grow materially.
- **Tests:** the two duplicate machine-share assertions (`connect.test.ts:197-206` and `connect-tunnel.test.ts:148-152`) become one connect-client test. That test adds a direct server-share case, which today is pinned only indirectly. The net test-line change is about zero.
- **Mechanisms:** before the change, three builders in two packages encode one wire format. After it, one formatter and two named builders in the package that owns Connect URL helpers do. The causal maintenance gain is that a format change becomes one edit, with one unit test next to the sibling `serverUrlForHandle` test.
- **Performance:** neutral by construction. The same string operations run, with one extra function frame.
- **Tradeoff:** connect-client's public surface grows by two exports in a private workspace package (`"private": true`). It is not published, so no external consumers exist.

**Execution steps**

1. **Reconfirm the anchors.** On current `main`, run:
   - `rg -n 'sharePublicUrl|machineSharePublicUrl|buildMachineSharePublicOrigin' apps packages plugins`
   - `` rg -n -e '--\$\{' apps packages plugins --glob '!**/*.test.*' ``

   Confirm that the builders and the four call sites (`shares.ts` `urlFor` and `serverUrl`, `tunnel.ts` origin resolver, daemon `resolveOrigin`) still match this card. Re-plan if any of these holds:
   - A new builder of the format exists, for example in the app, mobile or the relay.
   - RF-111 has already restructured `urls.ts`.
   - RF-134 has moved `resolveOrigin` into `@omnyo/tunnel-client`. In that case, call `machineShareOrigin` from wherever the resolver now lives.
   - The Connect plugin has been added to `scripts/forkable-plugins.json`. A forkable plugin cannot import `@omnyo/connect-client`. Stop and re-plan, because the shared copy would then have to go through the plugin SDK.
2. **Pin the baseline.** No new behavioral evidence is needed. The existing tests listed under Context pin both outputs. Before you edit, add the connect-client test from step 3a and confirm it passes against literal expected strings copied from the existing tests. The expected values must stay literals so that the replacement is not checked against itself.
3. **Edit, in this order:**
   1. In `packages/connect-client/src/urls.ts`, add `formatShareOrigin` (not exported), `serverShareOrigin` and `machineShareOrigin` exactly as in the end-state sketch. In `packages/connect-client/src/index.ts`, add both exports to the existing `./urls.js` export block. In `packages/connect-client/test/connect-client.test.ts`, inside `describe("connect URL helpers")`, add these assertions:
      - `machineShareOrigin({ label: "sawyer-air", baseDomain: "omnyo.localhost:42745" }, 8000)` returns `"http://sawyer-air--8000.omnyo.localhost:42745"`. This is moved from the plugin test.
      - `machineShareOrigin({ label: "sawyer-air", baseDomain: "omnyo.link" }, 4173)` returns `"https://sawyer-air--4173.omnyo.link"`.
      - `serverShareOrigin({ serverUrl: "https://sawyer.omnyo.link", handle: "sawyer" }, 8000)` returns `"https://sawyer--8000.omnyo.link"`.
      - `serverShareOrigin({ serverUrl: "https://laptop.omnyo.example:8443/", handle: "laptop" }, 3000)` returns `"https://laptop--3000.omnyo.example:8443"`.

      Checkpoint: run connect-client typecheck and tests.
   2. In `plugins/connect/src/shares.ts`:
      - Delete `sharePublicUrl` (lines 69-74) and `machineSharePublicUrl` (lines 76-81).
      - In `urlFor` (line 602), return `machineShareOrigin(identity, port)`.
      - In `serverUrl` (line 627), use `serverShareOrigin(identity, port)`.
      - Update the import at lines 12-16: drop `connectPublicProtocol` and `deriveConnectBaseUrl` if nothing else in the file uses them (verify with `rg`), and add `machineShareOrigin` and `serverShareOrigin`.
      - Keep `ShareIdentity`.
   3. In `plugins/connect/src/tunnel.ts`:
      - Remove `sharePublicUrl` from the `./shares.js` import (lines 23-29).
      - Add `serverShareOrigin` to the existing `@omnyo/connect-client` import (line 21).
      - At line 384, write `publicOrigin: new URL(serverShareOrigin(identity, port)).origin`.
   4. In `plugins/connect/src/connect.test.ts`, delete `describe("machineSharePublicUrl")` (lines 197-206) and drop `machineSharePublicUrl` from the import (line 17). Its assertion now lives in connect-client. The end-to-end `publicOrigin` and `url` assertions elsewhere in that file stay unchanged.

      Checkpoint: run the plugin typecheck and tests.
   5. In `apps/host-daemon/src/connect-tunnel/index.ts`, delete `buildMachineSharePublicOrigin` (lines 112-117). In `resolveOrigin` (line 535), use `machineShareOrigin(identity, port)`, and add it to the line-18 import. In `apps/host-daemon/src/connect-tunnel/connect-tunnel.test.ts`, drop `buildMachineSharePublicOrigin` from the import (line 15) and delete the assertion at lines 147-152. Keep the `buildMachineTunnelUrl` and `resolveTrustedConnectGate` assertions in the same test.

      Checkpoint: run the daemon typecheck and connect-tunnel tests.
4. **Clean up.** No configuration, dependency, asset or documentation change is needed: both consumers already declare `@omnyo/connect-client`. Confirm that no comment still names the deleted functions (`rg -n 'machineSharePublicUrl|buildMachineSharePublicOrigin|sharePublicUrl'` should return nothing).
5. **Review the diff.** Format and lint the changed files, then inspect the full diff. It should touch only the seven files named above. Recount with `git diff --stat` and compare against the baseline numbers in this card.

**Verification and acceptance criteria**

Commands. The package names and their `test` and `typecheck` scripts were read from each `package.json` at the snapshot. The `pnpm --filter` invocation itself was not run, because the snapshot had no `node_modules`.

- From `$OMNYO_CHECKOUT`:
  - `pnpm --filter @omnyo/connect-client typecheck`
  - `pnpm --filter @omnyo/connect-client test`
  - `pnpm --filter omnyo-plugin-connect typecheck`
  - `pnpm --filter omnyo-plugin-connect test`
  - `pnpm --filter @omnyo/host-daemon typecheck`
  - `pnpm --filter @omnyo/host-daemon test -- src/connect-tunnel`. The path argument follows the usual vitest convention and is unverified for this repository. If it is rejected, run the whole package test script.
- Formatting and lint: the repository has `.oxlintrc.json` and `.oxfmtrc.json`. From `$OMNYO_CHECKOUT`, run `pnpm exec oxlint --fix <changed files>`, then `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`. This sequence comes from the global agent policy for Oxc projects. The plugin and connect-client have no `lint` script of their own. The root `pnpm lint` runs `turbo run lint`.

Acceptance criteria:

- **Contract:** every existing end-to-end assertion stays unedited and passes. That covers `connect.test.ts` (`publicOrigin: "https://sawyer--8000.omnyo.link"` and the share `url` values) and `app.test.tsx`. The new connect-client assertions use literal expected strings, including the `*.localhost` HTTP case and a base with an explicit port.
- **Structure:** `rg -n -e '--\$\{' apps packages plugins --glob '!**/*.test.*'` shows the share format only in `packages/connect-client/src/urls.ts` `formatShareOrigin`. `rg -n 'machineSharePublicUrl|buildMachineSharePublicOrigin|sharePublicUrl' apps packages plugins` returns nothing.
- **UI:** no UI changes. The share URLs shown in the Connect panel are byte-identical, as the unchanged `app.test.tsx` fixtures show. No visual check is needed.
- **Performance:** no measurement is needed. The same string operations run.

**Rollback and stop conditions**

- **Rollback:** the change is a self-contained source commit with no persisted data, no migration and no wire change. Reverting that one commit restores the previous state, and it does not need to touch anything else.
- **Stop if any of the following holds:**
  - Any existing end-to-end share-URL assertion would need its expected value edited. That means the normalization changed, so stop and compare the server and machine builders against the end-state sketch.
  - The Connect plugin has joined `scripts/forkable-plugins.json`. The plugin then cannot import connect-client, and the shared builder would have to come from `@omnyo/plugin-sdk` instead. Re-plan, or drop this item.
  - RF-134 or RF-111 has already restructured the same files. Rebase onto that change and re-check the anchors instead of reapplying line-based edits.
- **Safer smaller alternative:** if a stop condition blocks the plugin edit, consolidate only the two verbatim machine-share copies. Make the daemon call a `machineShareOrigin` in connect-client, and leave the plugin unchanged until the forkability question is settled.
