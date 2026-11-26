# RF-011 — Retire the 13 unselected landing-lab design variants, their registry entries, three.js, five lab-only font packages and `/model.glb`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** high. This is the largest single block of handwritten code in the audit that nothing in production reaches: 57,328 lines (25,084 TS/TSX and 32,244 CSS) across 79 files. It also removes 1.77 MB of binary assets and seven dependency declarations.
- **Confidence:** high on reachability and counts. Proven by inspection and by a reachability script over the snapshot (described in Context).
- **Readiness:** decision-needed. The lab is a deliberate design workspace that still runs in development. Alex, as the product and design owner, must confirm the keep-list: which of the 13 variant slugs, if any, should stay. The default proposal is to retire all 13.
- **Effort:** small. About 2 to 4 hours after the keep-list is known: delete directories, edit two registry files, `apps/web/package.json`, the lockfile (through `pnpm install`) and the image test, then run the web checks below.
- **Risk:** low for users, because both lab routes answer 404 in production. The remaining risks are deleting a file the homepage imports (guarded by the reachability check) and removing the publicly served `https://omnyohq.com/model.glb` (see Rollback and stop conditions).
- **Prerequisites:** the owner's keep-list. No code prerequisite.
- **Related and overlapping:**
  - **RF-028** (move the live homepage out of `src/lab` and drop the Open 5 and Combined A standalone previews). RF-028 owns `combined-a/page.tsx` (339 lines) and `combined-a/content.ts` (141 lines); this card does not count them. `app-mock/glide.ts` (182 lines) is shared: `eclipse-4/page.tsx:22` (this card) and `combined-a/page.tsx:15` (RF-028) are its only importers, so it is deleted by whichever of the two lands second and is counted once, under RF-028. The two cards touch the same `designs.ts` and `lab.index.tsx`, so land them sequentially, not in parallel branches.
  - **RF-133** (drop dependency declarations with no consumer). RF-133 owns `@fontsource-variable/playfair-display`, `@fontsource-variable/space-grotesk`, `@fontsource/ibm-plex-mono` and `@fontsource/syne` in `apps/web/package.json`, which have no consumer anywhere, including the lab. This card removes only the seven declarations whose sole consumers are the 13 variants. If both land in one branch, regenerate the lockfile once.
- **Why it deserves its place:** every site-wide edit currently has to compile, and often be repeated in, 13 dead preview pages. The variants carry their own three.js scenes, shaders, copy and download buttons, and they typecheck and build on every website release.

**Context and evidence**

Snapshot: `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The local `main` checkout had diverged from it at audit time (3 local commits, 13 commits behind), so start from a fresh `origin/main`.

The public website (`apps/web`, package `@omnyo/web`) is a TanStack Start app served at `https://omnyohq.com`. `apps/web/src/lab` began on 2026-11-16 as a "landing lab" of homepage concepts (private-store commit `f217290deb`, "Add a landing lab with eight Omnyo landing page concepts"). The homepage decision has since been made: `apps/web/src/routes/index.tsx:5-6` imports `QUESTIONS` and the default `LandingPage` from `../lab/combined-a-v2/`.

Observed facts (Proven by inspection unless noted):

