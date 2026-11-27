---
name: canvas
description: Compose, inspect, edit, verify and undo modules in a Omnyo Canvas board, including island and bento layouts and connected data. Use when Canvas is on for the chat or working with a project canvas.
---

# Canvas boards

Prefer Canvas for evolving dashboards, comparisons and spatial explanations.
Build independent modules directly on the board. Use `canvas_compose` by default
for dashboards and arrange them as question-led islands. Small visuals stay inline in chat. Explicit HTML-only, file,
download and standalone-page requests keep their requested output.

Run `omnyo canvas on` inside the chat to receive the brief. A new chat whose first
message starts with `Continue from @thread:<chat>` receives that chat's board
automatically while its Canvas is on. When this chat continues another chat in
any other way and that chat has a board, run `omnyo canvas move-from <that chat>`
here instead of rebuilding it: the board, islands, history, sources and datasets
move, and the old chat keeps Canvas off. For an adopted board, the new chat
inherits its project-section link instead of moving project content. Users can enable Canvas
through the composer's **+** menu. Turning Canvas off keeps the board. Desktop
Canvas opens beside its own chat without switching chats or focusing another
pane. Compact screens use the header button and composition reading order.

Keep explanations in chat and show artifacts on the board. Do not add goal,
status or progress notes: the chat already shows them. Name changed nodes in one
short chat line. Archive superseded nodes and finish with a Result section containing proof and links.

## Project canvas

Each project has one canvas with independent **sections**. A section is a complete
board: modules, islands, composition, versions, history, sources, datasets and
media. **Views** bookmark sections, islands, modules, chat cards or free rectangles;
they do not contain content. A **canvas chat** is a real visible chat shown as a
card on the project page. That page has no chat transcript pane. Existing chat
boards keep their side panels.

Read with `canvas_project({})` or `omnyo canvas project show --json`. List sections,
views and chats with the corresponding `project sections`, `project views` and
`project chats` commands. Read access does not grant writes. From a visible,
unarchived project chat, run `omnyo canvas project join --section SECTION` to
receive the brief and link a default section. Without `--section`, join the whole
canvas and create a section before adding modules. Canvas chats and adopted-board
chats receive their target and brief automatically. Never enable project writes
without delivering the brief.

- Work in the target section; create another section for a different topic.
- Save a view after creating a section or a significant island.
- Never move or archive owner-placed sections, views or cards unless asked.
- Locked sections reject agent writes. Preserve locks and report them.
- Inspect before editing and preserve human changes with field versions.
- Reply briefly and link every changed module as `[Title](#canvas-node-ID)`;
  link saved views as `[Title](#canvas-view-ID)`.

Existing tools and commands default to the linked section. Explicit tool/RPC
inputs use `board: {"sectionId":"SECTION"}` for a section or
`board: {"threadId":"CHAT"}` for a chat board. Board RPCs accept exactly one
of `board` or legacy `threadId`. Inspect the same target you will edit: node IDs
and field versions are local to each board. The node field `section` is a legacy
module group, not a project section selector.

`canvas_section` takes `action` (`list`, `create`, `update`, `move`, `archive`,
`restore`) and operation fields in `input`. For example:

```json
{ "action": "create", "input": { "title": "Discovery", "question": "Where do users arrive?" } }
```

Update takes `sectionId` and optional `title`, `question`, `x`, `y` or `order`.
Section locks are owner-controlled; agents cannot change them. Archive retains
content and pauses polling; restore makes the section available again. Protected structural changes require the inspected project
`expectedRevision` in `input`.

`canvas_view` takes `action` (`list`, `put`, `remove`) and operation fields in
`input`. Include an existing `id` to update a view:

```json
{
  "action": "put",
  "input": {
    "title": "Discovery",
    "anchorKind": "section",
    "regionId": "SECTION",
    "rect": { "x": 0, "y": 0, "width": 1200, "height": 800 }
  }
}
```

