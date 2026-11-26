# RF-103 — One stream-collection loop for the host daemon's bounded server-body readers

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, but the sweep overstated what can be shared. Only the streaming loop (read, count, check, collect, cancel on failure, concatenate) is common. The size validators and their error messages differ in wording and in check order, so they stay with each caller.
- **Potential:** low. About 20 to 30 handwritten production lines disappear, and one duplicated mechanism becomes one.
- **Confidence:** high. Every claim below was checked against the source at the snapshot.
- **Readiness:** ready.
- **Effort:** about 1 to 2 hours, including one new regression test.
- **Risk:** low. The change touches one file and two internal call paths. The main hazard is changing an error message or the order of size checks; the plan keeps both unchanged.
- **Prerequisites:** none. The attachment reader's missing cancellation is a separate bug fix (see newIssues in this run's structured output, referred to by the sweep as ISS-S10-04 / ISS-006). Land that fix as its own commit before the consolidation, as step 3 describes.
- **Related or overlapping RF items:** none. `apps/host-daemon/src/server-move/download.ts` has a third bounded reader, but it streams to a file, reports progress and throws typed `CommandDispatchError` codes, so it stays out of scope. Other bounded readers live in other packages (`packages/sdk/src/explore.ts:711` "readBoundedBody", `apps/web/src/analytics/server.ts:71` "readBoundedBody"); sharing across packages would add a dependency for a few lines and is not proposed.
- **Why it deserves its place:** the two copies have already drifted. Only the host artifact reader cancels the stream when a size check fails. One owner for the loop removes that class of drift. The gain is small, so the item should rank near the bottom of ready work.

**Context and evidence**

The host daemon downloads two kinds of server-supplied bytes into memory: project attachments that a prompt references, and plugin host artifacts (bundled plugin worker code). Both downloads must bound memory and verify the received size. Snapshot: commit e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e (origin/main on 2026-11-26). The snapshot worktree was not present on disk, so files were read with `git show e9e1b74c3:<path>`.

Observed facts (Proven by inspection):

- `apps/host-daemon/src/server-client.ts:319-355` "readProjectAttachmentBytes" (37 lines) reads `response.body` with `getReader()`, adds each chunk's length to `totalBytes`, calls `validateProjectAttachmentPartialByteLength` (`:283-301`) after every chunk, then calls `validateProjectAttachmentFinalByteLength` (`:303-317`) and copies the chunks into one `Uint8Array`. The loop has no `try`/`catch`, so a failed size check throws without calling `reader.cancel()`.
- `apps/host-daemon/src/server-client.ts:398-446` "readHostArtifactBytes" (49 lines, exported) runs the same loop with `validateHostArtifactPartialByteLength` (`:357-371`), wraps it in `try`/`catch` that calls `await reader.cancel(error).catch(() => undefined)` (`:426-429`), then checks for an exact length and concatenates the chunks the same way.
- Callers: `fetchProjectAttachment` (`:607-648`) runs a content-length pre-check through `parseContentLength` (`:269-281`) and `validateProjectAttachmentFinalByteLength` (`:635-641`), then calls the reader (`:643`). `fetchPluginHostArtifact` (`:663-684`) rejects `expectedByteLength > HOST_ARTIFACT_MAX_BYTES` before fetching (`:664-668`), runs `assertHostArtifactContentLength` (`:373-396`) and calls the reader (`:683`). Both are reached from `apps/host-daemon/src/app.ts:1054-1058`, `:1140-1144` and `:1150-1154` through `runSessionRequest`, which rethrows errors unchanged (`app.ts:440-455`).
- Command used to recount lines: `sed -n '319,355p' | wc -l` gives 37, `sed -n '398,446p' | wc -l` gives 49, the four validators (`:283-317`, `:357-396`) give 75, and the whole range `:269-446` gives 178.

Contract differences that a shared helper must not erase:

| Aspect | Project attachment | Host artifact |
| --- | --- | --- |
| Expected size | optional (`expectedSizeBytes?: number` in `apps/host-daemon/src/project-attachments.ts:1-2`) | required (`expectedByteLength`) |
| Missing `response.body` | runs the final check with 0 and returns an empty array, so an empty body is valid when no size is expected | always throws `Host artifact length mismatch: expected N, received 0` |
| Check order per chunk | expected size first, then `maxBytes` | `maxBytes` first, then expected size |
| Message wording | `Project attachment size mismatch: expected N bytes, received …`, `Project attachment exceeds N byte limit: received X` | `Host artifact length mismatch: expected N, received …`, `Host artifact exceeds the N byte limit` |
| Cancel on failed check | no | yes |