- `apps/web/src/lab/designs.ts:11-131` `LAB_DESIGNS` registers 17 previews, each loaded with a dynamic `import()`. `LabDesign.group` (`designs.ts:5`) is the union `"open" | "cinematic-o" | "eclipse" | "combined" | "tools"`.
- `apps/web/src/lab/lab-access.ts:3-5` `requireLabPreview` throws `notFound()` when `import.meta.env.PROD`. Both lab routes use it as `beforeLoad`: `apps/web/src/routes/lab.index.tsx:7` (route `/lab/`) and `apps/web/src/routes/lab.$design.tsx:8` (route `/lab/$design`). `lab.$design.tsx:9-15` throws `notFound()` for an unknown slug. `apps/web/src/lab/lab-access.test.ts` covers the production guard.
- `apps/web/src/routes/lab.index.tsx:17-23` `GROUPS` lists one heading per group. After this change the `cinematic-o` and `eclipse` groups would have no entries.
- The 13 variant directories are `open-1`, `open-2`, `open-3`, `open-4`, `o-1`, `o-2`, `o-3`, `eclipse-1` through `eclipse-5` and `combined-b`. Their registry entries are `designs.ts:12-39` (open-1 to open-4), `designs.ts:47-102` (o-1 to eclipse-5) and `designs.ts:117-123` (combined-b).
- **Reachability (Reproduced with a script).** A Node script walked static `import`/`export from`, side-effect imports, dynamic `import()`, CSS `@import` and `url()`, `new URL(..., import.meta.url)` and `import.meta.glob` patterns, resolving relative and `@/` paths. Its entry points were every file in `apps/web/src` outside `src/lab/` and outside `routes/lab.*`, excluding tests. Edges into the two lab route files, which reach the lab only through `routeTree.gen.ts`, were cut. Result: 24 of the 114 files under `src/lab` are reachable from production: all of `combined-a-v2/` except its test, `open-5/{page.tsx,content.ts,story.ts,particles.ts,disc-frames.ts,tones.ts,styles.css,chrome-extras.css}`, `combined-a/styles.css` and `app-mock/{app-mock.tsx,app-mock.css}`. None of the 79 files in the 13 variant directories is reachable. The glob consumers are `features/features.ts`, `compare/comparisons.ts`, `guides/guides.ts`, `plugin-guide/plugin-directory.ts`, `explore/marketplace-detail.server.ts`, `landing/*-links.ts`, `features/visuals/index.tsx` and `lab/visuals/page.tsx`; none of their patterns matches the lab variants.
- **No cross-imports.** `rg -n "\.\./(open-[1-4]|o-[1-3]|eclipse-[1-5]|combined-b)/" apps/web/src`, excluding `designs.ts`, returns nothing. The variants never import each other, and nothing else imports them. Their imports outside their own directories are `../../landing/site` (`BB_URL` and `MACOS_DOWNLOAD_URL`, both still used by live code such as `landing/site-chrome.tsx`) and, from `eclipse-4/page.tsx:21-22` only, `../app-mock/app-mock` (still used by the homepage) and `../app-mock/glide`. Deleting the variants therefore orphans no live module except `glide.ts`, which RF-028 handles.
- **Repository-wide string search.** `rg -n --hidden "src/lab|lab/(open|o-|eclipse|combined|app-mock|visuals)|combined-b|model\.glb|lens-o|landing lab|landing-lab"` over the whole snapshot, excluding `apps/web/src/lab/**` and `pnpm-lock.yaml`, found only the lab routes, the homepage imports, five `features/visuals/*.visual.tsx` imports of `lab/app-mock/app-mock`, and `apps/landing/scripts/chibistack-test.mjs:800`. A second search for a quoted `/lab` path found only the lab routes and `apps/web/src/analytics/error-event.ts:39`, where `ROUTE_SECTIONS` includes `"lab"`. That entry stays while the lab routes exist. No doc, config file, Containerfile or `.containerignore` names a variant.
- **three.js.** `rg -l "from ['\"]three|['\"]three/"` over the whole snapshot lists 14 files, all in the 13 variants. `apps/web/package.json:41` `three` and `:49` `@types/three` are the only declarations in any workspace `package.json`.
- **Fonts.** `@fontsource-variable/fraunces` (`package.json:18`, used by open-4), `@fontsource-variable/inter-tight` (`:22`, used by open-1 to open-3, o-1 to o-3 and eclipse-1 to eclipse-4), `@fontsource-variable/jetbrains-mono` (`:23`, used by open-2), `@fontsource-variable/jost` (`:24`, used by eclipse-2) and `@fontsource/instrument-serif` (`:28`, used by open-1, o-1 to o-3 and eclipse-2 to eclipse-5). A repository-wide search for these five names outside `apps/web/src/lab/**` and the lockfile finds only `apps/web/package.json`.
- **`/model.glb`.** `apps/web/public/model.glb` (797,864 bytes) is loaded by 10 variant files and by nothing else: `open-2/orb.tsx:169`, `open-3/orbit.tsx:644`, `o-1/eclipse-scene.tsx:543`, `o-3/stage.tsx:766`, `eclipse-1/eclipse-scene.tsx:404`, `eclipse-2/eclipse-scene.tsx:777`, `eclipse-3/eclipse-scene.tsx:569`, `eclipse-4/eclipse-scene.tsx:651`, `eclipse-5/eclipse-scene.tsx:624` and `combined-b/engine.ts:549`. Because it sits in `public/`, production serves it at `https://omnyohq.com/model.glb` even though no production page requests it. The website image test asserts it: `apps/landing/scripts/chibistack-test.mjs:797-803` lists `"/model.glb"` as the third entry of `files`, and `:810-813` asserts `responses.at(2)` has content type `model/gltf-binary`. `apps/web/server.mjs:26` maps `.glb` to `model/gltf-binary` as a generic content type.
- **Other assets.** `o-2/lens-o-mesh.bin` (843,181 bytes, read by `o-2/lens-model.ts:3` through a `?url` import) and `o-2/lens-o.webp` (126,480 bytes, `o-2/page.tsx:11`). Together with `model.glb` that is 1,767,525 bytes.
- **Tests.** None of the 13 variant directories contains a test. The four lab tests (`lab-access.test.ts`, `combined-a-v2/beat-stepper.test.ts`, `open-5/disc-frames.test.ts`, `open-5/tones.test.ts`; 499 lines) all stay.
- **Build inclusion.** `apps/web/tsconfig.json` includes all of `src`, so `tsc --noEmit` checks every variant. `apps/landing/Containerfile:22` runs `pnpm exec vite build` over the whole app, and the dynamic imports in `designs.ts` make Vite emit every variant chunk and asset into `dist`, which `Containerfile:28` copies into the production image.
- **Maintenance burden observed.** Private-store commit `dcace223e0` (2026-11-24, "Separate weekly installation counts from opt-in product analytics") edited copy in 12 lab pages. Nine of them belong to this card's variants (`combined-b`, `eclipse-1` to `eclipse-5`, `o-1`, `open-2`, `open-4`). In the public history, the variants appear only in the import commit `ff501adc9` (2026-11-24), while `combined-a-v2` and `open-5` kept receiving homepage work (for example `85c55e838`, 2026-11-25).