Anchor kinds are `section`, `island`, `node`, `chat` and `free`. `regionId`
identifies the section and `anchorId` the object. Free views use absolute world
rectangles. Section rectangles are relative to the section. Node and island views fit the current object. Chat rectangles are offsets from the card; they follow the card across sections or into free space. Views of surviving chat cards remain when a board is returned. The CLI also supports view
`reorder` (`ids`) and `home` (`id`).

```sh
omnyo canvas project section create --input '{"title":"Discovery"}'
omnyo canvas project section update --input '{"sectionId":"SECTION","title":"Discovery","expectedRevision":7}'
omnyo canvas project view home --input '{"id":"VIEW"}'
```

Replace uppercase placeholders with current returned IDs and example revision
`7` with the inspected project revision. CLI section actions
match the tool's mutations; view actions are `put`, `remove`, `reorder`, `home`.
They accept JSON through `--input` or `--input-stdin`, resolve the invoking chat's
project, and accept explicit `--project PROJECT`. Use registered command `--help`
for exact options.

Most board CLI commands accept `--section SECTION [--project PROJECT]` for an
explicit target; otherwise they use the linked section. Check command `--help`.
For `image`, `--section` remains the legacy module group; use `--board-section`
to choose the project section. For example:

```sh
omnyo canvas inspect reach --section SECTION --project PROJECT --json
omnyo canvas image chart.png --board-section SECTION --section Evidence --chat CHAT
omnyo canvas project chat --at SECTION --prompt "Add an error-rate chart"
```

Image paths resolve in the `--chat` workspace. Outside a chat, supply `--chat`
when a section has no origin chat. `project chat` uses the project's execution
defaults and creates a visible chat. Use `--at free` for a free-space anchor;
optional integer `--x` and `--y` default to zero and are section-relative for a
section anchor or absolute world coordinates for free space. `--prompt-stdin`
reads the prompt from stdin instead of `--prompt TEXT`. `--project PROJECT`
selects the project explicitly.

Inside a chat, section and view mutations remain agent actions with join,
revision and lock checks. The owner can change `locked` through section `update`
from a terminal outside a chat. Do not use that owner route to bypass an agent
lock or other agent guard.

Adopt a board only when requested, with `canvas_project_add({"threadId":"CHAT",
"title":"Dashboard"})` or `omnyo canvas project add CHAT --title "Dashboard"`.
Adoption moves one board into a section, creates a view and retains a live alias
from the original chat. Modules, versions, history and sources move together;
old references still resolve. Continuations inherit the link. Archiving or
deleting a chat never removes or returns a project section.
Return only when requested with
`omnyo canvas project return SECTION --expected-revision REVISION`: the original
chat must exist and have no other board, and views anchored to the section are
removed. Inspect the project revision first.

Project structure has a journal and `project.journal`, `project.undo` and
`project.redo` RPCs. The CLI provides `project journal --json`,
`project undo --change-id ID --expected-revision REVISION` and
`project redo --change-id ID --expected-revision REVISION`. Omit `--change-id`
to select the latest eligible change. Inside a chat, join, revision and lock
checks still apply. Ownership replay refuses changed content, deleted origins
and conflicting boards. Module history and undo remain per section. Limits are 200 sections, 300 views,
200 open chat cards and coordinates within ±1,000,000 pixels. Existing module,
source and composition limits apply independently to each section.

## Inspect, edit and verify

1. Resume with `canvas_show` or `omnyo canvas show`. Reuse stable node IDs.
2. Inspect an existing module with `canvas_inspect({"id":"reach"})`.
   Inspect returns the authored node, `boardRevision`, `fieldVersions`, source
   previews and a connected-render report.
3. Apply only the intended fields with `canvas_edit`. Copy their current
   `expectedVersions` from inspection. Supply a short `label` for history.
4. Run `canvas_verify({"id":"reach"})`. Check report currency, readiness and
   issues. Use browser automation for the final visual check.
5. Use `canvas_history`, `canvas_undo` or `canvas_redo` when revising a change.

An edit has this shape. The example version `7` must be replaced with the
version returned by the current inspection.

