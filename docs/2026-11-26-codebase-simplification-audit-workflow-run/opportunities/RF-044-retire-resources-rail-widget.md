# RF-044 — Delete the core-hosted `ResourcesRailWidget` fallback that copies the Resources plugin's `overview` schema and polling

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** medium. About 549 handwritten production lines and about 456 test lines leave core. Core also stops holding a copy of an external plugin's RPC schema and polling policy.
- **Confidence:** high on the code facts and on the plugin builds that exist on this machine. Medium on what other hosts run.
- **Readiness:** conditional. The removal condition named in the commit that added the fallback is already met: every Resources build from 0.3.3 on registers its own footer card. One owner check remains before deletion (gate G1 below).
- **Effort:** small. One component and its test go, one branch goes from `PluginSidebarFooterCards`, and two test mocks plus one test case are removed. Expect about an hour with verification.
- **Risk:** low. The only affected installs are hosts running Resources 0.3.2 or older, and none was found. On such a host the footer would lose its Resources reading. The Resources navigation panel and dashboard would keep working.
- **Prerequisites:** gate G1 (owner confirmation). No plugin release is needed.
- **Related or overlapping items:**
  - RF-047 retires the Polish review manifest. That manifest names the deleted files as history, at `apps/app/src/polish-review/polish-review-manifest.ts:1709`, `:1732-1733` and `:8520`.
  - RF-019 covers `tests/qa/sidebar-rail/proof.mjs`. That proof bundles a Resources plugin but does not assert on the native widget.
  - There is no conflict with RF-009 (the provider-usage source).
- **Why it deserves its place:** the widget is a bridge whose stated removal condition has passed. It is dead machinery, not a feature retirement. It is also the only place where core couples to the Resources plugin's private RPC payload.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree path was no longer present when this card was written, so every file was read with `git show e9e1b74c…:<path>` from `$OMNYO_CHECKOUT`.

The subsystem works like this. Plugins can register an `experimental_sidebarFooterCard` slot. The slot's API is in `packages/plugin-sdk/src/app-contract.ts:2629` and its collector is in `packages/plugin-sdk/src/internal/plugin-app-collector.ts:677`. The host renders these cards through `PluginSidebarFooterCards`, which three callers mount:

- `apps/app/src/components/layout/AppFooter.tsx:382` mounts it in the desktop app footer with `placement="footer"`.
- `apps/app/src/components/sidebar/MobileBottomRail.tsx:30` mounts it in the phone bottom rail with `placement="status"`.
- `apps/app/src/components/sidebar/AppSidebar.tsx:309` mounts it in the sidebar with the default placement.

The following facts were observed (Proven by inspection):

1. `apps/app/src/components/sidebar/ResourcesRailWidget.tsx` has 535 lines (counted with `git show e9e1b74c…:apps/app/src/components/sidebar/ResourcesRailWidget.tsx | wc -l`). Its parts are:
   - `overviewSchema` at `:34-70` is a zod copy of the Resources plugin's `overview` response.
   - `useResourcesReading` at `:219-298` calls `sdk.plugins.callRpc({ pluginId: "resources", method: "overview", outputSchema: overviewSchema, … })` at `:228-241`. It uses a 5 s `refetchInterval`, a 6 s timeout, `retry: false` and `gcTime: 0`.
   - The exported `ResourcesRailWidget` is at `:300`.
   - The rendering is `FooterCpuBar`, `FooterHostPicker` and `ResourcesFooterReading` at `:306-535`.
   - Its test, `apps/app/src/components/sidebar/ResourcesRailWidget.test.tsx`, has 409 lines and 12 cases.
2. `apps/app/src/components/plugin/PluginSidebarFooterCards.tsx` (160 lines) is the only production importer, at `:8`. The fallback is computed at `:94-99`:
   ```ts
   const nativeResources =
     placement !== "sidebar" &&
     !sidebarFooterCards.some(isResourcesCard) &&
     navPanels.some((slot) => slot.pluginId === "resources" && slot.id === "resources");
   ```
   The fallback is consulted again at `:103` (`if (cards.length === 0 && !nativeResources) return null;`). It is rendered at `:127-132` as a divider followed by `<ResourcesRailWidget />`. The widget therefore renders only when a plugin with id `resources` registers a `resources` nav panel and no footer card.