Counterevidence and assumptions:

- The lab is a supported development tool. `/lab/visuals` ("Feature visuals") is an active working tool that stays. The variants may still serve as design references. The repository holds no evidence of which ones Alex still compares, which is why this card needs the keep-list.
- The prior Codex audit (2026-11-25, §20) measured only the six scene components (5,466 lines). The actual scope is the 13 full variant directories.
- Hypothesis: nothing outside this repository links to `https://omnyohq.com/model.glb`. The repository cannot prove this; see the stop conditions.

Per-variant scope, for building a partial keep-list (line counts from `cat <files> | wc -l` per directory and extension):

| Slug | TS/TSX lines | CSS lines | Uses three | Loads `/model.glb` | Lab-only fonts |
|---|---:|---:|---|---|---|
| open-1 | 1,300 | 1,943 | yes | no | instrument-serif, inter-tight |
| open-2 | 2,587 | 4,039 | yes | yes | inter-tight, jetbrains-mono |
| open-3 | 1,906 | 2,651 | yes | yes | inter-tight |
| open-4 | 1,189 | 2,611 | yes | no | fraunces |
| o-1 | 1,734 | 2,313 | yes | yes | instrument-serif, inter-tight |
| o-2 | 1,792 | 1,967 | yes | no (own 969,661-byte .bin and .webp) | instrument-serif, inter-tight |
| o-3 | 1,819 | 2,025 | yes | yes | instrument-serif, inter-tight |
| eclipse-1 | 1,653 | 1,550 | yes | yes | inter-tight |
| eclipse-2 | 2,117 | 2,757 | yes | yes | instrument-serif, inter-tight, jost |
| eclipse-3 | 1,842 | 2,590 | yes | yes | instrument-serif, inter-tight |
| eclipse-4 | 1,569 | 1,702 | yes | yes | instrument-serif, inter-tight |
| eclipse-5 | 2,270 | 2,176 | yes | yes | instrument-serif |
| combined-b | 3,306 | 3,920 | yes | yes | none |
| **Total** | **25,084** | **32,244** | | | |

**Proposed end state and preservation argument**