```json
{
  "id": "reach",
  "fields": { "title": "Where discovery grows" },
  "expectedVersions": { "title": 7 },
  "label": "Clarify acquisition heading"
}
```

Only actually changed fields require versions. A stale version fails before any
field changes. On conflict, inspect again and preserve the newer values. Do not
resubmit an old whole-node snapshot. Legacy `canvas_update` remains useful for
agent-owned status and content. It rejects changes to human-owned fields until
the agent inspects them and uses `canvas_edit`.

A current native render report matches the node, board and bound-source dataset
revisions and is less than two minutes old. It includes bounds, rendered text,
readiness and detected layout issues. Current does not mean issue-free. Missing
or stale reports are unverified. Open Canvas to obtain current measurements.
These reports are not screenshots and do not prove pixel appearance. Use browser
automation and inspect captures for typography, charts and visual acceptance.

## History and ownership

Authored mutations record an actor, label, timestamp and before/after field diff.
They include add, edit, update, duplicate, link, hide, move, pin and composition.
Undo preserves later changes to unrelated fields. A later writer to the same
field causes a visible conflict. Inspection versions also reject an old edit
after a value changes and returns through undo.

History retains 200 original operations per board. `canvas_history({})` returns
ten recent entries. `limit` accepts 1–20. Each summary shows at most ten fields,
with 250 characters for each before and after value. `fieldCount` reports the
full count. For full values, request `{"changeId":"7","fieldOffset":0}` and
continue with `nextFieldOffset` until it is null. Full-detail pages contain at
most 20 fields and have a bounded byte budget.

`canvas_undo({})` selects the latest applied original change.
`canvas_redo({})` selects the most recently undone change. Either accepts an
explicit `changeId`. Neither overwrites a conflicting later writer. Dataset
refreshes are separate from authored history and survive undo of a heading,
width or interpretation.

## Module fields and kinds

Use `canvas_add({"nodes":[...]})` for new nodes. Give each a short, stable `id`
and `section`. IDs contain 1–40 lowercase letters, digits or hyphens and start with a letter or
digit. `after`
orders a new node after an existing node. `wide` controls legacy section width.

| Kind             | Content                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `html`           | Sandboxed HTML, SVG, CSS and JavaScript, with shared Canvas styles.                            |
| `note`           | Short Markdown in `body`.                                                                      |
| `status`         | `state` running, done, failed, blocked or waiting, and `progress` from 0 to 1.                 |
| `code`           | `body` and `language`; `diff` highlights additions and removals.                               |
| `image`, `video` | Use `canvas_image` with a local path; do not add these through `canvas_add`.                   |
| `file`, `link`   | An absolute or workspace-relative file path, or an HTTPS `href`.                               |
| `decision`       | A question in `title`, 1–4 `options`, and optional `recommended`. Clicking submits the option. |

Use tone `neutral`, `positive`, `warning`, `negative` or `info`. Native node
references put that module's authored content into chat context.

The following optional fields can be added or edited. Set the entire field to
`null` to clear it.

| Field      | Shape and behavior                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `width`    | 240–1600 canvas pixels. An automatic flow node is capped at its allocated slot. A manually placed node uses its explicit width. Null uses the flow or section default.                                 |
| `views`    | Optional HTML strings `overview`, `evidence` and `sources`, each at most 32,000 characters.                                                                                                            |
| `binding`  | `{sourceId,view,x?,y?,format?,sources?}`. View is `metric`, `bar`, `line`, `table` or `html`. Format is `number`, `percent` or `currency`. `sources` adds up to 8 more source IDs for the `html` view. |
| `evidence` | `{sourceIds:[...],revisions:{sourceId:revision,...}}`, recording the datasets behind an authored interpretation.                                                                                       |

A binding renders source values instead of the module's normal body. Use numeric
`y` and label `x` column keys explicitly. A metric displays the first source row.
Percent formatting expects fractions. Keep the unit visible in provenance.
Bindings preserve authored titles, width, views and notes when data changes.
Custom HTML remains available for diagrams and unusual visualizations.

