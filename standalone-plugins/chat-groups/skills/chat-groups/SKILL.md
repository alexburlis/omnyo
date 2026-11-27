---
name: chat-groups
description: Explain the grouped chat sidebar and switch between its status view and Omnyo's normal project view.
---

# Chat Groups

Use a separate test Omnyo instance for plugin verification.

Open Chat view in the sidebar footer, then select Projects or Status. The selected view persists through Omnyo's UI preferences.

Status has three primary sections: Unread, Read, Working. Nest Needs you / Other chats / Ready to archive beneath Unread and Needs you / Unfinished / Ready to archive beneath Read. Working stays last, preserving the seven-status order. Hide empty sections and groups. Section bars and status groups collapse independently. Counts cover parent chats at each level. A sticky section bar keeps scroll context visible. Each status contains project groups: one project pill and connected frame for its chats, without repeated row labels. Projects sort by their most recent root; their chats sort by recent attention. Titles align consistently and wrap to two lines; explicit sub-chat counts sit beneath parent titles.

Needs you includes pending interactions, open Decisions row markers, unread parent errors, and failed queued messages. Split these chats by the parent's unread state. Running, queued and background work stays Working even when unread. Queued/running workflows keep their originating chat Working while hidden agents run and between agent calls. Unknown workflow activity suppresses Ready for the affected chat tree. Tidy's completion marks distinguish both idle unread and read Ready to archive sections. Read and idle never mean complete.

Only parent chats count toward sections and status groups. Expand a parent's chevron to see indented children; children can expand to deeper levels. Direct child navigation opens its section, status group and ancestors. Initial parent navigation keeps unread groups at the top. Child unread success/errors stay inside the tree and do not create parent attention. Actual input requests and live work in children roll up to the parent. Hidden and archived branches stay excluded.

Status icons and counts use the current theme: amber Needs you, blue unread other chats, gray read unfinished, green Ready to archive, purple Working.

Row indicators stay at the trailing edge on hover and while shortcut labels appear. The green archive suggestion calls Tidy's checked archive action, then opens the next parent in status/project order after success. At the end, use the previous parent; when none remains, open that project's new-chat screen. Failures keep the current chat open and show a visible error. The Tidy header Archive button also archives directly and advances through its ready queue.

Archive and decision grouping uses Tidy's and Decisions' existing live sidebar row markers. Keep those plugins and their row markers enabled to show their marks here. No message text is classified and no additional inference runs.

Each project label covers its chats within that status. Each chat header also has a project pill, including split panes and compact layouts. Rows support chat navigation, split opening, pinning, read/unread, rename, archive, and the host's delete confirmation. Archive is a user action.

To select a view from the CLI:

```sh
omnyo settings ui set sidebar.threadListProvider chat-groups/groups
omnyo settings ui set sidebar.threadListProvider thread-list/thread-list
```

The plugin preserves the Thread list plugin's grouping and layout preferences. Installation preserves the selected sidebar provider. Before disabling or removing Chat Groups, select `thread-list/thread-list`; leaving `chat-groups/groups` selected after removal leaves the sidebar empty.
