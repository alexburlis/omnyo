# Canvas

Canvas provides one dashboard per Omnyo project and boards beside individual
chats. Agents build charts, modules, diagrams and evidence. You can select a module, inspect its content,
edit it and undo a change without replacing someone else's later work.

Use Canvas for evolving dashboards, comparisons and spatial explanations. Small
visuals stay inline in chat. Explicit file, download and standalone-page requests
keep their requested output.

## Open and navigate

Turn Canvas on in the composer's **+** menu and send the Canvas pill with your
message. An agent can run `omnyo canvas on` inside its own chat. Both routes deliver
the board brief. Turning Canvas off keeps its content.

On desktop, Canvas opens beside its own chat. The header button reopens it.
Pinch on a trackpad, or hold ⌘/Ctrl while scrolling, to zoom around the pointer.
Scroll with two fingers in any direction, drag the background, or hold the middle
mouse button to pan. Shift + mouse wheel pans horizontally. The zoom buttons at
the bottom right use the viewport center, and clicking the percentage between them
fits the board. The padded minimap, **Jump to latest** and full-screen controls
help you navigate.

Drag a module header to move it on desktop, and use **Reset position** to return
it to flow. Select a module to reference, pin or hide it. On compact screens, the
header opens a list in composition reading order. The workbench exposes module
inspection, changes and sources. Its form controls can use dropdowns and tabs.

## Project canvas

The project canvas and its sidebar tree require Omnyo SDK 0.6.49 or later.

Open **Canvas** inside a project's sidebar group, including an empty project.
The page fills the main view while the sidebar stays visible; it has no chat
transcript pane. The top-level Canvas row and **Open project canvas** command
palette action also open the page.

A **section** is a complete board with independent modules, islands, composition,
positions, field versions, history, sources, datasets and media. Move sections by
their headers, lock finished sections against agent writes, or archive them and
restore them from Contents. Archiving preserves content and pauses polling.
The legacy module `section` field remains a group inside a board; it is not the
project section's ID.

**Views** bookmark sections, islands, modules, chat cards or free rectangles.
Anchored views follow their targets; free views can span sections. Save a view,
choose a home view, and navigate through Contents. Links reopen a view after
reload: `/plugins/canvas/p/PROJECT/v/VIEW`. Section and chat links use
`/plugins/canvas/p/PROJECT/s/SECTION` and `/plugins/canvas/p/PROJECT/c/CHAT`.
The project root restores the last camera position on that device. The
project's own **Canvas** sidebar row always opens its home view, even after
panning (`/plugins/canvas/p/PROJECT/h`). Its tree lists sections, other views and
canvas chats, never the home view, a section's own view or a lone view. A canvas
with a single section shows that section's other views directly under Canvas and
leaves its chats on the board; the Canvas row counts those waiting for input.

The page centers on its chat box. A chip above it names where a message goes:
the selected module, group or section, otherwise the section in view. Click the
chip to send to the whole canvas instead. Press `/` or start typing to open the
full Omnyo composer with its model, approval and attachment controls. Contents
(`C`), Save view (`B`), Changes, Sources and full screen sit in the page header;
Contents stays closed until opened and remembers that choice on desktop.

Sending from the page's chat box creates a real, visible **canvas chat** with a
**chat card** at the selected target. Open the card for streamed replies and
follow-ups, or open the full chat. Canvas chats appear under Canvas in
project-group sidebar lists; Inbox, questions, notifications and search still
work normally. Archiving a chat resolves its card. Deleting a chat removes its
card and link, not its section. Compact screens provide Contents, a reading-order
outline and chat cards in the shared responsive drawer; Board mode retains pan
and zoom.

### Add an existing chat board

Choose **Add to project** in the board toolbar (its move icon on narrow panels) or run
`omnyo canvas project add CHAT --title "Dashboard"`. Adoption moves one board
into a section and creates a view. Modules, islands, positions, versions,
history, sources, datasets and media move together. The original chat keeps
showing and editing that same section through a live alias; old module references
still resolve. Continuing that chat inherits its link. Archiving or deleting
the original chat does not remove project content.