The `html` view keeps the module's own HTML and gives every authored view the
bound dataset as `window.canvasData` (`sourceId`, `columns`, `rows`,
`provenance`, `revision` and `capturedAt`, or `null` before the first refresh)
before its scripts run. `window.canvasSources` maps the primary source and each
ID in `binding.sources` to its dataset or `null`, so one chart can combine
several sources. The frame reloads with each new dataset, so render the
chart from `window.canvasData` instead of hard-coding values. Use it for live
custom charts, stacked series, annotations and client-side grouping.

## Compose dashboards as islands

For dashboards, add independent modules, then call `canvas_compose`. Arrange
them as a map of **islands**: one island per question the reader asks, laid
out on the board like land on the dotted sea. An island is any flow group with
an `id` and an `island` object. Its surface, name, question and accent are
drawn for it; modules inside stay unframed. Read
[canvas-style](../canvas-style/SKILL.md) for recipes and the design checklist.

```json
{
  "composition": {
    "width": 1880,
    "root": {
      "id": "board",
      "flow": "column",
      "children": [
        { "node": "takeaway", "emphasis": "lead" },
        {
          "id": "map",
          "flow": "row",
          "children": [
            {
              "id": "discovery",
              "flow": "bento",
              "columns": 3,
              "weight": 1.6,
              "island": {
                "title": "Discovery",
                "question": "How do people find us?",
                "accent": "blue"
              },
              "children": [
                { "node": "clicks" },
                { "node": "impressions" },
                { "node": "ctr" },
                { "node": "search-trend", "span": 2, "emphasis": "lead" },
                {
                  "id": "search-reading",
                  "flow": "column",
                  "children": [{ "node": "search-finding" }, { "node": "search-caveat" }]
                }
              ]
            },
            {
              "id": "browsing",
              "flow": "bento",
              "columns": 2,
              "island": {
                "title": "Browsing",
                "question": "What happens after people arrive?",
                "accent": "teal"
              },
              "children": [
                { "node": "pageviews" },
                { "node": "depth" },
                { "node": "browse-trend", "span": 2 }
              ]
            }
          ]
        },
        {
          "id": "sources",
          "flow": "wrap",
          "minWidth": 320,
          "island": { "title": "Sources", "surface": "none" },
          "children": [{ "node": "source-notes", "emphasis": "quiet" }]
        }
      ]
    }
  }
}
```

| Field                   | Shape and behavior                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `island`                | `{title, question?, accent?, surface?}` on a group with an `id`. Title 1–60 characters, shown as a short name; question up to 160, shown as the heading.                                                                               |
| `accent`                | `neutral` (default), `blue`, `teal`, `violet`, `rose` or `amber`. Tints the surface and colors charts and `--canvas-accent` inside the island.                                                                                         |
| `surface`               | `soft` (default) draws the island surface; `none` keeps the name and question without a surface, for quiet footers.                                                                                                                    |
| `flow: "bento"`         | Aligned tracks. `columns` 1–6 (default 3). Children take `span` 1–`columns` (default 1) and wrap into rows; the last module of a short row absorbs the unused tracks. Narrow islands drop tracks automatically and keep reading order. |
| `row`, `column`, `wrap` | Unchanged. `row` divides width by child `weight` (0.25–8); `wrap` forms rows using `minWidth` (160–1200, default 280).                                                                                                                 |
| `gap`                   | 0–120 pixels. Defaults: 20 inside bento, 56 between groups that hold islands, otherwise 24.                                                                                                                                            |

Content sets every height, so a short module next to a tall chart leaves blank
space. Fill it deliberately: stack related short modules in a `column` group and
give that stack the slot beside the chart. Islands may not nest, the root cannot
be an island, `span` works only inside bento, and bento children use `span`
instead of `weight`. Composition width is 480–4000 pixels. Limits are 8 levels,
400 items, 200 node references and 24 islands. Group ids, including island ids, must be unique.