After the change, `apps/web/src/lab` holds the live homepage modules (`combined-a-v2`, `open-5`, `combined-a`, `app-mock`), the Feature visuals tool (`visuals`), `designs.ts`, `lab-access.ts` and any variants on the keep-list. `LAB_DESIGNS` lists only those entries. The `LabDesign.group` union and `GROUPS` in `lab.index.tsx` drop every group left without entries (with no variant kept, `cinematic-o` and `eclipse`). `apps/web/package.json` drops `three`, `@types/three` and the five lab-only font packages, unless a kept variant still imports one of them. `apps/web/public/model.glb` and its two image-test assertions go, unless a kept variant loads it. No three.js remains in the website when no variant is kept.

What is preserved:

- **Homepage and public site:** nothing they import changes. The reachability proof above shows that no live file depends on the deleted directories. `routes/index.tsx`, `combined-a-v2`, `open-5`, `combined-a/styles.css` and `app-mock/app-mock.*` are untouched.
- **Lab routes:** `/lab/` and `/lab/$design` keep their production 404 guard and their development behavior. A retired slug in development now hits the existing unknown-slug `notFound()` in `lab.$design.tsx:12`. `routeTree.gen.ts` does not change, because no route file is added or removed.
- **Feature visuals tool:** `lab/visuals/page.tsx` globs `../../features/visuals/*.visual.tsx` and does not depend on any variant.
- **Image contract:** every other image-test assertion stays: the hashed asset, `/logo.png` content type, `/releases/latest.json`, `/og.png`, the immutable cache header and the non-empty bodies. `apps/web/server.mjs:26` keeps its generic `.glb` content-type mapping. It is a one-line table entry, not machinery, and keeping it avoids touching the server.

The only intentional observable change is that `https://omnyohq.com/model.glb` returns 404 after the next website release. No product page requests it.

Non-goals: no change to the homepage, the Feature visuals, the open-5 shell or the Combined A preview (RF-028); no removal of the lab routes or `lab-access.ts`; no removal of dependencies that have no consumer at all (RF-133); no website deployment.

**Expected gain and cost**

- **Handwritten production code removed (measured):** 25,084 TS/TSX and 32,244 CSS lines in 77 source files, plus about 95 lines of registry entries in `designs.ts` (13 entries of 7 lines each) and `lab.index.tsx` (2 group rows). Total about 57,420 lines. Lines added: about zero (a narrowed union). Each kept variant subtracts its table row.
- **Shared, counted under RF-028:** `app-mock/glide.ts`, 182 lines.
- **Tests:** none removed. **Generated code:** `pnpm-lock.yaml` shrinks through regeneration. Do not count it. The transitive packages that only `@types/three` pulls in (`@dimforge/rapier3d-compat`, `@tweenjs/tween.js`, `@types/stats.js`, `@types/webxr`, `@webgpu/types`, `fflate@0.8.3`, `meshoptimizer`) should drop out of the lockfile.
- **Assets:** 1,767,525 bytes (`model.glb`, `lens-o-mesh.bin` and `lens-o.webp`).
- **Dependencies:** 7 declarations in `apps/web/package.json` (`three`, `@types/three` and 5 font packages).
- **Mechanisms before and after:** before, 17 registered previews, 13 independently maintained three.js scenes with their own shaders, one GLB asset asserted by a release-gate test, and 13 font families. After, 4 registered previews (`open-5`, `combined-a`, `combined-a-v2` and `visuals`; 2 after RF-028), no three.js and 8 font families declared (4 after RF-133).
- **Maintenance effect:** a site-wide change to copy, download buttons, analytics wording, shared-ui tokens or the TypeScript and Vite versions today must compile in, and often be applied to, the 13 dead pages, as `dcace223e0` showed with 9 variant pages. Afterwards only live pages take part. A three.js or Tailwind major upgrade no longer has to account for 14 scene files that no visitor runs.
- **Performance:** visitor page weight is unchanged, because production never requests the variant chunks. Projected and unmeasured: a shorter `vite build` and `tsc --noEmit` for `@omnyo/web`, a smaller `dist/client` and image without the variant chunks, three.js and the 1.77 MB of binaries, and a smaller `pnpm install` for the web filter. Measure before claiming any of these.
- **Cost:** about 2 to 4 hours, plus the owner's keep-list decision.

**Execution steps**

