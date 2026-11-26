# RF-126 — Build the Workflows plugin's settings schema, descriptors and defaults from one per-field table

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, but it is smaller than the sweep reported, and one of its claims was wrong. The two label sets are not drift. They serve two purposes: one set names fields in validation messages, and the other adds units for the settings form. Tests pin the validation labels.
- **Potential:** low. One file, six fields, roughly 15 to 25 handwritten production lines removed (the sweep estimated 30 to 50).
- **Confidence:** high on the facts, medium on the line gain.
- **Readiness:** ready. No owner decision is needed, because user-visible strings, keys, order, defaults and validation stay identical.
- **Effort:** about 45 to 60 minutes, including the characterization check.
- **Risk:** low. The realistic regressions are a changed description string, a changed field order in the settings form, or a widened TypeScript type. The plan below guards against all three.
- **Prerequisites:** none.
- **Related or overlapping opportunities:** RF-045 (one plain-JSON inspector and one schema-limit table in the Workflows plugin) touches other files in the same plugin, but its edits do not overlap with this one. RF-110 (build the SDK setting-descriptor validator from the server-contract schema) changes how the SDK validates descriptors, not the descriptor shape this plugin emits. Neither is a prerequisite.
- **Why it deserves its place:** today each setting's range is written twice: once in the validator and once in the prose of the settings-form description. Nothing checks that the two copies agree, so changing a bound leaves the form showing a stale range. Each default is also written twice. A test keeps those two copies aligned, but someone still has to edit both. This is a small, safe consolidation of duplicated knowledge. It ranks low because the file is small and stable: it has one commit in history, and that commit is the initial "Publish Omnyo source".

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The audit's read-only worktree for this snapshot no longer existed when this card was written. Every observation below was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`.

The Workflows plugin (`plugins/workflows`, package `omnyo-plugin-workflows`) declares six bounded-integer settings. The host renders them as numeric inputs under Plugins → Installed plugins, and the CLI command `omnyo plugin config workflows set <key> <value>` edits them. The plugin validates the values with zod and snapshots five of them into each run's `settings_json`.

Observed facts. Each was proven by inspection of `plugins/workflows/src/settings.ts` at the snapshot. The file has 215 lines, and lines 8 to 129 hold the duplicated knowledge (122 lines, 114 of them non-blank; counted with `git show e9e1b74c3:plugins/workflows/src/settings.ts | sed -n 8,129p | grep -c -v '^\s*$'`).

1. `settings.ts:8-12` declares the `IntegerField` interface, and `:14-45` declares `INTEGER_FIELDS`. That table holds the validation `label`, `minimum` and `maximum` for each key, in this order: `maxActiveRuns`, `maxConcurrentAgents`, `maxAgentCalls`, `totalRunTimeoutMs`, `retentionDays`, `maxNotificationBytes`.
2. `settings.ts:47-55` "boundedIntegerSchema" builds the messages `"<label> must be a whole number"` and `"<label> must be from <min> through <max>"`. `:57-66` `workflowSettingsSchema` lists all six keys by hand.
3. `settings.ts:70-115` `WORKFLOW_SETTING_DESCRIPTORS` (`as const satisfies PluginSettingDescriptors`) repeats every key. For each one it gives `type: "number"`, a display `label`, a `description` that restates the range in parentheses, `experimental_schema: workflowSettingsSchema.shape.<key>` and the `default`.
   - The display label matches the validation label for four keys. The other two add units: `totalRunTimeoutMs` shows "Total run timeout (milliseconds)" against the validation label "Total run timeout", and `retentionDays` shows "Retention (days)" against "Retention days". This is intentional, not drift. `settings.test.ts:75-80` pins the validation labels, and `:154` pins the full message "Maximum active runs must be from 1 through 32".
   - Every description ends with ` (<min>-<max>).`, with the numbers written without separators: `(1-32)`, `(1-64)`, `(1-1000)`, `(60000-604800000)`, `(1-3650)` and `(1024-262144)`. `String(number)` in JavaScript produces exactly these forms, so the ranges can be derived. Verified for all six fields by comparing the description text with `INTEGER_FIELDS`.
