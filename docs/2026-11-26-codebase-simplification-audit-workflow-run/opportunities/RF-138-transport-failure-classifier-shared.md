# RF-138 — Replace four hand-maintained fetch-failure message lists in the web app and mobile app with one shared matcher in `@omnyo/core-ui`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication and drift are real, but the gain is smaller than the sweep estimated. The four sites hold 46 non-blank lines of message-matching logic, and the expected net reduction is about 25 production lines.
- **Potential:** low. This is a small piece of duplicated knowledge, but the lists have already drifted, and the drift produces visible differences: the same transport failure gets different retry and toast behaviour on the web and on mobile.
- **Confidence:** high for the facts (proven by inspection). Medium for the claim that the union of messages is harmless, because that claim rests on knowledge of runtime error wording, not on a run.
- **Readiness:** conditional. The extraction makes three small, intentional behaviour changes (listed under the end state below), and Alex must accept them first. Retry policy is out of scope, so it needs no decision for this card.
- **Effort:** small, about 1 to 2 hours including tests.
- **Risk:** low. The worst realistic regression is an error that is not a transport failure but contains one of the phrases being shown as "Could not reach the server" or being retried twice.
- **Prerequisites:** none.
- **Related and overlapping:** RF-032 ("Retire the app's second HTTP client and HttpError") edits the same `HttpError` branches in `apps/app/src/hooks/queries/query-helpers.ts` and the `asHttpError` call in `apps/app/src/lib/mutation-errors.ts`. The two changes are independent, but whichever lands second must rebase onto the first. No other RF item touches these files.
- **Why it deserves its place:** the change leaves one canonical list of runtime fetch-failure wordings in place of four. It fixes the existing drift as a side effect. It is low on the list because the code is small and stable.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. The files cited below are byte-identical between that snapshot and `main` at `5f2d3f895` (checked with `git diff --stat`, which printed no differences).

When `fetch` fails before an HTTP response arrives (the server is down, the network dropped, or DNS failed), each runtime throws a `TypeError` with its own wording:

| Wording | Runtime |
|---|---|
| "Failed to fetch" | Chromium, including Electron |
| "Load failed" | Current WebKit |
| "NetworkError…" | Firefox |
| "Network request failed" | React Native |
| "The network connection was lost.", "Could not connect to the server." | Older WebKit and iOS URL-loading errors |
| "fetch failed" | Node's undici |

The runtime assignments are background knowledge (Hypothesis, not re-measured in this audit). Omnyo's clients recognise these messages so that they can retry reads and show friendly copy. Four places do this by hand.

Observed sites (Proven by inspection):

1. `apps/app/src/hooks/queries/query-helpers.ts:54` "isTransientReadError". It returns true for `name === "AbortError"` and false for `HttpError` or `OmnyoHttpError`. It then matches 3 message fragments (lines 63-75), using a private "normalizeErrorMessage" helper (lines 50-52). `shouldRetryTransientReadQuery` at line 78 additionally retries HTTP errors whose `body.retryable === true`. It has these consumers:
   - `apps/app/src/lib/query-client.ts:143`, the default query `retry`;
   - `apps/app/src/hooks/queries/thread-queries.ts`, which sets `retry: shouldRetryTransientReadQuery` at lines 787, 848, 890, 918, 1202 and 1463;
   - `apps/app/src/views/thread-detail/ThreadDetailView.tsx:873` and `apps/app/src/components/thread/timeline/useThreadTimelineController.ts:1203`, which both pass `isRecoverableLoadingError: isTransientReadError(...)`. That value decides whether the thread view shows a recovering state or an error state.
2. `apps/app/src/lib/mutation-errors.ts:39` "isNetworkTransportError" (private). It returns false for HTTP errors (`asHttpError`) and for aborts, then matches the same 3 fragments (lines 44-56). `getMutationErrorMessage` (line 138) uses it to replace the message with `NETWORK_TRANSPORT_ERROR_MESSAGE` ("Could not reach the server. Check that it is running and try again."). The local `normalizeMessage` helper is also used at lines 99, 148 and 193, so it stays.
3. `apps/mobile/src/lib/query/query-client.ts:11` "isTransientReadError". It returns false for `OmnyoHttpError` and true for `AbortError` or `TimeoutError`. It then matches 7 fragments (lines 21-32), with "fetch failed" matched by `startsWith`. It is used by `shouldRetryTransientReadQuery` (line 35), which `createProfileQueryClient` wires in (line 50). That client is consumed by `apps/mobile/src/lib/sdk/client-registry.ts:76` and `apps/mobile/src/app-shell/ProfilesProvider.tsx:55`. This file has no test.
4. `apps/mobile/src/lib/session/auth-error.ts:25` "mapAuthError". After the `ConnectListError`, `OmnyoHttpError`, response-like and status checks, it maps `AbortError` and `TimeoutError` to `"network"` and then matches 5 fragments (lines 51-63) without collapsing whitespace. It has two consumers:
   - `apps/mobile/src/data/connect/enrollment.ts:91`: `describeEnrollmentError` turns `"network"` into the title "Could not reach Omnyo connect"; anything else gets the title "Pairing failed".
   - `apps/mobile/src/lib/session/session-scheduler.ts:122`, which only checks for `"auth-required"`, so a message-list change cannot affect it.

