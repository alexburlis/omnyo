# Chat Topics

New chats can gain a short title during their existing first response. The sidebar
sorts each project's chats by state, and its Inbox shows Omnyo's server-owned Inbox:
your moves, what waits, and your Shelf.

The title names the chat's subject in 2–5 words, such as "Sidebar inline rename",
rather than repeating the prompt. The selected provider, model and reasoning stay
the same. There is no separate naming request, helper chat, backfill or paid
fallback. Existing titles and manual renames stay intact. Providers may omit the
naming tool; those chats remain usable and keep Omnyo's normal title display. When
the first turn fails before it finishes, Continue or retry keeps first-turn naming;
a message from another chat ends it. Send-now bypasses first-turn naming.

First-turn eligibility lives in the plugin's local SQLite store. Starting a chat
makes no metadata HTTP request and never waits behind tag changes or sidebar
diagnostics. A locked or unavailable naming store disables automatic naming for
the affected chat and logs a warning; the chat still starts. Completed and deleted
chats retire their eligibility. Active eligibility survives plugin reloads.
Existing thread-metadata eligibility markers are no longer read or backfilled.

Double-click a chat title to edit it inline. Enter or clicking outside saves;
Escape discards the edit. The normal Rename menu action remains available.

Sub-chats appear only under their parent, including when they need an answer.
Opening a chat reveals its sub-chats in Projects and Inbox. Switching to another
family collapses the branch you left; moving between a parent and its sub-chats
keeps their shared ancestors open. A running parent shows the total number of
nested chats and live subagents inside its left spinner, including on Shelf.

A chat started with "Continue from" groups with the chat it continues. The newest
chat in the chain keeps the row and marks how many earlier chats it continues;
opening it shows those earlier chats beneath it, each labeled "Source". Projects
and Inbox retain this grouping when an earlier chat receives messages, asks a
question or resumes work. Each earlier chat keeps its own status and explanation;
its activity does not replace the continuation's status. Child failures remain on their own rows: the parent owns recovery and reports
its own blocker or question when it needs the owner. Other sub-chat activity still
contributes to the parent's status. Expand the row to open earlier chats and use
their Inbox actions. Earlier chats do not count as subchats. A pinned earlier chat
or an unshelved earlier chat of a shelved continuation stays in its own place.

## Tags

Each chat can carry one tag that names its type of work. Tags never change a
chat's section; state still sorts the list. The default tags are:

| Id         | Icon       | Label    | Meaning                                   |
| ---------- | ---------- | -------- | ----------------------------------------- |
| `fix`      | `Bug`      | Fix      | defects, regressions                      |
| `build`    | `Code`     | Build    | features, refactors                       |
| `ship`     | `Sent`     | Ship     | releases, deploys, store submissions      |
| `ops`      | `Settings` | Ops      | infra, accounts, email, billing, machines |
| `research` | `Search`   | Research | questions, audits, investigations         |
| `design`   | `Palette`  | Design   | UI, copy, mockups                         |

- A tag's icon is an Omnyo icon name, such as `Bug`, drawn as a line icon in the
  text colour, or any emoji, drawn in colour. A capitalised ASCII word is an icon
  name; anything else is shown as typed. An unknown icon name shows Omnyo's generic
  icon.
- Rows do not show their tag. A chat's Tag menu marks the current tag.
- Change a chat's tag from Tag in the row's ⋯ menu or right-click menu. The
  change shows at once; if saving fails, the row shows an error and the old tag
  returns.
- Edit the list under Tools → Chat Topics → Tags: add, rename, change the icon
  or meaning, reorder, or delete. Removing a tag leaves its chats untagged;
  adding a tag with the same id later brings them back.

Who sets a tag, from strongest to weakest:

1. You, from the menu, the CLI or the RPC.
2. The chat's first response, through `chat_topics_set_name`. Its instruction
   lists the current tags as `id (meaning)`. An id outside the list is ignored,
   and the title still applies.
3. Omnyo's next-message prediction for older chats, through `tag.suggest`. It only
   fills an untagged chat or replaces its own earlier guess.

