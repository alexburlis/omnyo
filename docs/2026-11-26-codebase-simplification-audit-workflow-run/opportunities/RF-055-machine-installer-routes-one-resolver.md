# RF-055 — Resolve the `/install.sh` and `/install.ps1` enrollment credential through one function, next to `/m/:code`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, but it lives in two routes, not three. The sweep said all three installer routes repeat the credential lookup and the reconnect refresh. In fact `/m/:code` looks up a short code (`pendingBootstrapForShortCode`), has no reconnect refresh, and already uses the shared header constants and failure-script helpers. The proposed generic `installerResponse(platform, outcome, status)` renderer is also dropped. The three routes have three deliberately different status policies, so a shared renderer would need a switch for each caller and would hide those policies.
- **Potential:** low. This removes one duplicated decision rule (credential, then pending bootstrap, then reconnect refresh, then outcome), four copies of the expiry message, two copies of the refresh-failure message and four inline header objects. The net saving is about 45 to 65 production lines.
- **Confidence:** high. The duplication was checked by reading the source and by a byte-comparison run.
- **Readiness:** ready.
- **Effort:** small. Allow 1 to 2 hours, plus the targeted server tests listed below.
- **Risk:** low. The affected contract is the response body and status code that `curl … | sh` and `irm … | iex` receive. The change touches only one file pair in `apps/server`, and one revert undoes it.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** RF-056 (start-server background work). RF-056 also edits `apps/server/src/server.ts`, so expect a merge conflict but no shared savings. RF-063 (typed public route table) covers plugin and marketplace routes, not these installer routes. Nothing else overlaps.
- **Why it deserves its place:** this is a cheap, low-risk cleanup. Today a change to the reconnect-refresh rule, or to any installer failure wording, needs matching edits in two hand-written copies inside a 1,000-plus-line `server.ts`, and no test covers the refresh-failure branch of either copy. It does not rank as high-potential, because the total amount of code is small.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree had been removed by the time of this check, so the source was read with `git -C $OMNYO_CHECKOUT show e9e1b74c…:<path>` and `git grep` at that commit.

How the subsystem works: when a user adds a machine, Omnyo shows one of two command types:

- A long-credential command, built by `apps/server/src/services/machines/manual-enrollment-command.ts:7` `manualEnrollmentCommand` and `:20` `manualEnrollmentPowerShellCommand`. The shell form is `curl -sS --fail-with-body … -H 'X-Omnyo-Enrollment: <credential>' …/install.sh | sh`. The PowerShell form is `irm -Headers @{ 'X-Omnyo-Enrollment' = … } …/install.ps1 | iex`.
- A short-code command, built by `:51` `shortEnrollmentCommand` (`curl -fsSL …/m/<code> | sh`) and `:60` `shortEnrollmentPowerShellCommand` (`irm …/m/<code>.ps1 | iex`).

The server answers each command with an installer script that has the enrollment bootstrap embedded in it. When something fails, it answers with a script that prints the error.

Observed facts (Proven by inspection unless another label is given):