- **Design notes.** Every `canvas_compose` response returns `notes`: one-module
  islands, missing questions, underfilled bento rows, neighbouring islands with
  the same accent and competing leads. Fix them or keep a deliberate exception.
- **One island at a time.** `canvas_compose({"island":{...}})` replaces the island
  with the same `id` in place. A new id is added at the end of the root, or after
  the group or island named by `after`. Modules it references move out of their
  previous groups; groups left empty are removed; the response lists each move.
- **History.** Each island's layout is its own history entry, labelled
  “Arrange Discovery”, “Move Browsing” or “Add Business”. Undoing one island
  never conflicts with a later change to another island.
- **Human edits.** People rename, recolor and drag islands by their title. An
  island a person changed is protected: replace it only with the inspected board
  `expectedRevision`. Other islands stay editable without the guard. A moved
  island keeps its flow slot until **Return to flow**.
- **Verify.** `canvas_verify({"island":"discovery"})` checks every member's
  current render and reports `Uneven row` gaps, overlap, overflow and the
  island's design notes. Missing or stale member reports stay unverified.
- **Zoom.** Below 15% zoom, island names become map labels and modules without
  `views.overview` show only their title. Below 12%, every module is a title
  tile. Clicking a label flies to that island. Keep island names to one to
  three words and module titles short and specific: they are the zoomed-out
  board.

Preserve manual positions. A dragged node retains its reserved slot until reset.
`resetPositions:true` clears manual positions only for referenced nodes. Added
nodes omitted from the composition remain visible below it. Archived nodes
disappear without breaking the flow; an island that loses every module
disappears with them. `composition:null` restores sections. For a guarded
arrangement edit, supply the board's inspected `expectedRevision`; a newer board
revision causes a conflict. An unchanged arrangement remains a no-op.

## Semantic detail and spatial reading

Keep primary charts visible at overview scale. Supply `views.overview` only when
its visual summary uses a similar height to the evidence. Omit it when a tiny
claim or a few values would leave a large reserved slot empty; put short
interpretations in adjacent annotation modules.
`views.evidence` replaces normal `html` for an unbound HTML module. A bound module
uses its native data renderer for evidence. `views.sources` adds definitions or
provenance below evidence rather than replacing the chart.

Overview activates at zoom 0.15 or below. Evidence returns at 0.18 or above.
At 0.12 or below every module becomes a title tile until zoom returns above 0.14.
Sources activate at 1.15 or above and remain visible until zoom reaches 1.05.
These separate thresholds prevent flicker near a boundary. Selecting a module
or using compact mode exposes evidence and sources. Without authored views,
normal content stays visible.

Frames stay mounted and reserve the largest measured view footprint. Switching
zoom detail does not move surrounding nodes, connectors or minimap content.
Content changes can still grow naturally. Verify unselected modules at overview
scale and confirm the render report's `view` is `overview`. A measured overview
using less than half its reserved height with more than 120px blank reports a
`Sparse overview` issue. Keep useful visual evidence in that space or omit the
overview; do not collapse semantic footprints to fix it.

Inactive views stay out of keyboard navigation. Unhandled HTML wheel gestures
navigate desktop Canvas. Native controls and custom handlers that call
`preventDefault()` retain local behavior.

Keep primary evidence and comparisons visible. Prefer adjacent modules to
content dropdowns or accordions that hide the comparison. Filters remain useful
for large datasets. These content rules do not restrict inspector dropdowns,
source configuration forms, tabs or other editor controls.

Use custom HTML, SVG and CSS for expressive charts and flows. Connect independent
modules with `canvas_link` only when the relationship helps. Its shape is
`{from,to,label?,remove?,expectedRevision?}`. Changing or removing a human-owned
connection requires the current board `expectedRevision`. Use
[canvas-style](../canvas-style/SKILL.md) for a focused composition and readability
pass while preserving manual edits and source meaning.

## Connected sources

