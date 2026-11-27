---
name: chat-topics
description: Inspect Chat Topics, change a chat's tag, and manage the tag list.
---

# Chat Topics

New chats may receive a short title and a tag from their existing first
response. Do not create another chat or model request for naming. The normal Omnyo
Rename action changes a title; this plugin's manual operations change tags only.

```sh
omnyo chat-topics status --json
omnyo chat-topics diagnostics --json
omnyo chat-topics tag THREAD_ID --tag fix --json
omnyo chat-topics tag THREAD_ID --tag none --json
omnyo chat-topics tags list --json
omnyo chat-topics tags add docs --label Docs --icon 📝 --description "READMEs, guides"
omnyo chat-topics tags update docs --label Writing
omnyo chat-topics tags move docs --to 1
omnyo chat-topics tags remove docs
```

A tag names a chat's type of work: by default `fix`, `build`, `ship`, `ops`,
`research` or `design`. `--tag none` clears the tag and keeps predictions from
tagging the chat again. A tag you set wins over the first response's tag, which
wins over a prediction. Removing a tag from the list leaves its chats untagged.
Existing titles remain unchanged. There are no backfill, apply, undo, credits or
model-selection commands.

The sidebar list follows Omnyo's rail selection: the Inbox, or one project with its
chats in state sections and a folded Shelf. Tags never change a section or hide
chats. Hover over the Task Manager icon for machine usage and chat-owned tasks. Click it to show per-chat CPU and
RAM. It starts off, remembers the local choice and refreshes only while enabled.
Older Omnyo hosts keep the list's own Projects/Inbox toggle.

The Shelf, in each project and in the Inbox, follows core's one Shelf order:
newly shelved chats go on top, and the owner drags a top-level Shelf chat to
move it. That order belongs to the owner; agents cannot change it.

The Inbox shows Omnyo's server-owned Inbox. It has cards for the owner's moves (Question,
Result, Returned, Problem, Runs, Chain), Waiting (titled by kind: On you, Checking, Scheduled, Retrying, On another chat, When something happens; soonest first),
Running in the footer capsule, and the Shelf collection. The server decides each
chat's view and card; the plugin only renders them. Its sections (Needs you, Failed, Finished,
Ready to archive, Running, Waiting, Shelf) show only while they hold chats by default; every
section folds from its heading and the device remembers each choice, all start open except
the Shelf, and the Running heading keeps a spinning ring beside the number of running chats. The owner
reorders, hides or shows empty sections under Settings → Chat Topics → Inbox sections, or by right-clicking empty
space or a section heading in the Inbox on desktop; that choice is stored per device in the browser, so no CLI
changes it.

Projects use Omnyo's eight shared work labels: Needs you, Failed, Working,
Blocked, Waiting, Open, External and Ready to archive. External means only an
outside event remains (`assessment.waitingOn`); it is never Ready to archive. Shelf is a separate placement.

- The shared work summary supplies the label, reason, concurrent activity and
  input. Glance contributes phase display only.
- Ask decisions as native questions. Required input can show Needs you while
  independent work continues. Optional input does not imply Needs you.
- Failed work remains Failed after it is read. Unread dots never select a
  work label, and shelving never creates a postponement reason.
- Missing work evidence shows Open with an unavailable reason.
- The footer capsule lists current activity, including chats that also need input.

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