1. `apps/server/src/server.ts:998-1067` is the `app.get("/install.sh", …)` handler. It calls `readEnrollmentHeaderV1`, which is defined at `services/machines/enrollment-header-v1.ts:6`. An `invalid` header gets 403 with the expiry message. Otherwise the handler reads `INSTALL_MACHINE_SCRIPT_PATH`. When a credential is present, it calls `getMachineEnrollmentService(deps).pendingBootstrapForCredential(credential)`. If that returns null, it calls `reconnectBootstrapForCredential(deps, credential)` (`services/machines/reconnect.ts:59`) inside a try/catch. When that throws, the handler runs `deps.logger.warn({ error }, "Could not refresh machine access")` and returns 503 with the refresh-failure message. If the result is still null, it returns 403 with the expiry message. If no header was sent, it returns 200 with the plain script. If a bootstrap was found, it returns 200 with `enrolledInstallerScript(script, bootstrap)`. Every failure body is a hand-written `"echo '…' >&2\nexit 1\n"`, and every response builds its own inline header object with `cache-control: no-store` and `content-type: text/x-shellscript; charset=utf-8`, four times in all.
2. `apps/server/src/server.ts:1068-1133` is the `app.get("/install.ps1", …)` handler. It follows the same flow with its own local `headers` object (`text/plain; charset=utf-8`). It returns status 200 for every outcome and builds failures with `windowsInstallerFailureScript`. There is one difference from the shell route: a missing header gets the failure message "This installer needs an enrollment command. Generate one in Omnyo under Settings, Machines.", not the plain installer.
3. The expiry message "This enrollment command has already been used, replaced, or expired. Generate a new command in Omnyo." appears four times (`server.ts:1003`, `:1047`, `:1079`, `:1120`). The refresh-failure message "Could not refresh machine access. Run the command again, or generate a new one in Omnyo." appears twice (`:1033`, `:1110`). The `"Could not refresh machine access"` log call appears twice (`:1030`, `:1106`).
4. Reproduced (a `node -e` byte-comparison run): each inline shell failure string in `server.ts` is byte-identical to `shellInstallerFailureScript(message)`, which is defined at `services/machines/manual-enrollment-command.ts:32`. Neither message contains a single quote, so `quote()` adds no escaping. The comparison printed `true true`.
5. `apps/server/src/routes/short-enrollment.ts:31` `SHELL_HEADERS` and `:36` `POWERSHELL_HEADERS` hold exactly the same header values as the inline objects in `server.ts`. The `/m/:code` handler (`short-enrollment.ts:93-167`, registered by `registerShortEnrollmentRoutes` at `:87`) already uses those constants together with `shellInstallerFailureScript` and `windowsInstallerFailureScript`. It resolves its bootstrap with `pendingBootstrapForShortCode`, has no reconnect fallback, runs a per-client failure limiter and returns a browser page. Its shell failures return status 200, not 403.
6. `server.ts:1134-1137` calls `registerShortEnrollmentRoutes(app, deps, { shell: () => readFile(INSTALL_MACHINE_SCRIPT_PATH, "utf8"), windows: () => readFile(INSTALL_MACHINE_WINDOWS_SCRIPT_PATH, "utf8") })`. This is the `MachineInstallerSources` interface (`short-enrollment.ts:82`), which the moved routes can reuse. `registerShortEnrollmentRoutes` has no other caller. Search: `git grep -n -e registerShortEnrollmentRoutes -e MachineInstallerSources -e routes/short-enrollment e9e1b74c…`.
7. The server.ts imports that only these two handlers use are `enrolledInstallerScript`, `enrolledWindowsInstallerScript`, `windowsInstallerFailureScript` (`server.ts:32-36`), `reconnectBootstrapForCredential` (`:37`) and `readEnrollmentHeaderV1` (`:38`). `getMachineEnrollmentService`, `readFile` and the `INSTALL_MACHINE_*` paths stay in use elsewhere in `server.ts` (`:1135-1136`, `:1303`, `:1365`).

Why each route uses a different status policy (counterevidence that must be kept):

- `/install.sh` returns 403 or 503 with a script body. Its command uses `curl --fail-with-body`, so curl still pipes the body to `sh`, which prints the message and exits 1. The tests `apps/server/test/public/public-host-enrollment.test.ts:103`, `:139`, `:224` and `:258` assert the 403.
- `/install.ps1` returns 200 for every failure. `apps/server/test/app/install-machine-windows.test.ts:495-510` asserts 200 for a missing header and for an unknown credential. Hypothesis: the reason is that `irm` throws on a non-2xx status before `iex` can run the `throw '…'` body, so the user would see a raw HTTP error instead of the message.
- `/m/:code` returns 200 for its shell failures because its command uses `curl -fsSL`. With `-f`, a non-2xx status would suppress the body.