Use `canvas_sources({})` to list compact metadata, freshness and small row
previews. Before editing a saved connection, call `canvas_sources({id:"api-reach"})`.
Its one-entry array includes the complete validated `source.definition`, including
the query or API configuration, with the same bounded dataset preview. Modify
the intended definition fields and pass the definition to `canvas_source`.
Protected credential settings are excluded from both reads.

New sources default to `intervalSeconds:0`, meaning manual refresh.
Manual sources accept agent-pushed or pasted datasets and cannot poll. JSON, MCP,
GSC, PostHog and Cloudflare sources can opt into polling from 60 to 86400 seconds. Canvas checks
due sources each minute while their chat board is enabled or their project section is active. Pause stops polling. A
failed refresh retains the last successful dataset with an explicit error and
historical-data notice; retries back off up to an hour, and failed sources retry
at once when the schedule resumes after the computer slept. Refresh remote API sources with `canvas_refresh`. Push
manual datasets with `canvas_data` instead. Never describe cached data as a
successful fresh read.

| Provider     | Configuration                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manual`     | No remote configuration. Use `canvas_data` to replace its scalar dataset.                                                                                                                 |
| `json`       | Public HTTPS `url`, declared typed `columns`, optional `rowsPath`, per-column `path`, and optional approved credential slot `apiToken1` or `apiToken2`.                                   |
| `mcp`        | Streamable HTTP MCP server `url` on an origin the owner listed in `mcpOrigins`, a read-only `tool`, an optional `arguments` object, then the `json` fields.                               |
| `gsc`        | A Search Console broker command in Canvas settings, `siteUrl`, ISO `startDate` and `endDate`, optional `dimensions` and `limit`.                                                          |
| `posthog`    | A PostHog personal API key and address in Canvas settings, numeric `projectId` and a `query` string.                                                                                      |
| `cloudflare` | Cloudflare GraphQL Analytics: `zoneTag`, a read-only `query`, `rollingHours` (1–744), optional `alignTo` `hour` or `minute`, then `rowsPath`, `columns` and a required `credential` slot. |

A `cloudflare` source POSTs only to `https://api.cloudflare.com/client/v4/graphql`
with its slot token, so the slot's approved origin must be
`https://api.cloudflare.com`. Use a token limited to the zone's Analytics Read
permission. The query may declare only `$zoneTag`, `$start`, `$end`,
`$startDate` and `$endDate`; each refresh fills them with the rolling window,
ending at the last complete hour or minute in UTC. Queries containing
`mutation`, `subscription` or `fragment` are refused. `rowsPath` starts inside
the first returned zone, for example `["series"]` for an aliased dataset.

The provider connections read data. Keep existing accounts, access and approved
budgets. An `mcp` source calls `tools/call` only for a tool that the server's
`tools/list` marks `readOnlyHint: true`, and only on an origin the owner listed
in the `mcpOrigins` setting; those two checks are its read-only guard. Canvas
maps the tool's `structuredContent`, or else its first text block parsed as
JSON, through `rowsPath` and `columns` like a `json` source. Tool `arguments`
hold scalars, scalar arrays or one nested object of those, up to 4,096 bytes.

Source rows have declared `string`, `number` or `boolean` columns and may
contain null values. Limits are 30 sources per board, 24 columns, 2,000 rows
and a 2 MiB serialized dataset. Declare `provenance.windowLabel`, `timezone`,
`cohort` and `unit` for meaningful comparisons. Do not imply a conversion funnel
between different populations or time windows.

Configure a manual source through `canvas_source` with this illustrative shape:

```json
{
  "id": "example-reach",
  "title": "Example browser cohort",
  "provider": "manual",
  "provenance": {
    "windowLabel": "Illustrative sample",
    "timezone": "UTC",
    "cohort": "Example accepted browser IDs",
    "unit": "browser IDs"
  }
}
```

Push its dataset with `canvas_data`:

```json
{
  "sourceId": "example-reach",
  "columns": [
    { "key": "week", "label": "Week", "type": "string" },
    { "key": "browsers", "label": "Browsers", "type": "number" }
  ],
  "rows": [{ "week": "Example week", "browsers": 42 }]
}
```