The lists have drifted (Proven by inspection):

| Fragment | web query | web mutation | mobile query | mobile auth |
|---|---|---|---|---|
| failed to fetch | yes | yes | yes | yes |
| load failed | yes | yes | yes | yes |
| networkerror | yes | yes | yes | yes |
| network request failed | no | no | yes | yes |
| network connection was lost | no | no | yes | yes |
| could not connect to the server | no | no | yes | no |
| fetch failed (prefix) | no | no | yes | no |
| whitespace collapsed | yes | yes | yes | no |

Line count (Reproduced): `git show <snapshot>:<file> | sed -n '<range>p' | grep -cv '^\s*$'` gives these non-blank line counts:

- `query-helpers.ts` lines 50-52: 3; lines 63-75: 10;
- `mutation-errors.ts` lines 44-56: 10;
- mobile `query-client.ts` lines 21-32: 11;
- `auth-error.ts` lines 51-63: 12.

That is 46 handwritten production lines in total.

Searches and counterevidence:

- A `git grep -n -i -E 'failed to fetch|network ?request failed|networkerror|load failed|TimeoutError'` over `*.ts` and `*.tsx` at the snapshot, excluding tests and stories, found no other client-side message list. The remaining hits are product copy, server-side timeout classes, the `split-load.ts` dynamic-import regex (a different failure class) and `apps/mobile/src/lib/profiles/probe.ts:35`, which only checks names. That probe is a name-only timeout check and is out of scope.
- `plugins/thread-list/app/ui/mutation-errors.ts:65` "isNetworkTransportError" is a fifth copy. It must stay: `docs/forkable-plugins.md` (line 22) forbids plugins from importing workspace packages other than `@omnyo/plugin-sdk`, and `plugins/thread-list/package.json` does not depend on `@omnyo/core-ui`. Exporting a 15-line helper from the plugin SDK would require a minimum-SDK-version bump. That is rejected as a poor trade.
- `@omnyo/core-ui` is private (`"private": true`), is consumed from source, is already a dependency of both apps (`apps/app/package.json:27`, `apps/mobile/package.json:24`), and already holds `toRecord` and `extractErrorMessage` in `packages/core-ui/src/unknown-helpers.ts`. No published or external consumer is involved.
- No persisted data, route, setting or CLI contract depends on these functions.
- The SDK's own timeout error, `OmnyoRequestTimeoutError` (`packages/sdk/src/response.ts:68`), is produced only by `createRequestTimeoutFetch`. Only the Node entry (`packages/sdk/src/node.ts:56`) and server plugin code use that function, so neither client sees it from queries. It is not relevant here.

The maintenance cost today: when a runtime changes its wording, or a new runtime appears, four lists must be found and edited, and the drift above shows that this has not happened consistently.

**Proposed end state and preservation argument**

What remains: one exported function in `packages/core-ui/src/unknown-helpers.ts`, re-exported from `packages/core-ui/src/index.ts`.

```ts
// Runtime wordings for a fetch that failed before any HTTP response.
const FETCH_TRANSPORT_FAILURE_FRAGMENTS = [
  "failed to fetch", // Chromium
  "load failed", // WebKit
  "networkerror", // Firefox
  "network request failed", // React Native
  "network connection was lost", // older WebKit / iOS
  "could not connect to the server", // older WebKit / iOS
] as const;

export function isFetchTransportFailureMessage(error: unknown): boolean {
  const record = toRecord(error);
  if (!record || typeof record.message !== "string") return false;
  const message = record.message.replace(/\s+/g, " ").trim().toLowerCase();
  return (
    message.startsWith("fetch failed") || // Node undici
    FETCH_TRANSPORT_FAILURE_FRAGMENTS.some((f) => message.includes(f))
  );
}
```

The function matches messages only. Each caller keeps its own policy in front of the call and stays the owner of that policy:

- the `AbortError` handling (transient for queries, excluded for mutation toasts);
- `TimeoutError` (mobile only);
- the `HttpError` and `OmnyoHttpError` exclusion;
- `body.retryable` (web queries only);
- `ConnectListError` and status mapping (mobile auth).

What disappears: the four inline fragment lists, the private "normalizeErrorMessage" helper in `query-helpers.ts`, and the message-block body of each function. All exported names and signatures stay: `isTransientReadError` and `shouldRetryTransientReadQuery` in both apps, `getMutationErrorMessage`, `isAbortLikeError`, and `mapAuthError`.