4. `settings.ts:121-129` `DEFAULT_WORKFLOW_SETTINGS` restates all six defaults, two of them as arithmetic (`24 * 60 * 60 * 1_000` and `16 * 1_024`). They equal the descriptor defaults 4, 8, 100, 86_400_000, 7 and 16_384. `settings.test.ts:25-41` "keeps descriptor defaults and immutable internal defaults aligned" guards this copy. The test also asserts `Object.isFrozen(DEFAULT_WORKFLOW_SETTINGS)`.
5. `settings.ts:145` and `:152` "parseStoredWorkflowSettings" take the expected keys from `Object.keys(INTEGER_FIELDS)`, and `Object.fromEntries` then builds the parsed snapshot in that key order.

Consumers. Searched with `git grep -n -E 'WORKFLOW_SETTING_DESCRIPTORS|DEFAULT_WORKFLOW_SETTINGS|INTEGER_FIELDS|registerWorkflowSettings|parseStoredWorkflowSettings|validateWorkflowSettings|WorkflowSettings\b' e9e1b74c3 -- . ':!*.md'` over the whole repository. Every hit is inside `plugins/workflows/src`:

- `server.ts:83` "registerWorkflowSettings" and `server.ts:86` `DEFAULT_WORKFLOW_SETTINGS` (the fallback when the stored settings are invalid).
- `service.ts:456` (the default `initialSettings`) and `service.ts:757` "parseStoredWorkflowSettings".
- `cli.ts:197` and `cli.ts:262` "parseStoredWorkflowSettings".
- `settings.test.ts` and `service-policy.test.ts`, which spread `DEFAULT_WORKFLOW_SETTINGS` in about 10 places.

No other package imports these symbols. The plugin is independently forkable, so nothing outside it should import them. The SDK consumes the descriptors only at runtime, through `api.settings.define`: `apps/server/src/services/plugins/plugin-runtime.ts`, `packages/plugin-sdk/src/internal/host-policy.ts:277` (zod validation of a number descriptor) and `packages/plugin-sdk/src/testing/fake-plugin-host.ts`. Neither `packages/plugin-build` nor the manifest extracts descriptors statically. `plugins/workflows/package.json` lists no settings, and `git grep -l 'settingsDescriptors\|settings\.define' -- packages/plugin-build` returned no hits.

Type contract. `packages/plugin-sdk/src/backend-contract.ts:128-137` defines the number descriptor as `{ type: "number"; label; description?; experimental_section?; experimental_placeholder?; experimental_schema?: StandardSchemaV1<number, number>; default?: number }`. `PluginSettingsValues` (`:163-170`) types a value as non-optional only when the descriptor's type includes `default: number`, and as `number` only when it includes `type: "number"`. A derived descriptor map must keep both of those literal type facts.

Copies that stay, so this change does not remove them:

- `docs/configuration.md:2302-2307` documents the same keys, defaults and ranges in a table.
- `plugins/workflows/src/data.ts:206-207` is a historical migration whose column default is `'{"maxActiveRuns":4,…,"retentionDays":30,…}'`. That is persisted migration text and must never be edited.

Counterevidence and limits. The file is small, and its explicit descriptors are easy to grep. The existing test already catches default drift. The undetected drift risk is only the range text inside descriptions. Tests could not be run, because the snapshot has no `node_modules`.

**Proposed end state and preservation argument**

What disappears:

- The six hand-written descriptor object literals (`settings.ts:70-115`).
- The six hand-written default entries (`:121-129`).
- The six hand-written `z.object` entries (`:57-66`).
- The parenthesized range text duplicated in each description.

What remains:

- One frozen table, `WORKFLOW_INTEGER_SETTINGS`, which replaces `INTEGER_FIELDS` in the same file and the same key order. Each entry holds `label` (the display label), an optional `validationLabel` (used only for the two fields whose message wording differs), `description` (the stem without the range), `minimum`, `maximum` and `default`.
- One small typed `mapWorkflowSettings` helper.
- `boundedIntegerSchema`, which keeps its current messages and uses `field.validationLabel ?? field.label`.
- The derived exports `workflowSettingsSchema`, `WORKFLOW_SETTING_DESCRIPTORS` and `DEFAULT_WORKFLOW_SETTINGS`, with unchanged names, shapes and runtime values.
- `parseStoredWorkflowSettings`, `validateWorkflowSettings` and `registerWorkflowSettings`, unchanged apart from reading keys from the renamed table.