Bind a module with
`{"sourceId":"example-reach","view":"bar","x":"week","y":"browsers"}`.
Record the returned dataset revision in an interpretation's `evidence` metadata.
If that revision changes, review the interpretation before updating its evidence
record. Data refreshes never rewrite authored claims automatically.

Inspection, source configuration, refresh and push tool responses contain
previews of at most five rows, eight columns and 80 characters per text cell.
Use `canvas_dataset` for complete analysis through bounded pages:

```json
{
  "sourceId": "example-reach",
  "offset": 0,
  "limit": 50,
  "columns": ["week", "browsers"],
  "expectedRevision": 1
}
```

Use the current returned revision, not the example `1`. Pages return `revision`,
`capturedAt`, `provenance`, selected `columns`, `rows`, `offset`, `totalRows` and
`nextOffset`. Default limit is 50 and maximum is 200. The 30,000-byte row budget
can shorten a page. Continue at `nextOffset` until it is null. Keep the same
`expectedRevision` on later pages. If data changes, restart with its new revision.
If one row exceeds the byte budget, select fewer columns. Do not treat previews
or the first page as the full dataset.

Credentials belong in server-only settings. The user can enter them in Canvas
plugin settings. `canvas_source_credential` accepts `{slot,reference,origin?}`
with an `op://vault/item/field` reference, not a raw token, and reads it through
the local 1Password CLI. Each slot requires a matching approved reference and
HTTPS origin in Canvas settings. GSC sources need the user's broker command in
Canvas settings; without it, explain that setup instead of retrying. When you
point the user at settings, name the section they will see: Custom API 1 and 2
hold `apiOrigin1`/`apiToken1` and `apiOrigin2`/`apiToken2`, PostHog holds the
personal API key, Google Search Console holds the broker command and MCP
servers holds `mcpOrigins`. No
credential is returned by source tools or placed in HTML, notes, datasets or
chat output.

## Shared visual styles

Canvas supplies typography, spacing, table, control and SVG defaults to every
HTML node. Use the shared classes for content that belongs on the board. Leave
outer backgrounds, borders and shadows out of the HTML. The node's `title`
owns its primary heading; use internal headings only for meaningful subsections.
Metadata and drag handles appear on hover, selection or keyboard focus. Touch
surfaces keep their handles visible.

| Classes                                             | Use                                            |
| --------------------------------------------------- | ---------------------------------------------- |
| `canvas-stack`, `canvas-section`                    | Vertical rhythm or a separated section         |
| `canvas-row`, `canvas-columns`                      | A wrapping row or responsive two-column layout |
| `canvas-metrics`, `canvas-metric`                   | Unboxed metrics with a shared grid             |
| `canvas-label`, `canvas-value`                      | A muted label and prominent tabular value      |
| `canvas-note`, `canvas-caption`                     | Supporting detail and source dates             |
| `canvas-positive`, `canvas-warning`, `canvas-badge` | Meaningful color or a quiet inline label       |
| `canvas-controls`, `canvas-table`                   | Shared controls and tables                     |
| `canvas-chart`, `canvas-gridline`, `canvas-bar`     | SVG sizing, grid lines and series color        |
| `canvas-callout`, `canvas-lessons`, `canvas-lesson` | A left-rule annotation or spaced takeaways     |
| `canvas-line`, `canvas-area`, `canvas-accent`       | Island-accented SVG line, soft area and text   |

For example, an HTML node titled **Search traffic** can use this CSS-free body:

```html
<div class="canvas-stack">
  <p class="canvas-caption">Oct 3–30 compared with Sep 5–Oct 2</p>
  <div class="canvas-metrics">
    <div class="canvas-metric">
      <div class="canvas-label">Google clicks</div>
      <div class="canvas-value">4,899</div>
      <p class="canvas-positive">+504% versus the previous 28 days</p>
    </div>
    <div class="canvas-metric">
      <div class="canvas-label">Search CTR</div>
      <div class="canvas-value">2.05%</div>
    </div>
  </div>
  <p class="canvas-note">Clicks are not unique visitors.</p>
</div>
```

