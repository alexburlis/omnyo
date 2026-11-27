# State Machines plugin — UI/UX design

Status: implemented. §H (2026-11-19 home chats) and §R (2026-10-21 redesign)
are current and override any older section they name; the rest of this file
remains the original SM-2 specification where they do not change it.

## H. 2026-11-19 home chats (current)

A Sentry run could wait for many hours on a gate nobody saw: the
item existed only in this panel, its card said nothing about what had failed,
its only choice demanded a typed reason, and its step chats were archived.
D2's "attention lives inside the panel" and §17's deferred Inbox, sidebar and
`requestInput` rows are replaced by these rules:

- **A run is a chat.** Every instance has a visible `homeThreadId` in its
  machine's project. Start creates a chat named after the machine (or a
  caller-supplied title) unless the caller names an existing visible chat.
  Instances from before this change keep `null` and stay panel-only.
- **A run chat has no agent of its own (2026-11-24).** State Machines creates
  it idle and quiet: no first message, no model turn, and finished step chats
  never wake a model there. Each step chat shows as one row that reads
  running and settles to finished with the first paragraph of its last reply,
  failed or interrupted. The old placeholder prompt and the agent's "Step
  report received" replies are gone. Quiet takes effect once the server
  supports it; until then an idle run chat still receives core's step notices.
- **A gate is a question in that chat.** Each open attention item except
  `agent-input` opens once as an `api.ui.requestInput` form (renderer
  `run-decision`) in the home chat, which puts the chat in the Inbox,
  notifications and the sidebar's needs-you state. The panel lists the same
  item; resolving it anywhere withdraws the form.
- **The card explains itself.** Attention items entered from a step carry a
  `cause`: step title, how it ended (`failed`, `timed-out`, `uncertain`, …)
  and the step's own reason. Decisions show their target state's title, not
  its id. Notes are labelled optional unless the decision requires evidence.
- **Step chats nest and stay.** Agent steps of a run with a home chat run in
  visible children of it, titled `<step> · try <n>`, and are no longer
  archived per step; archiving the home chat archives them.
- **The log tells the truth.** Step starts read "Step started" and opened
  gates read "Waiting for your decision"; neither is a problem row.

## R. 2026-10-21 UX redesign

Scope: navigation, hierarchy, copy and canvas input only. No RPC, contract,
runtime or authority change.

### R.1 Problems found in the shipped v0.1 UI (production, read-only capture)

| Problem                                                                                                                                                                                | Effect on a first-time user                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A plain wheel panned the canvas; zoom needed Ctrl/Cmd or the toolbar.                                                                                                                  | Scroll felt broken; the graph sat at ~60% with small text.            |
| `m/<machine>` silently redirected to the only instance.                                                                                                                                | Back button and the machine itself became hard to reach.              |
| The machine page showed a 240px non-interactive preview, raw instance ids and four equal buttons (Edit draft, Versions, Settings, Start).                                              | No clear next step; the graph was unreadable.                         |
| Draft, Versions and Settings were separate pages reachable only from the machine page header.                                                                                          | Users lost their place; no sense of one machine with sections.        |
| The instance page repeated "View log" three times and led its side panel with "Phase —", the full instance id and raw JSON event fields; Active work and Context sat below the canvas. | Technical metadata crowded out "what is happening and what can I do". |
| The draft sidebar opened on an empty context-value form with a `sourceSha` placeholder; "Problems" was a button even with no problems.                                                 | Editing looked like data entry instead of building a graph.           |

### R.2 Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Wheel = zoom.** Any wheel or two-finger scroll over the canvas zooms around the pointer and never scrolls the page or canvas. Deltas are normalised by `deltaMode` (line 16px, page 800px), pinch (`ctrlKey`) is ~5x more sensitive, one event changes zoom by at most 2x, horizontal-dominant swipes do nothing, and events are batched to one update per animation frame. Range 20%–250%. Pan by dragging empty canvas. Toolbar keeps Fit, −, %, +, shortcuts; keys `F + − 0` unchanged; `0` now resets to 100% around the centre. Toolbar shows "Scroll to zoom · drag to pan" on wide layouts. Source: `src/ui/graph/viewport.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R2  | **One machine hub with section tabs:** Overview · Edit draft · Versions · Settings (`MachineTabs` in `shell.tsx`, `nav[aria-label="Machine sections"]`, `aria-current="page"`). Routes are unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R3  | **No redirect.** `m/<machine>` is always the Overview.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R4  | **Overview leads with one primary action:** "Start instance" when a version is published, otherwise "Edit draft". Chips say "Published vN" / "Not published"; unpublished draft changes are a link to the editor. Unpublished machines show a three-step "Get started" list instead of an empty graph.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R5  | **Overview = full graph workspace** (superseded the 0.2.0 420px card, R9): description, then a one-row horizontally scrolling **Instances** strip (Active / Ended cards: status pill, current state, phase, "vN · started … · #shortid"), then the `readonly` canvas filling all remaining width and height.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R6  | **Instance page:** status line "Now in / Ended in <state> · phase". Run controls appear once in the header. Views Graph · Outline · Activity log; "Keep current state in view". No persistent side column (R9): **Details** opens the floating panel ("This instance": Active work, Context, standing authority, Recent events, collapsed ids). It opens by default only while a manual decision is waiting (also as the compact drawer); selecting a state or transition opens it too. On compact, Active work and Context stay below the graph.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R7  | **Draft editor:** same tabs; "N problems" (blocking chip) only when problems exist and opens the panel on the draft overview. **Draft details** toggles the same panel ("How editing works", Problems, Changes, **Context values (n)** collapsed when empty). Selecting a state/transition opens its inspector in the floating panel; closing clears the selection. After publishing, the banner offers "Go to overview".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R8  | Copy: "Published vN" replaces "vN live"; version list marks the newest as "Latest"; machine list says "N unpublished changes". Breadcrumbs use `Instance #<8-char id>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R9  | **Graph dominates the workspace (0.2.1 correction).** Measured 0.2.0 at 1440×900 (Omnyo panel 1120×852): overview canvas 700×418 (31% of panel), live canvas 694×668 beside a 360px column, release-loop draft fitted to 57% → 7.5px node titles. Now every canvas page (overview, instance, draft, version) is a flush page (12/16px padding) whose canvas takes the full width and remaining height; inspectors are a floating panel (`FloatingPanel`, `min(400px, 45%)`, closable) over the canvas edge, opened on demand. The canvas treats the panel as occluding its right edge and pans a selected (or, for Details, the current) state into the visible area (`revealRect`). Initial view = fit clamped to 75%–125% (`readableViewport`); a graph too large for the canvas opens at 75% anchored at its start instead of shrinking; **Fit** still fits completely (min 20%, max 125%). Result in the isolated harness at the same panel size: release-loop canvas 1086×678 (77%), 91% → 11.9px titles; 1920×1080 panel: 1566×858, 120% → 15.6px.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R10 | **Readable routing (0.2.2).** Measured on the real release-loop draft (21 transitions, 0.2.1 installed): 3 labels on states, 7 labels over other arrows, 21 separately drawn near-duplicate lines, labels translucent so lines struck through text. Causes: labels placed at the midpoint of the longest segment with only an 80px centre-distance check; parallel same-pair transitions drawn as separate lines; ports in insertion order with 12px gaps; shared middle runs; first/last segments never collision-checked; `simplify` collapsing reversals (also dropping saved waypoints). Now (`src/ui/graph/route.ts`, checker `route-check.ts`): transitions between the same two states without saved routing share one line and a stacked label in which every transition is its own selectable button (accessible name "From A to B on trigger", tooltip = full text); opposite directions get separate lanes; each automatic connection chooses its sides by deterministic cost (length, bends, crossings with weight ×3 on short segments, shared runs, invalid entry/exit, state collisions), routing straight-capable connections first; ports sit at their partner's position then spread to ≥ the minimum gap; facing ports are aligned onto a shared coordinate; interior runs that coincide are moved to separate lanes; labels use measured-calibrated text widths (capped at 240px with ellipsis) and only take a box that clears states, other labels and other arrows (on the line, over a small jog, in a free interval between crossings, or beside the line); label backgrounds are opaque so they mask their own line. Up to four whole-layout variants are scored with the same checker and the first with zero problems is kept (one variant during drag and for graphs over 40 transitions). Saved sides, waypoints and label positions are honoured and never grouped. Result on the release loop: 0 label overlaps, 0 labels on states, 0 labels on other arrows, 0 paths through states, 0 shared runs, 0 shared arrowheads, 16 lines for 21 transitions. |

Unchanged on purpose: draft/live/version separation, immutable versions,
explicit destructive confirmations (stop, delete, discard), gate decisions only
by named choices, no default model or inferred authority, persistent Omnyo drawer
on compact.

| Field        | Value                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Written      | 2026-10-20; aligned to runtime plan revision SM-2 the same day (§19.1)                                                                                                                                                    |
| Scope        | Navigation, screens, graph editor and live view, inspector, run controls, attention, history, tokens, accessibility, compact layout, UI-facing contracts (agreed with runtime SM-2), frontend file map, acceptance matrix |
| Out of scope | Backend architecture, persistence, scheduler, dispatch, CLI command design, core edits                                                                                                                                    |

Contract labels used throughout:

- **SDK (current)** — exists in `@omnyo/plugin-sdk/app` today; source path cited.
- **Registry (current)** — vendorable Omnyo component in `packages/plugin-registry/registry.json`.
- **Agreed contract** — a shape this UI reads or writes, aligned with the runtime plan SM-2
  (§15). The runtime's `src/contracts/*.ts` files are the authority.
- **Gap (core)** — something a core change would add. The MVP does not depend on any gap.

---

## 0. Summary of design decisions

| #   | Decision                                                                                                                                                                                                   | Why                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | One `navPanel` (`path: "machines"`) owns every screen; sub-routes via `subPath` and `experimental_useAppNavigate().toPluginPanel`.                                                                         | Preserves app chrome; deep links and back/forward work through host history (`PluginNavPanelProps.subPath`, `app-contract.ts:74-85`).                                                                                                    |
| D2  | The inspector, log and attention live **inside the panel page**, not in host `fixedTabs`.                                                                                                                  | `fixedTabs` are experimental and mount only while the host right panel is open (`app-contract.ts:665-677`); a graph without its inspector is not usable. Revisit after MVP (§17).                                                        |
| D3  | Plugin-owned renderer: DOM nodes + one SVG edge layer. **No graph library in MVP.**                                                                                                                        | Graphs are small (target ≤ 40 states). Owning the DOM gives real focusable nodes, host-token styling and no third-party global CSS. Layout coordinates and edge waypoints persist in the definition, so the live view never runs layout. |
| D4  | Three status axes rendered separately: **lifecycle** (instance), **phase** (instance execution), **stateId** (named machine state).                                                                        | Parent direction (msg 2). Mixing them produces "green stopped with live process" lies.                                                                                                                                                   |
| D5  | Draft and live are visually and spatially distinct: different route, recessed dotted canvas, a persistent "Draft" pill, and edits are impossible on the live route.                                        | Prevents editing what is running; published versions are immutable.                                                                                                                                                                      |
| D6  | Human gates resolve only by an explicit choice that maps to a named outgoing transition. No "clear", no default success.                                                                                   | Parent direction (msg 1); reference "clear-attention" becomes a named choice, never an implicit success.                                                                                                                                 |
| D7  | Uncertain outcomes are first-class: dashed attention styling, "Outcome unknown", always routed to a person. The UI never says "ran once" or "delivered".                                                   | Parent direction (msg 2): no exact-once implication for external effects.                                                                                                                                                                |
| D8  | Model and permission choices use host components `experimental_ProviderModelPicker` and `experimental_PermissionModePicker`; the plugin stores the emitted value verbatim and never ships a default model. | Host owns provider catalog and machine ceilings (`app-contract.ts:3148-3262`); avoids default billable API use.                                                                                                                          |
| D9  | An **Outline** view (structured list of states and transitions) is a peer of the Graph view, the default on compact widths and the primary screen-reader path.                                             | A spatial canvas is not an accessible primary interface; the outline is the same data.                                                                                                                                                   |
| D10 | Plugin CSS uses a `stm-` class prefix, host color tokens only, sanctioned type tokens only, no `@scope`, no achromatic `oklch(L 0 0)` literals.                                                            | `omnyo/AGENTS.md` UI rules; `apps/app/src/components/ui/theme.css`.                                                                                                                                                                      |

---

## 1. Vocabulary (one term per object)

| Term (UI copy) | Meaning                                                                                                                                     | Proposed id                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Machine**    | A user-defined workflow: draft + published versions. Example: "Release loop".                                                               | `machineId` (`mch_…`)                                  |
| **Draft**      | The single mutable definition of a machine.                                                                                                 | `draftRevision` (integer, optimistic concurrency)      |
| **Version**    | An immutable published definition, numbered `v1, v2…`.                                                                                      | `versionId` (`ver_…`) + display `number` (integer ≥ 1) |
| **Visit**      | One entry into a state; re-entering creates a new visit. UI copy "visit".                                                                   | `entryId` (`ent_…`)                                    |
| **Attempt id** | One try beneath a step.                                                                                                                     | `attemptId` (`try_…`)                                  |
| **Event id**   | One durable accepted input.                                                                                                                 | `eventId` (`evt_…`)                                    |
| **Instance**   | One durable execution of a pinned version. A machine may have several; the Release loop normally has one.                                   | `instanceId` (`ins_…`)                                 |
| **State**      | A node in the definition. Author-chosen stable slug + display title.                                                                        | `stateId` (slug `^[a-z][a-z0-9-]{0,47}$`)              |
| **Transition** | A directed edge between states, triggered by an event, optionally guarded.                                                                  | `transitionId` (`tr_…`, stable across draft edits)     |
| **Step**       | One finite dispatch of a state's action (agent turn, command run). Has attempts.                                                            | `invocationId` (`inv_…`)                               |
| **Attempt**    | One try of a step; `attempt n of max`.                                                                                                      | `attempt` (1-based)                                    |
| **Gate**       | A manual state awaiting a person's choice. UI copy: "Needs you".                                                                            | `attentionId` (`att_…`)                                |
| **Event**      | A named signal that may fire a transition (`succeeded`, `failed`, `timed-out`, `source.new-sha`, `decision.<id>`, …).                       | `eventType`                                            |
| **Authority**  | Permission for a step with `external-write` effect. Not grantable from the UI until a verifiable person-approval capability exists (§19.2). | runtime-owned                                          |

