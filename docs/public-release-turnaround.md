# Shorten the Omnyo release from verified source to production

## Plan Metadata

Schema: 2
Kind: feature
State: complete
Risk: high
Boundary: external-or-stateful
Mutation: local

## Purpose / Big Picture

Ship from one verified application commit. Start the coordinator handoff as soon
as the runtime is built, while the Mac package goes through Apple notarization.
Once the approved Mac archive and feed are ready, publish those same bytes.
Let report-only audits finish on their own schedule unless the operator makes
one a release prerequisite.

## Scope Contract

Requested outcome: Eliminate repeated release preparation and allow coordinator staging and Mac preparation to overlap. Target 12–15 minutes for a comparable release with the restart window already available.
In scope: Public Mac release preparation, receipt-backed publication, an immutable runtime checkpoint, focused test fixtures, release instructions and a local experiment in batching independent audit findings.
Out of scope: Publishing a new version during development, broadening public plugin or platform distribution, changing chat interruption policy, and rewriting the audit criteria.
Authority: The current request authorizes local implementation and verification. The earlier 1.0.183 production approval applies to that existing build.
Acceptance signal: Promotion accepts verified bytes for the approved source and version and invokes zero build or notarization actions. The isolated audit fixture retains every finding and evidence obligation while reducing verifier launches.

## Current Facts and Sources

- Omnyo 1.0.183 reached the verified public Mac feed about 12 minutes after
  the release commit `7112fd7a0` on November 26. This is one release result.
- The preceding coordinator request sat behind active work for over two
  hours. A report-only audit had 149 verification checks, typically with 12
  running. Source reconciliation and the user-requested audit gate accounted
  for elapsed time outside the Mac publisher.
- `scripts/public-mac-release.mjs` prepares and publishes the signed Mac build.
  Its existing `--prepare` mode creates a ZIP and feed. A later publication
  rebuilds them in a new directory, since it has no contract for accepting
  prepared output.
- The private coordinator's publisher already verifies a protected stage job,
  native imports, host signatures and coverage of live web and plugin files.
  The 1.0.183 handoff consumed bytes compiled during the public Mac build.
  Retain that delivery mechanism and keep private release inputs local.

## Plan of Work

1. Freeze verified app changes in the clean release checkout and check both
   version files. Land audit reports independently. Preserve the operator's
   right to make a particular audit a release prerequisite.
2. Keep one compiler lane. Check the runtime version, protocol, digest and
   web source revision. Copy the verified runtime inventory into release
   output and emit its receipt after verifying the copy.
3. Prepare the Mac app through signing, notarization, Gatekeeper and feed
   generation. Copy the checked ZIP to the output directory and save a receipt
   that identifies the commit, version, protocol, destination and artifact hashes.
4. Add a promotion mode. Check the clean source and fresh public main again.
   Read the prepared receipt and compare both artifacts before uploading.
   Keep the versioned ZIP immutable. Verify alias and versioned bytes before
   replacing and checking the feed.
5. Group audit findings by source owner and overlap before verification. Keep
   separate IDs, complete evidence, independent high-risk review and all
   distinct verdicts. Verify coverage and launch count on one fixed fixture.
6. Measure from approved code freeze to the later of the verified public feed
   and the verified live coordinator with chats resumed. Record runtime
   readiness, notarization, staging, activation and gate delay separately.
   Compare releases with equivalent audit, approval and restart prerequisites,
   using the same warm-machine and concurrency conditions. Include preparation
   within the timed window. Keep the current release's audit delay visible.

## Validation and Acceptance

### Before-state baseline

Proof ID: publisher-baseline
Artifact: scripts/public-mac-release.test.mjs and the 1.0.183 publication record
Command: node --test scripts/public-mac-release.test.mjs
Expected signal: The existing suite passes, with separate preparation and publication effects that cannot reuse a prepared receipt.

### Post-change behavioral proof

Proof ID: publisher-promotion
Artifact: scripts/public-mac-release.test.mjs with temporary artifacts and a recorded effect transport
Command: node --test scripts/public-mac-release.test.mjs
Expected signal: Preparation produces a reusable receipt. Promotion performs zero compile or notarization actions, rejects changed bytes and stale source before upload, and verifies the feed only after both ZIP paths. Local tests measure those eliminated actions. Production timing requires a later authorized release.

### Production timing