The canonical owner remains `plugins/workflows/src/settings.ts`. No new module and no new dependency are added.

Sketch, for orientation only; let the formatter decide the final layout:

```ts
interface IntegerSetting {
  label: string;
  /** Field name in validation messages when it differs from the form label. */
  validationLabel?: string;
  /** Form description without the trailing range, which is derived. */
  description: string;
  minimum: number;
  maximum: number;
  default: number;
}

const WORKFLOW_INTEGER_SETTINGS = Object.freeze({
  maxActiveRuns: { label: "Maximum active runs", description: "Concurrent workflow runs across the plugin", minimum: 1, maximum: 32, default: 4 },
  // … the same order and values as today …
  totalRunTimeoutMs: { label: "Total run timeout (milliseconds)", validationLabel: "Total run timeout", description: "Fail a workflow after this total duration in milliseconds", minimum: 60_000, maximum: 604_800_000, default: 86_400_000 },
  retentionDays: { label: "Retention (days)", validationLabel: "Retention days", description: "Days to retain completed workflow data", minimum: 1, maximum: 3_650, default: 7 },
} satisfies Record<string, IntegerSetting>);

type WorkflowSettingKey = keyof typeof WORKFLOW_INTEGER_SETTINGS;

function mapWorkflowSettings<T>(
  map: (field: IntegerSetting, key: WorkflowSettingKey) => T,
): Record<WorkflowSettingKey, T> {
  return Object.fromEntries(
    Object.entries(WORKFLOW_INTEGER_SETTINGS).map(([key, field]) => [key, map(field, key as WorkflowSettingKey)]),
  ) as Record<WorkflowSettingKey, T>;
}

const workflowSettingsSchema = z.object(mapWorkflowSettings(boundedIntegerSchema));

export const WORKFLOW_SETTING_DESCRIPTORS = mapWorkflowSettings((field, key) => ({
  type: "number" as const,
  label: field.label,
  description: `${field.description} (${field.minimum}-${field.maximum}).`,
  experimental_schema: workflowSettingsSchema.shape[key],
  default: field.default,
})) satisfies PluginSettingDescriptors;

export const DEFAULT_WORKFLOW_SETTINGS: Readonly<WorkflowSettings> =
  Object.freeze(mapWorkflowSettings((field) => field.default));
```

How current behavior survives:

- **Strings.** Each description stem is today's description with its trailing ` (<min>-<max>).` removed. The template rebuilds it byte for byte, because `String(1000)` is `"1000"` and the current text has no digit separators. Display labels and validation messages are copied unchanged.
- **Order.** `Object.entries` keeps insertion order for string keys. The settings form, the parsed stored-snapshot key order and the `Object.keys` set in `parseStoredWorkflowSettings` therefore stay the same.
- **Types.** `PluginSettingsValues<typeof WORKFLOW_SETTING_DESCRIPTORS>` still resolves every key to a non-optional `number`, because each derived entry has the literal type `type: "number"` and `default: number`. `WorkflowSettings` (from `z.infer`) stays `{ [K in WorkflowSettingKey]: number }`.
- **Validation.** The zod chain `.number().int(msg).min(min, msg).max(max, msg)` is unchanged, and so is the host-side `experimental_schema` wiring.
- **Persistence.** The persisted data is unaffected. `settings_json` snapshots, stored plugin settings and the `data.ts` migrations keep the same keys and values.

Non-goals:

- Changing any label, description, bound or default.
- Editing `docs/configuration.md` or `data.ts`. The migration text is immutable, and the docs table stays a handwritten copy.
- Moving bounded-integer descriptor building into the plugin SDK. That would be a public SDK API addition for one consumer.
- Touching `registerWorkflowSettings` or its fallback behavior.

This is the simplest sufficient option. A smaller variant would derive only `DEFAULT_WORKFLOW_SETTINGS` and the description ranges, and keep the hand-written descriptor objects. That variant removes fewer lines and leaves the label and default copies in place. A larger variant, an SDK helper, adds public surface for one plugin.

**Expected gain and cost**

