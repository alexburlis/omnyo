---
name: fastloop-verification
description: Specify browser checks and evaluate FastLoop verification evidence, with a portable manual path when no compatible public runtime is available.
license: MIT
---

# FastLoop verification

Use this skill to turn a browser goal into explicit checks and report only what the evidence establishes. Runtime execution requires an installed, authorized FastLoop version with public documentation for its interface. This skill supplies no executable, hosted service, credentials, or undocumented adapter.

## Bind the target and scope

Record the exact application origin, page or build identity when observable, browser, test account type, and allowed mutations. Prefer local development fixtures. Keep credentials in the runtime's documented protected-input mechanism, never in goals, screenshots, logs, or ordinary model text.

Confirm the runtime can perform the required browser actions and return evidence before starting. Select one documented entry point, such as the available SDK, CLI, or tool interface. Do not submit the same task through several entry points to see which returns first.

If a compatible public runtime is unavailable, use the same check contract with an already available authorized browser tool or a manual run. Label that method explicitly; it is not a FastLoop runtime result. Do not install an unknown package or guess commands to fill the gap.

## Write observable requirements

Describe initial state, action, expected observation, and persistence check. A toast can show that the interface accepted an action; it does not prove saved state after reload.

This fictional fixture is a verification worksheet, not a FastLoop API payload:

```json
{
  "goal": "Save a display preference in a local sample app",
  "allowedEffects": ["Change one disposable fixture account's preference"],
  "checks": [
    {
      "id": "save-theme",
      "initial": "Preference is Light",
      "action": "Select Dark and save",
      "expected": "The control shows Dark after reload"
    },
    {
      "id": "keep-unrelated-preference",
      "initial": "Locale is English",
      "action": "Reload after saving the theme",
      "expected": "Locale remains English"
    }
  ]
}
```

Set a bounded run duration and a terminal completion signal. Keep the original requirements stable through a fix so a later pass addresses the same behavior. Add a requirement only when the user changes scope or new evidence exposes a missing acceptance condition; label that addition.

## Execute and read the evidence

Use current page observations to choose targets. After an action, wait for the expected state instead of repeatedly clicking. Capture the smallest evidence that establishes the result: an observed control value, a persistence read, a relevant screenshot, or a scoped response.

Read every required check and the terminal verdict. Use the runtime's own documented meanings, and distinguish:

- **Passed:** the required observation was established on the stated surface.
- **Failed:** observed behavior contradicts a requirement.
- **Blocked:** a prerequisite prevented execution.
- **Inconclusive:** execution or evidence cannot establish the requirement.

Blocked and inconclusive checks do not count as passes. Mark visual judgments as model-assessed or human-assessed and retain the supporting image. Confidence is not a substitute for an observation.

## Verify a fix without replaying uncertainty

When the app changes, bind the next run to the changed artifact and prior result using the runtime's documented continuation mechanism, if one exists. Otherwise start a clearly identified new run with the same requirements. Report an attribution limit when the served build cannot be established.

For a repeated write, establish a fresh precondition that makes the effect observable. If a prior write may have completed, inspect its outcome before repeating it. Cancel through the runtime's supported control and verify its result; closing a viewer does not establish cancellation.

## Finish

Return the target and build identity, method and version, per-check result, evidence references, and limits. Review artifacts for private data before sharing. Stable regressions can become deterministic browser tests, but inspect exported tests for unsupported checks before claiming equivalent coverage. Clean up only the disposable state and browser resources created for this run.