The UI never uses "workflow", "loop" or "job" as object names (copy may say
"Release loop" because that is a machine's title). "Run" is a verb only.

---

## 2. Status model (rendered separately)

### 2.1 Instance lifecycle — "where is this instance in its life"

| `lifecycle` | Pill label | Pill tone (token)                                  | Glyph (Omnyo icon name, verify at build) | Meaning shown in tooltip                                                                  |
| ----------- | ---------- | -------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `running`   | Running    | `--color-success` text on `--color-surface-raised` | `Play`                                   | Accepting events and dispatching steps.                                                   |
| `paused`    | Paused     | `--color-warning-text`                             | `Pause`                                  | No new steps or transitions. Results of running steps are recorded and applied on resume. |
| `stopping`  | Stopping…  | `--color-warning-text`, spinner                    | `Loader`                                 | Stop requested. Waiting for N running steps to end or be marked uncertain.                |
| `stopped`   | Stopped    | `--color-muted-foreground`                         | `Square`                                 | Ended by a person. All owned steps confirmed ended or recorded uncertain.                 |
| `completed` | Completed  | `--color-muted-foreground`                         | `CircleCheck`                            | Reached an End state.                                                                     |
| `failed`    | Failed     | `--color-destructive-text`                         | `CircleX`                                | The runtime could not continue (definition fault or unrecoverable error).                 |

Rule: `stopped` is only rendered when the runtime reports that owned work is
confirmed quiescent, or that a person recorded an unresolved outcome for an
unobserved step (§8.2 Mark outcome unknown). While any step is live or
unobserved without that record, the pill stays **Stopping…** and lists them.
A stopped instance with recorded unknown outcomes renders the variant pill
**Stopped · outcome unknown** (`--color-attention` dot + text), keeps its
attention item open, and shows why **Start new instance** is blocked when the
unknown step shared a mutating scope ("Reconcile `<step>` before starting
again in `<environment>`.").

The UI never labels an instance successful because a cycle completed. The
Context card may show "Cycles completed: 12" as a count only.

### 2.2 Instance phase — "what is it doing right now"

Rendered as text after the state name in the status line and on the current
node's meta row. Only meaningful while `lifecycle ∈ {running, paused, stopping}`.

| `phase`        | Node meta text                                          | Status line text                                       |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| `waiting`      | `Waiting for <event list>` or `Waiting · next check 4m` | `Waiting for new commit on main`                       |
| `queued`       | `Queued · 2 ahead`                                      | `Queued behind 2 steps (limit 1 per environment)`      |
| `executing`    | `Running · 3m 12s` + `attempt 1/3`                      | `Running pnpm check · attempt 1 of 3`                  |
| `retry-wait`   | `Retry 2/3 in 40s`                                      | `Attempt 1 failed · retrying in 40s`                   |
| `needs-person` | `Needs you`                                             | `Needs you: <gate prompt>`                             |
| `uncertain`    | `Outcome unknown`                                       | `Outcome unknown: <step> may or may not have finished` |

### 2.3 Named state

`stateId` + title is always shown separately from lifecycle and phase:
**Land fix** · Running · attempt 1 of 3 · `huppy/release-fix-5c05d51a7555`.

---

## 3. Navigation and information architecture

### 3.1 Registrations (SDK current)

```ts
definePluginApp((app) => {
  app.slots.navPanel({
    id: "machines",
    title: "State machines",
    icon: "Workflow",          // verify name resolves via experimental_Icon; unknown names fall back to branding
    path: "machines",
    component: MachinesPanel,  // routes on subPath
    headerContent: MachinesHeaderContent, // attention count + connection dot
  });
  app.commands.register({ id: "state-machines.open", title: "State machines: Open", run: … });
  app.commands.register({ id: "state-machines.attention", title: "State machines: Needs you", run: … });
  app.commands.register({ id: "state-machines.new", title: "State machines: New machine", run: … });
});
```

Sources: `PluginAppSlots.navPanel` (`app-contract.ts:2257`),
`PluginNavPanelRegistration.headerContent` (`:691`), `app.commands`
(`:2001-2048`). Commands are registered without `defaultShortcut` in MVP to
avoid collisions with host shortcuts.

Not used in MVP (reasons in §17): `fixedTabs`, `experimental_sidebarAccessory`
("no host surface currently mounts it", `:678-684`), `homepageSection`,
`pendingInteraction` (thread-scoped; gates here are machine-scoped).

### 3.2 Routes (`subPath`)

| `subPath`                          | Screen                                 | Title bar (host) shows | Back target |
| ---------------------------------- | -------------------------------------- | ---------------------- | ----------- |
| `""`                               | Machines list (§4.1)                   | State machines         | —           |
| `new`                              | New machine (§4.9)                     | State machines         | list        |
| `attention`                        | Needs you inbox (§4.8)                 | State machines         | list        |
| `m/<machineId>`                    | Machine Overview (§R3–R5; no redirect) | State machines         | list        |
| `m/<machineId>/i/<instanceId>`     | Live instance view (§4.3)              | State machines         | machine     |
| `m/<machineId>/i/<instanceId>/log` | Instance log (§4.7)                    | State machines         | instance    |
| `m/<machineId>/draft`              | Draft editor (§4.4)                    | State machines         | machine     |
| `m/<machineId>/v/<version>`        | Read-only version view (§4.6)          | State machines         | machine     |
| `m/<machineId>/versions`           | Version list (§4.6)                    | State machines         | machine     |
| `m/<machineId>/settings`           | Machine settings (§9)                  | State machines         | machine     |

Selection inside a screen is encoded as a query-like suffix so deep links
restore it: `…/i/<instanceId>?sel=state:gate` or `?sel=tr:tr_8k2`. The parser
lives in `ui/routes.ts`; unknown or stale selections are dropped silently with
the canvas fitted to all nodes.

Navigation calls always use `toPluginPanel("machines", { subPath })`; redirects
use `replace: true` (`app-contract.ts:3538-3550`). Opening an agent step's thread
uses `toThread(threadId, { split: true })` (`:3530-3535`).

### 3.3 Page shell (every screen)

```
┌ host title bar: "State machines"                     [headerContent: ● 2 need you] ┐
├───────────────────────────────────────────────────────────────────────────────────┤
│ Breadcrumb: State machines / Release loop / Instance ins_3fa                      │
│ Page header row: Title · lifecycle pill · version chip      [primary actions…] [⋯] │
│ Status line: Landing fix · huppy/release-fix-5c05d51a7555 for 5c05d51a75           │
│ View switch (segmented): Graph | Outline | Log         (instance views only)       │
├──────────────────────────────────────────────┬────────────────────────────────────┤
│ Main area (canvas / outline / list)          │ Inspector column (≥ 1024px)         │
│                                              │ 360px default, 320–480 resizable    │
├──────────────────────────────────────────────┴────────────────────────────────────┤
│ Lower cards (instance only): Active work | Context                                │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- `layout` is the page's own; the body uses `flush` semantics (page owns scrolling).
- Breadcrumb: registry `breadcrumb`. Segmented switch: registry `toggle-group`.
- `headerContent` is one line: attention count (`●` in `--color-attention` + "2 need you",
  hidden at 0) and, only when not `connected`, a muted "Reconnecting…" label.
  It is a button that navigates to `attention`.

---

## 4. Screens and all their states

Each screen lists: purpose, layout, data (RPC per §15.6), and states
**loading / empty / error / disconnected / populated** with exact copy.

### 4.1 Machines list (`""`)

Purpose: see every machine at a glance and what needs a person.

Layout: optional **Needs you** strip at top (only when count > 0): up to 3
attention rows (§4.8 anatomy) + "View all (N)". Then a table (registry `table`)
with one row per machine:

| Column        | Content                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine       | Title (text-sm, 500) + description (text-xs muted, 1 line, truncate)                                                                                                         |
| Status        | Aggregated: lifecycle pill of the most urgent instance (`needs-person` > `uncertain` > `failed` > `stopping` > `running` > `paused` > others), plus "+2" when more instances |
| Current state | `stateId` title of the most urgent instance + phase text                                                                                                                     |
| Version       | `v4 live` chip; `Draft · 3 changes` chip when the draft differs                                                                                                              |
| Updated       | Relative time; absolute in `title` attribute                                                                                                                                 |
| ⋯             | Open, Edit draft, Pause all, Duplicate, Archive (later)                                                                                                                      |

Row click opens `m/<machineId>`. Sort: needs-person first, then most recently
updated. Primary action (page header): **New machine**.

| State                 | Rendering                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading (first fetch) | Registry `skeleton`: 4 table rows, after 150ms delay (registry `delayed-loading`) to avoid flash                                                                                                            |
| Empty                 | Registry `empty-state`: title "No state machines yet", body "Build a loop of steps, checks and approvals that keeps running.", primary **New machine**, secondary **Start from Release loop template**      |
| Error (RPC failed)    | Inline `alert` (destructive): "Couldn't load machines. The State machines service didn't respond." Button **Try again**. Previous data, if any, stays visible underneath with a muted "Last updated 2m ago" |
| Disconnected          | Data stays; banner (§11.3)                                                                                                                                                                                  |
| Populated             | As above                                                                                                                                                                                                    |

### 4.2 Machine page (`m/<machineId>`) — instance list

Superseded by §R2–R5: always shown, no redirect, tabs, primary action, interactive map and instance cards.

- Header: machine title, `v4 live` chip, actions **Edit draft**, **Start instance**, ⋯ (Versions, Settings).
- Graph preview (read-only, non-interactive, `aria-hidden`, fitted, 240px tall) of the live version with **no** status highlighting.
- Instances table: Instance id (mono, short), Version (with "older" chip if not latest), lifecycle pill, state + phase, started, last event.

| State                   | Rendering                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| No published version    | `empty-state`: "Not published yet", body "Publish the draft to start an instance.", primary **Edit draft** |
| Published, no instances | `empty-state`: "No instances", body "Start an instance to run v4.", primary **Start instance**             |
| Machine not found       | `empty-state`: "This machine doesn't exist or was removed.", **Back to State machines**                    |

**Start instance** dialog (registry `dialog`; drawer on compact):
fields Version (select, default latest published; older listed), Environment
(see §9.3), Initial inputs (only those the definition declares, typed fields),
Authority summary (read-only list of `external-write` steps; each reads
"Will stop and ask: verifiable approval isn't available yet"). Start sends
`requestId`; `ENVIRONMENT_LIFETIME_UNSUPPORTED` shows the runtime's setup
requirement under the Environment field. Buttons **Start** / **Cancel**. After success: navigate to the new
instance (push).

### 4.3 Live instance view (`m/<machineId>/i/<instanceId>`) — the reference screen

This is the Omnyo equivalent of the supplied "Release loop" screenshot.

Header row:

- Title "Release loop" (text-base, 600) · lifecycle pill · version chip `v4`.
- Status line (text-sm): **`<State title>`** · `<instance.summary>` — summary is a
  backend-rendered one-line string (`InstanceView.summary`), e.g. `huppy/release-fix-5c05d51a7555 for 5c05d51a75`. Phase text follows in muted.
- Right side actions by lifecycle (§8.1): primary run control, **View log**, ⋯.
- If the instance's version < latest: inline info row "Runs v3. v4 is published." + **Compare** (opens version diff, §4.6). No migration action in MVP.

Main area: Graph (default ≥ 768px) or Outline (default < 768px). Graph is the
live canvas (§5) in **Inspect mode** (§6.1).

Inspector column: selected state/transition details in live form (§7.5), or,
with nothing selected, the **Instance panel**: lifecycle, phase, current state,
started, uptime, counters (attempts, fixer rounds per commit), active authority
standing authority references reported by the runtime (read-only), and the five most recent log events with "View log".

Lower cards (two columns ≥ 1024px, stacked otherwise), mirroring the
reference's "Active work" and "Release state":

- **Active work** — one row per owned invocation in `queued | executing |
  retry-wait | uncertain | cancelling`: kind glyph, step title, attempt `1/3`,
  elapsed, deadline countdown ("deadline in 14m", absolute on hover), target
  (environment name), and links: **Open thread** (agent steps → `toThread(…, {split:true})`), **Output** (command steps → log entry). Per-row ⋯: **Cancel step** (§8.4). Empty: "No work running." (text-sm muted).
- **Context** — key/value list of the instance's declared context variables
  (e.g. `sourceSha`, `pendingSource`, `fixBranch`, `lastBuildId`), then
  runtime budgets (`InstanceView.budgets`, e.g. "Fixer rounds for 5c05d51: 1 of 2")
  as meters (registry `progress`), then "Cycles completed: N" as a plain count.
  Values are text, mono for hashes; long values wrap anywhere; hashes get a copy
  button (`experimental_copyToClipboard`). Budgets are read-only.

| State                        | Rendering                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                      | Header skeleton + canvas skeleton (rounded rects at the definition's saved positions if the definition arrived first; otherwise 3 generic blocks) |
| Instance not found           | `empty-state`: "This instance doesn't exist.", **Back to Release loop**                                                                           |
| Definition failed to parse   | `alert` destructive: "This version can't be displayed (definition error: <code>)." Log and Active work remain usable                              |
| Error fetching               | As §4.1 error, scoped to the failing section (graph, active work, context fail independently)                                                     |
| Completed / stopped / failed | Run controls replaced by **Start new instance** (same version) and **View log**; canvas shows final state with terminal styling (§5.6)            |

### 4.4 Draft editor (`m/<machineId>/draft`)

Header row: title (inline rename, registry `inline-rename`) · **Draft** pill
(`--color-surface-selected` bg, `--color-surface-selected-border` border) ·
"Based on v4" muted · save indicator ("Saved" / "Saving…" / "Not saved — retrying" / "Save failed") · actions **Discard changes** (⋯ menu), **Validate** (shows count badge of problems), **Publish…** (primary; disabled with tooltip while problems exist or unsaved).

Toolbar (left of canvas, vertical on ≥ 768px, horizontal above canvas otherwise):
**Add state** (menu by kind, §5.2), **Connect**, **Undo**, **Redo**, **Fit**, **Zoom −/+/100%**, **Snap to grid** toggle (default on), **Problems** (opens problem list in inspector).

Canvas background: recessed (`--color-surface-recessed`) with 16px dot grid
using `color-mix(in oklab, var(--color-foreground) 12%, transparent)`, so the
editor never looks like the live view (solid `--color-card`).

Inspector: selected item editor (§7), or machine-level **Draft overview** when
nothing is selected: problem list, change summary vs base version (counts:
states +2 −0 ~1, transitions +3 −1 ~0), machine settings shortcut.

| State                                       | Rendering                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New empty draft                             | Canvas shows the initial pseudo-state dot and a centered hint card: "Add your first state" + **Add state**; template link "Use the Release loop template"                                                                                                                                                                                                                                                                                                         |
| Loading                                     | Canvas skeleton; toolbar disabled                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Save conflict (`REVISION_CONFLICT`)         | Sticky `alert` (warning): "This draft was changed somewhere else." Buttons **Reapply my changes** (fetch latest, replay the local unsaved edit operations from the editor's op log onto it, save with the new expected revision; any operation whose target no longer exists is listed as "Couldn't reapply: <op>" and dropped only after the person reads the list) / **Load latest** (discards local unsaved edits after confirm). There is no force overwrite. |
| Save failing (network)                      | Indicator "Not saved — retrying" with exponential backoff (1s→30s cap); after 3 failures `alert`: "Changes aren't saved yet. Keep this page open." Edits continue locally; leaving triggers the browser `beforeunload` prompt                                                                                                                                                                                                                                     |
| Read-only because published version is open | n/a — versions use their own route                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 4.5 Publish dialog

Opened from **Publish…**. Registry `dialog` (drawer on compact).

Contents, top to bottom:

1. Title "Publish v5" (next version number and change summary returned by `sm_machine_validate`).
2. Change summary list: Added states, Removed states, Changed states (field names that changed, e.g. "Gate: command, deadline"), Added/removed/changed transitions (as "Gate → TestFlight build on `green`").
3. Authority changes: any step newly requiring authority or whose effect class changed, each with its authority status.
4. Fixed explanation (text-sm): "Running instances stay on v4. New instances use v5." (Instance migration is not in MVP; no checkbox.)
5. Optional release note (textarea, 0–500 chars) stored with the version.
6. Buttons **Publish v5** / **Cancel**. Enter does not submit while focus is in the textarea.

Server-side validation failure at publish time (race): dialog stays open,
problem list replaces step 2 with heading "Fix these before publishing".
Success: the dialog closes and the editor header shows an inline success row
"Published v5." for 5s (no host toast API is assumed, §19). The editor then
shows "Based on v5" and no changes.

### 4.6 Versions (`m/<machineId>/versions`, `m/<machineId>/v/<n>`)

- List: version, published time, publisher, note, instance count pinned to it, "Live" chip on latest.
- Version view: same canvas in **Read-only mode** (no live status), header "v3 · published 12 Oct", actions **Compare with…** (select another version or Draft) and **Copy to draft** (confirm: "Replace the draft with v3? Current draft changes are lost." — only when draft has changes).
- Compare mode: canvas shows the newer version; nodes/edges get diff badges: added (`+` glyph, `--color-diff-added` border), removed (ghosted at old position, dashed `--color-diff-removed`), changed (`~` dot). Inspector shows field-level before/after.

### 4.7 Instance log (`…/i/<instanceId>/log`, also the Log view tab)

Newest first; cursor pagination ("Load older", 50 per page). Filters
(registry `toggle-group`, multi): **Transitions**, **Steps**, **People**,
**Problems**. Search box filters loaded rows client-side by text (MVP).

Row anatomy (one line collapsed, expandable with registry `collapsible`):

```
14:02:11  ⟶  Gate → TestFlight build   on green · dispatch          system
14:01:58  ▶  Gate · pnpm check          succeeded · attempt 1/3 · 2m 41s   [Output]
13:59:17  ▶  Gate · pnpm check          started on env "release-mac"
13:59:17  ⟶  Waiting for new commits → Gate   on commit.pushed (a1b2c3d)
13:20:44  ✋  Needs a person → Waiting  "Infra fixed, resume" · Omnyo client
13:02:09  ⚠  Land fix · CI + runner gate  outcome unknown · moved to Needs a person
```

- Time: `HH:MM:SS` local, date separators ("Today", "Yesterday", "12 Oct") as sticky sub-headers. Absolute ISO in `title`.
- Glyph column 16px; actor column right-aligned, muted (system / "Omnyo client" for operator decisions and controls / agent thread title as link; never a person's name, §15.5).
- Expanded detail: event payload as key/value; command output tail (last ≤ 200 lines, bounded server-side) in a `<pre>` with `font-mono text-xs`, plus "Output truncated at N KB" when applicable; agent steps link **Open thread**.
- Problem rows (failed, timed out, uncertain, cancelled-uncertain) use the attention or destructive left rule (2px) and are never collapsed by default.

| State                          | Rendering                                                            |
| ------------------------------ | -------------------------------------------------------------------- |
| Loading first page             | 8 skeleton rows                                                      |
| Empty                          | "No events yet."                                                     |
| Older page error               | Inline row "Couldn't load older events. **Try again**" at the bottom |
| New events while scrolled down | Pill at top "3 new events" — click scrolls to top; no auto-jump      |

### 4.8 Needs you inbox (`attention`)

Each open decision has a card in the attention inbox and its run’s home chat.
The card shows the stopped step and its reason when available. It offers a
step-chat link when that step has a chat. A paused gate keeps its longer
instructions under **Decision details**.

- Action buttons use the workflow’s choice labels. A routine choice records in
  one click. No choice is preselected.
- Choices that need evidence or acknowledgement open a short inline form.
  **Add a note** opens the workflow’s optional note field for the chosen action.
  Disabled choices show their reason.
- The action is disabled while the answer is being recorded. A submission error
  leaves the card and note available for another attempt.
- The panel sends the exact run, attention and entry IDs, the expected revision,
  the decision, evidence and the request ID. On a stale entry or revision
  conflict, refresh the card and keep the note while the same decision is open.
- Unknown outcomes keep their evidence and acknowledgement requirements.
  Client decisions cannot grant outward-effect authority.

The inbox shows **Nothing needs you.** when empty and card skeletons while loading.

### 4.9 New machine (`new`)

Two choices as cards: **Blank machine** and **Release loop template**
(§13). Fields: Title (required, ≤ 60 chars), Description (optional, ≤ 140).
**Create** → navigates to the new draft editor. No instance starts.

---

## 5. Graph canvas specification

### 5.1 Coordinate system and layout

- World units = CSS px at zoom 1. Grid 8px; positions snap when Snap is on.
- Node position = top-left; persisted in the definition `layout.nodes[stateId] = {x, y}`.
- Edge geometry persisted as `layout.edges[transitionId] = { sourceSide, targetSide, waypoints: [{x,y}…], labelAt: 0..1 }` (orthogonal polyline).
- Initial pseudo-state: 14px filled circle (`--color-foreground`), positioned at `layout.initial = {x,y}`, one edge to the initial state, not selectable as a state (selectable as its edge to change the initial state).
- Zoom range 20%–250%; initial view is fit with 48px padding clamped to 75%–125% (§R9); Fit fits completely up to 125%.
- Pan: drag on empty canvas. Zoom: plain wheel / two-finger scroll / pinch around the pointer, toolbar and keys (§R1). Zoom range 20%–250%.

### 5.2 Node anatomy

```
┌───────────────────────────────────────────────┐  default 224 × 60, min width 176,
│ [glyph] Title (text-sm, 600, 1 line)   [badges]│  max 320; title truncates with
│ subtitle (font-mono text-xs muted, 1 line)     │  ellipsis + full text in tooltip
│ meta row (text-2xs) — live only                │  meta row adds 18px when present
└───────────────────────────────────────────────┘
radius 8px · border 1px --color-border · bg --color-card
```

- **Glyph** (16px, `experimental_Icon`) by kind; **subtitle** is author text
  (reference: `pnpm check`, `opens a PR`, `manual`). If empty, subtitle shows the
  kind's default summary (command text first line, model name, "manual", wait event).
- **Badges** (right, 16px each, max 3, ordered): authority shield (external
  effect), retry count (`↻3`), deadline (`⏱`), problem (`!` draft only).
- Ports: none drawn at rest. In edit mode on hover/focus, four 10px connect
  handles appear on side midpoints (`--color-ring`).

| Kind          | Glyph (verify) | Default subtitle             | Notes                                                                                        |
| ------------- | -------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| Agent         | `Bot`          | model display name           | Finite agent turn; never a forever session                                                   |
| Command       | `Terminal`     | first line of command        | Host command in a chosen environment                                                         |
| Wait          | `Clock`        | "until <event>" / "every 5m" | Event or timer; no action                                                                    |
| Choice        | `GitBranch`    | "choose by guard"            | Instant branching; rendered as node with diamond-cornered glyph, same box (keeps label room) |
| Manual (gate) | `Hand`         | "manual"                     | Person must choose                                                                           |
| End           | `CircleStop`   | "end"                        | Terminal; no outgoing transitions                                                            |

### 5.3 Edge anatomy

- Orthogonal polyline, 1.5px stroke, corner radius 8px, arrowhead 8×6 filled at target.
- Color at rest: `color-mix(in oklab, var(--color-foreground) 55%, transparent)`.
- **Label** centered on the longest segment (or `labelAt`), text-xs, `--color-muted-foreground` text, background = canvas color with 4px horizontal padding to "cut" the line (as in the reference: `— new commit on main →`). Label text = event label + guard summary joined by " · " (reference: `green · dispatch`, `promote · manual`).
- Parallel edges between the same pair are offset by 12px.
- Self-loop: rounded rectangle loop on the node's right side (e.g. Wait "every 5m" ticks), label above.
- Implicit system edges (not authored; e.g. any step → Needs you on `uncertain` when the author did not route it): dashed 4/4, `--color-attention` at 70%, label "outcome unknown", visible only when "Show system routes" is on (default on in live view, off in editor; editor shows them as a problem-free info list in the Draft overview).

Router (own, deterministic, `ui/graph/route.ts`):

1. Choose sides: pick the side pair minimizing Manhattan length; prefer right→left for left-to-right, bottom→top for downward; respect persisted `sourceSide/targetSide` when set.
2. Build L- or Z-shaped route through persisted waypoints; route around node boxes by a 16px clearance using a simple visibility check (try Z with midpoint offsets ±16·k, k≤6; pick first collision-free; else accept collision and mark `routeWarning` in the editor only).
3. Label placement: longest horizontal segment midpoint; nudge ±8px steps to avoid other labels; never overlaps nodes.
   Recompute routes only for edges touching moved nodes during drag (rAF-throttled); persist on drop.

### 5.4 Live status styling (Inspect mode)

All colors are host tokens; opaque mixes use `oklch`, translucent use `oklab`.

| Visual state              | Border                                                                       | Background                                                         | Extra                                                                                                                     | Text cue (always present)         |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Idle                      | 1px `--color-border`                                                         | `--color-card`                                                     | —                                                                                                                         | none                              |
| Current · waiting         | 1.5px `--color-warning`                                                      | `color-mix(in oklch, var(--color-warning) 10%, var(--color-card))` | —                                                                                                                         | meta: "Waiting for …"             |
| Current · queued          | 1.5px `--color-warning`, dashed 6/3                                          | as above                                                           | —                                                                                                                         | "Queued · 2 ahead"                |
| Current · executing       | 1.5px `--color-warning`                                                      | as above                                                           | 2px indeterminate bar along bottom inside radius, `--color-warning`; disabled under `prefers-reduced-motion` (static bar) | "Running · 3m 12s · 1/3"          |
| Current · retry-wait      | 1.5px `--color-warning`                                                      | as above                                                           | —                                                                                                                         | "Retry 2/3 in 40s"                |
| Current · needs-person    | 2px `--color-attention`                                                      | `--color-surface-attention`                                        | attention dot on glyph                                                                                                    | "Needs you"                       |
| Current · uncertain       | 2px dashed `--color-attention`                                               | `--color-surface-attention`                                        | `?` badge                                                                                                                 | "Outcome unknown"                 |
| Instance paused           | current styling + `Pause` badge top-right; whole canvas edges at 40% opacity | —                                                                  | —                                                                                                                         | lifecycle pill "Paused"           |
| Final (stopped/completed) | 1.5px `--color-muted-foreground`                                             | `--color-surface-recessed`                                         | —                                                                                                                         | meta "Stopped here" / "Completed" |
| Failed                    | 2px `--color-destructive-text`                                               | `--color-surface-destructive`                                      | `CircleX` badge                                                                                                           | meta "Failed: <short reason>"     |
| Selected (any)            | outer 2px focus ring `--color-ring`, 2px offset                              | —                                                                  | —                                                                                                                         | `aria-selected`                   |

Edges in live view:

- **Last taken** transition: stroke `--color-foreground`, 2px, label in `--color-foreground`; persists until the next transition.
- **Candidates** (outgoing from current state): normal stroke, label normal.
- **Others**: stroke at 35% (`color-mix(in oklab, var(--color-foreground) 30%, transparent)`).
- No animated flow on edges (motion only on the executing bar).

The reference's amber "Land fix" box maps to **Current · executing**.

### 5.5 Read-only and preview modes

Same renderer, `mode: "inspect" | "edit" | "readonly" | "preview"`. `preview`
disables pointer/keyboard and sets `aria-hidden` on the canvas (a text summary
is rendered for SR users next to it).

### 5.6 Minimap

Not in MVP (graphs ≤ 40 nodes fit). Later item.

---

## 6. Interaction model

### 6.1 Inspect mode (live)

- Click node / edge → select; inspector shows live details (§7.5). Click empty → clear selection.
- Double-click node → no-op (editing never happens on live route). Toolbar shows **Edit draft** instead.
- Hover node → tooltip after 400ms: title, kind, last visited time, visits count (if provided).
- Context menu (registry `context-menu`) on the current node: **Open active step**, **View in log**, and, if phase is `needs-person`/`uncertain`, **Resolve…** (opens the gate card in the inspector).
- Follow mode: when the current state changes and the user hasn't panned in the last 10s, the canvas moves the current node into view (no zoom change). Toggle "Follow current" in ⋯ (default on).

### 6.2 Edit mode (draft)

| Action            | Pointer                                                                                                                                  | Keyboard                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Add state         | Toolbar **Add state** → kind menu → node appears at viewport center snapped, or drag kind from menu onto canvas                          | `N`, then kind letter (`A` agent, `C` command, `W` wait, `H` choice, `M` manual, `E` end)    |
| Select            | click; Shift+click toggles; drag marquee on empty canvas with Shift held (plain drag pans)                                               | `Tab` into canvas, arrows move focus spatially (§10), `Space` toggles selection              |
| Move              | drag node(s)                                                                                                                             | `Shift+Arrow` 8px (or 1px with `Alt`)                                                        |
| Connect           | drag from a side handle to target node; or **Connect** tool then click source and target                                                 | Focus source, `C`, arrows to target (target highlighted), `Enter` to create, `Esc` to cancel |
| Reconnect edge    | drag edge endpoint handle (visible when edge selected) to another node                                                                   | Inspector "From"/"To" selects                                                                |
| Edit waypoint     | drag a segment midpoint handle of a selected edge; double-click segment adds a bend; double-click bend removes it                        | Inspector "Reset route"                                                                      |
| Rename            | inspector Title field; or `F2` / `Enter` on focused node opens inline rename                                                             | `F2`                                                                                         |
| Delete            | ⋯ or `Delete`/`Backspace`; deleting a state deletes its transitions (confirm when > 2 transitions: "Delete Gate and its 4 transitions?") | `Delete`                                                                                     |
| Duplicate         | ⋯                                                                                                                                        | `Cmd/Ctrl+D` (offset +24,+24, transitions not duplicated)                                    |
| Undo/redo         | toolbar                                                                                                                                  | `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z` (100 steps, local to this page; cleared on reload)          |
| Set initial state | context menu **Make initial**                                                                                                            | inspector toggle                                                                             |
| Fit / zoom        | toolbar                                                                                                                                  | `F`, `+`, `-`, `0`                                                                           |

Shortcuts are active only while focus is inside the canvas region and no text
field is focused; they are listed in a "Keyboard shortcuts" popover (toolbar ⋯).

Edits are applied optimistically to the local draft model and autosaved
(debounce 600ms, flush on blur/route change) through `draft.save` with
`baseRevision`. Undo applies a local inverse and saves again (no server undo).

### 6.3 Validation (draft)

Live as you edit; problems are listed in the inspector's Draft overview and as
`!` badges on offending nodes/edges. Selecting a problem selects the item.

| Code                    | Severity | Message                                                                           |
| ----------------------- | -------- | --------------------------------------------------------------------------------- |
| `no-initial`            | error    | "Choose an initial state."                                                        |
| `unreachable`           | warning  | "`<state>` can't be reached from the initial state."                              |
| `dead-end`              | error    | "`<state>` has no way out. Add a transition or make it an End state."             |
| `unhandled-failure`     | error    | "`<step>` doesn't route every outcome (failed, timed out, cancelled, no result)." |
| `duplicate-priority`    | error    | "`<state>` has two transitions with the same priority."                           |
| `guard-order`           | warning  | "A guarded transition after an unguarded one on `<trigger>` never runs."          |
| `missing-prompt`        | error    | "Write a prompt for `<agent step>`."                                              |
| `missing-model`         | error    | "Choose a model for `<agent step>`."                                              |
| `missing-result-schema` | error    | "Add at least one result outcome for `<agent step>`."                             |
| `missing-command`       | error    | "Enter a program for `<command step>`."                                           |
| `missing-environment`   | error    | "Choose where `<step>` runs."                                                     |
| `wait-no-trigger`       | error    | "`<wait>` needs an event or a check interval."                                    |
| `gate-no-decisions`     | error    | "`<gate>` needs at least one decision."                                           |
| `choice-no-default`     | error    | "`<choice>` needs a default transition."                                          |
| `non-yielding-cycle`    | error    | "This loop never waits. Add a wait, gate or step to it."                          |
| `dangling-transition`   | error    | "A transition from `<state>` has no target."                                      |
| `guard-incomplete`      | error    | "Finish the condition on `<transition>`."                                         |
| `deadline-range`        | error    | "Deadline must be between 1 minute and 2 hours."                                  |
| `end-has-out`           | error    | "End states can't have outgoing transitions."                                     |
| `route-overlap`         | info     | "A route crosses a state. Drag a bend to clear it."                               |

Errors block Publish; warnings and info do not. `external-write` steps are not
a publish error; at run time they stop with `AUTHORITY_REQUIRED` (§7.8). Server
validation (`sm_machine_validate`, §15.6) is authoritative and returns exact
JSON paths; client checks mirror it for speed and must
use the same codes. On disagreement the server list wins and is shown.

---

## 7. Inspector

Width 360px (320–480, drag handle, persisted in `localStorage` keyed by
`experimental_usePluginId()`). Sections use registry `collapsible`; first two
open by default. All edit controls render `disabled` (not hidden) on
read-only/live routes, so the same component serves all modes.

### 7.1 Common to every state

1. **Identity** — Title (≤ 48), State id (slug, auto from title on create, editable until first publish; after publish read-only with note "Used by published versions"), Subtitle (≤ 48, optional), Description (markdown, optional).
2. **Kind** — read-only label with **Change kind…** (confirm when it drops fields).
3. **Transitions out** — ordered list (drag to reorder = guard priority) of rows: event label, guard summary, target; click selects edge; **Add transition**.
4. **Transitions in** — list, read-only.

### 7.2 Agent step

| Field            | Control                                                                                                                                                                                                          | Canonical mapping (§15.3)                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt           | textarea, supports `{{context.path}}` references with autocomplete from the declared context schema                                                                                                              | `action.prompt` (required)                                                                                                                                          |
| Model            | **`experimental_ProviderModelPicker`** with `value`, `onChange`, `routing` = `{kind:"environment", environmentId}` when the step's environment is set, else `{kind:"host", hostId}`; `disabled` on live/readonly | `action.execution` = emitted value verbatim (`providerId`, `model`, `reasoningLevel`, `serviceTier?`). No default; empty shows **Choose a model** → `missing-model` |
| Permission mode  | **`experimental_PermissionModePicker`** with `providerId` from the model value and same `routing`. Defaults to Full access and can be changed for each agent step                                                | `action.permissionMode` (required)                                                                                                                                  |
| Runs in          | Environment select (§9.3)                                                                                                                                                                                        | `action.environmentId` (required)                                                                                                                                   |
| Result           | **Result schema** editor: named outcomes (e.g. `pr-opened`, `no-fix`), each with typed fields (`prNumber: number`, `headSha: commit`). The worker must submit one through the plugin's result tool               | `action.result.outcomes[]` → each outcome becomes an event type `result.<outcome>` for transitions                                                                  |
| Thread placement | fixed text "New thread per run"                                                                                                                                                                                  | not stored (MVP has one behavior)                                                                                                                                   |

Helper under Result (text-xs): "The step succeeds only when the agent submits
a result. A finished turn without a result routes as `no-result`."
Required routes, validated: every declared outcome, `no-result`, `failed`,
`timed-out`, `budget-exhausted` (when the step has a repair budget).

Live phase display for agent steps: `executing` shows "Running"; after the
worker submits a result the runtime holds it until the worker is confirmed
idle with a drained queue, and the meta row shows **"Result submitted ·
finishing"**. The step keeps its admission slot and thread ownership while
finishing. The graph does not advance and no edge is highlighted until the
runtime commits the transition. If the worker doesn't settle within the
runtime's grace period (60s), the step shows **Outcome unknown** and keeps
ownership; the submitted result is shown in the log, labeled "Submitted, not
applied".

Picker sources: `app-contract.ts:3148-3192` and `:3250-3262`. If the picker's
catalog fails, it "leaves `value` unchanged" (`:3166-3168`); the inspector then
shows the stored value text and a muted "Model list unavailable" line — no
plugin-side substitute catalog.

### 7.3 Command step

| Field             | Control                                                                                                                                                                                                   | Canonical mapping                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Program           | single input, `font-mono` (e.g. `pnpm`)                                                                                                                                                                   | `action.argv[0]`                                                                         |
| Arguments         | ordered list editor: one row per argument, add/remove/reorder; each row is **Text** (literal) or **From context** (picks one typed scalar context path; substitutes the whole argument, never part of it) | `action.argv[1..]` as `{literal}` / `{contextPath}`                                      |
| Shell             | fixed text "No shell. Arguments are passed as-is."                                                                                                                                                        | `shell: false` (always in MVP)                                                           |
| Working directory | text, relative to environment root; validated inside the root                                                                                                                                             | `action.cwd`                                                                             |
| Runs in           | Environment select (§9.3)                                                                                                                                                                                 | `action.environmentId` (required)                                                        |
| Success           | "Exit code 0" (default) or list of codes                                                                                                                                                                  | `action.successExitCodes`                                                                |
| Output            | read-only "Up to 1 MiB; the step stops at the cap"                                                                                                                                                        | runtime limit                                                                            |
| Retry safety      | read-only from the adapter: **Never retried automatically** (default) or **Adapter-verified safe** with the adapter's evidence strategy name                                                              | `action.retrySafety` = `never` \| `adapter-verified` (set by adapter, not by a checkbox) |

The subtitle shows the joined argv (`pnpm check`) for display only.

### 7.4 Wait, Choice, Manual, End

- **Wait**: Triggers (one or more): **Event** (type from `sm_events_catalog`, with its typed filter fields) and/or **Check every** (interval, default 5m, minimum 30s; missed checks coalesce). **Person actions**: event types the catalog marks `personOnly` (e.g. `person.promote`) render as buttons in the live inspector and context menu. They are intent requests: the button label is "Request promotion", never "Promote". `personOnly` is a catalog label; the runtime can't yet verify that a person sent it (§19.2), so it only enters the manual gate and authorizes nothing. Each button sends
  the catalog entry's current `subscriptionId` and `epoch` with a new
  `requestId`. On `STALE_SUBSCRIPTION` or `EXPIRED_RECEIPT` the UI refetches the
  catalog and shows "This request expired. Press again to send a new one." It
  never resends or relabels the old request automatically.
- **Choice**: Transitions out list is the whole editor; one transition must be marked **Default** (no guard); `choice-no-default` otherwise. A cycle made only of choice states fails validation (`non-yielding-cycle`).
- **Manual (gate)**: Prompt (markdown); Decisions list (label ≤ 40, id slug, target via its transition, **Evidence required** switch with an evidence prompt). Each decision maps to event type `decision.<id>`.
- **End**: Outcome (`success` | `failure`) and reason text.

### 7.5 Live (inspect) inspector for a state

Read-only header: kind, title, "Current" chip if current. Sections:

- **Now** (current only): phase text, attempt, elapsed, deadline, active step links, **Cancel step**.
- **Recent visits**: cursor-paged visits from `sm_state_history` (entered, duration, exit event, attempts). Footer states the retention bound the runtime returns ("Showing visits since 20 Sep; older detail compacted"). No lifetime totals are invented.
- **Definition**: the same fields as edit mode, disabled.
- Gate states with open attention: the attention card (§4.8) inline at top.

Live inspector for a transition: trigger, guard, last taken time, and taken
count within retained history (labeled "in retained history").

### 7.6 Retries

| Field        | Control        | Default                                                                                                  | Bounds                    |
| ------------ | -------------- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| Max attempts | number stepper | 3                                                                                                        | 1–3 ("attempts in total") |
| Backoff      | read-only      | 5s, then 30s                                                                                             | runtime                   |
| Applies to   | read-only text | "Rejections before the step started. After it may have started, only adapter-verified safe steps retry." | runtime                   |

Unknown outcomes, timeouts after dispatch and missing results never retry
automatically; the inspector says so in one line.

### 7.7 Deadline

Duration per attempt. Default 10m for commands, 30m for agents; maximum 2h;
minimum 1m. Helper: "The deadline starts when the step is dispatched, not
while it is queued. It keeps running while the instance is paused." On expiry
the step routes `timed-out` once the runtime confirms the work ended, else it
becomes `uncertain`.

### 7.8 Effects and authority

| Field                   | Control                                                                                                            | Canonical mapping                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Effect                  | radio: **Reads local files** / **Edits local files** / **Reads external services** / **Changes external services** | `effect` = `local-read` \| `local-edit` \| `external-read` \| `external-write` |
| Category (display only) | optional select: none / Repository / Release                                                                       | `annotations.category`; never used for authority or admission                  |
| Target                  | text: project/repository/channel the step acts on                                                                  | `effectTarget`                                                                 |

For `external-write` steps the inspector shows a fixed notice instead of an
approval control:

> "Steps that change external services need an approval Omnyo can verify came
> from you. That isn't available yet, so this step will stop and ask for
> authority (`AUTHORITY_REQUIRED`)."

Exception: when the runtime reports an exact existing standing authority that
covers this step's target and operation, the notice is replaced by a read-only
line "Covered by existing standing authority: `<reference>` · scope
`<scope>`". The UI never creates, edits or extends such authority, and a
changed target, artifact or command makes the line disappear.

Rationale: the plugin RPC context classifies the app, CLI and agents all as
the same client (`packages/plugin-sdk/src/rpc-contract.ts:90-100`), so neither a
hidden button, a tool list nor a `personOnly` flag proves a human actor. The
UI therefore offers **no** standing-grant creation or per-run approval for
outward effects in MVP (see §19 Gap G1). Manual gate decisions for local
routing are intent labels recorded with the session actor, not security proof.

### 7.9 Transition (edge) inspector

| Field           | Control                                                                                                                                                                                                                                                                                                                                                                                 | Canonical mapping                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| From / To       | state selects                                                                                                                                                                                                                                                                                                                                                                           | `from`, `to`                                                                  |
| Trigger         | select from the source state's catalog: agent `result.<outcome>`, `no-result`, `failed`, `timed-out`, `cancelled`, `budget-exhausted`; command `succeeded`, `failed`, `timed-out`, `cancelled`; wait its event types and `check`; manual `decision.<id>`; choice none                                                                                                                   | `trigger` (tagged)                                                            |
| Label           | text, defaults to trigger display label                                                                                                                                                                                                                                                                                                                                                 | `layout.edgeLabels[transitionId]` (display only, excluded from semantic hash) |
| Guard           | structured builder (no code). Groups **All of** / **Any of** / **Not**, nestable to depth 4 in the UI (runtime allows 16). Leaves: `<path> <op> <value>` where path is picked from declared `context.*`, the trigger's `event.*` schema or the step's `result.*` schema; ops `exists`, `=`, `≠`, `<`, `≤`, `>`, `≥`, `in`; value is a typed literal. Type mismatches show inline errors | `guard` AST (`all`/`any`/`not`/`exists`/`eq`/`ne`/`lt`/`lte`/`gt`/`gte`/`in`) |
| Context changes | rows: **Set** `<writable context path>` to literal or `event.*`/`result.*` path; **Remove** `<path>`                                                                                                                                                                                                                                                                                    | `contextPatch` (`set`/`remove`)                                               |
| Priority        | position in the source state's Transitions out (drag or Move up/down); unique per source                                                                                                                                                                                                                                                                                                | `priority`                                                                    |

Guard summaries render as plain text on the edge label after the label text:
`failed · result.retryable = true`.

## 8. Run controls

### 8.1 Controls by lifecycle

| Lifecycle                    | Primary button                   | Secondary (⋯ or row)                                             | Disabled reasons shown |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| running                      | **Pause**                        | **Pause after current step**, **Stop…**                          | —                      |
| paused                       | **Resume**                       | **Stop…**                                                        | —                      |
| stopping                     | (none) "Stopping… 1 step ending" | **Mark step outcome unknown…** per stuck step after its deadline | —                      |
| stopped / completed / failed | **Start new instance**           | **View log**                                                     | —                      |

Buttons: registry `button`; Stop uses destructive variant only inside its
confirm dialog (header button is neutral — avoids the reference's prominent red
"Restart loop").

### 8.2 Semantics and exact copy

| Control                        | Effect (runtime owns; runtime plan SM-2)                                                                                                                                                                                                                                                                                                                                                 | Confirmation                                                                                                                                                                                                                                                                                                                      | Post-state copy                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pause**                      | Hold dispatch and transitions. Running steps continue; their results are recorded but not applied. Deadlines continue.                                                                                                                                                                                                                                                                   | none                                                                                                                                                                                                                                                                                                                              | Pill "Paused"; status line "Paused in <state>. 1 result waiting." when results queued                                                                                              |
| **Pause after current step**   | Persists `pauseAfterStep`. The one active step settles, takes exactly one outgoing transition, and the instance pauses in the target state **before** that state's action dispatch or choice microsteps. With no active step it pauses immediately. If the result needs a person, it pauses with the attention visible.                                                                  | none                                                                                                                                                                                                                                                                                                                              | Pill "Running · pausing after this step" (lifecycle stays `running`, flag shown as suffix); then Paused with status line "Paused on entry to `<target>`. Its step hasn't started." |
| **Resume**                     | Clears `pauseAfterStep`. Processes accepted results and overdue timers by the declared rules. A late result can't be backdated.                                                                                                                                                                                                                                                          | If ≥ 1 deadline expired while paused: dialog "2 deadlines passed while paused. Results that arrived before their deadline still count; the others time out and follow their timeout routes." **Resume** / **Cancel**                                                                                                              | Pill "Running"                                                                                                                                                                     |
| **Stop…**                      | Request terminal stop: cancel owned steps; stopping until each ends, is cancelled, or is marked unknown.                                                                                                                                                                                                                                                                                 | Dialog: "Stop this Release loop instance? Running steps are cancelled. The instance can't be resumed; start a new one to run again." Lists running steps. **Stop instance** (destructive) / **Cancel**                                                                                                                            | Pill "Stopping…" → "Stopped" only when all settled                                                                                                                                 |
| **Cancel step**                | Requests cancellation of the exact current step; new work is held until it settles. The definition's cancellation/failure route or a person decides the next state. Cancellation is never success.                                                                                                                                                                                       | Dialog: "Cancel `pnpm check`? New work waits until it ends. Then it follows its cancellation route, or asks you."                                                                                                                                                                                                                 | Row shows "Cancelling…" until the runtime reports `cancelled` or `uncertain`                                                                                                       |
| **Mark step outcome unknown…** | Only while `stopping`, only for a step the runtime reports unobserved/ambiguous (the item is absent for a step confirmed live). Sends exact `entryId`, `invocationId`, `expectedRevision`, reason/evidence and acknowledgement. Records uncertainty only: it doesn't kill anything, doesn't confirm cancellation, doesn't authorize a retry, and keeps the attention item and ownership. | Dialog: "Omnyo can't see whether `<step>` is still running. Record its outcome as unknown so the instance can finish stopping? This doesn't stop the process or allow a retry. Check `<environment>` yourself." Evidence textarea (required) + checkbox "I understand the outcome stays unknown". **Record unknown** / **Cancel** | Step row "Outcome unknown"; pill becomes "Stopped · outcome unknown" when nothing else is live                                                                                     |

The UI never presents "Restart" as one action. Restart = Stop, then Start new instance.

### 8.3 Optimistic behavior

Every control sends `{instanceId, operation, expectedControlRevision,
requestId}`. The UI generates one `requestId` per user action and reuses it
on network retry, so a lost response can't double-apply. A
`REVISION_CONFLICT` refetches and shows "The instance changed. Check its
state and try again." Controls switch to a pending label ("Pausing…", "Resuming…", "Stopping…")
immediately and disable siblings. Success is confirmed by the RPC result and
the next realtime/refresh snapshot. On RPC failure: revert, inline error under
the header "Couldn't pause. <reason>" with **Try again**.

### 8.4 Concurrency display

Machine settings expose (read-only in MVP unless runtime supports edit;
runtime plan defaults): global action concurrency **2**, per
environment **1**, per instance **1** step at a time. Queued steps show
"Queued · 2 ahead (limit 1 per environment)" so the wait is explained.

---

## 9. Machine settings (`m/<machineId>/settings`)

### 9.1 General

Title, description, archive (later).

### 9.2 Context variables

Editor for `contextSchema` and `initialContext`: name (slug), type (text,
number, boolean, commit, url), initial value, writable switch (only writable
paths appear in transition Context changes). Used by guards, prompts, argv
substitution and the summary template. Budgets and counters are runtime-owned
and not editable here.

### 9.3 Environments

Environment selection for steps lists environments the runtime reports
(`sm_environment_list`, §15.6, returning `{environmentId, label, hostId, available}`)
— the plugin does not invent a picker of hosts. Unavailable environments are
listed disabled with "Offline". (Gap note: if a host environment picker
component is added to the SDK later, swap it in; not required.)

### 9.4 Authority

Read-only in MVP. Lists each step with `external-write` effect, its target and
either "Covered by existing standing authority: `<reference>`" (when the runtime
reports an exact match) or "Needs verifiable approval (not available yet)". No grant creation,
revocation or acknowledgement switch is offered (§7.8, §19 G1). The page
states: "Omnyo records no provider permission here and changes no provider."

### 9.5 Summary template

One-line template for the status line, e.g. `{{fixBranch}} for {{sourceCommit|short}}`. Preview against the latest instance context.

---

## 10. Keyboard and screen-reader design

### 10.1 Structure and landmarks

- Page: `main` region is the host's; plugin page root is a `section` with `aria-labelledby` the page title.
- Canvas: `role="group"` (not `application`) with `aria-roledescription="state graph"` and `aria-label="Release loop graph, 7 states, current: Land fix, running"`. Nodes are `role="button"` elements with roving `tabindex` (one tab stop for the whole canvas). Edges are focusable in a second roving set reachable from a node (below).
- Outline view: `role="tree"` — level 1 states (in a deterministic order: initial first, then BFS by transition priority), level 2 their outgoing transitions ("on green · dispatch → TestFlight build"). Current state item has `aria-current="step"`.
- Inspector: `complementary` region "Inspector".
- Live changes: one polite `aria-live` region announces lifecycle changes, state transitions ("Moved to TestFlight build on green"), and new attention ("Release loop needs you"). Throttled to one message per 2s; repeated executing elapsed time is never announced.

### 10.2 Canvas keys (both modes)

| Key                 | Action                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `Tab` / `Shift+Tab` | Enter/leave canvas (focus goes to selected or current node, else initial state)           |
| Arrows              | Move focus to nearest node in that direction (angle cone ±45°, nearest center)            |
| `Home` / `End`      | First / last state in outline order                                                       |
| `J`                 | Jump to current state (inspect mode)                                                      |
| `Enter`             | Select focused node and move focus to inspector heading                                   |
| `E`                 | Cycle focus through focused node's outgoing edges; `Shift+E` incoming; `Esc` back to node |
| `F`, `+`, `-`, `0`  | Fit, zoom in/out, 100%                                                                    |
| `?`                 | Shortcut list popover                                                                     |

Edit-mode keys: §6.2.

### 10.3 Accessible names

- Node: "`<title>`, `<kind>`, `<subtitle>`. `<status text>`. `<n>` transitions out." e.g. "Land fix, command, CI plus runner gate. Current, running, attempt 1 of 3. 2 transitions out."
- Edge: "From Gate to TestFlight build on green, dispatch. Last taken."
- Status is never color-only: every status has text in the meta row and the accessible name.

### 10.4 Focus management

- Dialogs return focus to the invoking control.
- After creating a node, focus moves to its inline title editor; after deleting, to the nearest remaining node.
- After resolving an attention card, focus moves to the next card, else the page heading.

### 10.5 Contrast

Edge label text uses `--color-muted-foreground` on canvas — must meet 4.5:1 in
both themes (acceptance A-40). Dimmed edges are decorative and carry no
required text.

---

## 11. Global states: loading, error, disconnected

### 11.1 Loading

- First paint shows page chrome immediately; content sections use skeletons after 150ms.
- No full-page spinner anywhere.

### 11.2 Service errors (exact copy)

| Condition (error code)                             | Where                  | Copy                                                                                               | Actions                         |
| -------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| Plugin RPC call fails at transport level (no code) | page                   | "The State machines service isn't responding."                                                     | **Try again**                   |
| `NOT_FOUND`                                        | page                   | "This <machine/instance/version> doesn't exist."                                                   | Back link                       |
| `REVISION_CONFLICT`                                | editor / header / card | §4.4 for drafts; "The instance changed. Check its state and try again." elsewhere                  | Reapply / Load latest / refresh |
| `STALE_ENTRY`                                      | attention card         | "This decision is for an earlier visit. The card has been refreshed."                              | —                               |
| `VALIDATION_FAILED`                                | publish / editor       | "Fix these before publishing" + list with paths                                                    | —                               |
| `UNSUPPORTED_SCHEMA`                               | version view           | "This version uses a newer format than this plugin can show."                                      | —                               |
| `SCOPE_MISMATCH`                                   | page                   | "This item belongs to a different project."                                                        | Back link                       |
| `EVENT_ID_CONFLICT`                                | person action          | "That request was already sent with different details."                                            | —                               |
| `ENVIRONMENT_LIFETIME_UNSUPPORTED`                 | start dialog           | "This environment may be retired, so it can't host a long-running instance." + runtime requirement | —                               |
| `CAPABILITY_UNAVAILABLE`                           | attention / step row   | "Needs configuration: <capability>."                                                               | Open log                        |
| `AUTHORITY_REQUIRED`                               | attention / step row   | "Approval for external changes needs a verified person check that Omnyo doesn't have yet."         | —                               |
| `INVOCATION_UNCERTAIN`                             | step row               | "Outcome unknown."                                                                                 | Open attention                  |
| `BACKPRESSURE`                                     | person action / header | "Too many pending inputs. Try again after the instance catches up."                                | —                               |
| `STOP_PENDING`                                     | header                 | "Still stopping: <n> steps haven't ended."                                                         | —                               |
| `OUTPUT_LIMIT`                                     | log                    | "Output reached 1 MiB; the step was stopped."                                                      | —                               |
| `STALE_SUBSCRIPTION` / `EXPIRED_RECEIPT`           | person action          | "This request expired. Press again to send a new one." (catalog refetched; no automatic resend)    | —                               |
| `NON_YIELDING_CYCLE`                               | attention              | "This loop ran 32 instant steps without waiting and was held. Edit the draft so the loop waits."   | Edit draft                      |
| Unknown                                            | inline                 | "Something went wrong. <message if safe>"                                                          | **Try again**                   |

Raw stack traces and secrets are never shown; command output is shown only in
log details and is already bounded server-side.

### 11.3 Disconnected / reconnecting

Source: `useRealtimeConnectionState(): "connecting" | "connected" | "reconnecting"` (`app-contract.ts:2537-2540`, `:3636-3642`).

- `reconnecting`: thin banner under the page header (`--color-surface-recessed`, text-xs): "Reconnecting… Live status may be out of date. Last update 14:02:11." Live animations (executing bar) stop; elapsed counters freeze and show "≥ 3m 12s".
- Back to `connected` (after a reconnect, not the first connect): refetch every mounted query, then remove the banner. If the state changed, the live region announces the new state.
- Controls remain enabled (RPC is separate from realtime) but every control success waits for a fresh snapshot before showing the new pill.
- Realtime events are hints only; the UI always re-reads state through RPC after a hint (channel `state-machines.changed`, §15.6).

---

## 12. Compact and mobile (< 768px; phone < 480px)

- **Default view is Outline.** The view switch shows **Outline | Graph | Log**.
- Graph on compact is inspect-only: pan/zoom with touch, tap selects, no editing. Editor route on compact shows the Outline in edit form: each state row opens its inspector in the drawer; "Add state" and "Add transition" are form actions; positions for new states are auto-placed (right of the last state, wrapping every 4) so the desktop graph stays tidy.
- Inspector becomes a bottom drawer using the registry `drawer`, following the AGENTS.md rule: shared persistent responsive drawer, no `inert`/`aria-hidden` on app root, transform starts before content, content realized after two animation frames with timeout fallback, then retained.
- Header actions collapse into one primary control + ⋯ menu.
- Attention cards are full width; choices are 44px tall touch targets.
- Lower cards stack: Active work above Context.
- Text never below `text-xs` (12px) on compact; `text-2xs` meta rows switch to `text-xs`.
- Verify in iOS Simulator Safari (acceptance A-60–A-63).

---

## 13. Release loop template (seed for "Start from template")

Mirrors the runtime plan's "Reference Release Loop". Positions mirror the reference
layout (columns x = 64, 464, 864; rows y = 80, 240, 400, 560). Fields that need
a person's choice stay empty, so the draft shows problems until configured. No
model is preselected and no step has executable publication.

| stateId                | Title                   | Kind    | Subtitle         | Notes                                                                                                                      |
| ---------------------- | ----------------------- | ------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `waiting`              | Waiting for new commits | Wait    | between ticks    | Source observation event + check every 5m; person action `person.promote`                                                  |
| `gate`                 | Gate                    | Command | pnpm check       | argv `["pnpm","check"]`, effect `local-read`, environment unset                                                            |
| `testflight-build`     | TestFlight build        | Command | internal build   | Effect `external-write`, category Release; argv empty → `missing-command`; stops with `AUTHORITY_REQUIRED` until G1 exists |
| `fixer-agent`          | Fixer agent             | Agent   | opens a PR       | Effect `local-edit`; outcome `pr-opened {prNumber, headSha}`; repair budget 2 per source SHA (runtime-owned)               |
| `land-fix`             | Land fix                | Command | CI + runner gate | Observes CI/review for the exact PR head; effect `external-read`; merge needs separate authority                           |
| `needs-person`         | Needs a person          | Manual  | loop paused      | Decisions: Resume waiting (evidence required), Retry gate                                                                  |
| `production-promotion` | Production promotion    | Manual  | manual           | Shows artifact/version/channel; decisions: Promotion verified, Rejected, Unknown                                           |

| From → To                           | Trigger · label                                                    |
| ----------------------------------- | ------------------------------------------------------------------ |
| initial → waiting                   | —                                                                  |
| waiting → gate                      | `source.new-sha` · "new commit on main"                            |
| waiting → production-promotion      | `person.promote` · "promote · manual"                              |
| gate → testflight-build             | `succeeded` · "green · dispatch"                                   |
| gate → fixer-agent                  | `failed` · "red"                                                   |
| gate → needs-person                 | `timed-out` · "timed out"                                          |
| testflight-build → waiting          | `succeeded` · "released to internal TestFlight"                    |
| testflight-build → fixer-agent      | `failed` · "build or tests failed"                                 |
| testflight-build → needs-person     | `timed-out` · "stalled or infra failure"                           |
| fixer-agent → land-fix              | `result.pr-opened` · "PR opened"                                   |
| fixer-agent → needs-person          | `no-result` · "no repair"                                          |
| fixer-agent → needs-person          | `budget-exhausted` · "fixer limit"                                 |
| fixer-agent → needs-person          | `failed` / `timed-out` · "fixer failed"                            |
| land-fix → gate                     | `succeeded` · "merged · main moved"                                |
| land-fix → needs-person             | `failed` / `timed-out` · "needs review or red"                     |
| needs-person → waiting              | `decision.resume-waiting` · "resume waiting"                       |
| needs-person → gate                 | `decision.retry-gate` · "retry gate"                               |
| production-promotion → waiting      | `decision.verified` · "verified"; `decision.rejected` · "rejected" |
| production-promotion → needs-person | `decision.unknown` · "unknown"                                     |

Transitions listing two triggers are drawn as one edge with a combined label
but stored as two transitions with distinct priorities.

Deliberate differences from the screenshot: "clear-attention" becomes the
explicit **resume waiting** decision; the fixer bound is a runtime repair
budget shown in the Context card ("Fixer rounds for 5c05d51: 1 of 2"), not an
editable context counter; "promote · manual" is a person action that only
enters the promotion gate and never approves or runs a promotion.

## 14. Visual tokens and CSS rules

All plugin CSS lives in `app.css` (and per-area CSS files imported by it),
classes prefixed `stm-`. No `@scope`. Plugin-build already confines utilities
via `:where(<roots>)` (`packages/plugin-build/src/scope-plugin-utilities.ts:20`);
plugin-authored selectors stay single-class or `:where()`-wrapped descendants.

### 14.1 Plugin custom properties (defined on `.stm-root`, derived from host tokens only)

```css
.stm-root {
  --stm-canvas: var(--card);
  --stm-canvas-draft: var(--surface-recessed);
  --stm-grid-dot: color-mix(in oklab, var(--foreground) 12%, transparent);
  --stm-node-bg: var(--card);
  --stm-node-border: var(--border);
  --stm-node-title: var(--foreground);
  --stm-node-sub: var(--muted-foreground);
  --stm-edge: color-mix(in oklab, var(--foreground) 55%, transparent);
  --stm-edge-dim: color-mix(in oklab, var(--foreground) 30%, transparent);
  --stm-edge-strong: var(--foreground);
  --stm-edge-label: var(--muted-foreground);
  --stm-current: var(--warning);
  --stm-current-bg: color-mix(in oklch, var(--warning) 10%, var(--card));
  --stm-attention: var(--attention);
  --stm-attention-bg: var(--surface-attention);
  --stm-failed: var(--destructive-text);
  --stm-failed-bg: var(--surface-destructive);
  --stm-final-bg: var(--surface-recessed);
  --stm-focus: var(--ring);
  --stm-selected-bg: var(--surface-selected);
  --stm-selected-border: var(--surface-selected-border);
  --stm-diff-added: var(--diff-added);
  --stm-diff-removed: var(--diff-removed);
}
```

Every referenced host token exists in `apps/app/src/components/ui/theme.css`
(verified token names: `--color-card`, `--color-surface-recessed`,
`--color-foreground`, `--color-border`, `--color-muted-foreground`,
`--color-warning`, `--color-attention`, `--color-surface-attention`,
`--color-destructive-text`, `--color-surface-destructive`, `--color-ring`,
`--color-surface-selected`, `--color-surface-selected-border`,
`--color-diff-added`, `--color-diff-removed`, `--color-success`,
`--color-warning-text`, `--color-surface-raised`). Implementation must confirm
each resolves inside plugin pages (acceptance A-41).

Rules: no hex/rgb literals, no `oklch(L 0 0)`; opaque mixes `in oklch`,
translucent mixes `in oklab`; dark and light both derived automatically.

### 14.2 Typography

Sanctioned scale only: `text-2xs`, `text-xs`, `text-sm`, `text-base`
(theme.css `--text-*`). No `text-[Npx]`. Mono via `font-mono`. Numbers that
tick (elapsed, counters) use `tabular-nums`.

### 14.3 Spacing and shape

4px base; node radius 8px; card radius matches registry `card`; inspector
section padding 16px; canvas padding 48px; focus ring 2px with 2px offset.

### 14.4 Motion

Only: executing bar (1.6s linear loop, compositor `transform` sweep), loading
skeleton pulse (1.4s opacity loop, `--motion-ease-in-out`), drawer transform
(host drawer). All disabled/static under `prefers-reduced-motion: reduce`.

---

## 15. UI-facing contracts (aligned with the runtime plan; runtime owns the schemas)

The runtime owns the canonical schemas in `src/contracts/*.ts`. This section fixes
what the UI reads and writes, and the exact mapping between the editor's
relaxed draft and the canonical definition. Names here are the agreed names.

### 15.1 Status literals and projection

```ts
type Lifecycle = "running" | "paused" | "stopping" | "stopped" | "completed" | "failed";
type Phase = "waiting" | "queued" | "executing" | "retry-wait" | "needs-person" | "uncertain";
type AttemptStatus =
  | "pending"
  | "dispatching"
  | "running"
  | "result-ready"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancel-requested"
  | "cancelled"
  | "uncertain";
type DisplayStepStatus =
  | "queued"
  | "starting"
  | "running"
  | "finishing"
  | "retry-wait"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "uncertain";
```

| Runtime `AttemptStatus` (+ flags)                                | UI `DisplayStepStatus` | Copy                                                               |
| ---------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `pending` with admission reason                                  | `queued`               | "Queued · <reason>"                                                |
| `pending` with `nextRetryAt`                                     | `retry-wait`           | "Retry 2/3 in 30s"                                                 |
| `dispatching`                                                    | `starting`             | "Starting…"                                                        |
| `running`                                                        | `running`              | "Running · m:ss"                                                   |
| `result-ready`                                                   | `finishing`            | "Result submitted · finishing"                                     |
| `cancel-requested`                                               | `cancelling`           | "Cancelling…"                                                      |
| `succeeded` / `failed` / `timed-out` / `cancelled` / `uncertain` | same                   | "Succeeded", "Failed", "Timed out", "Cancelled", "Outcome unknown" |

`ui/data/projection.ts` is the only place that maps; it is table-tested and
throws on an unknown runtime status (no silent default).

### 15.2 Relaxed editor draft vs canonical definition

The editor works on `EditorDraft`: the canonical `MachineDefinition` shape in
which only the fields listed below may be `null` (incomplete). Publishing
requires the runtime compiler to produce a canonical `MachineDefinition`
(schemaVersion 1, tagged unions, no unknown fields). Each nullable field has
exactly one problem code; there are no editor-only fields that the compiler
ignores. Display-only data lives in `layout` and is excluded from the
semantic hash.

| Editor field (may be null in draft)       | Canonical path                   | Problem code if null/invalid |
| ----------------------------------------- | -------------------------------- | ---------------------------- |
| `initialStateId`                          | `initialStateId`                 | `no-initial`                 |
| agent `prompt`                            | `states[i].action.prompt`        | `missing-prompt`             |
| agent `execution`                         | `states[i].action.execution`     | `missing-model`              |
| agent/command `environmentId`             | `states[i].action.environmentId` | `missing-environment`        |
| agent `result.outcomes` (empty)           | `states[i].action.result`        | `missing-result-schema`      |
| command `argv` (empty or empty program)   | `states[i].action.argv`          | `missing-command`            |
| wait `triggers` (empty)                   | `states[i].triggers`             | `wait-no-trigger`            |
| manual `decisions` (empty)                | `states[i].decisions`            | `gate-no-decisions`          |
| transition `to` (dangling while dragging) | `transitions[j].to`              | `dangling-transition`        |
| guard leaf with missing value             | `transitions[j].guard…`          | `guard-incomplete`           |

Server problems carry the exact JSON path (`/states/3/action/argv`); the
inspector maps the path to the field and focuses it on click.

### 15.3 Canonical shapes the UI renders (conceptual; runtime file is authority)

```ts
interface MachineDefinition {
  schemaVersion: 1;
  machineId: string;
  name: string;
  description: string;
  initialStateId: string;
  contextSchema: ContextSchema;
  initialContext: JsonValue;
  states: StateDefinition[];
  transitions: TransitionDefinition[];
  limits: MachineLimits;
  layout: GraphLayout;
}
type StateDefinition =
  | { kind: "wait"; id: string; title: string; subtitle: string; triggers: WaitTrigger[] }
  | { kind: "choice"; id: string; title: string; subtitle: string }
  | {
      kind: "agent";
      id: string;
      title: string;
      subtitle: string;
      action: AgentAction;
      deadlineMs: number;
      maxAttempts: number;
      effect: Effect;
      effectTarget: string;
      annotations: Annotations;
    }
  | {
      kind: "command";
      id: string;
      title: string;
      subtitle: string;
      action: CommandAction;
      deadlineMs: number;
      maxAttempts: number;
      effect: Effect;
      effectTarget: string;
      annotations: Annotations;
    }
  | {
      kind: "manual";
      id: string;
      title: string;
      subtitle: string;
      prompt: string;
      decisions: Decision[];
    }
  | { kind: "end"; id: string; title: string; outcome: "success" | "failure"; reason: string };
type Effect = "local-read" | "local-edit" | "external-read" | "external-write";
interface Annotations {
  category: "repository" | "release" | null;
}
interface AgentAction {
  prompt: string;
  execution: ExperimentalProviderModelPickerValue;
  permissionMode: PermissionMode;
  environmentId: string;
  result: { outcomes: { name: string; fields: TypedField[] }[] };
}
interface CommandAction {
  argv: ({ literal: string } | { contextPath: string })[];
  shell: false;
  cwd: string;
  environmentId: string;
  successExitCodes: number[];
  retrySafety: "never" | "adapter-verified";
}
type WaitTrigger =
  | { kind: "event"; eventType: string; filter: Record<string, JsonValue> }
  | { kind: "check"; everyMs: number };
interface Decision {
  id: string;
  label: string;
  evidenceRequired: boolean;
  evidencePrompt: string;
}
interface TransitionDefinition {
  id: string;
  from: string;
  to: string;
  trigger: Trigger;
  guard: GuardExpression | null;
  contextPatch: PatchOperation[];
  priority: number;
}
type GuardExpression =
  | { all: GuardExpression[] }
  | { any: GuardExpression[] }
  | { not: GuardExpression }
  | { exists: Path }
  | { [op in "eq" | "ne" | "lt" | "lte" | "gt" | "gte"]?: [Path, Literal] }
  | { in: [Path, Literal[]] };
type Path = { root: "context" | "event" | "result"; segments: string[] };
type PatchOperation =
  | { op: "set"; path: string[]; value: Literal | Path }
  | { op: "remove"; path: string[] };
interface GraphLayout {
  initial: Point;
  nodes: Record<string, Point>;
  edges: Record<string, EdgeLayout>;
  edgeLabels: Record<string, string>;
}
```

`Point`, `EdgeLayout`, `ContextSchema`, `TypedField`, `Trigger`, `Literal`,
`MachineLimits` follow the runtime file. Retry backoff, repair budgets,
admission limits and lifecycle are engine-owned and never appear in patches.

### 15.4 Views the UI reads

```ts
interface InstanceView {
  instanceId: string;
  machineId: string;
  versionId: string;
  versionNumber: number;
  latestVersionNumber: number;
  revision: number;
  controlRevision: number;
  asOf: number;
  lifecycle: Lifecycle;
  phase: Phase | null;
  pauseAfterStep: boolean;
  stateId: string;
  entryId: string;
  summary: string;
  pendingResultCount: number;
  lastTransition: { transitionId: string; at: number } | null;
  context: { path: string; value: JsonValue; display: string }[];
  budgets: { label: string; used: number; limit: number; subject: string }[];
  cyclesCompleted: number;
  steps: {
    invocationId: string;
    attemptId: string;
    stateId: string;
    kind: "agent" | "command";
    status: AttemptStatus;
    admissionReason: string | null;
    attempt: number;
    maxAttempts: number;
    dispatchedAt: number | null;
    deadlineAt: number | null;
    nextRetryAt: number | null;
    environmentId: string;
    threadId: string | null;
    confirmedLive: boolean;
  }[];
  unknownOutcomes: { invocationId: string; blocksRestartIn: string | null }[];
  standingAuthority: { stateId: string; reference: string; scope: string }[];
  quarantined: { code: string; reference: string } | null;
}
interface AttentionItem {
  attentionId: string;
  kind:
    | "gate"
    | "uncertain"
    | "retries-exhausted"
    | "authority-required"
    | "instance-failed"
    | "non-yielding-cycle"
    | "capability-unavailable";
  instanceId: string;
  entryId: string;
  invocationId: string | null;
  revision: number;
  title: string;
  bodyMarkdown: string;
  evidenceSummary: string | null;
  createdAt: number;
  decisions: {
    name: string;
    label: string;
    targetStateId: string | null;
    evidenceRequired: boolean;
    disabledReason: string | null;
  }[];
}
```

```ts
interface EventCatalogEntry {
  eventType: string;
  label: string;
  source: string;
  personOnly: boolean;
  subscriptionId: string | null;
  epoch: number | null;
  payloadSchema: JsonValue;
}
```

Log rows come from `sm_history_list` (transitions, consumed/ignored events
with disposition, step attempts, controls, decisions) with cursor `after`.
Ignored events show their reason ("stale visit", "no matching transition").
Unchanged observations appear as one updating row per subscription: "No
change · last checked 14:02 · 12 checks coalesced".

### 15.5 Mutation envelope

Every mutation includes `requestId` (UUID per user action, reused on retry)
and the expected revision for its object: `expectedRevision` (draft or
instance), `expectedControlRevision` (controls), and `entryId` for decisions
and step operations. The UI never sends an actor. The server records the
calling client, but the plugin RPC context can't tell a person from the CLI or
an agent (§19.2), so the UI and runtime never infer a human from the session.
Records show the client as "Recorded by this Omnyo client", not as a named person. No mutation has a force flag.

### 15.6 RPC naming map (UI concept → runtime method)

| UI concept                                                                           | RPC method                                                             | Service call       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------ |
| machines.list                                                                        | `sm_machine_list`                                                      | `listMachines`     |
| machines.create                                                                      | `sm_machine_create`                                                    | `createMachine`    |
| draft.get / draft.save                                                               | `sm_machine_draft_get` / `sm_machine_draft_save`                       | `saveDraft`        |
| draft.validate                                                                       | `sm_machine_validate`                                                  | `validateDraft`    |
| draft.publish                                                                        | `sm_machine_publish`                                                   | `publishVersion`   |
| versions.list / get / export                                                         | `sm_machine_versions` / `sm_machine_version_get` / `sm_machine_export` | `exportDefinition` |
| instances.start                                                                      | `sm_instance_start`                                                    | `startInstance`    |
| instances.get / list                                                                 | `sm_instance_inspect` / `sm_instance_list`                             | `inspectInstance`  |
| instances.control (pause, pause-after-step, resume, stop, cancel-step, mark-unknown) | `sm_instance_control`                                                  | `controlInstance`  |
| person action (e.g. promote request)                                                 | `sm_instance_signal`                                                   | `signalInstance`   |
| attention.list / resolve                                                             | `sm_attention_list` / `sm_attention_resolve`                           | `resolveAttention` |
| history                                                                              | `sm_history_list`                                                      | `listHistory`      |
| state visits                                                                         | `sm_state_history`                                                     | `listStateHistory` |
| event catalog                                                                        | `sm_events_catalog`                                                    | `eventCatalog`     |
| step output                                                                          | `sm_log_read`                                                          | `readLog`          |
| environments                                                                         | `sm_environment_list`                                                  | (runtime read)     |

The draft-get, versions, instance-list, attention-list and environment-list
names are this file's proposals where the runtime plan lists none; the runtime may
rename them in `src/contracts/rpc.ts` and update this table in the same change.

Realtime: one channel `state-machines.changed` with `{kind, id, revision}`; the
UI refetches the affected view and on every reconnect.

Errors rendered by code: `VALIDATION_FAILED`, `REVISION_CONFLICT`,
`EVENT_ID_CONFLICT`, `NOT_FOUND`, `SCOPE_MISMATCH`, `STALE_ENTRY`,
`STALE_SUBSCRIPTION`, `EXPIRED_RECEIPT`, `NON_YIELDING_CYCLE`, `UNSUPPORTED_SCHEMA`, `ENVIRONMENT_LIFETIME_UNSUPPORTED`,
`CAPABILITY_UNAVAILABLE`, `AUTHORITY_REQUIRED`, `INVOCATION_UNCERTAIN`,
`BACKPRESSURE`, `STOP_PENDING`, `OUTPUT_LIMIT` (copy in §11.2).

CLI parity: every control above exists in the `omnyo state-machines` CLI;
the UI adds no capability the CLI lacks.

## 16. Frontend file map (proposed; under `state-machines/`)

| Path                                                                                                                                                                                                                                                            | Responsibility                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.tsx`                                                                                                                                                                                                                                                       | `definePluginApp`: navPanel, headerContent, commands                                                                                                                                                                                                                                                      |
| `app.css`                                                                                                                                                                                                                                                       | imports `ui/**/*.css`; `.stm-root` tokens (§14.1)                                                                                                                                                                                                                                                         |
| `ui-contract.ts`                                                                                                                                                                                                                                                | §15 types + `PluginRpcContract` declaration (shared with server; parent may own location)                                                                                                                                                                                                                 |
| `ui/routes.ts`                                                                                                                                                                                                                                                  | parse/format `subPath` + `?sel=`; tests                                                                                                                                                                                                                                                                   |
| `ui/data/store.ts`                                                                                                                                                                                                                                              | query cache per key, refetch on realtime hint and on reconnect (`useRealtimeConnectionState`), stale timestamps                                                                                                                                                                                           |
| `ui/data/hooks.ts`                                                                                                                                                                                                                                              | `useMachines`, `useDraft`, `useInstance`, `useAttention`, `useLog`                                                                                                                                                                                                                                        |
| `ui/shell/MachinesPanel.tsx`                                                                                                                                                                                                                                    | route switch, page shell, breadcrumb, reconnect banner                                                                                                                                                                                                                                                    |
| `ui/shell/HeaderContent.tsx`                                                                                                                                                                                                                                    | attention count + connection label                                                                                                                                                                                                                                                                        |
| `ui/screens/MachineList.tsx`, `MachinePage.tsx`, `InstanceView.tsx`, `DraftEditor.tsx`, `Versions.tsx`, `InstanceLog.tsx`, `AttentionInbox.tsx`, `NewMachine.tsx`, `MachineSettings.tsx`                                                                        | screens §4, §9                                                                                                                                                                                                                                                                                            |
| `ui/graph/Canvas.tsx`                                                                                                                                                                                                                                           | viewport, pan/zoom, modes, roving focus                                                                                                                                                                                                                                                                   |
| `ui/graph/Node.tsx`, `Edge.tsx`, `InitialDot.tsx`                                                                                                                                                                                                               | anatomy §5.2–5.3                                                                                                                                                                                                                                                                                          |
| `ui/graph/route.ts`                                                                                                                                                                                                                                             | deterministic orthogonal router + label placement (pure; unit tested)                                                                                                                                                                                                                                     |
| `ui/graph/spatial-nav.ts`                                                                                                                                                                                                                                       | arrow-key nearest-node logic (pure)                                                                                                                                                                                                                                                                       |
| `ui/graph/status-style.ts`                                                                                                                                                                                                                                      | (lifecycle, phase, current) → visual state (pure, table-tested)                                                                                                                                                                                                                                           |
| `ui/graph/edit-model.ts`                                                                                                                                                                                                                                        | draft reducer, undo/redo stack, autosave scheduler                                                                                                                                                                                                                                                        |
| `ui/graph/validate.ts`                                                                                                                                                                                                                                          | client mirror of server problem codes                                                                                                                                                                                                                                                                     |
| `ui/outline/Outline.tsx`                                                                                                                                                                                                                                        | tree view for SR/compact/editing                                                                                                                                                                                                                                                                          |
| `ui/inspector/Inspector.tsx` + `StateFields.tsx`, `AgentFields.tsx`, `CommandFields.tsx`, `WaitFields.tsx`, `ManualFields.tsx`, `TransitionFields.tsx`, `GuardBuilder.tsx`, `RetryFields.tsx`, `AuthorityFields.tsx`, `LiveStatePanel.tsx`, `InstancePanel.tsx` | §7                                                                                                                                                                                                                                                                                                        |
| `ui/run/RunControls.tsx`, `StopDialog.tsx`, `ResumeDialog.tsx`, `ActiveWork.tsx`, `ContextCard.tsx`                                                                                                                                                             | §8, §4.3                                                                                                                                                                                                                                                                                                  |
| `ui/attention/AttentionCard.tsx`                                                                                                                                                                                                                                | §4.8 (also embedded in inspector)                                                                                                                                                                                                                                                                         |
| `ui/publish/PublishDialog.tsx`, `ChangeSummary.tsx`                                                                                                                                                                                                             | §4.5                                                                                                                                                                                                                                                                                                      |
| `ui/a11y/live-region.tsx`                                                                                                                                                                                                                                       | throttled announcer                                                                                                                                                                                                                                                                                       |
| `components/ui/*`                                                                                                                                                                                                                                               | vendored registry items: `button, dialog, drawer, dropdown-menu, context-menu, collapsible, table, tabs, toggle-group, select, input, textarea, switch, radio-group, tooltip, popover, badge, alert, skeleton, empty-state, delayed-loading, breadcrumb, progress, inline-rename, resizable, scroll-area` |

Tests (Vitest DOM with `installTestPluginRuntime()` from
`@omnyo/plugin-sdk/testing/app`, `packages/plugin-sdk/src/testing/app.tsx:1568`):
`route.test.ts`, `spatial-nav.test.ts`, `status-style.test.ts`,
`edit-model.test.ts`, `validate.test.ts`, `routes.test.ts`, screen tests per
acceptance row marked DOM.

---

## 17. MVP vs later

| Area                   | MVP                                                                                     | Later                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation             | navPanel, headerContent, palette commands                                               | `fixedTabs` inspector/log in host right panel; `homepageSection` "Needs you"; Needs-you sidebar highlight integration; sidebar accessory once a host surface mounts it |
| Graph                  | own renderer, router, persisted layout, inspect/edit/readonly/preview, diff badges      | auto "Arrange" (layered layout; evaluate elkjs bundle size via `omnyo plugin build` first), minimap, grouping/swimlanes                                                |
| Node kinds             | agent, command, wait, choice, manual, end                                               | hierarchical/sub-machines, parallel regions (deferred by parent)                                                                                                       |
| Editing                | desktop full; compact form-based via Outline                                            | multi-user presence, server-side undo history                                                                                                                          |
| Versions               | publish, list, view, compare, copy to draft                                             | instance migration to new version                                                                                                                                      |
| Runs                   | start, pause, pause after step, resume, stop, cancel step, mark unknown (stopping only) | restart-in-place, scheduled pause windows                                                                                                                              |
| Attention              | inbox, inline gate cards, uncertain/authority/exhausted/failed kinds                    | reminders, assignment, thread-based `requestInput` rows when a machine is bound to an owner thread                                                                     |
| Agent thread placement | new thread per run                                                                      | reuse instance thread                                                                                                                                                  |
| Log                    | paged, filters, output tail                                                             | full-text server search, export                                                                                                                                        |
| Settings               | context vars, read-only authority status, summary template, read-only concurrency       | editable concurrency, archive machine                                                                                                                                  |

---

## 18. Acceptance matrix

Surface key: **U** unit (pure), **D** DOM test (Vitest + test runtime), **B**
Omnyo app in-app browser (Playwright against a dev Omnyo), **S** iOS Simulator Safari.

| ID   | Scenario                                  | Expected                                                                                                                                                                                       | Surface                                     |
| ---- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A-01 | Open navPanel root with 0 machines        | Empty state copy §4.1, both actions                                                                                                                                                            | D                                           |
| A-02 | Deep link `m/<id>/i/<ins>?sel=state:gate` | Instance view, Gate selected, inspector open                                                                                                                                                   | D, B                                        |
| A-03 | Machine with one instance                 | `m/<id>` replaces history to instance route; Back goes to list                                                                                                                                 | B                                           |
| A-04 | Back/forward across list → instance → log | Host history walks panel routes                                                                                                                                                                | B                                           |
| A-10 | Template seed                             | 7 states, 17 transitions plus the initial edge; problems include missing model, authority, environment and command                                                                             | D                                           |
| A-11 | Add/connect/delete via keyboard only      | Same draft as pointer path; focus rules §10.4                                                                                                                                                  | D                                           |
| A-12 | Undo/redo 20 mixed edits                  | Model equals snapshot at each step                                                                                                                                                             | U                                           |
| A-13 | Autosave debounce + conflict              | Single save per burst; conflict banner on stale `baseRevision`                                                                                                                                 | D                                           |
| A-14 | Publish blocked by errors                 | Button disabled with reason; dialog lists problems on server race                                                                                                                              | D                                           |
| A-15 | Publish success                           | "Published v5", editor "Based on v5", running instance shows "Runs v4. v5 is published."                                                                                                       | D, B                                        |
| A-16 | Router determinism                        | Same input → same polyline; no node overlap on template                                                                                                                                        | U                                           |
| A-17 | Spatial arrow nav                         | Arrow picks nearest in cone; no dead ends on template                                                                                                                                          | U                                           |
| A-20 | Status mapping                            | Every (lifecycle, phase) pair maps to one visual state with text cue                                                                                                                           | U                                           |
| A-21 | Executing current state                   | Amber border, bar, "Running · m:ss · 1/3"; reduced motion static                                                                                                                               | D                                           |
| A-22 | Pause while executing                     | Pill Paused; step keeps running; on result: "1 result waiting"; no transition until Resume                                                                                                     | D (fake runtime), B                         |
| A-23 | Resume with expired deadline              | Resume dialog lists expired steps                                                                                                                                                              | D                                           |
| A-24 | Pause after current step                  | Pill text, then Paused after transition                                                                                                                                                        | D                                           |
| A-25 | Stop with live step                       | "Stopping…" until step settles; never "Stopped" while an invocation is executing                                                                                                               | D                                           |
| A-26 | Mark unknown during stopping              | Only after deadline; creates attention; then Stopped                                                                                                                                           | D                                           |
| A-27 | Uncertain outcome                         | Dashed attention node, "Outcome unknown", server-listed decisions only; "Retry after checking" needs evidence and is disabled while `confirmedLive`                                            | D                                           |
| A-28 | Gate resolution                           | Confirm disabled until choice (+ note if required); no preselection; stale → "Resolved by …"                                                                                                   | D                                           |
| A-29 | Limit-disabled choice                     | "fixer rounds 2 of 2 used" visible, choice disabled                                                                                                                                            | D                                           |
| A-30 | Model picker                              | Host picker renders with environment routing; value stored verbatim; disabled in live                                                                                                          | D (test runtime), B                         |
| A-31 | No default model                          | Template agent step shows "Choose a model" and `missing-model`                                                                                                                                 | D                                           |
| A-32 | Authority                                 | `external-write` step shows the §7.8 notice, offers no approval control, and at run time renders an `AUTHORITY_REQUIRED` card without an "Allow" decision                                      | D                                           |
| A-33 | Agent finishing                           | `result-ready` shows "Result submitted · finishing"; no edge highlight until transition commits; after grace the step shows "Outcome unknown" with the result labeled "Submitted, not applied" | D                                           |
| A-38 | Expired person request                    | `STALE_SUBSCRIPTION`/`EXPIRED_RECEIPT` refetches catalog, shows expiry copy, sends nothing automatically                                                                                       | D                                           |
| A-39 | Standing authority                        | Runtime-reported exact authority renders read-only "Covered by…"; no UI path creates or edits authority                                                                                        | D                                           |
| A-34 | Pause after step                          | Active step settles, one transition, paused before target dispatch; idle pauses immediately                                                                                                    | D (fake runtime)                            |
| A-35 | Mutation envelope                         | Every mutation carries requestId + expected revision; retry reuses requestId; no actor or force field sent                                                                                     | D                                           |
| A-36 | Projection                                | Every `AttemptStatus` maps per §15.1; unknown status throws                                                                                                                                    | U                                           |
| A-37 | Mark unknown                              | Absent for `confirmedLive` steps; requires evidence + acknowledgement; result "Stopped · outcome unknown"                                                                                      | D                                           |
| A-40 | Contrast                                  | Edge label and meta text ≥ 4.5:1 in light and dark                                                                                                                                             | B                                           |
| A-41 | Tokens resolve                            | Every `--stm-*` resolves to a non-empty computed value in both themes; no hex/achromatic oklch in CSS (lint grep)                                                                              | B, U                                        |
| A-42 | No `@scope`, no `text-[`                  | Grep on plugin sources returns none                                                                                                                                                            | U                                           |
| A-50 | Screen reader names                       | Node/edge names per §10.3; live region announces transition once                                                                                                                               | D (aria assertions) + manual VoiceOver pass |
| A-51 | Outline parity                            | Outline lists all states/transitions in deterministic order with `aria-current`                                                                                                                | D                                           |
| A-52 | Tab order                                 | One tab stop for canvas; Esc from edge returns to node                                                                                                                                         | D                                           |
| A-55 | Reconnecting                              | Banner, frozen counters "≥", refetch on reconnect (not on first connect)                                                                                                                       | D                                           |
| A-56 | Service down                              | "The State machines service isn't responding." + Try again                                                                                                                                     | D                                           |
| A-60 | Compact default                           | < 768px shows Outline; graph inspect-only                                                                                                                                                      | S                                           |
| A-61 | Drawer inspector                          | Shared drawer, no app-root `inert`/`aria-hidden`, deferred realization retained                                                                                                                | S                                           |
| A-62 | Touch targets                             | Gate choices ≥ 44px                                                                                                                                                                            | S                                           |
| A-63 | Compact editing                           | Add state/transition via forms; auto-placement doesn't overlap                                                                                                                                 | S                                           |

---

## 19. Gaps, risks and resolved alignment

### 19.1 Resolved with the runtime plan (revision SM-2, 2026-10-20)

| Item                     | Resolution in this file                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| IDs                      | `mch_`, `ver_`, `ins_`, `ent_`, `tr_`, `inv_`, `try_`, `evt_`, `att_` (§1)                                                  |
| Lifecycle / phase        | Identical literals (§2, §15.1)                                                                                              |
| Attempt statuses         | Runtime `AttemptStatus` projected to `DisplayStepStatus` by one table (§15.1)                                               |
| Pause after current step | Persisted `pauseAfterStep`; one step settles, one transition, paused before target dispatch; idle pauses immediately (§8.2) |
| Promote from Waiting     | Person action entering the manual promotion gate; never approval to publish (§7.4, §13)                                     |
| Event catalog            | `sm_events_catalog`, derived from version and permitted sources, including `personOnly` (§7.4)                              |
| State history            | Cursor-paged visits with retention bound shown (§7.5)                                                                       |
| Deadlines                | 10m command, 30m agent, max 2h, from dispatch (§7.7)                                                                        |
| Retries                  | ≤ 3 attempts, 5s then 30s, never for ambiguous work; `retrySafety` from adapter (§7.3, §7.6)                                |
| Mark outcome unknown     | Stopping only, exact entry/invocation/revision/evidence, absent for confirmed-live steps, no retry authority (§8.2)         |
| Commands                 | argv array, `shell: false`, whole-argument context substitution (§7.3)                                                      |
| Agent success            | Structured result tool only; "Result submitted · finishing" until worker quiescence (§7.2)                                  |
| Guards / patches         | Runtime AST and `set`/`remove` only (§7.9, §15.3)                                                                           |
| Effects                  | Runtime four classes; Repository/Release are display categories (§7.8)                                                      |
| Draft vs canonical       | Relaxed draft with one problem per nullable field; no ignored fields (§15.2)                                                |
| Mutations                | requestId + expected revision/entry; actor server-derived; no force overwrite (§4.4, §15.5)                                 |
| Result settling          | Result-ready keeps ownership until worker quiescence; 60s grace then Outcome unknown (§7.2)                                 |
| Subscriptions            | Person/external signals carry subscriptionId + epoch; expired requests never auto-resent (§7.4, §11.2)                      |
| Observations             | Unchanged checks shown as one coalesced row (§15.4)                                                                         |
| Authority                | Exact existing standing authority shown read-only; otherwise `AUTHORITY_REQUIRED` (§7.8, §19.2)                             |
| RPC names                | One map to `sm_*` (§15.6)                                                                                                   |

### 19.2 Core prerequisite G1: trusted provenance for outward-effect approval

The plugin RPC context classifies the app, CLI and agents alike as client
(`packages/plugin-sdk/src/rpc-contract.ts:90-100`). Hidden buttons, omitted
tools and `personOnly` catalog labels therefore prove no human actor. The
frontend needs no new slot or SDK extension. Creating any new outward-effect
grant needs a separately scoped trusted core decision/provenance capability,
which the runtime plan SM-2 records as a prerequisite. Until it exists:

- `external-write` steps run only under an exact existing standing authority
  the runtime reports (shown read-only); otherwise they stop with
  `AUTHORITY_REQUIRED`.
- The UI offers no approval, grant or "Allow" control.
- Manual decisions are recorded as operator intent. Copy never calls them
  approvals.

### 19.3 Remaining implementation checks (not blockers)

- **Experimental SDK members used**: `experimental_ProviderModelPicker`,
  `experimental_PermissionModePicker`, `experimental_Icon`,
  `experimental_copyToClipboard`, `experimental_usePluginId`; isolate behind
  small wrappers.
- **Icon names** (`Workflow`, `Bot`, `Terminal`, `Clock`, `GitBranch`, `Hand`,
  `CircleStop`, `Play`, `Pause`, `Square`, `CircleCheck`, `CircleX`, `Loader`)
  are unverified; unknown names fall back to branding (`app-contract.ts:594-603`).
- **Toasts**: none assumed; success messages are inline.
- **Environment picker**: plugin select over `sm_environment_list`; unsuitable
  environments show `ENVIRONMENT_LIFETIME_UNSUPPORTED` copy.
- **Manual gates outside threads**: resolved in the panel; `pendingInteraction`
  rows are thread-scoped (`backend-contract.ts:1091-1101`).
- **Router quality on dense graphs**: persisted waypoints, `route-overlap`
  info problem, later layered auto-arrange.

## 20. Implementation notes (2026-10-20)

The implemented UI follows this file with these deliberate, source-bound differences:

| Area                              | Implemented behavior                                                                                                                                                                                                                                                                                                                  | Reason                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palette commands (§3.1)           | Not registered.                                                                                                                                                                                                                                                                                                                       | `PluginCommandContext` cannot open a navPanel; the sidebar entry is the route.                                                                                                                                   |
| Selection in routes (§3.2)        | A trailing path segment `@state:<id>` or `@tr:<id>`; compare is `v/<versionId>/compare/<versionId>`.                                                                                                                                                                                                                                  | `subPath` carries a path; a query string is not part of the contract.                                                                                                                                            |
| Removing a manual decision (§7.4) | Keeps transitions that use it; they show a problem until changed.                                                                                                                                                                                                                                                                     | No silent graph deletion; the problem list makes the follow-up explicit.                                                                                                                                         |
| Multi-select (§6.2)               | Shift+click and Shift+Space toggle; no marquee.                                                                                                                                                                                                                                                                                       | Marquee deferred; keyboard parity kept.                                                                                                                                                                          |
| Model choice (§7.2)               | **Choose a model** opens the host picker seeded with the first available provider and no model; **Use this model** commits. Nothing is stored until confirmed.                                                                                                                                                                        | The picker needs a value; the plugin never ships a default model.                                                                                                                                                |
| Permission default (§7.2)         | Choosing a model for a `local-read`/`local-edit` step sets `accept-edits`; otherwise the field stays empty.                                                                                                                                                                                                                           | Least-permissive explicit default tied to the user's action.                                                                                                                                                     |
| Discard draft (§4.4)              | Not offered in the editor; **Copy to draft** in a version replaces the draft after confirmation.                                                                                                                                                                                                                                      | The RPC has no discard method; copy reuses `sm_machine_draft_save`.                                                                                                                                              |
| Summary template (§9.5)           | Not editable; the status line shows `InstanceView.summary`.                                                                                                                                                                                                                                                                           | The canonical definition has no summary field.                                                                                                                                                                   |
| Settings (§9)                     | Read-only limits, context values and authority status; context values are edited in the draft overview.                                                                                                                                                                                                                               | Edits stay on the one draft path with revision and request ids.                                                                                                                                                  |
| Concurrency copy (§8.4)           | Not shown as fixed numbers.                                                                                                                                                                                                                                                                                                           | Only runtime-reported limits are displayed.                                                                                                                                                                      |
| Theme tokens (§14.1)              | Plugin CSS uses the runtime custom properties (`--card`, `--border`, `--surface-recessed`, …).                                                                                                                                                                                                                                        | The `--color-*` names are Tailwind `@theme inline` aliases and are empty at runtime; the rendered check found this (A-41).                                                                                       |
| Icons (§5.2, §19.3)               | Host icon names only: `Bot`, `Terminal`, `Clock`, `GitBranch`, `UserRound` (manual), `CircleCheck` (end), `ArrowTurnBackward`/`ArrowTurnForward` (undo/redo), `Maximize2` (fit), `AlertTriangle` (authority), `CircleQuestion` (unknown), `Edit` (draft).                                                                             | The earlier names were unverified; unknown names fall back to `Zap`. Every used name was checked against the shared-ui icon registry.                                                                            |
| iOS Safari (A60–A63, A40)         | Route segments are URI-decoded; checked in iOS 27 Simulator Safari through `safaridriver`. Compact defaults to Outline, the persistent drawer opens without app-root `inert`/`aria-hidden` and stays mounted after close, and add-state, add-transition and auto-placement work. Contrast: at least 7.81:1 (light) and 9.11:1 (dark). | The host returns the selection segment encoded (`%40state%3Agate`). Synthesized touches never completed in headless Simulator, so the run used DOM `click()`; real touch gestures and VoiceOver remain unproven. |
| Tests                             | `tests/ui/logic.test.ts` (pure) and `tests/ui/panel.test.tsx` (DOM through the real service RPC handlers, inputs and outputs parsed by `stateMachinesRpc`).                                                                                                                                                                           | Behavior proof without hand-written fake responses.                                                                                                                                                              |

## 21. Sources consulted

- SDK: `omnyo/packages/plugin-sdk/src/app-contract.ts` — `PluginNavPanelProps` 74-85; fixed tabs 618-677; `PluginNavPanelRegistration` 655-692; `PluginAppSlots` 2245-2300; commands 2001-2048; `PluginRealtimeConnectionState` 2537-2540; `experimental_AppContext`/`experimental_AppNavigate` 3523-3560; picker props 3148-3262; `PluginSdkApp` 3600-3670; pending interaction 800-814.
- SDK runtime exports: `omnyo/packages/plugin-sdk/src/app.ts`.
- Backend interaction surface: `omnyo/packages/plugin-sdk/src/backend-contract.ts` 999-1121.
- Test runtime: `omnyo/packages/plugin-sdk/src/testing/app.tsx:1568`.
- Registry UI items: `omnyo/packages/plugin-registry/registry.json` (`uiItems`).
- Theme tokens: `omnyo/apps/app/src/components/ui/theme.css`.
- Plugin CSS confinement: `omnyo/packages/plugin-build/src/scope-plugin-utilities.ts`.
- Repository rules: `omnyo/AGENTS.md` (UI, CLI and Plugin API sections).