3. The fallback was added as a bridge. Private-repository commit `90036f3c05` (2026-10-24, "Show the Resources plugin's footer card once it registers one", in `$ARCHIVED_OMNYO_CHECKOUT`) says: "Resources 0.3.3 registers a single footer card … Until a Resources build with the card is installed, they keep the native Resources reading, so the footer never loses Resources whichever ships first." The widget itself dates from `4834ecc996` (2026-10-17).
4. **The removal condition is met.** This corrects the sweep report. Every Resources build in `~/.omnyo/plugins/local-builds/resources/` registers the card. These builds are versions 0.3.3, 0.3.4, 0.4.0–0.4.4 and 0.5.0, the newest dated 2026-11-01. In each build `app.js` contains `e.slots.experimental_sidebarFooterCard?.({id:"footer",component:…})` next to `navPanel({id:"resources",…})`. The 0.5.0 README says the reading "appears only on hosts that mount Resources' `experimental_sidebarFooterCard`". Only the stale 0.3.1 copies lack the card: `~/.omnyo/plugins/resources-ui-rwm3ijg2ei` and `~/.omnyo/plugins/cutover-sources/resources`, both dated 2026-10-31. The sweep examined one of those copies.
5. **Resources is not installed on the owner's main host.** A read-only query of `~/.omnyo/app.db` (`select … from plugins where id like '%resour%'`) returned no row, not even a removed one. The plugin's data directory `~/.omnyo/plugins/resources/` was last written on 2026-11-01 (its log) and 2026-11-09 (`data.db-shm`). The sweep's claim that "the fallback is live for Alex today" does not hold on this host.
6. **Resources is not distributed by anything in the repositories checked.**
   - It is not a builtin. `apps/server/test/services/plugins/builtin-registry.test.ts:124-134` asserts that a fresh install has no `resources` plugin. `packages/omnyo-app/scripts/smoke-boot.mjs:17` and `smoke-tarball.mjs:30` list it only as "expected disabled if present".
   - The official marketplace manifest cached in `app.db` (`plugin_marketplaces.name = 'omnyo-official'`, 63 plugins) has no entry for it.
   - It has no source in `plugins/` at the snapshot. `git -C $ARCHIVED_OMNYO_CHECKOUT log --all -- plugins/resources` shows no history, and `$OMNYO_PLUGIN_CHECKOUT` has no copy.
   - The package is `bb-plugin-resources`, `"private": true`, with `engines.bb` and `engines.bbPluginSdk`. Legacy engines are still accepted through `apps/server/src/services/plugins/legacy-npm-plugin-engines-v1.ts`, so a hand-installed old build could still load.
7. Other references at the snapshot were found with `git grep -n -e ResourcesRailWidget -e data-resources-rail -e rail-overview -e '"resources"' e9e1b74c…`:
   - `apps/app/src/components/plugin/PluginSidebarFooterCards.test.tsx:39-41` mocks the widget, and the case at `:144-183` ("keeps the native Resources reading until the Resources plugin registers its footer card") encodes the fallback.
   - `apps/app/src/components/layout/AppFooterSidebarCell.test.tsx:39-41` mocks the widget as `null`.
   - The Ladle story `apps/app/src/components/sidebar/SidebarShell.stories.tsx:105-120` registers nav panels from `SHELL_STORY_NAV_PANELS` (`apps/app/.ladle/sidebar-shell-fixtures.ts:602-608`), which include `resources/resources`, without a footer card. The `sidebar--shell--*` stories therefore mount the native widget today.
   - The Polish review manifest entries are listed under item 9.
   - `docs/api_to_audit.md:3197-3201` describes "the native Resources reading".
   - Nothing else references the widget. `data-resources-rail` (widget `:404`) and the query key `["plugins","resources","rail-overview"]` have no other users.
8. The CSS class strings in `AppFooter` and `MobileBottomRail` stay correct after the deletion. The group `aria-label="Live usage and resources"` (`PluginSidebarFooterCards.tsx:116-118`) still applies to the usage and Resources plugin cards.
9. The Polish review manifest names the widget files at `apps/app/src/polish-review/polish-review-manifest.ts:1709`, `:1732-1733` and `:8520`. No test checks that those file paths exist: `git grep -n existsSync` over `apps/app/src/polish-review/` found nothing, and the manifest's only importer is `PolishReview.stories.tsx`.

**Maintenance cost today.** Any change to the Resources `overview` payload needs a matching core edit to `overviewSchema`. If a field is renamed, `outputSchema` fails parsing and the footer shows "No data". Core also carries a second, older design of the Resources reading: a per-machine CPU bar and a host picker. That design no longer matches the plugin's own card, which shows "Idle" or job counts and opens a details popover. Both designs keep their own Polish review history and tests.

**Counterevidence and remaining uncertainty.** This is a Hypothesis: a host other than this Mac may run Resources 0.3.2 or older. Candidates are the 3090 PC, a connected MacBook worker clones, or a hand-installed copy. That was not checked, because those machines are outside this read-only audit. On such a host the footer would lose its Resources reading after this change, and the Resources dashboard panel would stay.

