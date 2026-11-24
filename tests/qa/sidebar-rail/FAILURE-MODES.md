# Sidebar rail browser proof

The owner is the real AppSidebar with its built app CSS in the existing isolated
frontend-loading fixture. This proof adds no production export or runtime flag.
The existing Usage component tests retain ownership of credit confirmation,
saved reset attempts, expand/collapse and provider refresh behavior.

Before implementation, these failures must be observable in Chrome:

- A taller footer card must not increase the distance between Settings and the
  bottom of the footer. The original centered Settings cell fails this check.
- Usage and Resources must be reachable through the existing left rail or its
  More menu at desktop and narrow widths.
- Neither plugin may insert its old card into the chat footer.
- Usage must retain weekly bars and its account detail control.
- Resources must retain its dashboard and the exact running/queued fixture counts.
- The narrow viewport must remain free of horizontal page overflow.
- The live readings rail must stay between 56px and 60px wide.
- Each account is a 24-28px ring gauge with its reading centered inside the
  ring; two accounts of one provider share a row.
- Resource labels and exact counts must fit on single lines without clipping;
  only the host name may wrap, to at most two lines.
- The readings scroll area must accept keyboard focus at short heights.
- A legacy Resources overlay must not duplicate live rail readings in the chat
  footer. Its exact portal container is hidden only while live rail counts exist;
  other footer content and a disabled Resources contribution remain visible.

`readings-layout.mjs` measures the rendered rail and checks these geometry
contracts. The existing isolated component fixture can import the same checks
for a matched before/after comparison with synthetic readings.

`proof.mjs` exports `installSidebarRailPluginFixtures` and
`runSidebarRailProof`. The parent owns Chrome and the local HTTP fixture.
Install the fixture routes on a fresh page before its first navigation, using
the actual newly built Usage and Resources app directories. After navigation
to the seeded thread, run the proof. It writes a JSON report and screenshots
to a new evidence directory, then removes only its own temporary DOM child.

Example inside the existing frontend fixture, after timing has finished:

```js
const rail = await import(absoluteProofModule);
const fixture = await rail.installSidebarRailPluginFixtures(page, {
  usageDirectory: absoluteUsageBundleDirectory,
  resourcesDirectory: absoluteResourcesBundleDirectory,
});
await page.goto(origin + threadPath);
await rail.runSidebarRailProof(page, absoluteEvidenceDirectory, fixture);
```

The RPC replies are explicitly synthetic, read-only UI data. These checks do not
submit resource jobs, call a provider, redeem a credit, activate a plugin or
establish native UI behavior. Non-loopback requests remain blocked by the owning
frontend fixture. The parent binds the app build and records baseline/candidate
results; a candidate pass alone is not a reproduced regression.

The parent Vitest harness imports `pluginListResponseSchema` from `@omnyo/server-contract` and passes `validateRegistry: body => pluginListResponseSchema.parse(body)` to the installer. The response must validate before plugin loading; the fixture performs only read-only snapshot and overview calls.