1. **Decision gate (blocking).** Ask the owner for the keep-list: which of `open-1`, `open-2`, `open-3`, `open-4`, `o-1`, `o-2`, `o-3`, `eclipse-1` to `eclipse-5` and `combined-b` should stay as development previews. The default proposal is none. Record the answer in the commit message. If Alex wants to keep all 13, stop: this card does not apply.
2. **Reconfirm the baseline on a fresh `origin/main`** in a named branch in a linked worktree. Check that:
   - `apps/web/src/routes/index.tsx` still imports only `../lab/combined-a-v2/*` from the lab;
   - `rg -n "\.\./(open-[1-4]|o-[1-3]|eclipse-[1-5]|combined-b)/" apps/web/src` hits only `apps/web/src/lab/designs.ts`;
   - `rg -n "lab/(open-[1-4]|o-[1-3]|eclipse-[1-5]|combined-b)" . --glob '!apps/web/src/lab/**' --glob '!pnpm-lock.yaml'` hits nothing;
   - `rg -n "model\.glb" . --glob '!apps/web/src/lab/**'` hits only `apps/landing/scripts/chibistack-test.mjs`.
   If a live (non-lab) file now imports a variant, or a new consumer of `/model.glb` exists, re-plan. Record the baselines: `pnpm --filter @omnyo/web typecheck` and `pnpm --filter @omnyo/web test` should pass. If time allows, also record the wall time of `pnpm --filter @omnyo/web build` and `du -sk apps/web/dist/client`.
3. **Checkpoint A: the registry.** In `apps/web/src/lab/designs.ts`, delete the `LAB_DESIGNS` entries for each retired slug (at the snapshot, lines 12-39, 47-102 and 117-123). Remove `"cinematic-o"` and `"eclipse"` from the `LabDesign.group` union when no kept entry uses them. In `apps/web/src/routes/lab.index.tsx`, delete the matching `GROUPS` rows (`{ id: "cinematic-o", ... }` and `{ id: "eclipse", ... }`, lines 19-20 at the snapshot). Keep the `"open"` group, which still holds `open-5`.
4. **Checkpoint B: the directories.** `git rm -r` each retired directory under `apps/web/src/lab/`. If `apps/web/src/lab/combined-a/page.tsx` no longer exists (RF-028 has landed) and `eclipse-4` is retired, also `git rm apps/web/src/lab/app-mock/glide.ts`. Otherwise leave it, because `combined-a/page.tsx:15` imports it. Run `pnpm --filter @omnyo/web typecheck`. It must pass before you continue.
5. **Checkpoint C: dependencies.** For each of `three`, `@types/three`, `@fontsource-variable/fraunces`, `@fontsource-variable/inter-tight`, `@fontsource-variable/jetbrains-mono`, `@fontsource-variable/jost` and `@fontsource/instrument-serif`, confirm with `rg -n "<name>" apps/web/src apps/web/scripts apps/web/server.mjs` that no kept file uses it. Then remove its line from `apps/web/package.json`. Do not touch other font packages here (RF-133 owns the unused ones). From the repository root, run `pnpm install` to regenerate `pnpm-lock.yaml`. This needs network access to the registry. Never hand-edit the lockfile. Then run `pnpm install --frozen-lockfile` to confirm the lockfile is consistent, because `apps/landing/Containerfile:12` installs with `--frozen-lockfile --filter '@omnyo/web...'`.
6. **Checkpoint D: `/model.glb` and the image test.** Only if no kept variant loads `/model.glb` (see the table): `git rm apps/web/public/model.glb`. In `apps/landing/scripts/chibistack-test.mjs`, remove the `"/model.glb",` element of `files` (line 800) and the `assert.match(responses.at(2)...` block that expects `/^model\/gltf-binary/` (lines 810-813). The remaining index-based assertions (`responses.at(0)` for the cache header, `responses.at(1)` for the PNG content type) keep their positions, because only later elements shift. Leave `apps/web/server.mjs` unchanged.
7. **Format and lint the changed files.** Run `pnpm exec oxfmt apps/web/src/lab/designs.ts apps/web/src/routes/lab.index.tsx apps/web/package.json apps/landing/scripts/chibistack-test.mjs` and `pnpm exec oxlint --deny-warnings apps/web/src/lab/designs.ts apps/web/src/routes/lab.index.tsx apps/landing/scripts/chibistack-test.mjs`.
8. **Inspect the diff.** Expect only deletions under `apps/web/src/lab/<retired>/`, the registry edits, `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/public/model.glb` and the image test. `routeTree.gen.ts` must not change. Recount with `git diff --numstat origin/main -- apps/web/src/lab apps/web/src/routes` and compare with the table.