`omnyo canvas project return SECTION` moves an adopted section back. Its original
chat must exist and have no other board. Returning removes views anchored to
the section; the UI names them before confirmation. Agents supply the inspected
project revision with `--expected-revision`.

### Agent access and commands

Other project chats may read freely. Before writing, run
`omnyo canvas project join --section SECTION` inside a visible, unarchived chat.
Joining delivers the project brief and makes that section the default target
for existing Canvas tools and commands. Join without a section to target the
whole canvas, then create a section before adding modules. Canvas chats and
adopted-board chats receive their target and brief automatically. Locked sections
reject agent writes.

```sh
omnyo canvas project show --json
omnyo canvas project sections --json
omnyo canvas project views --json
omnyo canvas project chats --json
omnyo canvas project chat --at SECTION --prompt "Add an error-rate chart"
omnyo canvas project join --section SECTION
omnyo canvas project section create --input '{"title":"Discovery"}'
omnyo canvas project section update --input '{"sectionId":"SECTION","title":"Discovery","expectedRevision":7}'
omnyo canvas project view put --input '{"title":"Discovery","anchorKind":"section","regionId":"SECTION","rect":{"x":0,"y":0,"width":1200,"height":800}}'
```

Replace uppercase placeholders with returned IDs and example revision `7` with
the current inspected project revision. Project commands infer the
project from the invoking chat; use `--project PROJECT` outside it.
`project journal --json` lists structural changes with their revision and replay
state. `project undo` and `project redo` accept `--change-id ID` and
`--expected-revision REVISION`; omit the ID to select the latest eligible
change. Inside a chat, agent join, lock and revision checks still apply. Native
Cmd+Z and Shift+Cmd+Z use this same guarded journal. The journal RPC accepts
optional `revisions` (up to 201 exact revisions) for grouped action replay;
ordinary Changes reads show the latest 100 entries. Ownership replay refuses
changed board content, conflicting boards and deleted origin chats.

`project section` accepts `create`, `update`, `move`, `archive` and `restore`.
Rename and reorder through `update`; section agent locks are owner-controlled.
`project view` accepts `put`,
`remove`, `reorder` and `home`. Mutations accept operation JSON via `--input`
or `--input-stdin`. Protected project changes require the inspected
`expectedRevision` in that JSON.
Use `omnyo canvas project --help` and command-specific `--help` for registered
options. Agent tools are `canvas_project`, `canvas_section`, `canvas_view` and
`canvas_project_add`. Existing board RPCs select a section with
`board: {"sectionId":"SECTION"}` or a chat with `board: {"threadId":"CHAT"}`;
supply exactly one board reference or legacy `threadId`.

Most board commands accept `--section SECTION --project PROJECT` to select an
explicit project section; omission keeps the linked-section default. Check the
command's `--help` for supported selectors. For images and videos, `--section`
keeps its legacy module-group meaning; use `--board-section` for the board:

```sh
omnyo canvas inspect reach --section SECTION --project PROJECT --json
omnyo canvas image chart.png --board-section SECTION --section Evidence --chat CHAT
```

`--chat` selects the media workspace; supply it outside a chat when the section
has no origin chat. The file path resolves in that workspace.

`project chat --at SECTION --prompt TEXT` creates a visible canvas chat using
the project's execution defaults. Use `--at free` for free space and
`--prompt-stdin` instead of `--prompt` to read the message from stdin. Optional
`--x` and `--y` are integer coordinates, defaulting to zero: relative to the
section for a section anchor, absolute world coordinates for free space.
`--project PROJECT` selects the project outside a chat.

Section and view JSON mutations inside a chat are agent actions: they retain
join, revision and lock checks. Outside a chat, the owner's CLI can change a
section lock with `project section update --project PROJECT --input
'{"sectionId":"SECTION","locked":true}'`. Agents cannot unlock sections.

## Continue a chat with its board

An unadopted board belongs to one chat. When a new chat's first message starts with
`Continue from @thread:<chat>` and that chat has Canvas on, the board moves into
the new chat before its first turn. Modules, islands, undo history, sources and
datasets move together. The old chat turns Canvas off, so nothing polls twice,
and its panel links to the chat that now holds the board. Deleting the new chat
returns the board to the old chat unless the old chat has started a new board.

