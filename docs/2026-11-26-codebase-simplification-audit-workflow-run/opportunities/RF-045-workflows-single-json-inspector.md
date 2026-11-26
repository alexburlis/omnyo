# RF-045 — Replace the Workflows plugin's four plain-JSON walkers and two schema-limit tables with one bounded inspector in `json-value.ts`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds. Four separately written walkers enforce the same plain-JSON trust rule, and they disagree on forbidden keys, error wording, path format and limits. Verification changed three things:
  1. The second schema-limit table (`service.ts:102` `SCHEMA_LIMITS`, depth 64) never rejects anything. Every schema that reaches it has already passed the stricter `validation.ts` walk (depth 32, the same node and byte limits). The sweep treated this as possible defence in depth; it is proven dead in effect (see Context).
  2. The forbidden-key difference is a real behaviour difference with two concrete manifestations, not only the one the sweep named. It is recorded as a separate incidental issue (forbidden-key acceptance depends on the entry path; see "Linked incidental issue" below) and must land as its own commit before the structural change.
  3. Tests pin wording from two different message families. A single message table can contain every pinned substring, so no test assertion has to be weakened (table in "Proposed end state").
- **Potential:** medium. One owner for the trust-boundary rule replaces four. About 190 to 220 handwritten production lines disappear in the core step, plus about 80 to 100 more if the optional cache step is taken.
- **Confidence:** high for the facts (all proven by inspection). Medium for the line estimate, which is a projection.
- **Readiness:** conditional. Gate: choose the forbidden-key policy (Option A, recommended: reject `__proto__`, `constructor` and `prototype` at every boundary, which is already where every path ends up) and land that behaviour fix first. Option B keeps today's per-path acceptance through a flag and keeps two policies, which removes most of the point of this card.
- **Effort:** about 0.5 to 1 day, including a new characterization test file and focused vitest runs. The optional cache step adds about 2 hours, mostly for the golden cache-key test.
- **Risk:** medium-low. This is a trust boundary for values coming from agents and the QuickJS sandbox. Error text reaches agents. Cache keys are persisted and must stay byte-identical if the optional cache step is taken.
- **Prerequisites:** the forbidden-key decision and its separate fix commit (Execution step 2).
- **Related and overlapping items:** RF-126 (derive Workflows settings labels, ranges and defaults from one table) edits the same plugin. It does not touch these symbols, but both edit `plugins/workflows/src/service.ts`, so whichever lands second rebases. No other RF item touches these files.
- **Why it deserves its place:** adding a rejected value kind (for example `BigInt`) or changing a limit today means editing four functions in four files and keeping four message sets aligned. The disagreement has already produced an observable inconsistency: whether a `constructor` key is accepted depends on which entry path a value took. Afterwards there is one function and one schema-limit table.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The dedicated snapshot worktree had been removed by the time of verification, so files were extracted read-only with `git -C $OMNYO_CHECKOUT archive e9e1b74c plugins/workflows | tar -x` into a temporary directory and read there. `git diff --stat e9e1b74c HEAD -- plugins/workflows` showed no change on local `main` at verification time. No tests were run, because the snapshot has no `node_modules`.

*What the code protects (Proven by inspection).* The Workflows plugin (`plugins/workflows`, package `omnyo-plugin-workflows`, bundled through `packages/bundled-plugins/package.json:49`) runs agent-written workflow scripts in QuickJS. Workflow args, worker results, script results and JSON Schemas cross from agents, the CLI and the sandbox into the Node host. Before the host stores them, hands them to Ajv or hashes them, it requires plain JSON: no cycles, sparse or decorated arrays, symbols, accessors, non-enumerable properties, exotic prototypes or non-finite numbers. `plugins/workflows/README.md:77` documents the schema side: "Schemas also retain the 64 KiB, 4,096-node, depth, cycle, and prototype-safety limits."

*The four walkers (Proven by inspection; physical lines counted with `awk 'NR>=a && NR<=b'` over each range, non-blank lines with `NF>0`).*