**Verification and acceptance criteria**

Run from the repository root unless stated otherwise. The scripts below were read from `apps/web/package.json:6-13` and the root `package.json`. They were not executed during the audit, because the snapshot had no `node_modules`.

- `pnpm --filter @omnyo/web typecheck` (runs `tsc --noEmit`): passes.
- `pnpm --filter @omnyo/web test` (runs `vitest run --config vitest.config.ts`): passes, including `src/lab/lab-access.test.ts`, `src/lab/combined-a-v2/beat-stepper.test.ts`, `src/lab/open-5/disc-frames.test.ts` and `src/lab/open-5/tones.test.ts`.
- `pnpm --filter @omnyo/web build` (runs `vite build`): passes. `rg -l "WebGLRenderer|GLTFLoader" apps/web/dist/client` finds no three.js chunk when no variant is kept. Expect a smaller `du -sk apps/web/dist/client` than the baseline from step 2.
- **Image test against the local build**, using the recipe in `apps/landing/README.md` ("Develop and test"): copy `apps/web/dist`, `apps/web/server.mjs` and `apps/landing/scripts/chibistack-test.mjs` (as `test.mjs`) into one scratch folder, then run `SITE_TEST_ROOT=<folder> SITE_TEST_PORT=<free port> node <folder>/test.mjs`. It must pass. The recipe comes from the README and was not executed during this audit.
- **Development behavior:** run `pnpm --filter @omnyo/web dev` and open the port Vite prints:
  - `/` renders the same homepage as on `origin/main`;
  - `/lab/` lists only the kept groups and entries, with no empty headings;
  - `/lab/visuals`, `/lab/combined-a-v2`, `/lab/open-5` and `/lab/combined-a` still load;
  - `/lab/<retired slug>` renders the not-found page.
  Alex checks UI himself, so a manual look is enough. No screenshot rounds are required, because no live page changes.
- **Structural completion:**
  - `rg -l "from ['\"]three" apps/web` returns nothing (if no variant is kept);
  - `rg -n "\"three\"|@types/three|fraunces|inter-tight|jetbrains-mono|fontsource-variable/jost|instrument-serif" apps/web/package.json` returns nothing;
  - `rg -n "model\.glb" .` returns nothing outside kept variants;
  - `LAB_DESIGNS` has no entry whose directory is gone;
  - the `group` union has no value without an entry.
- **Production guard:** unchanged. `lab-access.test.ts` covers it.

**Rollback and stop conditions**

- **Rollback:** the change is a self-contained deletion commit (or one commit per checkpoint). `git revert` restores the directories, assets, registry entries, dependency lines and lockfile together. No persisted data, migration or public API is involved. A deployed website keeps serving the previous image until the next release, and the host keeps the previous image for rollback (`apps/landing/README.md`, "Release").
- **Stop and re-plan if:**
  - Alex wants to keep a variant: keep its directory, registry entry, its fonts and three.js from the table, and `/model.glb` if it loads it.
  - A live (non-lab) file imports a variant or `glide.ts` at the new baseline.
  - A new consumer of `/model.glb` appears in the repository.
  - `pnpm install` changes unrelated packages in the lockfile. In that case, isolate the dependency edit or rebase onto a clean lockfile.
- **`/model.glb` external-link check (optional, Hypothesis):** the repository cannot show whether anything outside it fetches `https://omnyohq.com/model.glb`. If Alex wants certainty, read the website host's access logs for that path through the read-only routes in `~/.agents/docs/coolify.md` and `~/projects/chibistack/AGENTS.md` before step 6. If the logs show real traffic, keep `public/model.glb` and its image-test assertions and retire only the code. That costs nothing in maintenance, because it is a static file.
- **Release:** shipping this change to `omnyohq.com` means fast-forwarding `landing-release`, and that needs the owner's explicit authorization. This card does not include a deployment.
