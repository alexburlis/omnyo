# Incidental findings

These are behavior-changing issues observed or raised during the source audit. Evidence and user impact determine their disposition. The linked simplification cards preserve current behavior unless a separate fix is scoped and verified first.

| Priority | Meaning                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------ |
| P0       | Confirmed active or imminent severe impact, such as broad outage or unrecoverable data loss.     |
| P1       | Urgent high-impact failure in a core path, or a serious reachable reliability or security issue. |
| P2       | Bounded correctness, reliability, accessibility or performance issue with meaningful impact.     |
| P3       | Limited edge case or lower-impact issue.                                                         |

## Backlog in priority order

| Priority                 | Issue                                                                                                                                   | Evidence and next check                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| P2, provisional exposure | [ISS-200 · Orphan storage retention](server-issues.md#iss-200--orphan-removal-bypasses-the-thread-storage-retention-check)              | Different retention rules confirmed in source. Confirm with a disposable host fixture and preserve both receipt checks. |
| P2                       | [ISS-201 · Callback source state](server-issues.md#iss-201--callback-readers-classify-the-same-source-differently)                      | Readers disagree on active commands/workflows and precedence. Confirm all overlapping states in one synthetic DB.       |
| P2                       | [ISS-300 · Fake backend hook lifecycle](provider-issues.md#iss-300--fake-backend-host-accepts-a-fresh-hook-registration-after-disposal) | Test harness and production apply different checks. Characterize fresh and duplicate registration after disposal.       |
| P3                       | [ISS-001 · CLI settings metadata](#iss-001--cli-plugin-config-json-drops-descriptor-metadata)                                           | Parser discrepancy reproduced. Confirm the intended JSON contract before changing output.                               |
| P3                       | [ISS-002 · Skill preview code fences](#iss-002--skill-preview-chunking-can-split-a-code-fence)                                          | Split reproduced in an isolated helper. Verify the preview keeps mixed fence markers inside one code block.             |
| P3                       | [ISS-100 · Desktop channel diagnostic](client-issues.md#iss-100--desktop-invalid-channel-error-omits-a-supported-channel)               | Error text omits `public-beta` on invalid input. Verify the local diagnostic fixture.                                   |
| P3, provisional          | [ISS-101 · Source install classification](client-issues.md#iss-101--canonical-source-checkout-is-classified-as-a-fork)                  | The documented upstream is classified as a fork. Confirm the intended official source policy before changing it.        |

## ISS-001 — CLI plugin config JSON drops descriptor metadata

**P3, observed at the parser, high confidence.** The SDK and server contract describe plugin setting capabilities. The CLI `plugin config --json` success path passes the `apps/cli/src/commands/plugin.ts` `pluginSettingsResultSchema` result to `outputMutationJson`. Its local descriptor parser strips `experimental_multiline` and `experimental_placeholder` as well as `experimental_optionLabels` and section descriptions. Script callers reading `schema` receive a narrower shape than the API. The text CLI still formats the fields it explicitly supports. Whether structured output should expose the extra fields is a compatibility decision, and no user impact was independently measured.

**Reproduced in isolation.** Running the pinned CLI and server descriptor schemas with the installed Zod and a synthetic string descriptor produced only `type`, `label` and `experimental_section.title` in the CLI parse. The server parse retained the multiline setting, placeholder and section description. The shell did not invoke the product CLI or use customer settings.

**Proposed fix and verification.** If the CLI is intended to expose server descriptors, update its success JSON contract deliberately. Add a fixture in `apps/cli/src/__tests__/command-output/plugin-config.test.ts` for one string descriptor and one select descriptor. Assert the full metadata survives on `--json` and compare text output, error envelopes, exit codes and secret redaction with the current baseline. Inspect consumers that validate exact property sets before shipment. Coordinate with [RF-002](opportunities/RF-002-cli-plugin-settings-client.md) while keeping behavior verification independently attributable.

## ISS-002 — Skill preview chunking can split a code fence

**P3, observed in the chunker, high confidence.** `apps/app/src/components/tools/SkillDetailView.tsx` renders each chunk independently through `FilePreview`. `splitMarkdownIntoChunks` treats a line beginning with either three backticks or three tildes as a fence toggle. That rule accepts a tilde marker as a close for an open backtick fence. Once the chunk has enough lines, a blank line can split the still-open fence and the next preview renders its continuation in isolation. The effect is confined to sufficiently long Markdown skill previews containing mismatched fence markers.

**Reproduced in isolation.** The pinned helper, invoked with a synthetic backtick opener, 118 code lines, a tilde marker, a blank line, another code line and the real closer, returned two chunks of 121 and 2 lines. The final code line moved into the second chunk. Browser rendering was outside this check.

**Proposed fix and verification.** Track the opener's marker and run length, or use fence boundaries from the existing Markdown parser if it can supply them without additional parsing cost. Keep the current one-pass split and lazy preview behavior. Extend `apps/app/src/components/tools/detail-page-recipes.test.tsx` with mixed marker, longer opener and ordinary chunk boundaries. Run `pnpm --filter @omnyo/app test src/components/tools/detail-page-recipes.test.tsx` from the repo root with dependencies installed. Compare the visible fenced text and scroll behavior on the skill preview before changing other Markdown rendering paths.