Consumers that were checked: the relay gate lists `/install.sh` and `/install.ps1` as anonymous routes with size limits (`apps/relay/src/gate/gate.ts:125-126`, `:151-152`). The server request context does the same (`apps/server/src/request-context.ts:22-23`), and `services/machines/bootstrap.ts:26` builds the `/install.sh` URL. None of these depends on where the handler code lives. The URL paths do not change. Plugins, the SDK and the CLI do not import these handlers (search: `git grep -l -e /install.ps1 -e /install.sh -e registerShortEnrollmentRoutes` at the snapshot, with Markdown excluded). The CLI and app hits are tests and stories that render the command text.

Test coverage that exists today: `apps/server/test/app/skeleton.test.ts:48-62` checks the anonymous `/install.sh` bytes and content type. `:138-180` checks that the registered install routes sit beside the install catch-all. `apps/server/test/public/public-host-enrollment.test.ts` covers the superseded, reused and invalid-header 403s and the 200 enrolled script. `apps/server/test/app/install-machine-windows.test.ts:495-510` covers the PowerShell failures. `apps/server/test/public/short-host-enrollment.test.ts` covers `/m/:code`. Gap: no test drives the refresh-failure branch, the 503 shell response or the PowerShell refresh message (search: `git grep -n "Could not refresh machine access"` at the snapshot finds only `server.ts`). The test suites were not run, because the snapshot has no `node_modules`.

Line count (method: line ranges from `git show <commit>:apps/server/src/server.ts | grep -n`): the handlers fill `server.ts:998-1133`, which is 136 lines, plus 7 lines of handler-only imports. `short-enrollment.ts` has 168 lines.

**Proposed end state and preservation argument**

What disappears: the two inline handlers in `server.ts`, together with their two credential-lookup and reconnect-fallback flows, their six literal message copies, their four inline shell header objects and the local PowerShell `headers` object.

What remains: `apps/server/src/routes/short-enrollment.ts` owns every machine-installer route. It holds:

```ts
const EXPIRED_ENROLLMENT_MESSAGE =
  "This enrollment command has already been used, replaced, or expired. Generate a new command in Omnyo.";
const REFRESH_FAILED_MESSAGE =
  "Could not refresh machine access. Run the command again, or generate a new one in Omnyo.";
const MISSING_ENROLLMENT_MESSAGE =
  "This installer needs an enrollment command. Generate one in Omnyo under Settings, Machines.";

type CredentialBootstrap =
  | { kind: "absent" }
  | { kind: "expired" }          // invalid header, or no pending/reconnect bootstrap
  | { kind: "refresh_failed" }   // reconnectBootstrapForCredential threw
  | { kind: "ready"; bootstrap: EnrollmentBootstrap };

async function resolveCredentialBootstrap(
  deps: ServerAppDeps,
  headers: Headers,
): Promise<CredentialBootstrap> {
  const enrollment = readEnrollmentHeaderV1(headers);
  if (enrollment.kind === "absent") return { kind: "absent" };
  if (enrollment.kind === "invalid") return { kind: "expired" };
  const pending = await getMachineEnrollmentService(deps)
    .pendingBootstrapForCredential(enrollment.credential);
  if (pending !== null) return { kind: "ready", bootstrap: pending };
  try {
    const refreshed = await reconnectBootstrapForCredential(deps, enrollment.credential);
    return refreshed === null ? { kind: "expired" } : { kind: "ready", bootstrap: refreshed };
  } catch (error) {
    deps.logger.warn({ error }, "Could not refresh machine access");
    return { kind: "refresh_failed" };
  }
}
```

The two handlers render the outcome themselves, so each route's status policy stays visible at its own call site:

- `/install.sh`: `absent` returns 200 with `await installers.shell()`. `ready` returns 200 with `enrolledInstallerScript(await installers.shell(), bootstrap)`. `expired` returns 403 with `shellInstallerFailureScript(EXPIRED_ENROLLMENT_MESSAGE)`. `refresh_failed` returns 503 with `shellInstallerFailureScript(REFRESH_FAILED_MESSAGE)`. All four use `SHELL_HEADERS`.
- `/install.ps1`: `ready` returns 200 with `enrolledWindowsInstallerScript(await installers.windows(), bootstrap)`. Every other outcome returns 200 with `windowsInstallerFailureScript(message)`, where the message is `MISSING_ENROLLMENT_MESSAGE`, `REFRESH_FAILED_MESSAGE` or `EXPIRED_ENROLLMENT_MESSAGE`. All four use `POWERSHELL_HEADERS`.
- `/m/:code`: unchanged.

Why this is the simplest sufficient option: one function now owns the rule for which bootstrap a credential receives. The rendering stays explicit because the shell route, the PowerShell route and the short-code route each have their own status contract. A generic renderer with a `status` or `platform` switch would only relocate those differences. A smaller alternative would replace only the literals with constants and the existing helpers. That alternative saves about 20 lines but leaves both copies of the lookup and reconnect flow in place, so it was not chosen.

How current behavior survives:

- **Bodies:** the shell failures go through `shellInstallerFailureScript`, which produces byte-identical bodies (fact 4). The PowerShell failures already use `windowsInstallerFailureScript`. The enrolled scripts are unchanged.
- **Statuses and headers:** both match the per-route list above. The header values are identical to the shared constants (fact 5).
- **Errors:** a throw from `pendingBootstrapForCredential` still reaches `app.onError`, because the resolver does not catch it. Only a throw from `reconnectBootstrapForCredential` is caught and logged, with the same message and object.
- **Invalid header on PowerShell:** it still gets the expiry message, not the missing-enrollment message, because the resolver maps `invalid` to `expired`.
- **Route order:** `registerShortEnrollmentRoutes` stays at its current position in `server.ts`, just before `registerPrivateUpdateFeedRoutes`. The moved routes are registered first inside it, so their order relative to the install catch-all and the web shell does not change. `skeleton.test.ts:138-180` checks this.

One intended ordering difference: the shell route currently reads `install-machine.sh` before the credential lookup (`server.ts:1014`). After the change it reads the script only for the `absent` and `ready` outcomes, which matches what `/install.ps1` and `/m/:code` already do. This is observable only when the shipped asset is missing. In that case an expired credential would now get the 403 body instead of a 500. A missing asset is already a broken install. If a reviewer wants exact parity, read the script first in the shell handler, at a cost of one line.

Optional mechanical follow-up: rename the file to `routes/machine-installers.ts` and the function to `registerMachineInstallerRoutes`, because the module would then hold more than short-code routes. Keep that rename in its own checkpoint, or skip it.

Non-goals: no change to any message, status, header or URL; no new response headers (`x-content-type-options` stays on the browser page only); no change to `/m/:code`, its limiter or its 200 status; no unification of status policies across the routes; no change to `reconnect.ts` or `enrollments.ts`.

**Expected gain and cost**

All counts below are projections, because the change has not been implemented.

| Measure | Before | After |
|---|---|---|
| Credential → pending → reconnect → outcome flows | 2 (inline in `server.ts`) | 1 (`resolveCredentialBootstrap`) |
| Copies of the expiry message | 4 | 1 constant |
| Copies of the refresh-failure message and its warn log | 2 and 2 | 1 and 1 |
| Shell and PowerShell header definitions | 4 inline shell, 1 local PowerShell, plus 2 constants | 2 constants |
| Files a maintainer edits to change installer wording or the refresh rule | `server.ts` (2 places), and sometimes `short-enrollment.ts` | `short-enrollment.ts` (1 place) |

