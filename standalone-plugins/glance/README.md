# Glance

Glance keeps an agent-written card beside each chat that answers three
questions at a glance: **Goal** (what the chat was asked to do), **Now** (where it
stands) and **Next** (who acts next, or **Ready to archive** once Tidy marks the
chat). Facts, deliverables, proof and recent changes sit under one closed Details
toggle. The Glance navigation page groups cards and supports Lines and Cards
views. It makes no model calls and creates no provider accounts or services.

Glance is the chat's single status card. When Omnyo's
server-owned Inbox lists the chat, the chip renders that view and never the
agent's reported status: a question, or any other move of yours, shows Needs you,
except that a Result shows Waiting or Working while the server's shared work
status says the chat still waits on a dependency or runs work, unless the Result
asks you to accept a proposed wait; a Problem shows Failed; a card whose only
move is Archive shows Done; Waiting, Running and Resting show Waiting, Working
and Open. The agent's headline and next
step stay as written. Chats the Inbox does not list, such as sub-chats, follow the
rules below.

When Omnyo supplies the server's shared chat work status, its label (Needs you, Failed, Working, Blocked, Waiting,
Open or Ready to archive) sets the card's status, matching the sidebar. While the
agent's card agrees, Glance keeps the card's headline and shows its next step;
otherwise it shows the server's reason and next actors and keeps the card under
Last reported. An open chat keeps a reported done or a fresh blocker. A chat
without a card shows the server status instead, with Archive when Tidy marks it
ready. Composer Predictions shows only suggested replies.

Without the server work status, current runtime work, native input, queue and
callback state determine the displayed status. A saved working report becomes Idle when the chat has no current producer;
a goal or plan alone does not mean work is running. Details retain the saved
headline and next step under Last reported. Unavailable current activity displays
Unknown instead of treating a saved working report as live.

## Where the card appears

On Omnyo hosts with thread companions, the card is the **Glance** companion. Its
title bar button, a list icon, turns the side card on and off. Omnyo chooses the
place and animates each move:

- **Beside the chat.** While the side card is on and the pane has room next to
  the chat column, a 288px card floats at the top right. It is strictly a
  summary: the status chip, the server's current reason when it adds something,
  then **About** (the chat title), **Started** (`goal`) and either **Toward**
  (`headline`, while the chat is under way) or **Result** (when it ended). A done
  result is green with a check (`sidebarSummary`, else `headline`); a blocked or
  failed result is red with a cross (the blocker or failure reason). Next,
  phase, freshness, Details and Archive stay out of it; Archive lives above the
  composer.
- **In the title bar.** Otherwise a one-line pill shows the status dot and the
  result, current reason or Toward line. The dot is blue (the composer's working
  accent) while the chat works or waits, green when done, red when blocked or
  failed and amber when it needs you. Clicking it opens the same summary below
  the title bar; Escape or a click outside closes it.
- **Loops.** While Pursue runs a loop on the chat, the pill adds a repeat icon
  with the time to the next check, and the side card and opened pill show a Loop
  section with the prompt, Edit and Stop loop.
- **Above the composer.** On phone widths the card keeps its composer form,
  described under Status and expansion.

A **Ready to archive** row with the completion reason and Archive action appears directly above
the composer whenever Tidy recommends archiving the current chat. It stays visible
without opening the chat card and disappears when the chat has new work. The inline
phone card leaves Archive to this row and wraps its summary text.

The side card counts as seen while it shows. The title bar pill counts only while
its card is open. Older hosts keep the card above the composer.

## Visual deliverables

A deliverable can include an explicitly owned image preview independently of its
primary link. Upload the image through the project attachments SDK, then supply
`preview: { kind: "project-image", projectId, path, mimeType, alt }`. The path is
the uploaded project-relative attachment path, never a browser host's local path.
PNG, JPEG and WebP images up to 4 MB are supported. Optional `visualRequestId`
and `role: "before" | "result"` identify captures from the same visual request.

Saving a card retains every preview for its owning thread through the source
project's attachment API. Duplicate paths are grouped by source project, with no
image copies or history events. A retention failure leaves the previous card
and its revisions intact. The images remain retained until their last owning
thread is deleted.