| # | Walker | Lines | Style | Limits | Forbidden keys | Path in errors | Callers |
|---|---|---|---|---|---|---|---|
| 1 | `src/json-value.ts:3` `assertJsonValue` (and `toJsonValue` at :82) | 3-80 (78 physical, 59 non-blank) | recursive | none | rejected | per node, `a.b[0]` | `server.ts:167` (tool args), `server.ts:204` (`omnyo_workflow_result` value), `runtime.ts:187` `dumpJson` (agent options from the VM), `runtime.ts:374` (every host-call result re-entering the VM), `runtime.ts:650` (script args) |
| 2 | `src/service.ts:205` `assertBoundedJson` | 205-303 (99 physical, 77 non-blank) | recursive | caller-supplied | **not rejected** | root path only | `service.ts:310-311` `validateValue`, `service.ts:685` (args in `start`), `service.ts:688-700` (schema re-walks in `start`), `service.ts:998-1002` (schema re-walk in `runAgentCall`) |
| 3 | `src/validation.ts:171` `assertValidJsonSchema`, structural part | 179-311 (133 physical, 106 non-blank) | iterative stack with exit markers | `MAX_SCHEMA_BYTES` 64 KiB, `MAX_SCHEMA_DEPTH` 32, `MAX_SCHEMA_NODES` 4,096 (`validation.ts:25-29`) | rejected | per node | `parser.ts:251`, `:336`, `:339`; `validation.ts:150` `parseStoredAgentOptions`; `validation.ts:454`, `:458` `parseAgentOptions` |
| 4 | `src/cache.ts:70` `canonicalizeValue` (with `FORBIDDEN_KEYS`, `quoted`, `pathForKey` at 54-68) | 54-199 (146 physical, 110 non-blank) | recursive, validates while serializing | none | rejected | `$["key"]` | `cache.ts:201` `canonicalizeJson`, used by `computeWorkflowCallCacheKey` (`cache.ts:236`), `parser.ts:262`, `validation.ts:464` |

The two limit tables: `service.ts:102` `SCHEMA_LIMITS = { bytes: 64 * 1024, nodes: 4_096, depth: 64 }` and `validation.ts:25-29` (bytes 64 KiB, nodes 4,096, depth 32). `service.ts:104` `VALUE_LIMITS = { bytes: 1024 * 1024, nodes: 100_000, depth: 128 }` is the only value-limit table and stays.

Walkers 2 and 3 share the same algorithm and node and depth semantics: count every visited value including the root, check the node limit before the depth limit, root at depth 0, error when depth exceeds the limit, ancestor-set cycle detection (shared non-cyclic references allowed), then `JSON.stringify` and a UTF-8 byte check. Walker 2 measures bytes with `Buffer.byteLength`; walker 3 with `TextEncoder`. Both give the same count.

*The service schema re-walks never fire (Proven by inspection).* Every schema that reaches walker 2 has already passed walker 3 with stricter or equal limits:
- `start` (`service.ts:684`) calls `parseWorkflowSource`, which validates `meta.inputSchema` and `meta.outputSchema` at `parser.ts:336` and `:339`. Lines 687-701 then re-walk the same objects with depth 64.
- `runAgentCall` (`service.ts:975`) receives `options` only from `capabilities.agent` (`service.ts:1781`), which is called only from the VM bridge at `runtime.ts:438-449` after `parseAgentOptions` validated the schema (`validation.ts:454`, `:458`). Lines 997-1003 re-walk it.
- `validateValue` (`service.ts:305`) is called at `service.ts:344` and `:358` (schema from `parseStoredAgentOptions`, which re-validates at `validation.ts:150`), `:704` and `:1901` (from `parseWorkflowSource`, re-parsed from `run.source` at `service.ts:1712`), and `:1818` and `:1855` (child source parsed at `service.ts:1815`). Line 310 re-walks the schema each time.
Search used: `grep -n "assertBoundedJson\|SCHEMA_LIMITS\|validateValue" plugins/workflows/src/*.ts`.