## Task Manager

Hover over the Task Manager icon in the sidebar footer, or focus it with the keyboard, to see the selected machine’s CPU, GPU and RAM. The small graphs show recent measurements. Each chat shows its CPU and RAM total. Expand a chat to inspect its processes, or search by chat title, executable or PID. The overview also includes a switch for sidebar readings. An unavailable counter has no plotted value.

On touchscreens, hold the icon to open the overview. Click or tap the icon to toggle CPU and RAM beneath chat titles in Projects and Inbox, including expanded sub-chats. This preference starts off and is remembered locally. Running chats show when a reading is pending or unavailable. Idle chats show CPU and RAM when Task Manager measures their processes. The sidebar and popover share samples from the Task Manager plugin (`leftover-processes`). Collection stops when both views are closed.

## The list

The list follows Omnyo's rail selection. A project shows only its chats, without
repeating its name: Omnyo's title bar names the project, and the New thread row
counts its chats. Each chat takes one line: a state dot, the title, and a muted
pencil when it has an unsent draft. A long title fades out at its trailing edge
instead of ending in an ellipsis. The dot shows the state, including for the
open chat:

- red: Failed; yellow: Needs you; yellow ring: Blocked;
- separate green dot: unread result; spinning ring: Working, with the number of
  running subagents inside when there are any; dashed ring: Waiting;
- green check: Ready to archive; grey ring with a centre pip: External;
- no mark: Open.

A project's chats sort into Running, Pinned, Needs you, Failed, Blocked, Waiting,
Open, External, Ready to archive and Shelf. External chats have only an outside
event left that nobody in the chat can speed up, such as App Store review; the
row reads "Awaiting" and names that event. Every view reads the same server-owned work
summary. The row shows its recorded reason, except that a running chat shows
only its title; a required answer can coexist with independent work. Optional
input does not force Needs you.
Family badges use the same shared priority and identify the sub-chat supplying
their reason. Each chat retains its own work summary.

Reading only changes the unread dot and count. Shelving only changes placement.
The Shelf keeps one order for all projects: a chat shelved a moment ago sits on
top until the server places it, which is also on top. Drag a top-level Shelf
chat up or down, in a project's Shelf or the Inbox's, to move it; its sub-chats
move with it. The new order shows at once and is saved through
`sdk.threads.experimental_reorderShelved`; if saving fails the chat returns to
its place and the list shows a notice. Dragging needs a mouse or trackpad.
Postponement needs an explicit recorded reason and resume trigger. A missing or
stale completion assessment cannot create Ready to archive.

Chat groups are Omnyo's named folders for chats from one project. The list shows
each group once, in the section of its most urgent member and where that member
would sort, with every visible member nested beneath it; each member keeps its
own dot and sub-chats. Pinned members stay in Pinned and shelved members on the
Shelf. Sub-chats and handoffs stay with their source chat whatever their own
group, and an unknown group or one from another project leaves the chat
ungrouped. Click a folder to collapse it; a collapsed folder shows its most
urgent member's dot, and the fold is saved with the other folds. Right-click a
folder to rename or ungroup it, or double-click its name to rename it inline.
Omnyo owns the group actions and Mod+G: the list publishes its multi-selection
through `experimental_setChatSelection` and clears its own selection when Omnyo
clears it, for example after grouping. Folder rows are not chats, so selection
gestures and Command+A skip them. The Inbox ignores groups.

The Inbox renders the server's cards and work views, one line per card. The
capsule reveals the Running section. A chat that needs your answer is
highlighted, and opening it shows the question in the chat that asked it. Waiting
starts open; click its heading to fold it. Waiting chats do not count as Inbox cards or enter Archive done chats.
Saved Glance prose does not create an approval or a required reply.
Rows move to their new section and position the moment a chat changes, with no
animation or delay, including while you hover the list or a menu is open.
The first layout waits for the core thread snapshot. Tidy is not a work-status
source, so disabling its sidebar marker does not change grouping.