The Cards overview projects at most two image references per chat. It fetches
images only when their previews become visible; chat details load them when
expanded. Images open in Omnyo's shared image viewer. Reads use the owning project's
authenticated attachment endpoint and never mark a card seen. Bytes stay out of
card storage, and temporary image URLs are revoked when their view closes.
The tool and CLI use the same card schema; `omnyo glance list --json` includes
the bounded `visuals` projection. Native questions continue to open in their chat.

This local worktree uses the paired core worktree's experimental image component.
It must not be installed independently on a runtime lacking that component.

## Authoring a card

Use the `glance_set` agent tool. Existing provider sessions receive tools only at
the next supported session boundary; the CLI works immediately after install:

```sh
omnyo glance set --card-stdin <<'JSON'
{"status":"working","phase":"test","goal":"Fix checkout on iPhone","headline":"Fix is in; the focused checks are running","facts":[{"label":"Scope","value":"Checkout only","tone":"info"}],"next":"The agent inspects the check results"}
JSON
omnyo glance show
omnyo glance show CHAT_ID --json
omnyo glance diff . --json
omnyo glance list --json
```

Piped card JSON must be one line and at most 16 KiB, as required by Omnyo's plugin
CLI. `set --chat CHAT_ID` targets an explicit chat. `show` and `diff` accept an
optional chat ID; `.` or omission uses the invoking thread. Outside a thread,
name a chat. Without `--json`, commands show concise human output. With it,
commands return structured JSON. The `glance_show` tool reads the invoking card.

A `needs-you` card reports that a native composer question awaits an answer.
The card, overview and sidebar subtitle combine saved evidence with Omnyo's live
thread state. An answered question held in the queue shows muted **Waiting**
immediately; a running turn shows **Working**. Old approval instructions and
blockers stay out of Next while queued or running. Native questions and failures
remain visible. An old Needs you card without a pending question shows **Idle**;
a fresh external blocker remains when no queued or running work supersedes it.
A stale blocker becomes **Idle** after that work ends.
These display states do not rewrite stored card revisions or RPC results.

Glance accepts status only; create all decisions through Omnyo native questions
(`AskUserQuestion` or `omnyo question command`). `ask` is not an authoring field.
A `blocked` card requires a concrete blocker; other statuses cannot contain one. `done` means the whole
requested outcome has been delivered. Only the user can accept a narrower finish
line. A partial attempt or delegated handoff does not complete a larger request.
Core's shared work summary owns archive readiness; a done card does not set it.
See [the skill](skills/glance/SKILL.md) for field limits and examples.

`goal` is optional (at most 120 characters, ideally 80). Agents set it from the
owner's original request on the first card. A later card that omits `goal` keeps
the previous one, so a new goal is sent only when the request changes. Chats
without any goal show the chat title in the Goal row. `headline` is the Now row and `next` the Next row; the skill asks for at most
90 and 80 characters.

Completed cards can supply `sidebarSummary`: the single outcome of the chat's main
request in at most 64 characters, ideally 55 or fewer, such as `Pentest page live
with €1,900 security check`. Unrelated outcomes are never joined with `·`. It
appears in the chat sidebar, the Inbox and on the minimized chat card instead of
the longer headline. Older completed cards show a shorter
headline excerpt, cut at a word boundary with an ellipsis. Working, decision and
blocker previews keep their existing behavior. The tool and CLI accept the same
field, and JSON show/list results include it.

## Proof and privacy

Reproduced proof supplies a command and can supply an `eventSeq`. An explicit
sequence selects a same-thread completed command event. Without one, Glance
requires a unique exact command match after trimming outer whitespace and
normalizing line endings. The server searches the latest 500 completed events in
one compact lookup. Ambiguous or
missing evidence is shown as **Not linked**. The linked command's actual status
and exit code are shown; execution alone does not establish the claim.

Card saves use `threads.experimental_lookupCommandProofs` to validate the chat and
resolve proofs in one request. The server reads command headers within the latest
500 completed events and hydrates output only for a selected unique execution.
Empty proof lists validate the chat without reading history. General history reads
still use the public SDK events endpoint. Both paths use the core redactor. Glance
never reads provider environment resolution directly or bypasses that boundary.
Glance keeps persistent redacted excerpts. Each linked proof
retains at most 3,000 characters of the selected command output, including the
truncation marker, with the beginning and end preserved. Snapshots also retain
command, status, exit code, cwd and sequence. No raw provider history, credentials
or arbitrary tool argument/result objects are retained. Older proof snapshots
can still report an unavailable excerpt. The revision limits below also apply
to these snapshots.