- **Before (observed):** `settings.ts:8-129` has 122 lines (114 non-blank). Each field's range is written twice, its default twice, and its key four times: in the table, the schema, the descriptors and the defaults.
- **After (projection, not measured):** about 95 to 105 lines for the same region, which is roughly 15 to 25 fewer handwritten production lines. Each field's facts are written once, and each key appears once. Additions: the optional `validationLabel` field, the 10-line typed `mapWorkflowSettings` helper and two type assertions inside it.
- **Tests:** `settings.test.ts:25-41` becomes partly tautological, because both values derive from the same table. Keep the test anyway: it still checks that the defaults validate and that the object is frozen, and it costs nothing. Test line count stays the same, plus or minus 2 lines.
- **Maintenance effect:** changing a bound such as the `maxAgentCalls` ceiling becomes one edit instead of two, and the settings form can no longer show a stale range. Changing a default becomes one edit instead of two. Adding a seventh integer setting becomes one table entry instead of four coordinated edits. The `docs/configuration.md` table still needs a manual edit, as today.
- **Tradeoff:** a reader no longer sees a literal descriptor object for each key. They see a table and a mapping instead. The type assertion in the helper is a small, contained loss of compile-time checking.
- **Performance:** a one-time module-load mapping of six entries, which is negligible. Not measured.

**Execution steps**

1. **Reconfirm.** At the current `main`, check that `plugins/workflows/src/settings.ts` still matches the anchors above: `INTEGER_FIELDS`, `WORKFLOW_SETTING_DESCRIPTORS`, `DEFAULT_WORKFLOW_SETTINGS`, and descriptions ending in ` (<min>-<max>).`. Re-run the consumer search from Context.
   - Stop and re-plan if a description no longer ends in exactly `(<minimum>-<maximum>).`, a field gains a non-integer type, a field's range comes from another source, or any file outside `plugins/workflows` imports these symbols.
2. **Capture a baseline.** Record the current runtime output before editing, so the comparison does not check the new code against itself. From `plugins/workflows`, with dependencies installed, run a one-off script; do not commit it. For example, write `$TMPDIR/rf126-dump.test.ts`, then run `pnpm exec vitest run --config vitest.config.ts <that path>` (or move it temporarily under `src/` if the include glob requires that). The script should:
   - import `WORKFLOW_SETTING_DESCRIPTORS` and `DEFAULT_WORKFLOW_SETTINGS`;
   - write `JSON.stringify(Object.entries(WORKFLOW_SETTING_DESCRIPTORS).map(([k, d]) => [k, d.type, d.label, d.description, d.default]))` and `JSON.stringify(DEFAULT_WORKFLOW_SETTINGS)` to `$TMPDIR/rf126-before.json`;
   - for each key, record the error message of `validateWorkflowSettings` with `minimum - 1`, with `maximum + 1` and with `minimum + 0.5`.
3. **Edit `plugins/workflows/src/settings.ts`, the table.** Replace `IntegerField` and `INTEGER_FIELDS` with `IntegerSetting` and `WORKFLOW_INTEGER_SETTINGS`, as sketched. Copy each display `label` from the current descriptor. Add `validationLabel` only for `totalRunTimeoutMs` ("Total run timeout") and `retentionDays` ("Retention days"). Use each current description without its trailing ` (<min>-<max>).` as the `description` stem. Move each default in, keeping the same key order.
4. **Edit the schema builder.** Change "boundedIntegerSchema" to accept `IntegerSetting` and to use `field.validationLabel ?? field.label` in both messages. Add `WorkflowSettingKey` and `mapWorkflowSettings`. Build `workflowSettingsSchema` as `z.object(mapWorkflowSettings(boundedIntegerSchema))`. `boundedIntegerSchema` takes only its first argument, so passing it directly is safe; if lint objects, wrap it in an arrow function.
5. **Edit the derived exports.** Derive `WORKFLOW_SETTING_DESCRIPTORS` with `satisfies PluginSettingDescriptors` and the literal `type: "number" as const`. Derive `DEFAULT_WORKFLOW_SETTINGS` with `Object.freeze`. In "parseStoredWorkflowSettings" (`:145`, `:152`), replace `INTEGER_FIELDS` with `WORKFLOW_INTEGER_SETTINGS`. Leave `LEGACY_STORED_SETTING_KEYS`, `validateWorkflowSettings` and `registerWorkflowSettings` alone.
   - **Checkpoint:** `pnpm --filter omnyo-plugin-workflows typecheck` passes. In an editor, hovering `DeclaredWorkflowSettings` should show six non-optional `number` fields. If the type shows `number | undefined` or `string`, the literal `type` or `default` type was lost; fix the mapping's return type and do not add casts at the call sites.
