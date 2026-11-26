# RF-069 — One typed helper for the Tasks CLI's 40 hand-paired contract-validated domain calls

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The pattern exists as described. This card corrects the counts: there are 40 wrapper sites (34 in `plugins/tasks/cli/index.ts`, 6 in `plugins/tasks/cli/seed.ts`), not about 43. 38 of them follow the canonical three-part shape and 2 parse the input in a separate statement first. The plan also changes: one generic helper takes the contract and the handler map as arguments, so the delegation calls need no "twin" helper. Seven input-only parse sites stay out of scope.
- **Potential:** low. This is a local readability and consistency win in one plugin. No mechanism, persisted format or contract changes.
- **Confidence:** high (Proven by inspection) for the counts and the preservation argument. Medium for the exact line saving, because the formatter decides the final wrapping.
- **Readiness:** ready.
- **Effort:** small. About 2 hours of mechanical edits plus one typecheck and one test run.
- **Risk:** low. The only real risk is in the TypeScript generics: indexing a handler map by a generic method key needs one internal cast.
- **Prerequisites:** none.
- **Related / overlapping:** RF-125 (one owner for agent-facing Tasks context and task attachment queries) touches nearby Tasks read paths, but it does not edit these CLI wrappers. Apply either first; if RF-125 lands first, re-run the site count in step 1. RF-046 and RF-071 also touch the Tasks plugin, in disjoint files. No overlap with RF-107 (that card covers core CLI plugin settings commands, not this plugin's CLI).
- **Why it deserves its place:** each CLI command restates the rule "an in-process CLI call is validated exactly like an RPC call" by naming its method three times: contract input, handler call and contract output. One helper makes that pairing structural and type-checked from a single method key. That matters most when someone later changes how CLI calls are validated or how their errors are mapped. The gain is mostly lines and consistency, so it ranks below items that remove whole mechanisms.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree was no longer present when this card was written, so every file was read with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>`. No `node_modules` were available and no tests were run.

How the subsystem works:

- The Tasks plugin defines its RPC surface in `plugins/tasks/shared/contract.ts:413` `tasksRpcContract = defineRpcContract({...})`, using zod 4 schemas (`plugins/tasks/package.json` depends on `zod ^4.3.6`). Delegation has its own contract in `plugins/tasks/delegate/contract.ts:7` `delegationRpcContract`.
- `plugins/tasks/api/index.ts:628` `registerHandlers(api, store): PluginRpcHandlers<typeof tasksRpcContract>` returns plain one-argument handler closures. `plugins/tasks/api/index.ts:1170` registers them with `api.rpc.register(tasksRpcContract, ...)`. On that path the host validates input and output.
- The CLI does not go through the host. `plugins/tasks/cli/index.ts:752` `registerTasksCli` calls `registerHandlers(api, store)` again (line 756) and calls the handlers in-process. To keep validation identical to RPC, each call is wrapped by hand:

  ```ts
  tasksRpcContract.X.output.parse(
    await domain.X(tasksRpcContract.X.input.parse(args)),
  )
  ```

- Delegation calls do the same with `delegationRpcContract.X` and `delegationHandlers(api, store).X(...)` (`plugins/tasks/delegate/index.ts:317` `handlers`).
- Validation failures surface as a `z.ZodError`. `guard` (`plugins/tasks/cli/index.ts:136`) turns it into a one-line CLI error through `friendlyError` (line 111), which prints the first issue's path and message.
- `PluginRpcHandlers` (`packages/plugin-sdk/src/rpc-contract.ts:116`) types each handler as taking the input schema's *output* type and returning the output schema's *input* type. The zod `.parse` calls therefore also convert between these types for TypeScript.

Site inventory (Proven by inspection). A Node script matched every `<x>RpcContract.<m>.output.parse(` call, found its closing parenthesis and checked whether the same method name appears in the handler call and in `input.parse`:

| File | Wrapper sites | Canonical (same method in all three places) | Pre-parsed input in a separate statement | Lines spanned |
|---|---|---|---|---|
| `plugins/tasks/cli/index.ts` | 34 (31 tasks, 3 delegation) | 33 | 1: `createTask` at 1384/1402 | 293 |
| `plugins/tasks/cli/seed.ts` | 6 | 5 | 1: local `createTask` helper at 31-34 | 30 |
| **Total** | **40** | **38** | **2** | **323** |

Canonical sites in `plugins/tasks/cli/index.ts`, by line and method: 286 `listProjects` (helper function `listProjects`), 407 `listFolders` (`resolveFolder`), 442 `getTask` and 455 `getTaskByKey` (`resolveTask`), 478 `listTasks` (`listAllTasks`), 525 and 534 `listAttachments` (`listTaskAttachments`), 548 `listPresets` (`listPresets`), 585 `listMachines`, 632 `listLabels`, 835 `createProject`, 863 `listFolders`, 1077 `createFolder`, 1097 `listFolders`, 1222 `deleteFolder`, 1560 `listTasks`, 1586 `listTaskThreads`, 1673 `listComments`, 1687 `listTaskThreads`, 1696 `listTaskPullRequests`, 1944 `updateTask`, 1994 `moveTaskToProject`, 2133 `createLabel`, 2195 `deleteLabel`, 2368 `listComments`, 2418 `deleteAttachment`, 2615 `createPreset`, 2731 `updatePreset`, 2788 `deletePreset`, 2948 `listTaskThreads`; delegation at 2836 `delegate`, 2879 `taskThreadsAttach`, 2921 `taskThreadsDetach`.

Canonical sites in `plugins/tasks/cli/seed.ts`: 57 `listProjects`, 63 and 69 `createFolder`, 101 `createProject`, 122 `createLabel`.

Sites that validate input only and then call the store or another helper directly. They are **not** wrapper sites and stay unchanged:

- `plugins/tasks/cli/index.ts:997` `renameProjectPrefix.input.parse` and 1009 `updateProject.input.parse`. Both feed one `store.transaction(...)` that combines two updates.
- `plugins/tasks/cli/index.ts:1177` `renameFolder.input.parse` and 1185 `moveFolder.input.parse`. Both feed one `store.tasks.updateFolder` transaction.
- `plugins/tasks/cli/index.ts:1668` `listTasks.input.parse`. It is passed to `listAllTasks`, which parses it again.
- `plugins/tasks/cli/seed.ts` `createComment.input.parse`. It feeds the non-RPC `createComment` import from `../api`.

Checked counterevidence and consumers:

- No mismatches exist today: all 38 canonical sites use the same method name in all three places. The helper removes the *possibility* of a mismatch. It fixes no current bug.
- None of the handler closures in `registerHandlers` reads `this` (`git show ...:plugins/tasks/api/index.ts | sed -n 628,1170p | grep -c "this\."` returns 0). Calling `handlers[method](...)` through a variable is therefore safe. The delegation `handlers` also returns an object of closures.
- Consumers of the CLI module are `plugins/tasks/server.ts:6,32` (`registerTasksCli`) and `plugins/tasks/cli/cli.test.ts:21,1046`. `seedDemo` is used only by `cli/index.ts`. Search: `git grep -n "seedDemo\|registerTasksCli\|cli/seed" e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- plugins/tasks`. Nothing outside the plugin imports these files, and the change adds no SDK export, so `docs/forkable-plugins.md` is unaffected.
- The same pattern does not appear elsewhere. `git grep -c "RpcContract\.[A-Za-z]*\.output\.parse(" e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- plugins packages apps` outside tests also hits `plugins/prompt-library/server.ts` (3 sites). Those calls validate cross-plugin `api.sdk.plugins.callRpc` results, which is a different shape. An SDK-level helper is therefore not justified.
- History: the pattern arrived with the source publication commit `060950255` (2026-11-24, "Publish Omnyo source"). No recorded requirement asks for per-site wrapping.

Maintenance cost today: any change to how CLI calls are validated or how their errors are reported must be applied at 40 sites. A copy-pasted wrapper can pair one method's output schema with another method's handler without a type error, because TypeScript checks the three references separately.

**Proposed end state and preservation argument**

End state:

- A new plugin-local module `plugins/tasks/cli/contract-call.ts` owns the rule "CLI calls are validated exactly like RPC calls". It contains:
  - `callContract(contract, handlers, method, input)`. This generic function parses `input` with `contract[method].input`, awaits `handlers[method](parsed)` and returns `contract[method].output.parse(result)`.
  - `callTasks(domain, method, input)`. This is a thin binding of `callContract` to `tasksRpcContract`, so the 35 Tasks sites stay short.
  - `export type TasksDomain = PluginRpcHandlers<typeof tasksRpcContract>`. It replaces the two identical `type TasksDomain = ReturnType<typeof registerHandlers>` declarations in `cli/index.ts:98` and `cli/seed.ts:5`. The types are equal, because `registerHandlers` is annotated with that return type.
- The 40 wrapper sites become `await callTasks(domain, "<method>", {...})` or `await callContract(delegationRpcContract, delegationHandlers(api, store), "<method>", {...})`.
- The 7 input-only parse sites listed above remain as they are.

Suggested signatures. Adjust them to whatever compiles cleanly; the cast lives in this one place only:

```ts
import type { PluginRpcContract, PluginRpcHandlers } from "@omnyo/plugin-sdk";
import type { z } from "zod";
import { tasksRpcContract } from "../shared/contract";

type ZodRpcContract = PluginRpcContract &
  Readonly<Record<string, { readonly input: z.ZodType; readonly output: z.ZodType }>>;

/** Call an in-process handler with the same input and output validation as its RPC route. */
export async function callContract<
  Contract extends ZodRpcContract,
  Method extends keyof Contract & string,
>(
  contract: Contract,
  handlers: PluginRpcHandlers<Contract>,
  method: Method,
  input: z.input<Contract[Method]["input"]>,
): Promise<z.output<Contract[Method]["output"]>> {
  const schemas = contract[method];
  const handler = handlers[method] as (value: unknown) => unknown;
  return schemas.output.parse(await handler(schemas.input.parse(input)));
}

export type TasksDomain = PluginRpcHandlers<typeof tasksRpcContract>;

export function callTasks<Method extends keyof typeof tasksRpcContract & string>(
  domain: TasksDomain,
  method: Method,
  input: z.input<(typeof tasksRpcContract)[Method]["input"]>,
) {
  return callContract(tasksRpcContract, domain, method, input);
}
```

Why the semantics survive (Proven by inspection):

- **Same validation.** The same zod schema objects run `.parse` on the same values, so defaults, coercions and `ZodError` issues are unchanged. `guard` and `friendlyError` receive the same error objects, so CLI stderr text is unchanged.
- **Same evaluation order.** Call arguments are evaluated first. That includes the `await readTextOption(...)` inside the `createTask` input object at `cli/index.ts:1387-1394`. Then the input is parsed, the handler is called and the output is parsed. Today's nested form runs in the same order.
- **Same failure channel.** Every current site sits in an `async` function and is awaited. A synchronous `ZodError` from `input.parse` becomes a rejection today, and it stays a rejection inside the async helper.
- **Same handler instances.** The CLI keeps the `domain` built at `cli/index.ts:756`. Delegation keeps calling `delegationHandlers(api, store)` per command, so construction timing does not change. Hoisting that call is a non-goal.
- Persisted data, RPC contracts, the SDK surface, CLI flags, output text and JSON output do not change.

Non-goals:

- Do not convert the 7 input-only sites. They intentionally combine validated inputs into one store transaction.
- Do not remove the double parse at `cli/index.ts:1668` → `listAllTasks`. It is harmless, and removing it would change the declared input type of `listAllTasks`.
- Do not move the helper into `@omnyo/plugin-sdk`. No second consumer exists.
- Do not route CLI calls through `api.rpc` or the host. That would change error envelopes and add overhead.

**Expected gain and cost**

- **Before (measured):** 40 wrapper sites spanning 323 handwritten production lines in `plugins/tasks/cli/index.ts` (3,009 lines) and `plugins/tasks/cli/seed.ts` (286 lines). Count method: the Node bracket-matching script described in Context, run on `git show` output of the snapshot.
- **After (projection):** each multi-line object-argument site loses about 4 lines (the handler-call line, the `input.parse` line and two closing lines). Single-line sites lose about 2–3 lines. Estimated gross removal is about 120–140 lines. The new module adds about 25–35 lines, and each file gains one import line.
- **Net (projection):** about **−85 to −120 handwritten production lines**. No test, generated or documentation lines change unless the optional seed test from step 2 is added (about +15 test lines).
- **Mechanisms:** 40 hand-paired input/handler/output triples become 1 helper plus 1 Tasks binding. The duplicate `TasksDomain` type alias goes from 2 copies to 1.
- **Maintenance effect:** a future change to CLI-side validation, such as error-code mapping, issue formatting or tracing, becomes one edit. TypeScript ties the method key to its schemas and handler, so a mismatched pairing no longer compiles.
- **Performance:** neutral (Proven by inspection). There is one extra function frame per CLI call and no new allocations beyond the existing parses. The code runs on the CLI path only.
- **Tradeoff:** readers must open `contract-call.ts` once to see that validation happens. A one-line doc comment on `callContract` covers this.

**Execution steps**

1. **Reconfirm the baseline.** In a worktree at current `main`, re-run the site count:
   `rg -c "RpcContract\.[A-Za-z]+\.output\.parse\(" plugins/tasks/cli/index.ts plugins/tasks/cli/seed.ts` (it counts lines; expect 34 and 6). Also run
   `rg -n "RpcContract\.[A-Za-z]+\.input\.parse\(" plugins/tasks/cli` to re-list the input-only sites. Re-plan if any of the following holds:
   - the canonical sites have moved into a shared module;
   - a handler now uses `this` or a second `context` argument (`ExperimentalPluginRpcHandlersWithContext`);
   - the contracts no longer use zod;
   - RF-125 has restructured these call sites.
2. **Close the one coverage gap.** `plugins/tasks/cli/cli.test.ts` covers most commands, including friendly zod errors in the test at line 799 ("returns single-line friendly errors for invalid statuses and unknown keys"), folder delete, attach and delegate. It never runs `seed-demo --yes`: the test at line 94 checks only the confirmation guard. Before editing `seed.ts`, add one test to `cli.test.ts` that runs `harness.runCli(["seed-demo", "--yes", "--json"])` against the existing harness and asserts the created counts. Run it on the unchanged code first so it records the current baseline. If adding a test is unwanted, leave `seed.ts` unchanged instead (it accounts for about 15 of the projected lines).
3. **Add `plugins/tasks/cli/contract-call.ts`** with `callContract`, `callTasks` and `TasksDomain` as sketched above. Run `pnpm typecheck` in `plugins/tasks`. Checkpoint: the module compiles without casts beyond the single `handler` cast. If `schemas.output.parse(...)` does not infer as `z.output<Contract[Method]["output"]>`, add one `as` on the return, still inside the helper.
4. **Convert the helper functions in `cli/index.ts`** (lines 285-640): `listProjects`, `resolveFolder`, `resolveTask`, `listAllTasks`, `listTaskAttachments`, `listPresets`, the `listMachines` site in the function at line 582, and the `listLabels` site at line 632. Example: `return (await callTasks(domain, "listProjects", {})).projects;`. Replace `type TasksDomain = ReturnType<typeof registerHandlers>` at line 98 with an import from `./contract-call`. Keep `type ListTasksInput = Parameters<TasksDomain["listTasks"]>[0]` at line 100. Checkpoint: `pnpm typecheck`.
5. **Convert the command bodies in `cli/index.ts`**: the canonical sites from line 835 to line 2948. For `createTask` (lines 1384-1405), fold the `created` object literal into `callTasks(domain, "createTask", {...})` and keep the `unwrapTask(...)` wrapper. Do not touch the 7 input-only sites. For the three delegation sites (2836, 2879, 2921), use `callContract(delegationRpcContract, delegationHandlers(api, store), "<method>", {...})`. Checkpoint: `pnpm typecheck` and `pnpm test -- cli/cli.test.ts`.
6. **Convert `cli/seed.ts`**: the local `createTask` helper (lines 17-39) becomes `const result = await callTasks(domain, "createTask", input);`, followed by the existing `ok` check. Convert the 5 canonical sites. Replace the local `TasksDomain` alias and the `import type { registerHandlers }`. Keep the `tasksRpcContract` import for the `createComment.input.parse` site.
7. **Clean up.** Remove imports that become unused. `registerHandlers` stays imported in `index.ts` because line 756 uses it. `tasksRpcContract` and `delegationRpcContract` stay imported. Format the touched files from the repository root with `pnpm exec oxfmt plugins/tasks/cli/contract-call.ts plugins/tasks/cli/index.ts plugins/tasks/cli/seed.ts plugins/tasks/cli/cli.test.ts`.
8. **Final check.** Re-run the count from step 1. Expect 0 `output.parse(` hits in `index.ts` and `seed.ts`; the only remaining `input.parse(` hits should be the 7 input-only sites. Recount the line delta with `git diff --stat -- plugins/tasks/cli`, and inspect the full diff for unrelated changes.

**Verification and acceptance criteria**

Commands. The scripts exist in `plugins/tasks/package.json` and the root `package.json` at the snapshot; they were not run here because the snapshot had no dependencies installed.

- `cd plugins/tasks && pnpm typecheck` (`tsc --noEmit`) passes.
- `cd plugins/tasks && pnpm test -- cli/cli.test.ts` (`vitest run --config vitest.config.ts`) passes, with all 27 existing tests plus the new seed test from step 2. No expected output or stderr strings change.
- `cd plugins/tasks && pnpm lint` (oxlint) passes. From the repository root, `pnpm exec oxfmt --check plugins/tasks/cli` passes.
- From the repository root, `pnpm check:plugin-forks` (`node scripts/check-plugin-forks.mjs`) still passes. This confirms that no sibling-plugin import was added.

Behavior and contract checks:

- Validation errors keep their exact text. The existing test at `cli.test.ts:799` and the parent-update rejection test at `cli.test.ts:434` must pass unchanged.
- Mutation side effects are unchanged. The folder tests around `cli.test.ts:979-1050`, including the racing-store delete at line 1046, must pass unchanged.
- The seed test from step 2 produces identical counts before and after the change.

Structural completion:

- Every canonical wrapper is gone, `contract-call.ts` is the only place that pairs `input.parse` → handler → `output.parse`, and one `TasksDomain` alias remains.

No UI or performance measurement is needed: the change touches the CLI only and adds no work per call.

**Rollback and stop conditions**

- **Rollback:** the change is self-contained in `plugins/tasks/cli/`. Revert the commit. No data, persisted format, contract or SDK surface is involved.
- **Stop conditions:**
  - Making the generic helper type-check requires casts at the call sites rather than only inside the helper. Fallback: keep `callTasks` with per-method overloads, or stop and leave the code as is, because the gain is modest.
  - Any existing CLI test changes its expected stdout or stderr.
  - A handler in `registerHandlers` or the delegation `handlers` is found to depend on `this` or on a second context argument.
  - A reviewer decides the explicit inline form is preferred for readability. The item is low potential, and declining it costs nothing.