Running starts open in the global Inbox. Its heading shows a spinning ring
beside the number of running chats, so you can still see how much is working
after you fold it. Shelf is the last section by default, and its titles use the same
color as other rows. Running chats form one list across projects, with a project icon on each row. Project Running sections start expanded. Click the heading
to collapse or expand Running.

The live capsule lists Working chats with optional Glance phase text. On
desktop it sits in the middle of the app footer and also counts chats that need
you, listing them first with their question or reason; such a chat is not
counted as running there. Click the capsule to open the list above it; hovering
does not open it. Click outside the capsule and list, or press Escape, to close
it. On a phone, a compact capsule in the sidebar counts running chats and, with
the Inbox open, expands the Running section in place. Both show a short note when a chat
finishes. Glance card data comes from Glance's `cards.index`; it never
classifies work status.

## The Inbox

The Inbox renders the server's snapshot from `sdk.experimental_inbox`. The
server decides each chat's view, card, primary and order; the list shows them as
given and never works them out itself.

The list has seven sections, each with a heading and count, by default in this order:
Needs you, Failed, Finished, Ready to archive, Running, Waiting and Shelf. A section with
no chats stays out of the list. Every section heading folds and unfolds its
section, and this device remembers each choice; every section starts open except
the Shelf. Ready to archive also has an Archive all button; it, like Shift+E, turns into
an inline Cancel / Archive N? confirmation in that heading. When
every shown section is empty, the list says so. Drag a heading above or below
another section to reorder them. Right-click empty space in the Inbox, or a
section heading, to choose which sections show, show empty sections, or reset to the
default; right-clicking a chat still opens its chat menu. The right-click menu is
for desktop; on a phone, use Settings.
**Inbox sections** on the Chat Topics page in Settings also reorders them, hides
any section except Needs you, can show empty sections, and resets to the
default. This device remembers these choices, and keyboard navigation follows
them. While Running is hidden, the footer capsule opens its own panel instead of
expanding Running in place. Ready to archive holds
exactly the chats the server marks finished and ready to archive. Failed operations
appear in Failed with their recovery actions. Finished results without archive
readiness appear in Finished; only chats asking for required input appear in Needs you. A shelved chat whose card is OK, Archive or a runs
card stays on the Shelf; it moves to Needs you only when it asks something of you. Each top-level chat appears once. Sub-chats appear only under
their parent; a chat continued in a newer chat appears within that chat's children,
labeled "Source", instead of appearing as a separate top-level row. A working chat
(its agent's turn, a queued turn, or a workflow or background command it started)
sits in Running until the work stops, then its card shows every earlier result.
Questions, failures and decisions still appear as cards while work runs. The
footer capsule expands Running in place; Esc collapses it.

- **Cards.** Questions first, then the oldest. Each card takes one line: one
  leading project mark, the title and age. The mark carries a corner dot when
  the chat needs you or is running, and a hollow attention ring when it is
  blocked. A long title fades out at its trailing edge instead of ending in an
  ellipsis. A chat that needs your answer is
  highlighted. Opening it shows the question in the chat that asked it, often a
  sub-chat, and you answer it there. Hovering a card shows its kind (Question,
  Result, Returned, Problem, Runs or Chain) and every outstanding cause. Clicking
  a card never adds a second line: its primary, Wait and Reply sit at the top of
  the row's ⋯ menu, beside Archive and Shelve. Right-click shows the usual chat
  menu. A card whose chat is still running shows the running corner dot unless
  the chat needs you or is blocked. The keys
  below still act on the focused card.
- **Runs.** One card groups an automation's results. Its primary is "Archive N
  done runs", or "Keep latest · archive N older" when none is done; Undo restores
  the whole set. Its menu's Runs submenu lists each run with that run's own
  primary.
- **Waiting.** Rows sit under titles that say what they wait for: On you (each
  with It happened), Checking, Scheduled, Retrying, On another chat and When
  something happens. Within a title, rows run soonest first on a timeline: the
  gutter says how soon each chat comes back (55m, 20h, 2d), and a chip shows the
  next check, the scheduled time or the retry attempt. Only waits on a condition
  get a second line, naming the check, the other chat or the event; dates and
  retries need none. A speech-bubble chip with a number
  counts the chat's new replies: turns it finished since you last wrote to it or
  moved it in the Inbox.
- **Row chips.** A stack chip with a number shows and hides the chat's subchats;
  an arrow chip marks a chat that continues an earlier one, and "Earlier chat"
  marks the earlier one. Hover a chip to read what it means.
- **Running.** Each row shows only the chat's title, with no second line for the
  agent's latest note, the command it is running, an optional question or pending
  results. When the chat keeps a todo list, a bar and a done/total count follow
  the title.
- **Shelf.** Shelved chats that no other section shows, in sidebar Shelf order.
  Drag a Shelf row in the sidebar or Inbox to move it. The project mark
  carries the same corner marks as a card for their current view. The section
  starts folded; your choice is remembered.

With the list focused:

| Key          | Does                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| J / K, ↓ / ↑ | Move between rows and show the chat                                                                                                            |
| Enter        | The card's primary. Reply only focuses the composer; Your call and a failed chat open a chooser; a question opens the chat that asked it       |
| 1–9          | Pick a chooser item                                                                                                                            |
| R            | Open the chat and focus its composer                                                                                                           |
| E            | Archive. With running work or an open question, 1 Stop and archive confirms. Not on Runs                                                       |
| W            | Tomorrow 09:00, Monday 09:00, Pick a date, On you (When I report it). A Returned card keeps its wait armed instead. Not on Question or Problem |
| S            | Add to or remove from the Shelf. Not on Runs                                                                                                   |
| H            | It happened, on an On you row or its reminder                                                                                                  |
| O            | Open the chat                                                                                                                                  |
| Z            | Undo the last move while its 10-second toast shows                                                                                             |
| Shift+E      | Confirm inline in Ready to archive: every done card Archive would file, skipping Shelf chats and running work; Enter archives exactly those    |

Each action sends the receipts its card displayed and the card's latch. If the
card changed meanwhile, the server answers `inbox_updated`. The card then shows
Updated, and the next Enter only shows the new card. Cards always show their
current content and take the server's order the moment it changes, including
while you use the list. A new question takes its place after the other
questions in Needs you at once. When you have scrolled past that place, a
"1 new question ↑" pill counts it until you click the pill or scroll back to it.
Enter never sends words, grants a permission or archives a chat with running
work or an open question.

The Inbox refreshes after every action and as soon as the sidebar's chats
change. If it cannot load, it says so.

## CLI and RPC

```sh
omnyo chat-topics status --json
omnyo chat-topics diagnostics --json
omnyo chat-topics tag THREAD_ID --tag fix --json
omnyo chat-topics tag THREAD_ID --tag none
omnyo chat-topics tags list
omnyo chat-topics tags add docs --label Docs --icon 📝 --description "READMEs, guides"
omnyo chat-topics tags update docs --label Writing
omnyo chat-topics tags move docs --to 1
omnyo chat-topics tags remove docs
```

`tag` without a thread ID uses the calling chat. `--tag none` clears the tag; a
user's "none" also stops predictions from tagging the chat. `tags move --to`
takes a 1-based position. Every command accepts `--json`.

RPC methods, for the app, the CLI and other plugins:

| Method               | Input                                            | Output                                                                           |
| -------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `diagnostics.list`   | `{}`                                             | `{ traces }`, the latest eight bounded captures                                  |
| `diagnostics.record` | `{ trace }`                                      | `{ stored: true }`; strict content-free layout schema                            |
| `tags.list`          | `{}`                                             | `{ tags: [{ id, label, icon, description }] }`                                   |
| `tag.set`            | `{ threadId, tagId: id or null }`                | the stored tag record (source `user`)                                            |
| `tag.suggest`        | `{ threadId, tagId }`                            | `{ applied }`; false for an unknown id or a chat tagged by you or its first turn |
| `tags.add`           | `{ id, label, icon, description? }`              | `{ tags }`                                                                       |
| `tags.update`        | `{ id, patch: { label?, icon?, description? } }` | `{ tags }`                                                                       |
| `tags.remove`        | `{ id }`                                         | `{ tags }`                                                                       |
| `tags.move`          | `{ id, index }` (0-based)                        | `{ tags }`                                                                       |

`tag.suggest` also accepts `tagId: null`, which clears only a tag that an earlier
prediction set. Each chat's tag lives in its plugin metadata as `tag: { v: 1, tagId, source,
updatedAt }`, with `source` one of `first-turn`, `user` or `prediction`. The
list lives in plugin storage. Changes publish on `chat-topics-changed`, so open
windows update at once. Older `topic` metadata is no longer read.

## Development and delivery

The plugin consumes the reviewed `@omnyo/plugin-sdk` 0.6.50 archive
pinned by `package.json` and `pnpm-lock.yaml`:
`./vendor/omnyo-plugin-sdk-0.6.50-6ba198b6e052.tgz`, written by `omnyo plugin types`. That artifact supplies
runtime exports and bundled declarations. Use Node 22.23.4 and pnpm 11.28.5.

The SDK test host and naming lock tests load native SQLite builds for Node 22.
If those tests report `Could not locate the bindings file`, run the existing
`pnpm ensure-native-modules` owner in Core and `pnpm rebuild better-sqlite3`
here, both on Node 22.

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test:e2e
pnpm package:runtime
pnpm install:runtime -- --machine <host-id>
```

