# RF-004 — Retire design previews after the keep list is confirmed

## Rank and disposition

Decision required. High confidence in internal reachability and measured footprint, unknown owner intent. Small to medium effort and medium visual regression risk. Independent of the Explore catalog. Sharing lifecycle between retained variants is an alternative whose savings overlap retirement.

## Context and evidence

Proven by inspection at `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. `apps/web/src/lab/designs.ts` dynamically imports `o-1` and `eclipse-1` through `eclipse-5`. `apps/web/src/routes/lab.$design.tsx` exposes the registry in preview mode and throws `notFound` for unknown designs. `apps/web/src/lab/lab-access.ts` rejects production access, but the homepage in `apps/web/src/routes/index.tsx` directly imports `lab/combined-a-v2`, including its content and styles. The variants vary geometry, uniforms, materials, timeline and rendering choices. The two inspected close siblings, `eclipse-4` and `eclipse-5`, allocate and dispose environment maps and renderer resources within their own effects. An import search scoped to `apps/web/src` confirmed the registry as the direct source importer of the six variant page entry points. Developer URLs, comparisons and screenshots may still be deliberate consumers.

## Proposed end state and preservation argument

Keep every design still used for comparison or iteration. Delete only explicitly retired previews and unreachable implementation/assets, together with their registry entries. Trace surviving dependencies before removing even a directory with a retired name. A lifecycle extraction for previews that remain should preserve each scene's shader, rendering attributes, animation timing and resize/reduced-motion behavior. The public homepage and production lab restriction stay intact.

## Expected gain and cost

Six `eclipse-scene.tsx` files total 4,273 handwritten source lines. Their six shader files total 1,193 additional lines. Counts come from listing tracked `eclipse-scene.tsx`/`eclipse-shaders.ts` under `o-1` and `eclipse-1`–`eclipse-5` and running `wc -l`. The whole 5,466-line footprint is an upper bound for those two file families. Estimate net deletion by the owner-approved keep list. Page, CSS and asset quantities are additional scope to measure individually. No production performance gain is established.

## Execution steps

1. Record the current purpose of each slug and obtain the maintainer's keep list. Search exact route strings, previews, guides and saved comparison context for those slugs. If intent is unavailable or there is a live consumer, keep that slug.
2. Capture public homepage and surviving preview baselines at desktop and touch widths, including reduced motion. Record URLs, screenshots for scene changes, and mount/unmount checks.
3. Remove only selected registry entries in `lab/designs.ts` and their now-orphaned files. Remove assets/styles only where imports and string references have been checked. Keep the lab route, production guard and `combined-a-v2` unchanged. Keep common framework pieces where another retained preview uses them.
4. Verify removed previews 404 in preview mode, surviving previews still load in preview mode, and production still refuses the lab. Only if retained preview duplication remains materially burdensome, compare two variants and share lifecycle code with exactly matching resource ownership as a separate change.

## Verification and acceptance criteria

From the repository root, run `pnpm --filter @omnyo/web test src/lab/lab-access.test.ts src/lab/combined-a-v2/beat-stepper.test.ts` and `pnpm --filter @omnyo/web build`. Exercise the public homepage and the before/after preview URLs in local browser/build modes. The homepage layout, hero behavior and reduced-motion UI match. Use repeated navigation to verify matching canvas/frame disposal if any retained renderer implementation changes. Recount only the files actually removed.

## Rollback and stop conditions

Restore the variant and its registry entry together. Stop for unconfirmed ownership, a surviving dependency or an observable difference in a retained page. Do not retire the lab infrastructure based on production gating alone.
