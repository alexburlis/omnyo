---
name: feature-map-testing
description: Build and maintain a small source-linked map of user journeys, prerequisites, and verification evidence.
license: MIT
---

# Feature-map testing

Use this skill to make a product's test coverage inspectable without turning every change into a full audit. It works with a local app, CLI, or service and needs no particular testing platform.

## Map behavior, not filenames

Start from user-visible entry points: routes, menus, commands, settings, import/export flows, and documented integrations. Follow source references to identify the implementation owner. Keep internal helper functions out of the feature map unless they expose a distinct contract that needs its own check.

Give each capability a stable ID and a compact recipe:

| Field         | Purpose                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| Capability    | The observable outcome a user can obtain.                                 |
| Source        | Relevant entry point and implementation paths.                            |
| Prerequisites | Platform, build, fixture, account, and optional integration requirements. |
| Actions       | The shortest realistic interaction sequence.                              |
| Assertions    | Visible result and any required persisted or downstream result.           |
| Evidence      | Run identity, artifact identity, result, and supporting files.            |
| Cleanup       | Changes this recipe owns and how to restore them.                         |

Use the project's existing documentation format. Add machinery only when a recurring maintenance problem justifies it.

## Example recipe

The following is a fictional local note app, not a command for an installed product:

```text
ID: notes.rename
Capability: Rename a note and keep the name after reopening it.
Source: app/notes/rename-action.ts and app/notes/note-view.ts
Prerequisite: Local fixture containing one note named Sample.
Actions: Open Sample, rename it to Revised sample, save, reload, reopen.
Assertions: The list and editor both show Revised sample after reload.
Failure check: An empty name gives a visible error and preserves the saved name.
Cleanup: Restore the fixture through its supported local reset mechanism.
```

Do not infer the expected result from what the implementation currently does. Ground it in the product contract or user request. If that contract is unclear, record the missing decision.

## Select checks for a change

Trace the changed behavior to the recipes it affects. Include adjacent journeys only when they share state, ownership, or a relevant contract. Identify material failure modes before running: lost persistence, duplicate action, inaccessible control, stale data, or inconsistent API/CLI output.

Use lower-level tests where they establish the property cheaply. Use real interaction for behavior they cannot establish. An API assertion can confirm persisted state; it does not prove a button can be reached or activated. A web run does not establish native-client behavior.

Choose an isolated fixture, record the actual target and build, and reuse the existing test owner or runner. Do not silently point a recipe at real user data. Set a bounded duration and expected completion signal before a costly run.

## Record results precisely

Every selected recipe receives `passed`, `failed`, `blocked`, or `not run`. Record partial subchecks individually instead of promoting a partially tested capability to passed. A blocked recipe names the missing prerequisite; a failure includes the observed contradiction and evidence.

Bind results to the source or artifact, platform, configuration, and date tested. Preserve useful prior results as history, but do not display them as fresh verification after relevant inputs change. Existence in the map means inventoried, not tested.

## Maintain the map

For a focused change, review and run only the affected recipes. For a requested inventory audit, compare the map with current routes, commands, settings, schemas, and runtime-discovered actions. Static extraction can find omissions but cannot determine behavioral completeness.

If an inventory helper records fingerprints, treat drift as a review prompt. Inspect the source change, update affected ownership or recipes, and only then accept a new baseline. Refreshing hashes alone is not maintenance evidence.

Finish with a short coverage statement: selected capabilities, results, verified surfaces, and remaining gaps. Preserve the evidence needed to reproduce a finding, remove task-owned disposable fixtures after their consumers stop, and retain unrelated work.