The release process binds the CLI and SDK from the same
verified cohort. `pnpm build` runs `omnyo plugin build`; the CLI's plugin
runtime manifest must include every `@omnyo/plugin-sdk/app` export imported
by this plugin.

`tests/tag-retry.e2e.mjs` fails tag loading on an installed Omnyo (`OMNYO_TEST_URL`)
for ten seconds and checks that the sidebar's tag notice clears afterwards. It
loads `dist/app.js` in place of the installed bundle; `--installed` tests that
bundle instead. It only reads.

`tests/inbox-feed.e2e.mjs` checks the server-owned Inbox on an installed Omnyo
(`OMNYO_TEST_URL`) with `dist/app.js` and `dist/app.css`; `--installed` tests the
installed bundle. It picks five idle, unrelated live chats and serves its own Inbox snapshot for
them, then checks section order and placement, Running open by default, the
right-click view menu, hover and menu stability, opening
a chat from its title or reason line, J and K, Enter archiving with Undo, and the
390px layout. It answers Inbox actions itself and blocks every other write, such
as read markers, so live data never changes. Pass a directory to keep its
evidence; it defaults to a temporary folder.

Before installation, verify the coordinator's conditional-title API and capture
the current sidebar provider and `thread-title` AI-service selection. The release
owner installs the verified package, selects title AI off, then selects
`chat-topics/topics`. Verify the running plugin source and version, then check the real first response
and desktop/narrow sidebar. The update activates the package; do not reload it again.
Rollback restores the captured settings before disabling this plugin. It keeps
chat titles, tag metadata and the tag list.

## Sidebar layout diagnostics

The sidebar retains recent mouse hover transitions, scroll offsets, row geometry,
transforms and animation state automatically. Each batch contains at most 40
samples and 12 rows per sample; sampling is limited to once per 250 ms and uploads
to once per five seconds. The server keeps the latest eight batches in a fixed
ring. The browser also keeps its latest batch across reloads at localStorage key
`chat-topics:layout-diagnostics:v1`, with the preceding mount retained at the
same key plus `:previous`. During continuous activity the server ring covers
roughly 40 seconds, so retrieve it soon after the glitch.

Run `omnyo chat-topics diagnostics --json` after a visual glitch, even after moving
the mouse. Captures contain session-local row numbers, renderer versions and an
asset hash, with no chat text, raw chat IDs, screenshots or full URLs. Geometry
cannot prove a defect confined to painted pixels. The capture is diagnostic only;
it does not repair the overlap.

Inbox categories and order always follow current work state the moment it changes, including while a row is open, the pointer is over the list or a menu is open. A chat appears once: active chats belong to Running unless a higher-priority category owns the row.