There are three intentional behaviour changes, which are the conditional gate:

1. **Web queries:** messages that contain "network request failed", "network connection was lost" or "could not connect to the server", or that start with "fetch failed", now count as transient. Effect: up to 2 retries at 250 ms (`TRANSIENT_READ_RETRY_COUNT`, `TRANSIENT_READ_RETRY_DELAY_MS`). The thread detail view and timeline show their recovering state instead of the error state for such errors.
2. **Web mutation toasts:** the same messages now show "Could not reach the server. Check that it is running and try again." instead of the raw text.
3. **Mobile pairing:** an error whose message starts with "fetch failed" or contains "could not connect to the server" now maps to `"network"`. The pairing error then reads "Could not reach Omnyo connect" instead of "Pairing failed". Auth messages also get whitespace collapsed before matching.

Mobile query retry behaviour does not change: its list already equals the union.

Why these are acceptable: each newly matched phrase is a known transport-failure wording, and none of the callers can see an HTTP error in that branch, because the HTTP errors are filtered out first. The realistic false positive would be an app-thrown, non-HTTP `Error` whose message happens to contain one of these phrases. The snapshot search above found none in client code. The `startsWith` form for "fetch failed" avoids matching words such as "prefetch failed".

Non-goals, which ship separately if Alex wants them:

- Making mobile honour `body.retryable` (ISS-X1-04). No server-side `retryable: true` body that mobile reads was identified. The hits in `apps/server/src/internal/session.ts:86` and `:170` are host-daemon session routes. So this is currently a Hypothesis gap, not a demonstrated defect.
- Making web queries treat `TimeoutError` as transient (ISS-X1-03).
- Changing abort semantics anywhere.
- Touching the thread-list plugin copy.

This is the simplest sufficient option. A shared list with per-caller subsets would keep the drift, and a typed transport error in the SDK transport would need changes to every fetch path and to the published SDK. A message-only helper in an existing private shared package is the smallest owner.

**Expected gain and cost**

- **Observed baseline:** 46 non-blank production lines of matching logic across 4 sites, with 4 lists of 3 to 7 fragments.
- **Projected after the change:**
  - about 16 lines of new helper code;
  - 1 changed export line in `index.ts`;
  - 4 one-line call sites, and the `query-helpers.ts` import line gains one name.
  - The net reduction is about 25 production lines, plus one list instead of four (plus the forced plugin copy).
- **Tests:** add about 20 to 30 lines in a new `packages/core-ui/test/unknown-helpers.test.ts`, because `core-ui` has no test for `unknown-helpers` today. The existing app and mobile tests stay unchanged.
- **Performance:** neutral by construction. The helper runs a single string normalisation and up to 7 `includes` checks, and it runs only on error paths. Nothing was measured.
- **Maintenance gain:** a new runtime wording becomes a one-line edit in one file, and the web and mobile apps cannot disagree on what a transport failure is.

**Execution steps**

1. **Reconfirm.** On the target branch, check that the four functions still have the shape described: `apps/app/src/hooks/queries/query-helpers.ts` "isTransientReadError", `apps/app/src/lib/mutation-errors.ts` "isNetworkTransportError", `apps/mobile/src/lib/query/query-client.ts` "isTransientReadError" and `apps/mobile/src/lib/session/auth-error.ts` "mapAuthError". Re-run the search `git grep -n -i -E 'failed to fetch|network request failed|networkerror|load failed' -- '*.ts' '*.tsx' ':!*.test.*'` for any new list. If RF-032 has landed, the `HttpError` branches will have changed; keep whatever HTTP exclusion is current. Re-plan if a site has gained a different policy that is mixed into the message block, or if `@omnyo/core-ui` is no longer a dependency of both apps.
2. **Gate.** Present the three behaviour changes above to Alex and get acceptance. If Alex rejects the union for the web, stop. The only remaining option that removes duplication would be per-caller subsets, which is not worth doing.
3. **Add the helper.** In `packages/core-ui/src/unknown-helpers.ts`, add `FETCH_TRANSPORT_FAILURE_FRAGMENTS` (not exported) and `isFetchTransportFailureMessage` as shown above. In `packages/core-ui/src/index.ts`, change the last export to `export { extractErrorMessage, isFetchTransportFailureMessage, toRecord } from "./unknown-helpers.js";`. Add `packages/core-ui/test/unknown-helpers.test.ts`, which must cover:
   - each fragment in mixed case;
   - collapsed whitespace;
   - "fetch failed" matching only as a prefix ("prefetch failed" stays false);
   - non-record and non-string-message input returning false;
   - an `Error("Unexpected parse error")` returning false.