6. **Compare with the baseline.** Re-run the step 2 script into `$TMPDIR/rf126-after.json`, then run `cmp $TMPDIR/rf126-before.json $TMPDIR/rf126-after.json`. The two files must be identical. Then delete the script and both JSON files, because they are disposable scratch.
7. **Tests.** Leave `settings.test.ts` unchanged. If you keep the alignment test at `:25-41`, keep its frozen assertion. Do not rewrite the literal expectations at `:75-80`, `:150-155` or `rawSettings`; they are the independent baseline.
8. **Clean up.** Format and lint the changed file. Confirm `INTEGER_FIELDS` has no remaining references (`rg -n 'INTEGER_FIELDS' plugins/workflows`). Review the full diff: it should touch only `plugins/workflows/src/settings.ts`. Recount lines 8 through the end of the `DEFAULT_WORKFLOW_SETTINGS` declaration and report the real reduction against 122 lines (114 non-blank).

**Verification and acceptance criteria**

The commands below were taken from `plugins/workflows/package.json` (`test`, `typecheck`, `lint`) and from the root `package.json` and the global agent policy (oxfmt and oxlint). They were not run during this audit, because the snapshot has no `node_modules`.

- From the repository root: `pnpm --filter omnyo-plugin-workflows test`. All tests should pass. The focused checks are `src/settings.test.ts`, which covers labels in messages, bounds, frozen defaults, fake-host registration with `toEqual(WORKFLOW_SETTING_DESCRIPTORS)`, string rejection and stored-snapshot parsing, and `src/service-policy.test.ts`, which spreads `DEFAULT_WORKFLOW_SETTINGS`.
- From the repository root: `pnpm --filter omnyo-plugin-workflows typecheck`. It should pass, and `DeclaredWorkflowSettings` should still resolve to six non-optional numbers.
- From the repository root: `pnpm exec oxfmt plugins/workflows/src/settings.ts`, then `pnpm exec oxlint --deny-warnings --format=agent plugins/workflows/src/settings.ts`. Both should be clean. The root configuration files `.oxfmtrc.json` and `.oxlintrc.json` exist.
- **Contract check:** the step 6 `cmp` shows that the descriptor `type`, `label`, `description` and `default` values, the default values and the validation messages are byte-identical to the baseline, in the same key order.
- **UI:** no visual review is needed if the `cmp` passes, because the host renders these descriptors and their bytes and order are unchanged. Alex can optionally open Plugins → Installed plugins → Workflow scripts and confirm that the six inputs, labels and descriptions look as before.
- **Structural completion:** each field's label, bounds, default and description stem appear exactly once in `settings.ts`, and the keys appear only in the table. No hand-written descriptor or default literal remains. `docs/configuration.md` and `data.ts` are unchanged.

**Rollback and stop conditions**

- **Boundary:** a single-file change to `plugins/workflows/src/settings.ts` with no persisted-format or API change. Roll back by reverting that one commit. No data migration or compatibility work is involved.
- **Stop conditions:**
  - The `cmp` shows any difference in strings, order or defaults.
  - Typecheck can only pass with casts outside `mapWorkflowSettings`.
  - `PluginSettingsValues` widens a value to optional.
  - A new setting appears that is not a bounded integer, such as a select or a string. A single integer table then no longer fits; keep the table for the integer fields only, or stop.
  - A consumer outside `plugins/workflows` is found that depends on `INTEGER_FIELDS` or on the literal descriptor types.
- **Fallback:** if the typed mapping proves awkward, apply the smaller variant. Keep the hand-written descriptors, but derive each description's range from `INTEGER_FIELDS` and build `DEFAULT_WORKFLOW_SETTINGS` from the descriptor defaults. That variant still closes the undetected range-drift risk.
