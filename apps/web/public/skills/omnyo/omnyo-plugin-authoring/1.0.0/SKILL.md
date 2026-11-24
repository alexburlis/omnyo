---
name: omnyo-plugin-authoring
description: Plan and verify an Omnyo plugin against a documented compatible SDK, with an offline design path when no runtime is available.
license: MIT
---

# Omnyo plugin authoring

Use this skill to design a bounded extension and implement it only through a documented SDK compatible with the user's installed Omnyo runtime. This package contains no SDK, runtime, credentials, or private integration instructions. It does not establish that a particular plugin API is publicly available.

## Establish the available contract

Ask the project evidence to answer these questions before writing adapter code:

| Question                                    | Required evidence                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| Which runtime will load the plugin?         | The installed runtime version in the authorized test environment.               |
| Which SDK matches it?                       | Public SDK documentation and package declarations for a named version.          |
| How is a plugin packaged?                   | That version's documented manifest, entry points, build, and loading procedure. |
| Which extension point supports the request? | A documented API and its lifecycle or permission constraints.                   |

Use existing public project examples when their license permits reuse, retaining notices. Do not guess package names, manifest fields, import paths, or commands. Do not use unpublished endpoints or reverse-engineered private runtime internals to fill a documentation gap.

If compatible public material is unavailable, complete the offline design and testable core below. Report the precise missing contract before attempting integration. Source code existing somewhere is not evidence that it is a supported public interface.

## Keep the core independent

Describe one observable user outcome, the extension point it needs, its inputs and outputs, and its failure behavior. Keep transformations and validation separate from the runtime adapter. The adapter should translate a documented host request into that core and translate its result back.

For example, a fictional `Reading List Summary` extension can accept a local fixture containing titles and read/unread states and return counts plus a short text summary. Its core needs no network, model provider, user account, or host internals. Test an empty list, repeated titles, and invalid status values before choosing a UI surface.

Use this design worksheet as data, not as an Omnyo manifest:

```json
{
  "fixtureName": "reading-list-summary",
  "input": [{ "title": "Sample chapter", "status": "unread" }],
  "expected": { "read": 0, "unread": 1 },
  "effects": [],
  "integration": "Requires a documented compatible SDK adapter"
}
```

## Build the documented adapter

Request only capabilities the feature uses. Parse external input once at the boundary and pass typed values internally. Keep secret values out of frontend state, public settings, error messages, and logs. Reject unsupported inputs visibly.

Use host-provided navigation and controls for host-owned behavior when the SDK provides them. Keep plugin-owned behavior in the plugin. Do not add a parallel route that bypasses the host's permission or lifecycle checks.

Track every registration, listener, timer, subscription, and resource the adapter creates. Release those resources through the SDK's documented disposal mechanism. Loading twice or unloading during work should not produce duplicate effects or leave active listeners behind.

Implement only declared settings and manifest capabilities. Document user-facing configuration, constraints, and commands that actually exist in the chosen SDK. Separate packaging from installation: preparing files does not authorize loading the plugin into someone else's active environment.

## Verify and hand over

Run core fixtures, focused adapter tests, the package's documented typecheck, and its build. If an authorized compatible runtime is available, load the built artifact in an isolated test environment and exercise the requested user journey. Check error display and unload/reload behavior as well as the successful path.

Report the exact SDK and runtime versions, artifact identity, tested surface, and remaining gaps. A passing core fixture is offline proof only; a passing build does not establish runtime behavior. Do not claim installation, publication, or compatibility with untested versions.