Artifact: One receipt per measured release with freeze, runtime, notarization, feed, staged and live timestamps.
Command: Run the documented release sequence for an authorized version and capture its phase timestamps with the existing provider and runtime readbacks.
Expected signal: A comparable baseline and candidate complete the same delivery and recovery checks. Claim a 10× improvement only if the observed total supports it. A slower operator gate stays in the total.

## Context / Tool Boundary

Run from the public source checkout. Notarization still uses the existing
external credential overlay and protected runner. GitHub writes belong to
the exact approved Mac version and download/update channel. The coordinator
operator stages and offers the runtime separately through the existing signed
workflow. Make restart decisions after reading current work ownership and
the operator's approved interruption window.

## Interfaces and Dependencies

- `pnpm public:mac-release --prepare --credential-overlay PATH --output-dir PATH`
  prepares the standard release and writes its receipt.
- `pnpm public:mac-release --promote --output-dir PATH` reuses a closed receipt
  without loading the notarization overlay or invoking a build.
- `runtime-prepared.json` binds the independently verified runtime snapshot,
  exact public source, runtime digest and protocol for the protected stage
  producer. It is ready before the desktop build starts.

## Idempotence and Recovery

Finish the local receipt before accepting it for publication. Treat a missing
receipt as an incomplete build. If the source or bytes change, decline before
upload. If a versioned ZIP is already present, compare it before proceeding.
Never overwrite differing bytes at the immutable versioned path. During an
ambiguous upload, read back the release assets before any retry and include the
expected digest in that decision. Restart and rollback remain with the existing
coordinator owner.

## Concrete Steps

1. Add characterization tests with a locally hashed prepared archive and feed.
2. Add source-bound runtime and closed Mac receipts to the existing preparations.
3. Add promotion-only mode and verify source, receipts and publication order.
4. Run the focused publisher suite, formatting, lint and an offline invocation.
5. Update the desktop release instructions. Record the timing target and the
   next production measurement separately from the local result.
6. Measure the audit plan on a frozen labelled fixture. Check every ID, its
   coverage and its assigned independent review before comparing launch counts.
   A live end-to-end audit comparison remains a distinct measurement.

## Review Record

### Release integrity

Reviewer: Codex release-integrity reviewer
Scope: Source admission, artifact integrity, protected credentials and interrupted publication
Plan revision: November 26 reviewed release design
Evidence inputs: Public publisher and notary source at 7112fd7a0, existing coordinator stage and delivery contracts, and signed predecessor receipts
Disposition: Accepted. The reviewer confirmed the final timing and immutable runtime changes preserve release integrity. The implementation includes a closed credential-redactor failure case.

### Timing and audit coverage

Reviewer: Codex audit-throughput reviewer
Scope: Measurement boundaries, equivalent audit coverage, release operation and acceptance
Plan revision: November 26 reviewed release design
Evidence inputs: Release scope, timing proof, immutable runtime contract, prior release evidence and active audit phase counts
Disposition: The initial timing blocker was closed by timing both live surfaces under equivalent prerequisites and making production measurement distinct from local behavior checks.

## Progress

- [x] Verified the baseline publisher and reproduced the unavailable promotion mode.
- [x] Verified the signed 1.0.183 runtime inventory and source marker from its real compiled output.
- [x] Exercised promotion with temporary artifacts and corrected the credential redactor's exit handling.
- [x] Grouped 30 labelled findings into three primary verifier batches while preserving each original record and separate independent-review assignments.
- [x] Passed 29 publisher and runtime checkpoint tests, scoped lint and formatting.

## Outcomes & Retrospective

The publisher now prepares the Mac archive once, keeps a verified runtime
snapshot for coordinator staging and supports publishing the prepared archive
later. The checkpoint was run against the compiled 1.0.183 runtime and
verified its 2,558-file inventory. The tests exercised the release commands
with temporary artifacts, including modified data, newer source or feed,
previous uploads and a failed credential redactor.

The audit fixture reduced primary verifier launches from 30 to 3 while
keeping all 30 records and their review assignments. That is a reduction
in launched verifier jobs on this fixture. It establishes neither an
elapsed-time speedup nor equivalent model judgment on a live audit.

The release wait included a second audit of the same scope. Before starting
workers, the audit workflow now checks for a matching completed or active
audit and reserves its output directory. Additional findings belong in a
separate supplement.

An authorized production run is needed to measure the complete new release
path. Record the gate delay, publication and coordinator confirmation under
the same prerequisites used for the baseline.