For any other move, the agent runs `omnyo canvas move-from <old chat>` inside the
receiving chat. The receiving chat must not already have a board.

## Inspect, edit, verify and undo

The default agent workflow is `canvas_inspect` → `canvas_edit` → `canvas_verify`.
Inspection returns authored content and field versions. An edit names only the
intended fields and supplies their inspected `expectedVersions`. A stale edit
fails instead of replacing newer work. Legacy `canvas_update` remains available
for agent-owned fields. Replacing a human-owned field requires a fresh inspection
and a guarded edit. Replacing a human-owned composition or resetting human
positions requires the current board `expectedRevision`. Changes to human-owned
connections use the same guard.

Every authored mutation has an attributed field diff. Undo and redo preserve
later changes to unrelated fields and reject conflicts on the same fields.
History retains the latest 200 original operations per board, including their
undo or redo activity. Source refreshes live outside authored history, so undoing
a heading or layout does not revert a newer dataset.

Your own board actions join Omnyo's single undo history, the one chat actions such
as Archive use. Cmd+Z undoes your newest action wherever it happened: a module
move, a resize, an edit or an archived chat. Cmd+Shift+Z or Cmd+Y redoes it
(Ctrl+Z and Ctrl+Y elsewhere), and the toolbar's Undo and Redo do the same.
Agent changes stay out of that history; undo one from **Changes**.

```sh
omnyo canvas inspect reach --json
omnyo canvas verify reach --json
omnyo canvas history 10 --json
omnyo canvas history --change-id 7 --json
omnyo canvas undo 7
omnyo canvas redo 7
omnyo canvas duplicate reach
```