*Message families pinned by tests (Proven by inspection; `grep -n "toThrow(\|stringContaining(\|toContain(" src/*.test.ts`).*
- `runtime.test.ts:316` "cycle" and `:323` "plain objects" (walker 1 through `executeWorkflowScript` args).
- `server-harness.test.ts:853` "contains a cyclic value" and `:856` "unsafe prototype" (walker 2 through `service.start` args).
- `validation.test.ts:104-105` "cyclic value" and `:114-115` "unsafe prototype" (walker 3).
- `server-harness.test.ts:784` "node limit", `:799` "byte limit", `:818` "maximum depth" (walker 3, reached through the `omnyo_workflow_run` tool and `parseWorkflowSource`).
- `cache.test.ts:181-241`: "non-finite", "cycle", "sparse array", "non-index", "data property", "symbol", "symbol property", "plain objects", "forbidden key", "enumerable" (walker 4).
- `cache.test.ts:175` pins the canonical string for `{ z: -0, a: [true, null, "x"] }`, which covers `-0` normalization and key sorting.

*Other validators that are not part of this card.* `runtime.ts:95-130` validates the limit-override object, and `runtime.ts:566-592` `validateWorkflowReference` is JavaScript source that runs inside QuickJS. Both check one specific shape, not general JSON, and stay as they are.

*External consumers (Proven by inspection).* `git grep -n -e canonicalizeJson -e assertValidJsonSchema -e assertBoundedJson -e plugins/workflows/src/json-value -e workflows/src/cache e9e1b74c -- ':!plugins/workflows'` returned nothing. The package is `"private": true`, has no `exports` field and is not part of the plugin SDK, so all four walkers are plugin-internal.

*Linked incidental issue: forbidden-key acceptance depends on the entry path (Proven by inspection, not reproduced).* Walker 2 does not reject forbidden keys, but walker 1 rejects them when the value re-enters the VM (`runtime.ts:374`, `runtime.ts:650`). Two observable consequences:
- A structured worker result containing a forbidden key passes `validateValue`. This happens on the plain-text idle path (`service.ts:1285-1316`) and on the string-wrapped path of `omnyo_workflow_result`: `server.ts:204` checks only the outer string, and `service.ts:352-361` then runs `JSON.parse` and validates the result. The call is stored as `succeeded` and can be reused from the cache (`cache.ts:240` `reusableSuccessfulResult`). Then `agent()` rejects inside the script with "agent result contains forbidden key". The worker never gets a repair turn, and a resumed run replays the same rejected result.
- `omnyo workflows run --args '{"constructor":1}'` (`cli.ts:386` `parseJsonOption`, then `service.start`) queues a run that later fails at `runtime.ts:650`. The `omnyo_workflow_run` tool rejects the same args immediately (`server.ts:167`).

*Maintenance cost today.* A limit or rule change has to be repeated in four places, with four message sets and three path formats. Two of the four walkers are recursive. Walker 1 has no depth limit, so very deep values that reach it end in a `RangeError` from the call stack rather than a JSON error. The duplication already let the forbidden-key rule drift between walkers.

**Proposed end state and preservation argument**

*One owner.* `plugins/workflows/src/json-value.ts` exports:

```ts
export interface JsonLimits { bytes: number; nodes: number; depth: number }
export function assertJsonValue(value: unknown, path = "result", limits?: JsonLimits): asserts value is JsonValue
export function toJsonValue(value: unknown, path: string): JsonValue // unchanged
```

The third parameter replaces today's internal `ancestors` recursion parameter. No caller passes it today: all calls at `runtime.ts:187`, `:374`, `:650` and `json-value.ts:83` pass two arguments. The walk is iterative and uses walker 3's stack with exit markers, pushing children in reverse so errors are reported in document order. Each stack frame stores `{ value, depth, parent, key }`, and the path string is built only when an error is thrown. Walker 2 reports only the root path today and checks up to 100,000 nodes, so building a path string for every node would add allocation on 1 MiB values. Lazy paths avoid that.

