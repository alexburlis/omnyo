# RF-032 — Retire the app's private `HttpError` class and response-error parser in `apps/app/src/lib/api.ts`, and read every app response through the browser SDK transport

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds. The web app has a second error class and a second response-error parser beside `@omnyo/sdk`'s `OmnyoHttpError`, and error consumers test for both classes. The sweep overstated or misdescribed three points, corrected below. First, the browser SDK has no 75 s timeout. Second, voice upload and file preview should keep their raw `fetch`, because moving them to SDK area wrappers changes behaviour. Third, the two parsers differ in more places than the HTML 401/403 case.
- **Potential:** medium. One error class, one parser and three dual `instanceof` checks disappear. About 105 to 115 handwritten production lines go, net.
- **Confidence:** high on the mechanics, because every claim is proven by inspection. Medium on user-visible copy, because the error bodies that real proxies return were not observed.
- **Readiness:** conditional. Alex must decide one copy question before merge (gate G1 in the execution steps): whether the app may use the SDK's error wording for HTML and empty error bodies on the five affected endpoints.
- **Effort:** small to medium, about half a day to one day, including test updates.
- **Risk:** low to medium. The risk is limited to error wording and error classification on five endpoint families. Successful responses are unchanged.
- **Prerequisites:** none.
- **Related or overlapping:** RF-138 ("One transport-failure classifier for web and mobile") touches `isTransientReadError` and `isNetworkTransportError`, which call the same dual checks. Land RF-032 first or rebase RF-138 onto it; the two changes do not conflict in intent. RF-103 ("Read bounded server response bodies through one helper") is server-side and does not overlap.
- **Why it deserves its place:** today every new error consumer in the app has to remember two classes, and any change to server error bodies has to be mirrored in two parsers that already disagree. The fix is local to `apps/app`, needs no SDK or contract change, and removes a whole mechanism rather than moving it.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the audit brief had been removed, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` and searched with `git grep` at that commit. No tests were run: the snapshot has no `node_modules`.

*How the app talks to the server today (observed facts, proven by inspection).*

- `apps/app/src/lib/sdk.ts:7` builds the main client with `createBrowserOmnyoSdk({ baseUrl: BASE_URL, fetch: fetchWithAppSurface })` and exports it as `sdk`. Almost every app call goes through it. Its failures throw `OmnyoHttpError` from `packages/sdk/src/response.ts:84`, parsed by `readHttpErrorInfo` at `packages/sdk/src/response.ts:333`.
- `apps/app/src/lib/api.ts` keeps a second stack:
  - `HttpError` at `:29`, which has the same `status`, `body` and `"HTTP <status>: <message>"` message shape as `OmnyoHttpError`, but types `code?: string` where the SDK uses `code: string | null`;
  - `parseHttpError` at `:48`, `extractErrorCode` at `:93`, `throwHttpError` at `:105`, `requestResponse` at `:123` and `request<T>` at `:135`;
  - the helpers `HTML_DOCUMENT_PATTERN` at `:19` and `normalizeErrorText` at `:21`, which only that parser uses.
- `apps/app/src/lib/api-server.ts:7` creates a second typed Hono client, `apiClient`, with the same base URL and the same `fetchWithAppSurface` that the SDK transport uses. `apiClient` is also used only for `$url()` building in `file-content-urls.ts`, `attachment-diagnostics.ts`, `voice-diagnostics.ts`, `PluginUrlLink.tsx` and `managed-preview-link.tsx`. This card keeps `apiClient`; see the non-goals.

*Every place an `HttpError` is produced at runtime* (from `git grep -nE 'lib/api"|from "\./api"' e9e1b74c… -- apps packages plugins`; the only other `./api` hits are unrelated Tasks plugin and rename-script fixtures):

| Call site | Endpoint | Path through `api.ts` |
|---|---|---|
| `apps/app/src/hooks/mutations/host-mutations.ts:62` `useUpdateHostPermissionCeiling` | `PATCH /api/v1/hosts/:id/permission-ceiling` | `request<Host>` over `apiClient` (no SDK wrapper exists) |
| `apps/app/src/hooks/queries/sidebar-navigation-query.ts:35` `fetchSidebarNavigation` | `GET /api/v1/sidebar-bootstrap` | `request<SidebarBootstrapResponse>` over `apiClient` |
| `apps/app/src/lib/project-branch-options.ts:13` `readProjectBranchOptions` | `GET /api/v1/projects/:id/branch-options` | `request<ProjectBranchesResult>` over `apiClient` (the SDK only wraps `/branches`) |
| `apps/app/src/lib/api.ts:256` `transcribeVoiceInput` and `:280` `prepareVoiceInput`, called from `components/promptbox/usePromptVoice.ts:132,142` and `components/promptbox/VoiceInputTextarea.tsx:41,46` | `POST /api/v1/system/voice-transcription` and `.../prepare` | `postMultipart` or `request` over **raw global `fetch`** plus `appSurfaceRequestInit` |
| `apps/app/src/lib/api.ts:164` `loadFilePreview`, reached through `getThreadStorageFilePreview` and `getThreadHostFilePreview` (`thread-queries.ts`), `environment-queries.ts:25`, `project-queries.ts:11` and `host-file-preview-query.ts:2` | raw-content URLs with a `Range` header | `throwHttpError` and `requestResponse` over **raw global `fetch`** plus `appSurfaceRequestInit` |

*Where the app tests for both classes* (from `git grep -nw HttpError`, which found no hits in `packages/` or `plugins/` and no use of the `"HttpError"` name string outside one test label):

- `apps/app/src/lib/http-error.ts:7` `asHttpError` returns `HttpError | OmnyoHttpError | null`, and `getHttpErrorMessage` at `:13` accepts that union. `asHttpError` is called by `mutation-errors.ts:40,132`, `ThreadStorageFilePreview.tsx:90,116`, `provider-cli-install-store.ts:186` and `app-update-presentation.ts:219`.
- `apps/app/src/hooks/queries/query-helpers.ts:59` in `isTransientReadError` and `:88` in `shouldRetryTransientReadQuery`.
- `apps/app/src/lib/lifecycle-errors.ts:441` in `parseLifecycleError`.
- `isQueuedMessageNotFoundError` (`http-error.ts:36`) and `isEmptyAttachmentRejection` (`attachment-diagnostics.ts:62`) already check only `OmnyoHttpError`. That is correct today because their endpoints go through the SDK. It also shows the trap: a new check written against one class silently misses errors of the other.

*The two parsers disagree in more places than the sweep listed* (proven by inspection of `api.ts:48-91` and `response.ts:333-380`; `extractErrorMessage` is `packages/core-ui/src/unknown-helpers.ts:9`):

| Error response body | App `parseHttpError` message | SDK `readHttpErrorInfo` message |
|---|---|---|
| Empty | `statusText \|\| "Request failed"`, body `undefined` | `statusText`, body `null`. Browsers report an empty `statusText` over HTTP/2, so the message becomes `"HTTP 500: "`. `getHttpErrorMessage` then returns `null`, and the caller's own fallback copy shows. |
| HTML document (`<!doctype html` or `<html`), status 401 or 403 | `"Authentication failed"` | `statusText \|\| "Request failed with status 401"` |
| HTML document, other status | `statusText \|\| "Request failed"` | `statusText \|\| "Request failed with status N"` |
| Any other non-JSON body starting with `<` | the raw text | the generic status message |
| JSON with `message` or `detail` | that value | the same value |
| JSON with only an `error` string | the raw JSON text | the `error` value (the SDK passes `legacyKeys: ["detail", "error"]`) |
| JSON body with `code: ""` | `code` is `undefined` | `code` is `""` |

No test pins the app parser's wording. `apps/app/src/lib/api.test.ts` (123 lines) covers only successful `loadFilePreview` range handling. `git grep -n "Authentication failed"` finds only `api.ts:80` and an unrelated title in `views/AuthCallbackView.tsx:10`. The SDK parser is pinned by `packages/sdk/test/response.test.ts:218-318`, including "falls back to statusText for HTML error bodies".

*Corrections to the sweep report.*

- **No timeout change.** `DEFAULT_CORE_REQUEST_TIMEOUT_MS` is applied only in `packages/sdk/src/node.ts:56` and in two server plugin callers. `createBrowserTransport` (`packages/sdk/src/browser.ts:27`) and `createHttpTransport` (`packages/sdk/src/transport-http.ts:11`) add no timeout, so long voice uploads are not affected.
- **Do not route voice upload or file preview through `fetchWithAppSurface`.** Both paths call the global `fetch` today. `fetchWithAppSurface` (`apps/app/src/lib/app-surface.ts:42`) adds boot-read serving and, on the web surface, `reloadForGateReauth` (`apps/app/src/lib/gate-reauth.ts:13`), which reloads the page on a gate 401. A reload after a recording finished would drop the in-memory audio that the voice retry path (`useVoiceInput.ts:722` `transcribeRecording`) keeps for another attempt. Usage telemetry is not affected either way: `usageRequestEligible` (`packages/domain/src/usage-telemetry.ts:219`) does not match these paths. `sdk.system.transcribeVoice` (`packages/sdk/src/areas/system.ts:495`) uses `transport.fetch`, which is `fetchWithAppSurface` in the app. It also adds behaviour of its own:
  - an empty-file pre-check that throws a plain `Error`, which `voiceHttpStatus` (`voice-diagnostics.ts:177`) would then classify as `transport_error` instead of `http_error`;
  - a zod parse of the response;
  - no prompt trimming.

  This card therefore keeps the app's voice and preview wrappers and changes only how they turn a response into an error.
- **No SDK publication question.** `packages/sdk/package.json` is `"private": true` at this snapshot, and the plan needs no new SDK export: `createBrowserTransport` and `createOmnyoSdk` are already exported from `@omnyo/sdk/browser` (`browser.ts:27,52`). `OmnyoSdkTransport` exposes `api`, `readJson`, `readVoid` and `resolve` (`packages/sdk/src/transport.ts:10-26`).
- **`sdk.projects.sidebarBootstrap` is an exact replacement.** It calls the same route through the same transport (`packages/sdk/src/areas/projects.ts:744`), and its result type is `SidebarBootstrapResponse` (`projects.ts:211`). Boot-read serving still applies, because both paths use `fetchWithAppSurface`.

*Maintenance cost today:* every error consumer must test for both classes. A server change to error bodies must be mirrored in two parsers. The `code` typing differs (`undefined` against `null`). The same server failure already shows different wording depending on which client made the call.

**Proposed end state and preservation argument**

What disappears from `apps/app/src/lib/api.ts`: `HTML_DOCUMENT_PATTERN`, `normalizeErrorText`, `HttpError`, `parseHttpError`, `extractErrorCode`, `throwHttpError`, `requestResponse` and `request`. In other files, the `HttpError` half of `asHttpError`, of `getHttpErrorMessage`'s parameter type, of the two `query-helpers.ts` checks and of `parseLifecycleError` goes too.

What remains, and who owns it:

- A new module, `apps/app/src/lib/sdk-transport.ts`, owns one browser transport:

  ```ts
  import { createBrowserTransport } from "@omnyo/sdk/browser";
  import { fetchWithAppSurface } from "./app-surface";
  const BASE_URL = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  export const sdkTransport = createBrowserTransport({ baseUrl: BASE_URL, fetch: fetchWithAppSurface });
  ```

  `lib/sdk.ts` builds `browserSdk` with `createOmnyoSdk({ transport: sdkTransport })` instead of `createBrowserOmnyoSdk(...)`; both are exported from `@omnyo/sdk/browser`, and `createBrowserOmnyoSdk` is exactly `createOmnyoSdk({ context, transport: createBrowserTransport(args) })` (`browser.ts:39-46`). The transport lives in its own module because 94 app test files mock `@/lib/sdk` or `@/lib/api` with factories, and a new export on `@/lib/sdk` would be missing from those mocks.
- `OmnyoHttpError` becomes the only HTTP error class in the app. `readHttpErrorInfo` becomes the only parser.
- `loadFilePreview` keeps its raw `fetch` calls, its `Range` header and its 416 handling. It replaces `throwHttpError(sample)` with `await sdkTransport.resolve(Promise.resolve(sample))` on a non-ok sample, and `requestResponse(fetch(...))` with `sdkTransport.resolve(fetch(...))`.
- `transcribeVoiceInput` and `prepareVoiceInput` keep their raw `fetch`, field trimming and fire-and-forget behaviour. `postMultipart` returns `sdkTransport.readJson(fetch(...))` with a type cast to `T`.
- The three typed-route callers use `sdkTransport.readJson(sdkTransport.api.v1.<route>.$method(...))`. The exception is the sidebar query, which calls `sdk.projects.sidebarBootstrap({ signal })`.

Preserved contracts: the request URLs, methods, bodies, headers, `cache` modes, the boot-read and gate-reauth coverage of each path (unchanged per path), the success payloads, error `status` and `body` (so lifecycle-error parsing, 404 "not found" file states, retryable bodies and `threads_running` parsing all keep working), and the `"HTTP <status>: <message>"` message prefix that `getHttpErrorMessage` and the voice `sanitizeErrorMessage` (`useVoiceInput.ts:142`) strip.

Intentional differences, which gate G1 must accept: for these five endpoint families, the error wording follows the SDK table above. The HTML 401/403 message `"Authentication failed"` goes away, and empty bodies show each caller's own fallback copy instead of `"Request failed"`. This is the wording the rest of the app already shows for the same server failures through `sdk.*`.

Non-goals:

- Adding SDK wrappers for `permission-ceiling` or `branch-options`.
- Replacing `api-server.ts`'s `apiClient` (optional follow-up: `sdkTransport.api.v1` is built from identical arguments, but about six tests mock `./api-server`).
- Moving voice to `sdk.system.transcribeVoice`. That needs its own decision about gate-reauth reloads and diagnostic classification.
- Changing SDK error wording.

**Expected gain and cost**

- Observed baseline: `apps/app/src/lib/api.ts` has 316 lines and `apps/app/src/lib/http-error.ts` has 43. The deletable block (`api.ts:19-24` and `:29-142`, which keeps `requestOptions` at `:25-27` because `sidebar-navigation-query.ts` and `project-branch-options.ts` still pass signals) is 120 physical lines, or 97 non-blank. This was counted with a `node -e` slice of `git show e9e1b74…:apps/app/src/lib/api.ts`.
- Projected additions: about 7 lines for `sdk-transport.ts` and 1 or 2 changed lines in `sdk.ts`. The caller edits in `host-mutations.ts`, `sidebar-navigation-query.ts` and `project-branch-options.ts` are about line-neutral. The dual checks shrink by 4 conditions and one import each in `http-error.ts`, `query-helpers.ts` and `lifecycle-errors.ts`.
- Projected net: about 105 to 115 handwritten production lines removed from `apps/app` (an estimate, not a measurement). Mechanisms: two error classes become one, two parsers become one, two `code` conventions become one, and two independent Hono-client error stacks become one transport.
- Tests: about seven test files switch `new HttpError({...})` to `new OmnyoHttpError({..., code: <value or null>, body: <value or null>})`. One parameterized row (`query-helpers.test.ts:79`) disappears because its class is gone; the `OmnyoHttpError` row keeps the obligation. `sidebar-navigation-query.test.tsx` changes its mock target. Two new `loadFilePreview` error tests are added. The net test-line change is about zero.
- Performance: neutral by construction. No timeout, no extra wrapper, no extra body read, and the same `fetch` per path. Success bodies are read with `response.json()` instead of `text()` followed by `JSON.parse`, which is equivalent for valid JSON. This is unmeasured.
- Maintenance effect: a future error-body change, such as a new `code` shape, is made once in `packages/sdk/src/response.ts`. A new error consumer checks one class.

**Execution steps**

1. **Reconfirm the baseline.** In a fresh worktree at or after the snapshot, rerun these searches (use `${C}:path`, not `$C:path`, in zsh):
   - `git grep -nw HttpError -- apps packages plugins`
   - `git grep -nE 'from "(@/lib/api|\./api)"' -- apps/app/src`
   - `git grep -n "DEFAULT_CORE_REQUEST_TIMEOUT_MS" -- packages/sdk/src`

   Re-plan if any of these holds:
   - `HttpError` appears outside `apps/app`, for example in `packages/plugin-sdk`, a plugin, or `apps/mobile` native code;
   - the browser transport has gained a timeout;
   - a new `request()` caller has appeared;
   - `createBrowserTransport` is no longer exported from `@omnyo/sdk/browser`.
2. **Gate G1 (owner decision, before any edit).** Ask the owner: "For the permission-ceiling, sidebar-bootstrap, branch-options, voice-transcription and file-preview requests, may error messages follow the SDK wording? An HTML 401 or 403 page would read 'Request failed with status 401' instead of 'Authentication failed', and an empty error body would show each screen's own fallback text instead of 'Request failed'." The options are:
   - (a) accept the SDK wording (recommended);
   - (b) teach `readHttpErrorInfo` the 401/403 HTML mapping, which also changes CLI and plugin messages and needs a matching case in `packages/sdk/test/response.test.ts`;
   - (c) stop.

   Without an answer, do not merge.
3. **Add the missing characterization tests first.** Add them to `apps/app/src/lib/api.test.ts` and watch them pass against the old code:
   - `loadFilePreview` rejects with an error whose `status` is 404 and whose `body` is the parsed JSON when the sample request returns `404` with `{"code":"not_found","message":"File not found"}`;
   - the same assertion when the sample is a 206 text sample and the follow-up full fetch returns `500` with a JSON body;
   - a 416 sample still resolves to an empty preview (already covered at `:108`; keep it).

   Assert `status`, `body` and `message` (which must contain `"File not found"`), and not the class, so the tests prove that behaviour survives the class swap.
4. **Checkpoint A: add the transport.**
   - Create `apps/app/src/lib/sdk-transport.ts` as shown in the end state.
   - In `apps/app/src/lib/sdk.ts`, replace `createBrowserOmnyoSdk({ baseUrl: BASE_URL, fetch: fetchWithAppSurface })` with `createOmnyoSdk({ transport: sdkTransport })`, then drop the now-unused `BASE_URL` and `fetchWithAppSurface` import.
   - Keep the `sdk` override object and the `OmnyoHttpError` re-export unchanged.
   - Run the app typecheck.
5. **Checkpoint B: move the callers.**
   - `hooks/queries/sidebar-navigation-query.ts:30` `fetchSidebarNavigation`: call `sdk.projects.sidebarBootstrap({ signal })` inside `readSidebarNavigation(...)`. Remove the `apiClient`, `request` and `requestOptions` imports.
   - `hooks/mutations/host-mutations.ts:58` `useUpdateHostPermissionCeiling`: make `mutationFn` return `sdkTransport.readJson(sdkTransport.api.v1.hosts[":id"]["permission-ceiling"].$patch({ param: { id: hostId }, json: { maxPermissionMode } }))`. If the inferred body type is not `Host`, annotate it as `Promise<Host>`. Remove the `apiClient` and `request` imports.
   - `lib/project-branch-options.ts:8` `readProjectBranchOptions`: return `sdkTransport.readJson(sdkTransport.api.v1.projects[":id"]["branch-options"].$get({ param: { id: projectId }, query }, requestOptions(signal)))` and keep the `ProjectBranchesResult` return type. Remove the `apiClient` import.
   - `lib/api.ts` `loadFilePreview`: at `:186`, replace `await throwHttpError(sample)` with `await sdkTransport.resolve(Promise.resolve(sample))`; at `:214`, replace `requestResponse(...)` with `sdkTransport.resolve(...)`. Keep both raw `fetch` calls exactly as they are.
   - `lib/api.ts` `postMultipart` and `prepareVoiceInput`: replace `request<T>(fetch(...))` with `sdkTransport.readJson(fetch(...)) as Promise<T>`, and keep the raw `fetch`, `toRelativeUrl`, field trimming and `.catch(() => {})`.

   Run the app typecheck and the focused tests listed below.
6. **Checkpoint C: delete the legacy machinery.**
   - In `lib/api.ts`, delete `HTML_DOCUMENT_PATTERN`, `normalizeErrorText`, `HttpError`, `parseHttpError`, `extractErrorCode`, `throwHttpError`, `requestResponse` and `request`. Drop the `extractErrorMessage` and `toRecord` imports if they are now unused, and import `sdkTransport` from `./sdk-transport`.
   - In `lib/http-error.ts`, make `asHttpError(error: unknown): OmnyoHttpError | null` return `error instanceof OmnyoHttpError ? error : null`, make `getHttpErrorMessage` take `OmnyoHttpError`, and remove the `./api` import.
   - In `hooks/queries/query-helpers.ts:59,88`, reduce the two checks to `error instanceof OmnyoHttpError` and remove the `@/lib/api` import.
   - In `lib/lifecycle-errors.ts:441`, reduce the check to `!(error instanceof OmnyoHttpError)` and remove the `./api` import.
7. **Checkpoint D: update the tests without weakening them.** Swap `HttpError` for `OmnyoHttpError` in:
   - `components/secondary-panel/FilePreview.test.tsx:20,970,1021`, passing `code: null, body: null` where the old test omitted them;
   - `hooks/mutations/thread-interaction-mutations.test.tsx:6,31`;
   - `lib/lifecycle-errors.test.ts:3,19-26,555`, and rename the test title "parses HttpError bodies" to "parses OmnyoHttpError bodies";
   - `lib/mutation-errors.test.ts:5,124,151,176,232`.

   In `hooks/queries/query-helpers.test.ts:77-93`, delete the `HttpError` row and keep the `OmnyoHttpError` row with every assertion. In `hooks/queries/sidebar-navigation-query.test.tsx:12,38-46,238-322`, replace the `@/lib/api` `request` mock and the `@/lib/api-server` mock with a `vi.mock("@/lib/sdk", ...)` whose `sdk.projects.sidebarBootstrap` is a `vi.fn()`. Keep every expectation, including `toHaveBeenCalled` and the pending-forever cases. `usePromptVoice.test.tsx` and `thread-queries.test.tsx` mock functions that survive, so they need no change.
8. **Clean up and review.**
   - Confirm that `git grep -nw HttpError -- apps/app/src` matches only `OmnyoHttpError`, and that `git grep -nE '\brequest(<|\()' -- apps/app/src | grep '@/lib/api\|\./api'` is empty.
   - Read the complete diff for stray edits.
   - Recount `wc -l apps/app/src/lib/api.ts apps/app/src/lib/http-error.ts apps/app/src/lib/sdk-transport.ts` against the 316 + 43 baseline.

**Verification and acceptance criteria**

Commands. The script names were read from `apps/app/package.json` and the root `package.json` at the snapshot. They were not executed, because the snapshot has no `node_modules`.

- `cd apps/app && pnpm typecheck` (script `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`) must pass.
- `cd apps/app && pnpm exec vitest run --config vitest.config.ts src/lib/api.test.ts src/lib/lifecycle-errors.test.ts src/lib/mutation-errors.test.ts src/hooks/queries/query-helpers.test.ts src/hooks/queries/sidebar-navigation-query.test.tsx src/hooks/mutations/thread-interaction-mutations.test.tsx src/components/secondary-panel/FilePreview.test.tsx src/components/promptbox/usePromptVoice.test.tsx src/hooks/queries/thread-queries.test.tsx` must pass. The `test` script is `vitest run --config vitest.config.ts`; passing file filters through `pnpm exec vitest` is standard Vitest usage, but it was not run here.
- `cd packages/sdk && pnpm test` must pass and stay unchanged, unless G1 chose option (b).
- Run `pnpm exec oxfmt <changed files>`, then `cd apps/app && pnpm lint`, which runs `oxlint src ...`. The repository-wide `pnpm lint` runs `turbo run lint`.

Behaviour checks that can catch the realistic regressions:

- The `loadFilePreview` error tests from step 3 pass before and after the change. A 404 still renders the "not found" state (`ThreadStorageFilePreview.tsx:116`, covered by the `FilePreview.test.tsx` 404 case), and a 413 or 502 still shows the server message.
- A host-offline lifecycle body still parses (`isHostDisconnectedError`, covered by `thread-interaction-mutations.test.tsx`), and retryable bodies still retry (`query-helpers.test.ts`).
- The sidebar query still writes and reads the bootstrap cache and keeps its placeholder behaviour (`sidebar-navigation-query.test.tsx`).
- Manual check, because Alex tests UI himself: record and transcribe one voice note, open a thread-storage file and a host file preview, change a host's permission ceiling in Settings, and open a branch picker. Each must behave as before. To exercise one error path, stop the host daemon and open a host file preview; the panel must show an error message, not a blank state.

Structural completion: `HttpError`, `parseHttpError`, `throwHttpError`, `requestResponse` and `request` no longer exist. `asHttpError` names only `OmnyoHttpError`. Every app response that turns into an HTTP error goes through `readHttpErrorInfo`.

Performance: no benchmark is needed. Request count, `fetch` implementation per path and body reads are unchanged.

**Rollback and stop conditions**

- Rollback boundary: one commit that touches only `apps/app` files. No persisted data, contract or SDK export changes (unless G1 chose option (b), which then touches `packages/sdk/src/response.ts` and its test, and must land as a separate commit). A revert restores the old behaviour completely.
- Stop when any of the following holds:
  - Alex rejects the wording change in G1 and also rejects option (b);
  - `HttpError` or `request` turns out to have a consumer outside `apps/app/src`, such as a plugin bundle or a mobile WebView bridge;
  - the typed `$patch` or `$get` result for `permission-ceiling` or `branch-options` is not a `Response`-like value that `readJson` accepts;
  - a characterization test from step 3 fails after the swap.
- Safer smaller alternative, if G1 blocks the wording change: keep only `parseHttpError`'s wording as a small local `messageFor(response, rawBody)` wrapper and still throw `OmnyoHttpError`. This removes the second class and all dual checks (about 40 lines) but keeps the second parser. Its value is lower, so record it as a partial outcome.