Because wording and order differ per message, a single validator driven by a label (the sweep's `describe: (kind) => message` idea) would need four message functions and an order switch per caller. That is not simpler than today's validators, so this card keeps them.

Consumers and contracts searched: `git grep -n -e readHostArtifactBytes -e readProjectAttachmentBytes -e "Host artifact length mismatch" -e "Host artifact exceeds" -e "Project attachment size mismatch" -e "Project attachment exceeds" e9e1b74c3 -- .` over the whole repository. The only hits outside `server-client.ts` are in `apps/host-daemon/src/server-client.test.ts`: it imports `readHostArtifactBytes` (`:9`), asserts `/exceeds the .* byte limit/u` and a single `cancel` call for a chunked artifact (`:491-515`), rejects oversized artifacts before fetching (`:470-489`), and asserts `"Project attachment size mismatch"` (`:543-568`). The `@omnyo/host-daemon` package is private and exports only `./test` (`apps/host-daemon/package.json`), so no SDK, plugin SDK or external plugin consumes these functions. No string matching on these messages was found in `apps/host-daemon/src` outside the file (search: `git grep -n -E "mismatch|byte limit" e9e1b74c3 -- apps/host-daemon/src`). Error messages may still appear in logs and in thread errors, so they are treated as observable behavior and kept unchanged.

Maintenance cost today: any change to chunk handling, such as adding cancellation, abort support or a preallocated buffer, needs two matching edits, and the cancellation edit has already been made in only one copy.

**Proposed end state and preservation argument**

One internal helper in `apps/host-daemon/src/server-client.ts` owns the read loop:

```ts
async function collectBoundedBody(
  body: ReadableStream<Uint8Array>,
  checks: {
    afterChunk: (totalBytes: number) => void;
    atEnd: (totalBytes: number) => void;
  },
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      checks.afterChunk(totalBytes);
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  checks.atEnd(totalBytes);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
```

What remains:

- `readProjectAttachmentBytes` keeps its missing-body branch and calls `collectBoundedBody(response.body, { afterChunk: (n) => validateProjectAttachmentPartialByteLength(args, n), atEnd: (n) => validateProjectAttachmentFinalByteLength(args, n) })`.
- `readHostArtifactBytes` keeps its exported signature `(response, expectedByteLength, maxBytes = HOST_ARTIFACT_MAX_BYTES)`, its missing-body throw, and calls the helper with `validateHostArtifactPartialByteLength(expectedByteLength, n, maxBytes)` after each chunk and its exact-length check (the message at `:431-435`) at the end.
- All four validators, `parseContentLength`, `assertHostArtifactContentLength` and both content-length pre-checks stay as they are.

How current semantics survive:

- The end-of-stream check runs before the result buffer is allocated, exactly as today in both readers.
- Each caller passes its own validators, so message text and check order are unchanged.
- `readHostArtifactBytes` keeps its export, default parameter and cancel-on-failure behavior, so the existing test at `server-client.test.ts:491-515` still applies without change.
- The project attachment reader gains cancellation on a failed check. That is a behavior change (a bug fix), so it lands first in its own commit (step 3), and the consolidation commit is then behavior-neutral.

Non-goals: do not change any error message; do not merge the validators; do not touch `apps/host-daemon/src/server-move/download.ts`; do not add body cancellation to the content-length pre-check rejections (that is part of the separate incidental finding and needs its own decision and test); do not share the helper across packages.

**Expected gain and cost**

- Before: two copies of the read, collect, concatenate loop (86 lines across the two readers), with different cleanup.
- After: one helper of about 28 lines, plus two thin readers of about 10 and 18 lines. Projected net reduction: about 20 to 30 handwritten production lines. This is a projection, not a measurement; recount after the edit. The sweep's estimate of 30 to 45 lines assumed the validators could merge, which this card rejects.
- Tests: plus about 25 lines for the new attachment cancellation test (step 3). No generated code, docs or assets change.
- Mechanisms: two bounded stream loops become one; cancellation behavior has one owner.
- Performance: neutral by inspection. The same reads, checks and one final allocation happen in the same order; the only addition is one callback call per chunk. No benchmark is needed for a change of this size.

**Execution steps**

1. Reconfirm the anchors. In the checkout you work in, open `apps/host-daemon/src/server-client.ts` and confirm `readProjectAttachmentBytes`, `readHostArtifactBytes`, the four validators and the two `fetch*` callers still match the Context section. Stop and re-plan if a third caller of either reader appears, if the validators have already been merged, if either reader now streams to disk or reports progress, or if a package outside `apps/host-daemon` imports `readHostArtifactBytes`. Check with `rg -n "readHostArtifactBytes|readProjectAttachmentBytes" apps packages plugins`.
2. Record the baseline. From the repository root, run the host-daemon test file (command in the next section) and note that it passes.
3. Commit 1, the bug fix: add cancellation to the attachment path.
   - In `apps/host-daemon/src/server-client.test.ts`, add a test next to "rejects project attachment responses with unexpected byte length" (`:543`). It returns, from `fetchFn`, a `Response` built on a `ReadableStream` whose `pull` enqueues 16-byte chunks up to 32 times and whose `cancel` is a `vi.fn()`, with no `content-length` header. Call `client.fetchProjectAttachment({ maxBytes: 64, projectId: "project-1", threadId: "thread-1", path: "big.bin" })` and assert that it rejects with `"Project attachment exceeds 64 byte limit"`, that fewer than 32 chunks were emitted and that `cancel` was called once. Run it and watch it fail on the `cancel` assertion.
   - In `readProjectAttachmentBytes`, wrap the loop in the same `try`/`catch` with `reader.cancel(error)` that `readHostArtifactBytes` uses at `:426-429`. Run the test file again and see it pass. Commit this alone.
4. Commit 2, the consolidation, which changes no behavior:
   - Add `collectBoundedBody` (signature above) directly above `readProjectAttachmentBytes`.
   - Replace the loop and concatenation in `readProjectAttachmentBytes` with one call to the helper. Keep the `if (!response.body)` branch unchanged.
   - Replace the loop, `try`/`catch`, exact-length check and concatenation in `readHostArtifactBytes` with one call to the helper. Pass the existing exact-length check (same message) as `atEnd`. Keep the export, the default `maxBytes` and the `if (!response.body)` throw unchanged.
   - Leave `validateProjectAttachmentPartialByteLength`, `validateProjectAttachmentFinalByteLength`, `validateHostArtifactPartialByteLength`, `assertHostArtifactContentLength` and `parseContentLength` unchanged.
5. Format and lint the two changed files, run the checks in the next section, and read the whole diff. It must touch only `apps/host-daemon/src/server-client.ts` and `apps/host-daemon/src/server-client.test.ts`, and there must be no second `getReader()` loop left in `server-client.ts` (`rg -n "getReader\(\)" apps/host-daemon/src/server-client.ts` should print one line). Recount lines with `git diff --stat` against the baseline commit.

**Verification and acceptance criteria**

These commands come from `apps/host-daemon/package.json` (`test`, `typecheck`) and the root `package.json` (`format`, `format:check`) and `.oxlintrc.json` at the snapshot. They were not run during the audit, because the snapshot has no `node_modules`.

- Tests, from the repository root: `pnpm --filter @omnyo/host-daemon exec vitest run --config vitest.config.ts src/server-client.test.ts`. Expected: every existing test passes, including "stops a chunked host artifact response at the byte limit", "rejects oversized host artifacts before fetching them", "rejects project attachment responses with unexpected byte length", and both "fetches project attachment bytes over HTTPS" and "fetches project attachment bytes over loopback HTTP"; the new attachment cancellation test passes after commit 1 and still passes after commit 2.
- Types, from the repository root: `pnpm --filter @omnyo/host-daemon typecheck`. Expected: no errors.
- Format and lint, from the repository root: `pnpm exec oxfmt apps/host-daemon/src/server-client.ts apps/host-daemon/src/server-client.test.ts`, then `pnpm exec oxlint --deny-warnings --format=agent apps/host-daemon/src/server-client.ts apps/host-daemon/src/server-client.test.ts`. The host-daemon package has no `lint` script of its own, so the root `oxlint` with the repository's `.oxlintrc.json` is the check. Expected: no findings.
- Contract checks: every error string listed in the Context table is byte-identical before and after (`git diff` must show no change to a template string). The order of checks per chunk is unchanged for each caller. `readHostArtifactBytes` keeps its exported signature.
- Structural completion: `server-client.ts` contains exactly one read loop (`collectBoundedBody`); both readers call it; cancellation on a failed check exists only in the helper.
- UI: none affected. Performance: no measurement required, as argued under Expected gain.

**Rollback and stop conditions**

- Rollback: commits 1 and 2 are independent and reversible with `git revert`. Neither touches persisted data, protocols or public exports, so reverting has no compatibility effect. Reverting commit 1 restores the leak-prone attachment path, so revert commit 2 alone if only the refactor is in doubt.
- Stop if any existing test in `server-client.test.ts` needs its expected message or expected order changed to pass; that means the helper altered behavior.
- Stop if the helper needs a third callback or mode flag to serve a caller; at that point it is no simpler than two loops, so keep commit 1 and drop commit 2.
- Stop if a consumer outside `apps/host-daemon` is found for `readHostArtifactBytes`; keep its signature and re-plan the export.
- Stop if the attachment cancellation test from step 3 cannot be made to fail before the fix (for example because a newer runtime already cancels the stream); then record that finding and land only the consolidation.