- **Handwritten production lines:** about 143 lines removed from `server.ts` (the 136 handler lines plus 7 import lines) and about 80 to 95 lines added to `short-enrollment.ts` (constants, union type, resolver, two compact handlers and imports, after formatting). That is a net reduction of about 45 to 65 lines. The basis is the line ranges above and the sketch. Moving the handlers is not itself a saving. The saving comes from the shared resolver, the shared constants and the reuse of the helpers.
- **Tests:** these add about 30 to 50 lines if the recommended refresh-failure test is added (see Verification). There are no changes to generated code, docs or assets.
- **Maintenance example:** today, changing the expired-credential wording, or making reconnect refresh return a new outcome, requires two matching edits in `server.ts` and a check that the shell and PowerShell copies still agree. After the change, there is one constant or one resolver branch, and each route's status policy can be read at its call site.
- **Cost:** one new union type and one function. No new dependency or layer.
- **Performance:** neutral. The same awaits run in the same order. The only difference is that the shell route skips one asset read on failure.

**Execution steps**

1. **Reconfirm the anchors.** Reconfirm against current `main`: `apps/server/src/server.ts` still has the inline `/install.sh` and `/install.ps1` handlers immediately before the `registerShortEnrollmentRoutes(...)` call, and `apps/server/src/routes/short-enrollment.ts` still exports `registerShortEnrollmentRoutes` with `MachineInstallerSources`. Re-plan if any of these has changed: a handler has gained route-specific behavior (rate limiting, telemetry, a new header), `/m/:code` has gained a reconnect fallback, or the statuses differ from this card. Run `rg -n "already been used, replaced, or expired|Could not refresh machine access|needs an enrollment command" apps/server/src` and confirm the hits match fact 3.
2. **Pin the refresh-failure contract before moving it.** No test currently covers it. Add one characterization test in `apps/server/test/public/public-host-enrollment.test.ts`, or in a new `apps/server/test/app/install-machine-refresh.test.ts`. The test creates a reconnect enrollment for an active host, as the existing reconnect test at `public-host-enrollment.test.ts:20` does, and makes the server-access repair fail. One option is `vi.spyOn` on the module that `reconnect.ts` uses for `serverAccess.repair`; another is the harness's own release or repair stub, if it has one. The test then asserts three things: `/install.sh` returns 503, its body equals `shellInstallerFailureScript("Could not refresh machine access. Run the command again, or generate a new one in Omnyo.")`, and the content type is `text/x-shellscript; charset=utf-8`. `/install.ps1` returns 200 with a body that starts with `throw 'Could not refresh machine access.`. Exactly one warn log reads "Could not refresh machine access". Run the test against the unchanged code and confirm it passes before you edit anything. If the repair cannot be made to fail without heavy harness work, export `resolveCredentialBootstrap` in step 3 and unit-test it with stub deps instead, and say so in the PR.
3. **Add the resolver and constants** to `apps/server/src/routes/short-enrollment.ts`: the three message constants, `CredentialBootstrap` and `resolveCredentialBootstrap`, exactly as sketched above. Import `readEnrollmentHeaderV1` from `../services/machines/enrollment-header-v1.js`, `reconnectBootstrapForCredential` from `../services/machines/reconnect.js`, and `type EnrollmentBootstrap` from `../services/machines/enrollments.js`. Confirm that `reconnect.ts`'s `Dependencies` parameter accepts `ServerAppDeps`; `server.ts` passes `deps` today, so it should.
4. **Move the handlers.** Inside `registerShortEnrollmentRoutes`, before `app.get("/m/:code", …)`, register `app.get("/install.sh", …)` and `app.get("/install.ps1", …)` with the per-route rendering described above. They read the scripts through `installers.shell()` and `installers.windows()`. In `apps/server/src/server.ts`, delete the two inline handlers and the now-unused imports: `enrolledInstallerScript`, `enrolledWindowsInstallerScript` and `windowsInstallerFailureScript` (delete the whole import block if it becomes empty), plus `reconnectBootstrapForCredential` and `readEnrollmentHeaderV1`. Keep the `registerShortEnrollmentRoutes(app, deps, { shell, windows })` call where it is. **Checkpoint:** typecheck, then run the targeted tests below.
5. **Optional rename** (separate checkpoint): `git mv apps/server/src/routes/short-enrollment.ts apps/server/src/routes/machine-installers.ts`, rename `registerShortEnrollmentRoutes` to `registerMachineInstallerRoutes`, and update its single import in `server.ts`. Run the typecheck again.
6. **Clean up and recount.** Format and lint the touched files, then run `git diff --stat` and confirm the projected net reduction against the 136-line baseline plus 7 import lines. Run `rg -n "text/x-shellscript" apps/server/src` and confirm it hits only `SHELL_HEADERS`. Run `rg -n "reconnectBootstrapForCredential\(" apps/server/src` and confirm one production call site.

**Verification and acceptance criteria**

The commands below come from the snapshot's `package.json` files. They were not run during this audit, because the snapshot has no `node_modules`.

- Typecheck, from `apps/server`: `pnpm run typecheck` (script `"typecheck": "tsc --noEmit"`).
- Targeted tests, from `apps/server` (script `"test": "vitest run --config vitest.config.ts"`; the config accepts explicit `src/**` or `test/**` file filters):
  `pnpm exec vitest run --config vitest.config.ts test/app/skeleton.test.ts test/app/install-machine-windows.test.ts test/public/public-host-enrollment.test.ts test/public/short-host-enrollment.test.ts src/services/machines/manual-enrollment-command.test.ts src/services/machines/enrollment-header-v1.test.ts`
  plus the new refresh-failure test from step 2. All of them must pass without edits to their existing assertions.
- Format and lint, from `$OMNYO_CHECKOUT`: `pnpm exec oxfmt <touched files>`, then `pnpm exec oxlint --deny-warnings --format=agent <touched files>`. The root has `.oxlintrc.json` and scripts `"format": "oxfmt ."` and `"lint": "turbo run lint"`. The per-file invocation is the global convention and was not checked against a repository script.
- Contract checks that must hold, each one asserted by an existing test or the new test:
  - `/install.sh` with no header returns 200 with the exact asset bytes and `text/x-shellscript; charset=utf-8`.
  - `/install.sh` with an invalid, superseded or used credential returns 403 with the expiry script, which exits 1 under `sh`.
  - A refresh failure returns 503 with the refresh script.
  - `/install.ps1` returns 200 in every case, with `throw 'This installer needs…` for a missing header and `throw 'This enrollment command has already been used…` for an invalid or unknown credential.
  - `/m/:code` behavior, its rate limiting and its browser page are unchanged.
- Structural completion: `server.ts` contains no `readEnrollmentHeaderV1` and no `reconnectBootstrapForCredential`, and has no inline installer handlers left. Each message string appears once in `apps/server/src`. The resolver is the only production caller of `pendingBootstrapForCredential` outside `enrollments.ts`.
- There is no UI change, so no visual check is needed. No performance comparison is needed, because the same async steps run.

**Rollback and stop conditions**

- **Rollback:** the change is two source files plus one test, with no persisted data, migration or protocol change. Reverting that one commit fully restores the previous behavior.
- **Stop conditions:**
  - An existing installer test needs an assertion change to pass. That means a status, header or body has drifted, so fix the code, not the test.
  - Some other module depends on the routes being defined inline in `server.ts`, such as a route-order assertion that fails because the `/install.*` routes must come before something registered between line 1068 and line 1134.
  - The reconnect-refresh rule is found to differ on purpose between the shell and PowerShell routes, for example a future product requirement that PowerShell skips refresh.
  - In any of these cases, fall back to the smaller alternative: keep the handlers in `server.ts`, but replace the literal messages and headers with shared constants and `shellInstallerFailureScript`.