## Status and expansion

The conversation owns the outcome recap; Glance summarizes current status and
next action. Omnyo's native composer form owns all decision prompts, options and
answers. Glance has no answer controls and never writes or submits the composer.
Older stored cards remain readable as status; their legacy decision fields do
not reappear in cards, the overview or change history. Original revisions stay
in storage.

The card has two states. Minimized, it is one line: status pill, Now line, a
**Ready to archive** pill when Tidy marked the chat, update time and a chevron.
A completed card that Tidy confirms is ready uses a soft success treatment,
a check mark and a visible **Archive** button beside the result. A last loaded
card gets it too while its fresh read is pending, so the card opens in its final
layout instead of growing when the read returns. Archive runs
Omnyo's own optimistic archive action: the chat leaves the sidebar and the next chat
opens immediately, the server confirms in the background, and Omnyo's Undo toast
follows. Nothing animates. If Omnyo rolls the archive back, the chat returns and
Omnyo shows its error toast. Continuing work removes the completion treatment.
Completed cards with a `sidebarSummary` show that summary instead of the
headline. Open, it shows the status pill with a four-step phase strip, then the
Goal, Now and Next rows. A blocked card shows its blocker in red in the Next row.
A done card without a `next` states Tidy's answer: **Not marked ready to archive
yet**, or **Archive status unavailable** when Tidy cannot be read. The Details
toggle, closed by default, shows the facts, files, proof and the changes since
you last looked. The status row toggles between the two states.

Glance reads Tidy's presentation of Omnyo's current work summary, live, just like
the Inbox. Core combines a source-bound completion assessment with current
obligations and owns the archive recommendation. Agents report outcomes; they
cannot set readiness. A done card or a stopped turn does not make a chat ready.

Glance does not depend on Tidy's sidebar marker setting or on which plugin owns
a chat's row status. Tidy's app re-sends readiness changes as a
`omnyo-tidy:readiness` window event. Glance reads Tidy's `ready_ids` RPC on load,
reconnect and focus. When a read fails, Glance asks Tidy's app for its snapshot
(`omnyo-tidy:readiness-request`). It shows **Archive status unavailable** when
nothing answers, Tidy reports a stale snapshot, or Tidy sends
`omnyo-tidy:readiness-ended` on unload. Older snapshots cannot restore readiness
after a newer stale snapshot. Core's current obligations and completion assessment
govern whether Tidy recommends archiving.
Phone widths hide the phase name and keep the four-step strip. The header button
describes the Ready to archive pill and phase strip to screen readers.

Cards that carry `goal` cannot be read by Glance 0.1.16 or older, whose card
schema rejects unknown fields. Roll forward from 0.1.17 instead of reinstalling
an older package.

Working and completed cards start minimized. Attention statuses open on each new
revision; minimizing one keeps it minimized until the next revision. Manual
choices persist for the browser session.

## Read state and lifecycle

The plugin stores its own read state and leaves Omnyo's `lastReadAt` unchanged.
Visible cards acknowledge their displayed revision and captured event cursor after
two seconds. The last 64 displayed revision/cursor pairs per chat persist in SQLite,
so plugin reloads preserve pending acknowledgements. New activity on the same card
can advance the captured cursor. Delayed acknowledgements cannot move either
cursor backward. The
view's original diff stays visible for that visit.

The diff compares card fields with the last seen revision. Activity counts are
**new replies**, defined as distinct nonempty completed assistant-message items
after the captured event cursor. They are capped at 100 over five pages of 100
completed events. **More activity available** means the cap or event scan has
remaining activity; it does not claim an exact unread-message count. Published
SDK 0.6.42 does not expose the newer conversation method.

History reads compare captured card revisions before waiting for reply history, so
another view can acknowledge and prune old revisions without invalidating that read.

SQLite retains the newest 50 revisions plus the last seen revision. A later agent
turn makes an older card stale as soon as the chat starts running; a new card write clears that marker. Deleting a
thread removes all of its cards, proofs and read state. Realtime updates are
coalesced for 50 milliseconds, and the app refetches after reconnecting.
Each realtime signal carries the changed card's `cards.index` entry, or `null`
after deletion. Glance re-announces it in the window as `omnyo-glance:changed`
(`{ threadId, revision, entry }`) so other plugins, such as the Chat Topics
Inbox, update that card at once without another request.