4. **Web query (checkpoint A).** In `apps/app/src/hooks/queries/query-helpers.ts`:
   - delete "normalizeErrorMessage";
   - in "isTransientReadError", replace lines 63-75 with `return isFetchTransportFailureMessage(error);`, keeping the `AbortError` check and the `HttpError`/`OmnyoHttpError` exclusion above it, in the same order;
   - add the name to the existing `@omnyo/core-ui` import.
5. **Web mutation (checkpoint A).** In `apps/app/src/lib/mutation-errors.ts` "isNetworkTransportError", keep the first `if` (the HTTP and abort exclusion) and replace the rest with `return isFetchTransportFailureMessage(error);`. Keep `normalizeMessage`, because three other callers use it. Then run the app checks listed below.
6. **Mobile query (checkpoint B).** In `apps/mobile/src/lib/query/query-client.ts` "isTransientReadError", keep the `OmnyoHttpError` exclusion and the `AbortError`/`TimeoutError` branch, and replace lines 21-32 with `return isFetchTransportFailureMessage(record);`.
7. **Mobile auth (checkpoint B).** In `apps/mobile/src/lib/session/auth-error.ts` "mapAuthError", replace the `if (typeof record.message === "string") { … }` block (lines 51-63) with `if (isFetchTransportFailureMessage(record)) return "network";`. Leave the status checks and the name checks before it in place. Then run the mobile checks listed below.
8. **Leave the plugin copy alone.** Do not touch `plugins/thread-list/app/ui/mutation-errors.ts`. Optionally add a one-line comment there naming `isFetchTransportFailureMessage` as the canonical list to mirror. That is the only edit allowed in the plugin.
9. **Final review.** Inspect the full diff: confirm no fragment literal remains in the four files (`git grep -n -i 'load failed' -- apps/app/src apps/mobile/src ':!*.test.*'` should return nothing from these files). Recount the lines against the baseline of 46.

**Verification and acceptance criteria**

The script names were read from the snapshot's `package.json` files. No command was run in this audit, because the snapshot has no `node_modules`.

- `packages/core-ui`: `pnpm exec vitest run --config vitest.config.ts` and `pnpm run typecheck`. The `test` and `typecheck` scripts exist. The config includes `test/**/*.test.ts`.
- `apps/app`: `pnpm exec vitest run --config vitest.config.ts src/hooks/queries/query-helpers.test.ts src/lib/mutation-errors.test.ts src/lib/query-client.test.ts`, then `pnpm run typecheck` and `pnpm run lint`. These scripts exist. The file-filter form of `vitest run` is standard Vitest, but it was not run here.
- `apps/mobile`: `pnpm exec vitest run --config vitest.config.ts src/lib/session/auth-error.test.ts src/data/connect/enrollment.test.ts src/lib/session/session-scheduler.test.ts`, then `pnpm run typecheck` and `pnpm run lint`. These scripts exist, and the config includes `src/**/*.test.ts`.
- From the repository root: `pnpm exec oxfmt <changed files>` and `pnpm exec oxlint --deny-warnings --format=agent`, as the global instructions require for Oxc projects.

Expected outcomes:

- All existing assertions pass unchanged. In particular:
  - `query-helpers.test.ts:133` ("matches browser transport failures but not HTTP responses");
  - the retryable-body cases at lines 95-131;
  - `mutation-errors.test.ts:167-174`;
  - `auth-error.test.ts:40` and `:44`;
  - `enrollment.test.ts:102-104`.
- Do not edit existing expectations.
- Optionally add one assertion per behaviour change so that the change is recorded:
  - in `query-helpers.test.ts`, `isTransientReadError(new TypeError("Network request failed"))` is true;
  - in `mutation-errors.test.ts`, "The network connection was lost." yields the friendly copy.

There is no UI change beyond the toast text and the recovering-versus-error state for the newly matched messages. Alex tests UI himself, so no screenshot round is needed.

Structural completion: there is exactly one fragment list in `apps/` and `packages/`, in `packages/core-ui/src/unknown-helpers.ts`, plus the documented forkable-plugin copy, and every caller's policy branches are untouched.

**Rollback and stop conditions**

- **Rollback:** the change is a single commit touching 6 to 8 files, with no persisted data or wire contract involved. Reverting it restores the four lists exactly.
- **Stop if:**
  - Alex declines any of the three behaviour changes;
  - a caller turns out to rely on a phrase being *not* transient (for example, a test or a code path that throws "Network request failed" deliberately on the web expecting raw copy). The snapshot search found none in production code. `apps/app/src/lib/plugin-sdk-hooks.test.ts:104` uses it only as an error cause in a test, and the step-1 search must re-check this;
  - `@omnyo/core-ui` gains a published consumer that makes adding an export a versioned change.
- **Smaller alternative:** if the web union is declined, share the helper only between the two mobile sites. This saves about 10 lines and fixes the mobile auth drift, but leaves two web lists.