Rules, applied identically everywhere, using the strictest current variant of each:
- Primitives: `null`, strings and booleans pass. Numbers must be finite. Anything else is not JSON-compatible.
- Arrays: the prototype must be exactly `Array.prototype` (walker 4's rule). `Reflect.ownKeys` may contain only `length` and in-range canonical indices: no symbols and no non-index keys (walker 4). Every index must be an own, enumerable data property (walker 4). Array elements are read through descriptors, so a getter is never invoked. Walker 1 reads `value[index]` today and so would run a getter.
- Objects: the prototype must be `Object.prototype` or `null`. Keys come from `Reflect.ownKeys`: no symbol keys, no `__proto__`, `constructor` or `prototype` (Option A), and every property must be an own, enumerable data property.
- Cycles: ancestor-set detection; shared non-cyclic references stay allowed (all four walkers allow them today).
- Limits, when `limits` is given: node count before depth, with walker 2 and 3 semantics, then `JSON.stringify` and the UTF-8 byte count with `Buffer.byteLength`. The plugin's server, CLI and runtime all run in Node, and `app.tsx` imports only types from `ui-contract.ts`.

*One message table* that contains every substring tests pin today, so no assertion changes:

| Condition | Message (per-node `path` unless noted) | Pinned substrings it satisfies |
|---|---|---|
| non-finite number | `${path} contains a non-finite number` | "non-finite" |
| other non-JSON type | `${path} is not JSON-compatible (${typeof value})` | "symbol" (for a Symbol value) |
| cycle | `${path} contains a cyclic value (a cycle back to an ancestor)` | "cycle", "cyclic value", "contains a cyclic value" |
| exotic prototype (object or array) | `${path} contains an object with an unsafe prototype; values must contain only plain objects and arrays` | "unsafe prototype", "plain objects" |
| symbol key | `${path} contains a symbol property` | "symbol property", "symbol" |
| forbidden key | `${path} contains forbidden key ${JSON.stringify(key)}` | "forbidden key" |
| sparse array | `${path} contains a sparse array` | "sparse array" |
| non-index array key | `${path} contains non-index array property ${JSON.stringify(key)}` | "non-index" |
| accessor | `${path}.${key} must be a data property` (or `[i]`) | "data property" |
| non-enumerable | `${path}.${key} must be enumerable` (or `[i]`) | "enumerable" |
| node limit (root path) | `${path} exceeds the ${n}-node limit` | "node limit" |
| depth limit (root path) | `${path} exceeds the maximum depth of ${n}` | "maximum depth" |
| byte limit (root path) | `${path} exceeds the ${n} byte limit (${bytes} bytes)` | "byte limit" |

Some agent-visible text changes: wording now matches across entry points, and walker 2 errors gain a per-node path. That is intentional and named here. No code parses these messages: the search `grep -rn "cyclic\|unsafe prototype\|forbidden key\|node limit" plugins/workflows/src --include=*.ts` outside tests and the walkers found nothing. Repair prompts embed `validation.error` verbatim (`service.ts:1329-1336`), so workers will see the new wording.

*Consumers after the change.*
- `validation.ts` exports `SCHEMA_JSON_LIMITS = { bytes: 64 * 1024, nodes: 4_096, depth: 32 }`, replacing `MAX_SCHEMA_BYTES`, `MAX_SCHEMA_DEPTH` and `MAX_SCHEMA_NODES`. `MAX_SCHEMA_PROPERTIES` and `MAX_SCHEMA_ENUM_VALUES` stay, because they are keyword rules. `assertValidJsonSchema` keeps its first check (boolean or object, `validation.ts:175-177`), calls `assertJsonValue(schema, path, SCHEMA_JSON_LIMITS)`, then runs `assertSupportedSchema` and the Ajv compile, in the same order as today. That order keeps the 4,100-property test (`server-harness.test.ts:765-785`) failing on "node limit" before the 256-property rule.
- `service.ts` deletes `assertBoundedJson`, `SCHEMA_LIMITS`, the schema re-walks at 687-701 and 997-1003, and the schema line in `validateValue` (310). The value checks become `assertJsonValue(input.args, "Workflow args", VALUE_LIMITS)` (685) and `assertJsonValue(value, "JSON value", VALUE_LIMITS)` (311). `VALUE_LIMITS` stays in `service.ts`, its only consumer.
- `runtime.ts` and `server.ts` call sites stay unchanged; they keep the unlimited form.
- Optional cache step: `canonicalizeValue` becomes `assertJsonValue(value, "$")` followed by a small recursive serializer. The serializer keeps the current output byte for byte: `JSON.stringify` for strings and keys, `String(n)` for numbers with `-0` written as `"0"`, keys sorted with the default `Array.prototype.sort` (UTF-16 code units), and no whitespace. Cache keys are stored in workflow call rows and decide replay on resume, so they must not change. The serializer recursion is safe: canonicalized inputs are schemas (depth 32 or less) and small identity objects, as today. The `$["key"]` path format in cache errors becomes the shared dotted format. Those errors are effectively unreachable in production, because every canonicalized input has already been validated.

*Dependency flow.* `cache.ts` imports `json-value.ts`; `validation.ts` imports `json-value.ts` and `cache.ts`; `json-value.ts` imports only types. This adds no cycle and no cross-plugin import, so `docs/forkable-plugins.md` is unaffected.

*What stays.* Everything that reaches Ajv, storage or the cache is still checked at least once with the same or stricter rules. Acceptance only tightens, and only for inputs that real entry points do not produce: every real entry point delivers `JSON.parse`, zod or `vm.dump` output, which never has decorated arrays or accessors. The only acceptance change real inputs can hit is the forbidden-key rule, which is the gated decision. Schema-keyword policy (`SUPPORTED_SCHEMA_KEYWORDS`, `UNSAFE_SCHEMA_KEYWORD_REASONS`, fan-out limits) and Ajv options stay unchanged.

*Non-goals.* Changing limits. Merging `validateWorkflowReference` or the limit-override validator. Caching Ajv compilation: `validateValue` builds a new `Ajv` on each call, which is a separate performance lead and not part of this card. Dropping the redundant `toJsonValue` at `server.ts:167`, which stays for type narrowing.

**Expected gain and cost**

Production lines (handwritten, physical; the after-sizes are projections):
- Core step. Removed: walker 1 body (78), `assertBoundedJson` (99), the service schema re-walks, `SCHEMA_LIMITS` and the `validateValue` schema line (24), and walker 3's structural part (133), about 334 in total. Added: the inspector with lazy paths and the message table (about 100 to 125) plus about 8 lines of call sites and the exported limits table. Net about **-190 to -220**.
- Optional cache step. Removed: `cache.ts:54-199` (146). Added: a serializer of about 35 to 45 lines and the call. Net about **-80 to -100**. The double walk costs one extra pass over small inputs.
- Tests: about +60 to +90 lines for a new `src/json-value.test.ts`, plus one golden cache-key test (about 15 lines) if the cache step is taken. No existing assertion changes.

Mechanisms: before, 4 walkers, 2 schema-limit tables (one dead in effect), 2 forbidden-key policies, 4 message sets and 3 path formats. After, 1 walker, 1 schema-limit table and 1 value-limit table, 1 policy, 1 message set and 1 path format.

Maintenance example: adding a rejected kind such as `BigInt`, or changing the schema depth, touches 4 functions in 4 files today and 1 function or 1 table entry afterwards.

Performance (Hypothesis, unmeasured): neutral to slightly better. Each `start`, `runAgentCall` and `validateValue` walks the schema once fewer. Lazy paths keep the per-node cost of the value check comparable to `assertBoundedJson`. The optional cache step adds one pass over small identity objects. The byte check uses `Buffer.byteLength`, which avoids the extra 64 KiB buffer that `TextEncoder.encode` allocates for each schema check today.

**Execution steps**

1. **Reconfirm.** In the canonical checkout, run `git diff --stat e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e HEAD -- plugins/workflows`. Re-run `grep -n "assertBoundedJson\|SCHEMA_LIMITS\|VALUE_LIMITS\|validateValue\|assertJsonValue\|toJsonValue\|assertValidJsonSchema\|canonicalizeJson" plugins/workflows/src/*.ts`. The call sites must match the Context tables. Re-plan if any of the following holds: a new caller passes a schema to `validateValue` or `runAgentCall` without going through `parseWorkflowSource`, `parseAgentOptions` or `parseStoredAgentOptions`; another package imports any of these symbols; or a test now pins different wording.
2. **Investigation gate: forbidden-key policy.** Get the owner's choice between Option A (reject at every boundary; recommended) and Option B (keep a flag).
   - Option A. Land the behaviour fix as its own commit, before any refactor. Add the forbidden-key check to `service.ts` `assertBoundedJson`, in the object-key loop at lines 272-288, with the message `${path} contains forbidden key ${JSON.stringify(key)}`. Add two regression tests and watch them fail before the fix: (a) in `server-harness.test.ts`, next to the `:827` case, `service.start({ ...base, args: { constructor: 1 } })` rejects with "forbidden key"; (b) in `service-policy.test.ts`, a structured call whose worker finishes with plain text `{"constructor":1}` gets a repair turn (or, after `MAX_REPAIR_ATTEMPTS`, a `failed` call), not a `succeeded` call row. Model (b) on the existing plain-text fallback tests in that file; locate them with `grep -n "handleThreadIdle\|corrective turns" src/service-policy.test.ts`. This commit closes the linked incidental issue.
   - Option B. Give `assertJsonValue` an `allowForbiddenKeys` flag used only by `service.ts`, and record the retained inconsistency in the incidental backlog. Then expect about 10 fewer lines saved and two remaining policies.
3. **Characterization test (new file `plugins/workflows/src/json-value.test.ts`).** Write it against the current code first, so it captures today's behaviour. Cover each rejection kind in the message table, through `assertJsonValue` (walker 1) and through `assertValidJsonSchema` (walker 3), asserting only the pinned substrings. Also cover: a shared non-cyclic reference passes (`const x = {}; ({ a: x, b: x })`); a nesting depth of exactly the limit passes and limit + 1 fails; node count equal to the limit passes and limit + 1 fails; the byte limit measured on UTF-8 (`"é".repeat(n)`). Add one new-behaviour case that fails until step 4: `assertJsonValue` on arrays nested 20,000 deep, with no limits, returns normally instead of throwing a `RangeError`. Checkpoint: the existing cases pass on the old code.
4. **Rewrite `json-value.ts`.** Implement `JsonLimits` and the iterative `assertJsonValue(value, path = "result", limits?)` as specified in the end state, including lazy path construction from `{ parent, key }` frames and the message table. Keep `toJsonValue` as is. Checkpoint: `json-value.test.ts`, `runtime.test.ts` and `server-harness.test.ts` pass.
5. **Switch `validation.ts`.** Replace `MAX_SCHEMA_BYTES`, `MAX_SCHEMA_DEPTH` and `MAX_SCHEMA_NODES` (lines 25-29) with `export const SCHEMA_JSON_LIMITS = { bytes: 64 * 1024, nodes: 4_096, depth: 32 } as const satisfies JsonLimits;`. In `assertValidJsonSchema`, replace lines 179-311 with `assertJsonValue(schema, path, SCHEMA_JSON_LIMITS);`, keeping lines 175-177 before it and `assertSupportedSchema` and the Ajv compile after it. Checkpoint: `validation.test.ts`, `parser.test.ts`, `workflow-validation.test.ts` and `server-harness.test.ts` (node, byte and depth cases) pass.
6. **Switch `service.ts`.** Delete `assertBoundedJson` (205-303) and `SCHEMA_LIMITS` (102). In `validateValue`, delete line 310 and change 311 to `assertJsonValue(value, "JSON value", VALUE_LIMITS)`. In `start`, change 685 to `assertJsonValue(input.args, "Workflow args", VALUE_LIMITS)` and delete 687-701. In `runAgentCall`, delete 997-1003. Import `assertJsonValue` from `./json-value.js`. If Option A landed in step 2, delete the now-redundant forbidden-key check together with `assertBoundedJson`; the regression tests from step 2 must still pass. Checkpoint: `service-policy.test.ts` and `server-harness.test.ts` pass.
7. **Optional: switch `cache.ts`.** First, on the unchanged code, add a golden test to `cache.test.ts` that pins the exact `computeWorkflowCallCacheKey(cacheInput())` hex string and the `canonicalizeJson` output for an input with nested objects, arrays, unicode keys, `-0`, `1e21` and `0.1`. Then replace `FORBIDDEN_KEYS`, `pathForKey` and the validation branches of `canonicalizeValue` with one `assertJsonValue(value, "$")` call in `canonicalizeJson`, followed by a serializer that keeps `quoted` and the `-0` rule. Checkpoint: the golden test and all of `cache.test.ts` pass without edits. Skip this step if the golden test cannot be made to pass unchanged.
8. **Clean up.** Remove now-unused imports. Leave `README.md:77`, which stays accurate. Run the structural greps under Verification. Recount lines with `wc -l plugins/workflows/src/{json-value,service,validation,cache}.ts` against the baseline sizes 86, 2150, 492 and 248.

**Verification and acceptance criteria**

Commands run from the repository root unless stated otherwise. The scripts named below exist in `plugins/workflows/package.json` (`test`, `typecheck`, `lint`) and the root `package.json` (`check:plugin-forks`). They could not be executed during this audit, because the snapshot has no `node_modules`.
- Focused tests: `cd plugins/workflows && pnpm exec vitest run --config vitest.config.ts src/json-value.test.ts src/cache.test.ts src/validation.test.ts src/parser.test.ts src/workflow-validation.test.ts src/runtime.test.ts src/service-policy.test.ts src/server-harness.test.ts`. Passing file arguments to `vitest run` is standard vitest CLI and has not been run here. Turbo's `omnyo-plugin-workflows#test` depends on `@omnyo/plugin-sdk#build` and `//#ensure-native-modules` (`turbo.json:1694-1699`); if imports fail, run `pnpm --filter omnyo-plugin-workflows test` through turbo instead.
- Types and lint: `pnpm --filter omnyo-plugin-workflows typecheck` and `pnpm --filter omnyo-plugin-workflows lint`. Then, on the changed files, `pnpm exec oxlint --fix <files>`, `pnpm exec oxfmt <files>` and `pnpm exec oxlint --deny-warnings --format=agent`.
- Forkability: `pnpm run check:plugin-forks`, expected unchanged (no new cross-plugin import).
- Behaviour contracts:
  - Every existing assertion listed in Context passes without edits.
  - The step 2 regression tests pass (Option A).
  - The step 3 characterization tests pass, including the deep-nesting case.
  - With the cache step, the golden cache-key hex is unchanged. A changed key would silently disable replay of cached calls on resume, so this check is mandatory.
- Structural completion:
  - `rg -n "assertBoundedJson|SCHEMA_LIMITS|MAX_SCHEMA_DEPTH|MAX_SCHEMA_NODES|MAX_SCHEMA_BYTES" plugins/workflows/src` returns only `SCHEMA_JSON_LIMITS` hits.
  - `rg -n "getOwnPropertyDescriptor|Reflect.ownKeys" plugins/workflows/src --glob '!*.test.ts'` returns only `json-value.ts` and the `runtime.ts` override and reference validators. With the cache step skipped, `cache.ts` remains in the list.
- UI: none. The plugin's UI does not render these checks.
- Performance: no existing budget covers these checks. Accept on the reasoning above. If a reviewer wants evidence, time `assertJsonValue` against the old `assertBoundedJson` on a 1 MiB, roughly 100,000-node object in a one-off `node` script outside the repository. A slowdown of more than 2x is the signal to revisit lazy paths.

**Rollback and stop conditions**

Each step is its own commit inside one plugin, with no persisted-format change (unless the cache step changes the cache key, which the golden test forbids). Reverting the refactor commits restores today's walkers; the Option A fix can stay on its own. Stop and re-plan if any of the following happens:
- An existing message assertion can only pass by editing it.
- A caller is found that passes an unvalidated schema to `validateValue` or `runAgentCall`. In that case keep one `assertJsonValue(schema, …, SCHEMA_JSON_LIMITS)` call at that site; do not drop it.
- The golden cache key changes. Abandon step 7 and keep `cache.ts` as it is.
- A timing check shows the value check is materially slower.
- The owner chooses Option B. Proceed, but re-estimate the gain.
The smaller safe alternative, if the full change is declined: delete only the dead `SCHEMA_LIMITS` re-walks (`service.ts:102`, 687-701, 997-1003, 310), about 24 lines with no behaviour change, and make `assertBoundedJson` reject forbidden keys.
