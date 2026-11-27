# Canvas

- Keep `contract.ts` the shared tool/RPC boundary. Validate external data once,
  then use typed values internally. Keep the app and server contract aligned.
- Chat boards are chat plus board: keep core's chat pane unmodified and show the board
  in the thread side panel, with the header button able to reopen it at any time.
- The project canvas is a main-view page without a chat transcript pane.
  Sections are complete boards; views bookmark places. Canvas chats are real
  visible chats shown as cards, preserving Inbox, questions and callbacks.
- Agents may read their project canvas freely. Project writes require joining
  with its brief; canvas chats and adopted-board chats receive it automatically.
  Existing commands default to the linked section; explicit board references
  select other sections in the same project. Locked sections reject agent writes.
- Keep CLI board selectors distinct from legacy module groups: most board
  commands use `--section`; image uses `--board-section` and keeps `--section`
  for the group. A visible canvas chat starts through `project chat --at` with
  project execution defaults. Owner CLI actions outside chats must not become
  an agent route around joins, revisions or section locks.
- Adoption moves one board and keeps a live alias from its chat. Continuations
  inherit the link. Deleting a chat removes its card and link only; never delete
  or return a project section because its chat was deleted.
- Canvas turns on only together with the board brief: a dispatch carrying the
  `mode:canvas` pill, the first dispatch of a new chat that starts with
  `Continue from @thread:<chat>` while that chat's Canvas is on (its board moves
  in), or `omnyo canvas on` or `omnyo canvas move-from` from inside that chat. Never
  enable it without delivering the brief. Turning it off keeps the board.
- The agent decides when to turn Canvas on. Other chats get only the short
  `offer` instruction; Canvas tools, skill and full instructions go only to
  chats with Canvas on through `api.agents.configure`. Instructions stay under
  4,096 characters. The manual switch lives in the composer **+** menu.
- Use Canvas selectively when a spatial view helps with nonlinear or highly
  visual work. Task length or multiple steps alone do not justify a board.
- On desktop, enabled boards open in their own chat's side panel without
  changing chats or pane focus. Reopen on return, but preserve manual panel
  choices during the current visit. On compact screens, open the board from Thread actions → Open Canvas.
- Serve only passive raster images and video. HTML nodes stay in a sandboxed
  frame without same-origin access.
- Module heights are measured before modules come into view and remembered per
  board in `lib/measured-heights.ts`, so panning never resizes a module. Bump
  its storage version whenever card layout CSS, `canvasFrameStyles` or the frame
  height script changes how tall a module renders.
- Use the standalone package checks and SDK test harness with real SQLite.
- Code comments are forbidden except semantic tool directives. Add no model
  calls, paid provider features, service accounts or infrastructure.