Change IDs are examples. Use the IDs and field versions returned by the current
board. `omnyo canvas edit --input-stdin` accepts
`{"id":"reach","fields":{"title":"Discovery"},"expectedVersions":{"title":7}}`.
See [the Canvas skill](skills/canvas/SKILL.md#inspect-edit-and-verify) for the full
workflow and output limits.

Verification uses measurements from an open Canvas client. A report is current
only when its node, board and bound-source revisions match and it is less than
two minutes old. Reports include bounds, rendered text, readiness and detected
layout issues. They are not pixel screenshots. Use browser automation for visual
proof of typography, charts and the final composition. Missing or stale reports
remain explicitly unverified.

## Compose dashboards as islands

Agents arrange dashboards as a map of **islands**, one per question the reader
asks. An island is a flow group with a name, a question, an accent color and a
soft surface that sits on the dotted board like land on a sea. Modules inside it
stay unframed; spacing does the grouping. Inside an island, **bento** layout
aligns modules on two to four column tracks: a chart spans two tracks, short
findings stack beside it, and content still decides every height.

- **Select and move.** Click an island's name to inspect it. Drag the name to
  move the whole island; **Return to flow** puts it back. Rename it, change its
  question, accent or surface in the workbench.
- **Zoom out.** Below 15% zoom, island names become map labels sized to their
  island's header, and modules without an authored overview show only their
  title. Below 12%, every module becomes a title tile, so the board reads as a
  bento of titles. Click a label to fly to that island.
- **Undo per island.** Each island's layout is its own history entry. Undoing an
  agent's “Arrange Discovery” keeps your later “Move Browsing”.
- **Resize snaps.** Resizing a module inside a bento island snaps it to whole
  tracks.
- **Compact screens.** The outline groups modules under each island's name and
  question in reading order.
- **Agent feedback.** Every arrangement returns design notes, such as one-module
  islands or rows that leave empty columns. Verification flags modules that
  leave a large blank beside a taller neighbour.

Nested rows, columns and wrapping groups remain available inside and around
islands. Weighted widths pair broad evidence with narrow annotations. Lead and
quiet emphasis establish a reading path without repeated frames. Groups can have
stable IDs. Each module remains independently selectable and editable.

Optional module fields provide:

- `width` for a preferred width from 240 to 1600 canvas pixels.
- `views.overview`, `views.evidence` and `views.sources` for authored HTML detail.
- `binding` for a native metric, bar chart, line chart or table from a source, or
  view `html` to run the module's own HTML with the live dataset as `window.canvasData`
  and up to eight more `sources` in `window.canvasSources`.
- `evidence` for the source revisions behind an authored interpretation.

At a distance, an authored overview replaces the evidence view. Zooming closer
shows evidence and then adds sources. Selection and compact mode expose evidence
and sources directly. Canvas reserves their measured footprint, so switching
views does not move surrounding modules. Without authored views, existing HTML
keeps its normal presentation.

Keep primary comparisons visible for pan and zoom. Reserve content filters for
large datasets. This guidance does not restrict the editor's form controls.
Custom HTML, SVG, CSS and JavaScript remain available in sandboxed frames. Use
[canvas-style](skills/canvas-style/SKILL.md) for a focused readability and
composition pass. See [islands and bento](skills/canvas/SKILL.md#compose-dashboards-as-islands)
for layout rules and manual-position behavior.

## Connect source data

Sources keep data separate from authored layout and interpretation. The Sources
workbench and agent tools support manual datasets, public HTTPS JSON APIs,
read-only tools on owner-listed MCP servers, Google Search Console through a
configured broker command, PostHog read queries, and Cloudflare GraphQL
Analytics queries over rolling time windows with an approved read-only token.
These connections read source data. They do not modify provider records.

New sources default to manual refresh. Manual datasets accept agent or pasted
scalar rows. Other providers can opt into polling with `intervalSeconds` from
60 to 86400. A minute schedule checks due sources while their chat board is on or their project section is active.
Pause stops polling. A failed refresh shows an error and retains the last
successful dataset as historical data. Repeated failures back off up to one
hour. When the minute schedule resumes after more than 2.5 minutes, for example
after the computer slept, failed sources retry at once with their backoff reset.

Declare windows, timezones, units and cohorts beside the values. A binding can
refresh its chart without rewriting the module's title, width or notes. An
interpretation whose recorded evidence revision changes needs review. Source
lists and inspection return previews, not complete datasets. `canvas_dataset`
and `omnyo canvas dataset SOURCE --offset 0 --limit 50 --expected-revision 1 --json`
provide paged rows. Use the source's current revision instead of the example `1`. See
[connected sources](skills/canvas/SKILL.md#connected-sources) for configuration,
bindings and paged dataset access.

Before revising a connection, use `canvas_sources({id:"api-reach"})` or
`omnyo canvas sources --source api-reach --json`. The targeted result includes the
complete saved source definition and a bounded row preview. Source lists stay
compact, and protected credential settings are never returned.

Credentials stay in server-only Canvas settings. Enter them there, or let an
agent import an approved `op://vault/item/field` reference through the local
1Password CLI; the credential command never accepts a raw token. Each slot needs
a matching approved reference (`apiReference1`, `apiReference2` or
`posthogReference`) and HTTPS origin (`apiOrigin1`, `apiOrigin2` or
`posthogOrigin`). Search Console sources need `gscBroker`, a command that runs
`<command> gsc gsc.query_search_analytics <json> --json`; they report a setup
error while it is empty. Reuse existing access and approved provider budgets.

MCP sources poll one tool on a Streamable HTTP MCP server (protocol
2025-06-18). They stay off until the owner lists the server's exact HTTPS
origin, including any port, in `mcpOrigins` (one per line). Listed servers may
resolve to private, unique-local or carrier-grade NAT addresses such as a
tailnet; loopback, link-local, multicast and cloud metadata addresses stay
refused. Canvas pins the resolved address, follows no redirects and applies the
JSON limits. It calls a tool only when the server's `tools/list` marks it
`readOnlyHint: true`; the owner allowlist and that annotation are the read-only
guard. An optional `apiToken1` or `apiToken2` credential is sent as a bearer
token when its `apiOrigin` matches the server origin. Canvas maps the tool's
`structuredContent`, or else its first JSON text block, through `rowsPath` and
`columns`.

## Limits

- 200 active nodes and 200 retained authored operations per chat board or project section.
- 200 sections, 300 views and 200 open chat cards per project; world coordinates
  within ±1,000,000 pixels.
- 24 islands, 400 flow items and eight nesting levels per composition. Islands
  cannot contain islands.
- HTML and each authored HTML view have a 32,000-character limit.
- Sources have at most 24 typed columns and 2,000 scalar rows per dataset, with a
  2 MiB serialized dataset limit. Each board can configure 30 sources.
- Source previews contain at most five rows, eight columns and 80 characters per
  text cell. Recent history defaults to ten entries with abbreviated field diffs.
- Images and videos support PNG, JPEG, GIF, WebP, MP4, MOV or WebM, up to 20 MiB
  each. Assets are stored by SHA-256, and videos support byte ranges.
- HTML frames allow scripts without same-origin access. Shared styles provide
  typography, spacing, tables, controls and chart defaults.
- Sessions started before Canvas was enabled can use `omnyo canvas` until their
  native tool list refreshes.

## Development and delivery

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
omnyo plugin source canvas --json
```

Canvas uses the verified private SDK artifact produced from the canonical
`omnyo/packages/plugin-sdk` source and pinned in `package.json` and
`pnpm-lock.yaml`. It provides `experimental_useActionHistory` and native
`ThreadChat` conversations. React and test packages resolve from this plugin's
frozen lockfile. The plugin requires Omnyo 0.46.246+private.1 and private SDK
0.6.46 or later.

For an existing installation owned by the local-build runtime store instead,
`pnpm package:runtime` creates a bundle and hash receipt. Then
`pnpm install:runtime -- --machine MACHINE_ID` installs through verified local
copies and `omnyo plugin install`. Run it in a coordinator-local Omnyo terminal
on the selected Mac; the installer checks that the machine is connected. The installer refuses an existing installation owned by a
different source; preserve that guard. The receipt is
`docs/evidence/runtime-install.json`. Satisfy the pinned runtime and SDK
requirements before activation. A prepared package alone does not prove delivery.

### Conversations on the board

Requires the native scoped-conversation SDK (0.6.45 or newer). These modules
continue the current chat; project canvas chat cards represent separate chats.

Double-click empty canvas space or use **New prompt** to place a conversation. Each region uses Omnyo’s native composer, model picker and streamed answers in the current chat, with its own saved draft. The prompt and its answer stay together inside the region across reloads.

The toolbar uses labelled icons with hover tooltips. Click the new or updated badge to visit changed items; undo and redo move to the affected area.

The same node can be created through `omnyo canvas add --input-stdin` with a note containing `conversation: {"id":"prompt-one"}` and matching node `id`. Existing SDK node RPCs use the same schema.

### Link ideas to their details

Use `<a href="#canvas-node-module-id">Idea title</a>` inside an HTML module,
or `[Idea title](#canvas-node-module-id)` in Markdown. Use the destination's
exact node ID. A click selects and smoothly focuses that module; compact views
scroll to it. Undo returns to the prior view and selection, and Redo revisits the
module. These navigation actions use Omnyo's shared history without changing board
content. Reduced motion uses immediate movement. Local anchors and external links
keep their usual behavior. A missing destination shows a visible error.

## Loading and image quality

Video range responses read only the requested byte slice from SQLite. Unsatisfiable ranges read metadata without materializing the media payload. Prepared image variants use the same bounded range path.

Canvas keeps a bounded board-model cache across panel visits and revalidates it on reopen or reconnect. Revision signals refresh active boards; a disabled or moved board clears the cached model. History loads as paged summaries, with before/after values retrieved when a change is selected. Sources without a board binding load when Sources is opened.

Raster previews use prepared responsive sizes and lossless WebP compression. Images at most 1280px wide may also use full-resolution recompression, published only after decoded RGBA pixels match. Larger images retain the exact native-resolution original for deep zoom and download; their smaller previews use lossless encoding after resizing. The original asset bytes remain the image link target. Animated, high-bit-depth, color-managed and oversized images retain their original encoding when conversion cannot preserve their fidelity. Previews increase resolution with zoom and display density.

HTML documents and offscreen heavy modules load when first visible. Once shown, documents remain mounted during the visit to retain interactive state. Geometry verification reports deferred or incomplete content as unverified.

The image codec is staged for the coordinator's platform with `node scripts/stage-assets.mjs`; the supported bundled-runtime preparation runs that step automatically. For a direct path install, stage it before building and reloading the plugin.
