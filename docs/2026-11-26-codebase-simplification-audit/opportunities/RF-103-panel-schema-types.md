# RF-103 — Derive persisted tab variants from their existing schemas

## Rank and disposition

**Potential: medium. Confidence: high. Readiness: ready. Effort: small (less than one engineering day unless exact optional types expose a mismatch). Risk: low-to-medium.** Rechecks prior §13. A good small first change, though it ranks below lifecycle consolidation on maintenance value. Independent of RF-102. No storage-format change or product decision is required.

## Context and evidence

At `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`, `packages/client-core/src/panel/fixed-panel-tabs-state.ts` owns strict Zod schemas for eleven persisted variants at 71–201, then declares their interfaces and the `SecondaryFixedPanelTab` union again at 230–348. The declaration range is 119 lines / 104 nonblank. Examples of duplicated field knowledge are `BrowserFixedPanelTab.desktopTarget`, `TerminalFixedPanelTab.target`, `PluginPanelFixedPanelTab.fileOpenerOwner`, and nullable file/project/thread ownership fields.

`packages/client-core/package.json` is private. Its barrel exports these types to the app. `apps/app/src/lib/fixed-panel-tabs-state.ts` provides the app-facing re-export seam, and the root/detail panels, tab-state hooks and terminal integration consume these names. The existing schemas already validate browser/terminal ownership with `@omnyo/desktop-contract` and `@omnyo/server-contract`.

Tests include `apps/app/src/lib/fixed-panel-tabs-state.test.ts` (browser generation identity and stored state), `fixed-panel-tabs-sync.test.ts`, `fixed-panel-tabs.plugin-terminal.test.ts` and `components/secondary-panel/secondaryPanelTabState.test.ts`.

Counterevidence: not all runtime state equals the stored schema. `FixedSecondaryPanelTabGroupState.previousActiveTabId` is transient, tab arrays are readonly in runtime state, and storage accepts historical extras/filtering. Schemas have defaults and preprocessing (including removal of historical `side-chat` tabs). A wholesale `z.infer<typeof fixedPanelTabsStateSchema>` replacement would lose these distinctions. Explicit optional-property types may also differ from `z.output`'s optional `undefined` spelling. Check compiler behavior rather than casting it away.

## End state and preservation

Infer the persisted variant union from the output of `secondaryFixedPanelTabSchema` after defaults are applied. Keep every current exported name as an alias to its corresponding schema output or `Extract<SecondaryFixedPanelTab,{kind:...}>`. Define `FixedPanelViewTab` and `SecondaryFileFixedPanelTab` by their explicit allowed kinds. Keep runtime container types, readonly arrays and `previousActiveTabId` explicit. Leave schema definitions, default values, parse/normalize/serialize functions and all string identifiers unchanged.

Remove only declarations proved equal to schema output. Preserve named imports used elsewhere. If exact optional semantics differ, retain a narrow explicit type for that actual semantic difference. Do not introduce a general type-rewriting framework or change stored JSON to make the compiler pass.

## Expected gain and cost

Projection: remove 100–119 production declaration lines. Add 25–45 type aliases. **net 55–90 lines**. Eleven duplicated field lists become eleven aliases to one schema family. Changing a persisted field then updates the schema and genuine runtime logic, without a second handwritten field declaration. Test/config/generated savings: none claimed. Runtime JS and parsing work should be unchanged because the edit is erased types. Confirm the diff introduces no schema/runtime changes.

## Execution steps

1. Reconfirm the eleven variants, all exported names and every consumer from the client-core barrel/app seam. Establish baseline typecheck and fixed-tab tests. Stop if a runtime variant has a deliberate field distinction not represented by its schema.
2. Add inferred aliases for the three simple view variants and migrate their union. Do not export schemas solely to make aliases possible.
3. Replace remaining variant interfaces one at a time, preserving existing exported names. Use output inference so `.default(null)` fields remain required in parsed runtime values. Inspect browser target, terminal target and file-opener ownership optional properties explicitly.
4. Derive the full union and file/view subsets. Keep runtime group/container interfaces and historical parsing/preprocessing unchanged. Remove only now-unused type imports from desktop/server contracts.
5. Run target checks, examine emitted/runtime diff (there should be no changed parsing algorithm), and recount declarations removed/added. Search former interface names to verify their imports still resolve to aliases rather than disappearing.

## Verification and acceptance

Not run during this audit. From repository root:

```sh
pnpm --filter @omnyo/client-core typecheck
pnpm --filter @omnyo/app typecheck
pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/lib/fixed-panel-tabs-state.test.ts src/lib/fixed-panel-tabs-sync.test.ts src/lib/fixed-panel-tabs.plugin-terminal.test.ts src/components/secondary-panel/secondaryPanelTabState.test.ts
```

Keep current fixtures/expectations. Required checks: old/current stored shapes, defaulted nulls, optional browser/terminal identities, plugin file-opener ownership, stale/expired records, invalid records, runtime-only previous selection and terminal tab persistence. A type-only refactor needs no new visual suite. Existing UI consumers must typecheck with the same discriminated-union narrowing and exact optional fields. No benchmark is needed if the complete production diff contains only declarations/import-type changes. Any runtime edit invalidates that assumption and requires a revised plan.

## Rollback and stop

Revert only these type declarations and imports if a supported consumer requires a distinct shape. No migration, storage deletion or fixture rewrite is authorized. Stop on assignability changes, optionality changes, schema defaults being edited, or a required generic normalization layer. Retain explicit types only for proven runtime differences.