Inside an island, `--canvas-accent`, `--chart-1` and `--brand` resolve to the
island's accent in light and dark themes; outside islands they fall back to the neutral
primary color. Use them instead of hard-coded colors so an island recolor
reaches every chart.

Apply `canvas-chart` to an SVG or its wrapper. Only the SVG gets the default
200px height; captions and controls remain outside that height. Set
`--canvas-chart-height` when a chart needs a different height. Authored CSS
follows the shared defaults and can override them without `!important`.
Existing custom HTML is retained as authored; other boards are not rewritten.

## CLI

Use `omnyo canvas` when a session does not yet have native tools. Read commands use
`--json` for explicit machine-readable output. Commands with an ID accept
`--chat THREAD` when targeting another chat. `on`, `off`, `show` and `sources`
use their existing optional positional chat argument. Only enable Canvas from
inside its own invoking chat.

```sh
omnyo canvas on
omnyo canvas move-from thr_previous_chat
omnyo canvas show --json
omnyo canvas inspect reach --json
omnyo canvas edit --input-stdin <<'JSON'
{"id":"reach","fields":{"title":"Where discovery grows"},"expectedVersions":{"title":7},"label":"Clarify acquisition heading"}
JSON
omnyo canvas verify reach --json
omnyo canvas verify --island discovery --json
omnyo canvas history 10 --json
omnyo canvas history --change-id 7 --field-offset 0 --json
omnyo canvas undo 7
omnyo canvas redo 7
omnyo canvas duplicate reach
omnyo canvas sources --json
omnyo canvas sources --source api-reach --json
omnyo canvas refresh api-reach --json
omnyo canvas dataset example-reach --offset 0 --limit 50 --columns week,browsers --expected-revision 1 --json
```

The example versions and change IDs must come from current inspection, history
or dataset output. `edit`, `source`, `data` and `source-credential` accept their
native tool shapes through `--input-stdin` with a quoted JSON heredoc. For a
single guarded edit, `fields` contains only intended changes. History limits and
paging match the native tool. Sources are paused through the Sources workbench
or by updating their definition with `paused:true`.

Existing commands remain available:

```sh
omnyo canvas add --input-stdin <<'JSON'
{"nodes":[{"id":"finding","kind":"note","section":"Result","title":"Search brings two thirds of new visitors"}]}
JSON
omnyo canvas update --input-stdin <<'JSON'
{"id":"finding","tone":"positive"}
JSON
omnyo canvas compose --input-stdin <<'JSON'
{"composition":{"width":1000,"root":{"id":"main","flow":"column","children":[{"node":"finding"},{"node":"trend"}]}}}
JSON
omnyo canvas compose --input-stdin <<'JSON'
{"island":{"id":"discovery","flow":"bento","columns":2,"island":{"title":"Discovery","question":"How do people find us?","accent":"blue"},"children":[{"node":"clicks"},{"node":"trend","span":2}]}}
JSON
omnyo canvas link trend finding --label supports
omnyo canvas archive old-plan
omnyo canvas image shots/chart.png --title "Chart verification" --section Result
omnyo canvas off
```

Use a workspace or absolute path for `canvas_image` or `omnyo canvas image`. Media
supports PNG, JPEG, GIF, WebP, MP4, MOV and WebM up to 20 MiB per asset. Never put
credentials in board content or CLI arguments. The credential input contains
references only. Source and history output is bounded; explicit dataset paging
provides complete rows without a large unrequested response.

When a summary, shortlist or table refers to detail modules, link the idea names
with `<a href="#canvas-node-ID">Idea name</a>` in HTML or
`[Idea name](#canvas-node-ID)` in Markdown, using real node IDs from the board.
Clicking focuses and selects the destination. Undo returns to the previous view;
Redo revisits it. Keep ordinary local anchors for sections inside one HTML module.