**Rejected part of the sweep proposal.** The sweep also proposed replacing the hard-coded id checks `isUsageCard` (`omnyo--account-usage/usage`, `:37-39`), `isResourcesCard` (`:41-43`) and `isSidebarFilterCard` (`chat-topics/tag-filter`, `:45-47`) with an SDK placement hint. That change adds a public SDK contract rather than removing dead machinery. It needs a design decision and a plugin-SDK minimum-version bump, so it is not part of this card. `isResourcesCard` must stay after this change, because it still routes the plugin's own card into the footer group instead of the sidebar (`cardsForPlacement`, `:60-67`).

**Proposed end state and preservation argument**

After the change:

- The following disappear: `ResourcesRailWidget.tsx` and its test, the `nativeResources` computation and render branch in `PluginSidebarFooterCards`, the two `vi.mock("@/components/sidebar/ResourcesRailWidget", …)` blocks, and the fallback test case.
- `PluginSidebarFooterCards` renders only registered plugin cards. Its early return becomes `if (cards.length === 0) return null;`.
- `isUsageCard`, `isResourcesCard`, `isSidebarFilterCard`, `cardsForPlacement`, `PluginFooterCenterCards`, `PluginFooterSidebarCards`, the placement classes and the divider stay unchanged.
- The Resources plugin owns its reading entirely, including the schema, the polling and the UI. Core keeps no knowledge of the Resources RPC.

Preservation by case:

- **Resources 0.3.3 or newer installed.** No visible change. `isResourcesCard` already suppressed the native widget whenever the plugin registered any footer card, so this path never rendered it.
- **Resources not installed.** No visible change. `nativeResources` required a `resources/resources` nav panel.
- **Resources 0.3.2 or older installed.** The footer loses the native reading. This is the only behavior change, and gate G1 decides whether it is acceptable. The plugin's nav panel and dashboard are unaffected. The fix for such a host is to update the plugin.
- **Ladle `sidebar--shell--*` stories.** The footer no longer shows the old Resources reading, because the story fixture registers only a nav panel. This is a story-fixture change, not a product change. Optionally, register a stub Resources footer card in `SidebarShell.stories.tsx` if the story should keep showing a Resources slot.

Non-goals:

- No change to the plugin SDK or to the `experimental_sidebarFooterCard` contract.
- No SDK placement hint for usage, chat-topics or Resources.
- No change to the Polish review manifest's historical entries, which RF-047 owns.
- No change to `tests/qa/sidebar-rail/proof.mjs`, which RF-019 owns.

**Expected gain and cost**

These are projections from line counts at the snapshot, not measurements:

| Item | Lines removed | Category |
|---|---|---|
| `apps/app/src/components/sidebar/ResourcesRailWidget.tsx` | 535 | production |
| `PluginSidebarFooterCards.tsx`: import `:8`, `:94-100`, `:127-132`, condition at `:103` | about 14 | production |
| `apps/app/src/components/sidebar/ResourcesRailWidget.test.tsx` | 409 | test |
| `PluginSidebarFooterCards.test.tsx`: `:39-42` and `:144-184` | about 45 | test |
| `AppFooterSidebarCell.test.tsx`: `:39-42` | about 4 | test |
| `docs/api_to_audit.md:3197-3201` wording | 0 net (reword) | docs |

The change removes about 549 production lines and about 458 test lines, and adds no lines.

What gets easier to maintain:

- A Resources payload change becomes a plugin-only release.
- One Resources footer design exists instead of two.
- One fewer 5 s polling query exists in core. It ran only on old-plugin hosts, so the performance effect for current installs is neutral.
- The cost is the gate-G1 risk described above.

**Execution steps**

1. **Gate G1: owner confirmation.** This is an investigation gate and must pass before any edit. Ask the owner to confirm one of two things: that no host he supports runs the Resources plugin below 0.3.3, or that losing the footer reading on such a host is acceptable because its owner can update the plugin. Optionally, he can check each enrolled host with `omnyo` CLI plugin listing. The exact subcommand is unverified: use the `omnyo-cli` skill to find it. If Alex names a host that needs the old path, stop: see Rollback and stop conditions.
2. **Reconfirm the anchors.** On the working branch, run `git grep -n -e ResourcesRailWidget -e data-resources-rail -e rail-overview` and confirm that the only hits are the files listed in Context items 2, 7 and 9. Confirm that `PluginSidebarFooterCards.tsx` still contains `nativeResources`. If a new production importer of `ResourcesRailWidget` appears, or the widget gained a second caller such as a mobile or desktop shell, stop and re-plan.
3. **Edit `apps/app/src/components/plugin/PluginSidebarFooterCards.tsx`** in the function `PluginSidebarFooterCards`:
   - Remove the import at `:8`.
   - Remove the `nativeResources` constant at `:94-99`.
   - Change `usePluginSlots()` destructuring at `:92` to `const { sidebarFooterCards } = usePluginSlots();`, because `navPanels` becomes unused.
   - Change `:103` to `if (cards.length === 0) return null;`.
   - Remove the `{nativeResources ? (…) : null}` block at `:127-132`.
   - Leave every other symbol untouched.