## Refresh diagnostics

A failed list refresh keeps its original exception only in the mounted list's
memory. The list revalidates when browser connectivity returns, even if its
WebSocket stays connected. The error stays visible until a successful response.
Its next refresh, network restoration or reconnect carries one typed diagnostic on
`cards.index`; no separate reporting request, timer or model call is added.
Transport retries retain the same report ID until a successful index response.
The server deduplicates the last 100 IDs and writes safe metadata through its
existing rotating plugin log: `omnyo plugin logs glance -n 100`.

Reports contain time, duration, HTTP status, failure stage, allowlisted error
name/code, connectivity, visibility and build identifiers. They exclude error
text, stack, payloads, URLs and user-agent strings. Pending exceptions do not
survive page unload. Existing clients can continue sending `null` to the index.

## Development and delivery

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
omnyo plugin build
```

The plugin's SDK
artifact is produced from the canonical `omnyo/packages/plugin-sdk` source
and pinned in this package and lockfile. Install the frozen dependency closure,
including this package’s declared TypeScript 7 compiler and React/test peers.
The shared Inbox view requires Omnyo 0.46.246 or later.

Run the standalone checks here. Keep prior verified runtime packages
until the replacement is verified. Disabling Glance removes its UI/tools while
leaving its SQLite database intact.

The sidebar subtitle requires the host's optional experimental subtitle setter.
Older hosts continue to render the card and Glance page without a subtitle.

## Loading and revisits

Only `card.read` opts into conversation bootstrap hydration. Glance observes the
host's exact plugin/chat/method bootstrap cache without another request, validates
the result against its RPC schema and paints an arriving card synchronously.
Pending bootstrap does not trigger a parallel card read. Fresh missing cards clear
the UI; bootstrap errors stay visible and do not silently fall back to another read.

When the app-wide card index already lists the chat, its status, headline, next
actor and facts render with the chat while the full card loads. That indexed card
is labelled as the last loaded card and is never marked seen; the full card
replaces it, adding files and proof to the open card.

A bootstrap snapshot already cached when the chat opens remains labelled as the
last loaded card while one explicit server read checks it. The host marks a bootstrap current
when it belongs to this route entry, including when it arrives before Glance mounts. Manual Retry, reconnect and realtime retain explicit revalidation. The
composer and early route observer share their request and state.

Up to 32 inactive card reads remain in browser memory, keyed by plugin and chat.
History and cursor capture stay separate; read-position acknowledgement waits for
the displayed revision and matching captured cursor. `card.get` and CLI show keep
their existing captured-cursor contract. No snapshot is presented as universally
fresh, and refresh settles after the card and history requests finish.

## Dev servers

On desktop, a compact shelf above the composer shows this chat's active managed
previews and one recent stopped server. On mobile, a server button in the chat
header shows the count and status; tap it to open the same controls in Omnyo's drawer.
The mobile composer has no server shelf. Each server is a row with a status dot, its
address, a status badge, its machine and one action; long addresses truncate without
pushing the action out of view. **Open** opens a running preview, and **Restart** runs
a stopped or failed server's saved command again on its owning machine. A failed
server shows its exit message under the address with one sentence saying what to do.
Host-offline, unknown and occupied-port states stay visible with a plain explanation
and no unsafe restart.

The shelf remembers online observations in Glance's database across reloads. The
recent stopped server shows **Last seen running …** with the time it was last
observed online, or **Not seen running yet** when its registered recipe has never
been observed online. Activity while every shelf is closed cannot be ordered by the
current preview API.

Use `omnyo glance servers [chat] --json` for the same active/recent selection.
After registering and starting a preview, run
`omnyo glance servers [chat] --remember <preview-id>` to associate its saved recipe
with this chat. Reusing a fixed-port recipe preserves its original owner; an
explicit association makes it visible here without exposing other chats' servers.
The existing `omnyo preview list`, `status` and `restart` commands provide lifecycle
controls. Read `omnyo guide previews` before registering a server. Historical plain
localhost links have no saved restart command and are not guessed or adopted.

“Not ready to archive” is available beside Archive in readiness banners and in thread menus. It uses Tidy’s existing `dismiss` RPC (`omnyo tidy dismiss <chat-id> --json`), hides the suggestion without archiving or sending a message, and lasts until new chat input arrives.
