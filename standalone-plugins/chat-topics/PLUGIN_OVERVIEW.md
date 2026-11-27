# Chat Topics

Chat Topics names new chats, sorts them by state, and gives the Inbox keyboard
shortcuts.

## Short titles without extra model calls

The agent suggests a 2–5 word title in its first response. Use **Rename** to
change a title.

## Chats sorted by state

Choose **Chats by state** in Settings → Interface → Sidebar. Each project then
lists its chats in sections:

- **Needs you** first, led by running chats asking you
- **Running**, **Pinned**, **Failed**, **Blocked**, **Waiting**, **Open**,
  **External** and **Ready to archive**
- a folded **Shelf** last

Sub-chats and handoffs stay with their source chat. A running chat's dot counts
its subagents.

Command-click selects chats; Shift-click selects a range. Press Command+A to
select the displayed list and Escape to clear it. On Windows or Linux use Ctrl.
Use the row menu to open a split.

## Chat groups

Select chats, then right-click and choose **Group** or press Command+G to put
them in a named folder. A folder appears once, in the section of its most
urgent chat, and nests its chats beneath it; pinned and shelved chats stay in
Pinned and on the Shelf. Click a folder to collapse it, or right-click it to
rename or ungroup it.

## Inbox

Pick the Inbox in Omnyo's rail to see one card per chat: Question, Result,
Returned, Problem, Runs and Chain, plus Waiting lists for what is on you and
what comes back by itself. Click a card to open its chat, or use the keyboard:

| Key          | Action                                                |
| ------------ | ----------------------------------------------------- |
| J / K, ↓ / ↑ | Move between cards                                    |
| Enter        | Do the card's main action                             |
| E            | Archive (asks first if work is still running)         |
| Shift+E      | Review and archive every card that is ready to go     |
| R / W / S    | Reply, wait, or move to the Shelf                     |
| 1–4          | Pick from the open menu, such as Archive, Reply, Wait |
| Z            | Undo the last move                                    |

The Inbox groups cards by chat state. Needs you and Finished show the reason,
and Waiting counts replies since you last wrote to or moved the chat. Omnyo
hides empty sections by default and remembers which sections you fold. Drag
headings to reorder them. Right-click a heading or use **Inbox sections** in
Settings to choose which sections appear. If refresh fails, Omnyo shows the
last snapshot and a notice.

## Tags for the type of work

Use a chat's menu to tag it as Fix, Build, Ship, Ops, Research or Design. Your
choice takes priority over the agent's suggestion. Manage tags in Settings.
Tags leave chats in their existing sections.

Hover over the Task Manager icon for compact CPU, GPU and RAM graphs and usage by chat. Expand a chat or search for a process. Click the icon to toggle per-chat CPU and RAM in Projects and Inbox.

## What's running now

A card at the foot of the sidebar shows what is running now; click it to open
the Inbox's Running list. While you type, an **On you** note appears when your
draft looks like the answer another chat is waiting for, with a button to send
it there instead or open that chat.

## Command line

```sh
omnyo chat-topics status --json
omnyo chat-topics tag THREAD_ID --tag fix --json
omnyo chat-topics tag THREAD_ID --tag none --json
omnyo chat-topics tags list --json
omnyo chat-topics tags add docs --label Docs --description "READMEs, guides"
omnyo chat-topics tags update docs --label Writing
omnyo chat-topics tags move docs --to 1
omnyo chat-topics tags remove docs
omnyo chat-topics diagnostics --json
```

`--tag none` clears a chat's tag and keeps automatic tags off it.
`diagnostics` returns recent sidebar layout measurements to attach to a bug
report after a visual glitch; they contain no chat text or chat IDs.
