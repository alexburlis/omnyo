---
name: screen-atlas
description: Map observed app screens and navigation into a stable registry and portable offline HTML atlas.
license: MIT
---

# Screen Atlas

Build an inspectable map of an application's screens, important states, and the actions connecting them. The deliverable is a local HTML viewer plus a machine-readable registry, using real captures from the stated build.

## Scope and identity

Identify the app, build or commit, platform, viewport, account state, and permitted interactions. Discover candidate states from navigation declarations and the running interface. Include meaningful overlays, empty/error states, and feature-gated branches. Repeated list rows are data, not distinct screens.

Assign each state a semantic key and stable display ID. Preserve IDs on refresh and reserve retired IDs; numbering must not change because a new state sorts earlier. Separate a route wrapper from its rendered component. A source candidate remains uncaptured until the corresponding UI has been observed.

Use this synthetic registry shape as a starting contract:

```json
{
  "schemaVersion": 1,
  "build": "fixture-build",
  "entryPoints": ["S-001"],
  "screens": [
    {
      "id": "S-001",
      "key": "library/empty",
      "status": "captured",
      "image": "S-001.png",
      "source": "LibraryView"
    },
    {
      "id": "S-002",
      "key": "library/create",
      "status": "blocked",
      "reason": "Test account lacks permission",
      "source": "CreateView"
    }
  ],
  "edges": [
    {
      "from": "S-001",
      "to": "S-002",
      "action": "Select New",
      "evidence": "source-only",
      "condition": "create permission"
    }
  ]
}
```

Use only `captured`, `blocked`, `excluded`, or `unvisited` for screen status. An exclusion needs a reason. Do not assign a screenshot to a blocked state merely to fill the canvas.

## Explore and capture

Use an available browser driver for web apps or a supported native automation tool. Maintain a frontier of unvisited states and untested actions. From a genuine entry point, inspect the current UI, perform one permitted action, assert the destination, and capture it after the state is stable. Prefer accessible selectors and state waits to coordinates and fixed sleeps.

Record the literal action, precondition, source, destination, and evidence for each transition. Classify an edge as `observed` only when the action and both endpoint states were witnessed. A deep link can prove the destination exists but does not prove its incoming button works. Keep source-inferred edges visually distinct.

Explore back, cancel, shared navigation, overlays, and alternate branches. Use separate scenarios for incompatible account or feature conditions. Do not connect states from different accounts into an impossible journey. Stop before unapproved payments, messages, invitations, or data deletion. After two identical blocked attempts, record the blocker and continue independent branches.

Inspect every retained capture for the correct state, personal information, keyboard occlusion, unfinished animation, and accidental duplicates. Use synthetic accounts and content for an atlas intended for public sharing. Redaction must be explicit; it must not fabricate interface evidence.

## Build the offline viewer

Generate a standalone HTML file with embedded or locally bundled screenshots and no analytics, remote fonts, or runtime network dependencies. Escape labels and filenames before inserting them into HTML. Treat captured text and registry content as data, never executable markup.

Provide an overview canvas with readable thumbnails and labeled edges, zoom/pan, fit-to-content, search by ID/key, and a full-size screenshot view. Screen details show source, capture conditions, incoming/outgoing actions, and blockers. Include a table view for navigation without dragging. Keep excluded states in a separate searchable list and omit them from the default coverage denominator.

Arrange the diagram from real forward navigation. Show return and cross-links separately when they would overwhelm the main flow. Layout convenience must never create a fictional edge.

## Validate and deliver

Check ID and key uniqueness, valid edge endpoints, existing image files for captured states, reasons for blocked/excluded states, and reachability from documented entry points. Report unreachable nodes rather than attaching them to the nearest convenient screen. Graph reachability is structural evidence; it does not prove a path's conditions are jointly satisfiable.

Open the HTML with networking disabled. Exercise search, one edge, zoom, fit, image expansion, keyboard access, and a narrow viewport. Check that the first overview remains legible.

Return the viewer, registry, captured/included/blocked/excluded counts, observed/source-only edge counts, platform/build, and remaining frontier. Claim completeness only for the reconciled scope. A source inventory with a few captures is a draft, not a finished screen atlas. Preserve the registry as the input for subsequent refreshes.