4. **Delete** `apps/app/src/components/sidebar/ResourcesRailWidget.tsx` and `apps/app/src/components/sidebar/ResourcesRailWidget.test.tsx`. Both are clean tracked files, so name them in the report.
5. **Update the tests:**
   - In `apps/app/src/components/plugin/PluginSidebarFooterCards.test.tsx`, remove the `vi.mock` at `:39-41` and the case at `:144-183`. Keep every other case, especially `:185-231` (phone rail order) and `:233` onward (placement and footer grouping), because they cover the surviving placement contract.
   - Add one small replacement assertion to an existing case, or as a new case: when only a `resources/resources` nav panel is registered and no footer card, `PluginSidebarFooterCards placement="footer"` renders nothing (`container` is empty). This pins the intended new behavior.
   - In `apps/app/src/components/layout/AppFooterSidebarCell.test.tsx`, remove the `vi.mock` at `:39-41`.
6. **Update the docs.** In `docs/api_to_audit.md:3197-3201`, replace both phrases "the native Resources reading" with wording that the Resources plugin's own footer card follows the usage card. Leave the Polish review manifest alone (RF-047).
7. **Optional story fixture.** If the reviewer wants the `sidebar--shell--*` stories to keep a Resources slot, add a `sidebarFooterCards: [{ id: "footer", component: <static stub> }]` entry for `resources` in `shellPluginRegistrations` in `apps/app/src/components/sidebar/SidebarShell.stories.tsx`. Otherwise leave the fixture as it is and note the story change.
8. **Format, lint and recount.** Run the formatter on the changed files, then run the checks below. Inspect the full diff for unrelated edits. Recount with `git diff --stat` against the base commit and confirm about 549 production and about 458 test lines removed.

**Verification and acceptance criteria**

The snapshot has no `node_modules`, so these commands were not run for this card. The script names come from `apps/app/package.json` (`test`: `vitest run --config vitest.config.ts`; `typecheck`; `lint`) and from the root `package.json` (`format:check`: `oxfmt . --check`).

- Targeted tests. From `apps/app` (or the lane's `apps/app`), run `pnpm exec vitest run --config vitest.config.ts src/components/plugin/PluginSidebarFooterCards.test.tsx src/components/layout/AppFooterSidebarCell.test.tsx src/components/layout/AppFooter.test.tsx`. This is the package's own `test` script with file filters. Expect them to pass, including the new "nav panel only renders nothing" assertion. `AppFooter.test.tsx:382` still finds the "Live usage and resources" group, because it registers a usage card.
- Typecheck. From `apps/app`, `pnpm typecheck` must report no errors. This catches the unused `navPanels` and any dangling import.
- Lint and format. From `apps/app`, run `pnpm lint`. From the repository root, run `pnpm exec oxfmt <changed files>` and then `pnpm format:check`.
- Structural completion. `git grep -n -e ResourcesRailWidget -e data-resources-rail -e rail-overview -e nativeResources` returns hits only in `apps/app/src/polish-review/polish-review-manifest.ts`, which is historical and owned by RF-047. `git grep -n 'pluginId: "resources"' apps/app/src` shows no RPC call to the Resources plugin.
- UI check (manual; Alex tests UI himself). On a host with Resources 0.3.3 or newer installed, the desktop footer and the phone bottom rail show the usage card, a divider, then the Resources plugin card, the same as before. On a host without Resources, nothing changes. A screenshot cannot verify the focus order or tooltips of the plugin card, but this change does not touch them.
- Ladle (optional). From `apps/app`, `pnpm storybook` serves the `sidebar--shell--inbox` story. Confirm that the footer renders without errors. The Resources reading is absent unless step 7 added a stub.

**Rollback and stop conditions**

- **Rollback.** The change is one self-contained commit. Reverting it restores the widget, the branch and the tests. No persisted data, settings keys, migrations or SDK exports are involved.
- **Stop if gate G1 fails.** If Alex names a supported host that must keep Resources below 0.3.3, keep the fallback. The safer alternative is to update that host's Resources plugin to 0.3.3 or newer first, then run this card.
- **Stop if a new consumer appears.** Stop if step 2 finds a new consumer of `ResourcesRailWidget` or of its query key, or finds that `PluginSidebarFooterCards` gained other logic that depends on `navPanels`. Re-plan in that case.
- **Stop if the plugin card goes away.** Stop if a newer Resources build (beyond 0.5.0) has dropped `experimental_sidebarFooterCard`, which is unlikely given its README. Check its `app.js` with `rg experimental_sidebarFooterCard`. In that case the bridge would be live again, and the decision returns to the owner.
