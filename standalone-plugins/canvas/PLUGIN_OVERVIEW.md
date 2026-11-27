# Canvas

Canvas gives each project a dashboard and each chat a board. Agents update
charts, notes, images, decisions and results so you can scan the work without
scrolling through a transcript. Use it for evolving dashboards, experiments and
visual comparisons. Quick questions stay in chat; small visuals stay inline.

## Project canvas

The project canvas and its sidebar tree require Omnyo SDK 0.6.49 or later.

Open **Canvas** inside a project's sidebar group, even before its first section
exists. The page keeps the sidebar and has no chat transcript pane. **Sections**
hold independent boards with their own modules, islands, sources and history.
**Views** bookmark places and reopen from links. Contents provides navigation;
compact screens also offer an outline and chat drawers.

Ask for a change in the page's chat box. A real, visible **canvas chat** appears
as a card at its target, with streamed replies and follow-ups. Inbox, questions
and search still work. Archiving resolves a card; deleting a chat keeps its section.

**Add to project**, in the board toolbar, moves a chat board into a section and saves a view.
The original chat keeps showing and editing that content through a live link,
including when continued in another chat. Modules, sources and history move
together. Return a section to its surviving original chat when that chat has
no other board.

Agents read freely and join with `omnyo canvas project join --section SECTION`
before writing, receiving the project brief. Existing board commands then target
the linked section. Lock sections to prevent agent writes; archive to pause
polling while preserving content for restore.

## Chat boards

Choose Canvas in the composer's **+** menu and send your message, or ask the
agent for a board. Desktop boards open beside their chat; the header button
reopens them. Turning Canvas off keeps the board.

Continue with `Continue from @thread:` and the chat reference. An unadopted board,
its history and sources move before the new chat's first turn. Adopted boards
keep their project-section link.

- **Islands.** Named groups answer one question each, with a lead takeaway first.
- **Navigation.** Pinch, scroll or drag to move around. Zoom out for island labels
  and module titles; zoom in for evidence and sources.
- **HTML.** Custom HTML, SVG and charts run in sandboxed frames.
- **Compact screens.** Modules appear in reading order.

## Edit and undo

Select modules to inspect, edit, pin, hide or reference them. Drag modules or
islands to rearrange them. Your actions join Omnyo's undo history; Cmd+Z undoes
the newest change. **Changes** lists agent edits for individual undo.

Agents inspect fields before editing. Stale edits fail instead of overwriting
newer work, and agents cannot silently replace content you wrote.

## Connect data

Bind charts, tables and custom HTML to manual datasets, public HTTPS JSON APIs,
read-only MCP tools on servers listed in settings, PostHog read queries,
Cloudflare analytics or Google Search Console through a configured broker. Sources never change provider records.
Polling starts only when an interval is configured. Failed refreshes retain the
last good data as historical. Dates, units and cohorts stay beside values;
refreshing data never rewrites authored interpretations.

Credentials stay in server-side settings. Agents can import approved 1Password
references through the local CLI without seeing or printing the secret.

## Terminal

Board actions are available through `omnyo canvas`, including `on`, `show`,
`inspect`, `edit`, `compose`, `history`, `undo` and `sources`.
Use `omnyo canvas project --help` for sections, views, adoption and canvas chats.
Start a canvas chat with `omnyo canvas project chat --at SECTION --prompt TEXT`.
Most board commands accept `--section SECTION`; image uploads use
`--board-section SECTION` while `--section` names the module group.
Canvas makes no model calls of its own.
