The sidebar thread list, as a plugin.

## What you get

- **Pinned** and **Threads** sections, plus the custom sections you create. Fold a section with its chevron, or by clicking the name of Pinned, Threads or the Shelf; a folded section shows how many threads it hides, and the list remembers what you folded.
- A folded **Shelf** section for shelved chats, kept out of every other group until they return.
- Organize by project, by machine, or chronologically, with sort by updated, created, or title.
- Nested child threads, worktree grouping, drag to reorder, pin, nest, and move between sections.
- Inline rename, keyboard jump shortcuts, and the same status glyphs Omnyo draws elsewhere.
- Agent provider icons before thread titles, controlled by Organize → Rows → Provider icons.
- Unread threads listed above read ones, controlled by Organize → Groups → By read status.
- Follows the navigation rail: a selected project shows only its threads, and the Inbox shows every project.

## How it works

The plugin reads Omnyo's live thread view through the plugin SDK and stores your layout choices (organization, sort, section order, collapsed groups) in its own storage, synced to every open window. Sections and thread moves go through Omnyo's public API, so `omnyo thread section` and this list always agree.

Use Command-click (Ctrl-click on Windows and Linux) to toggle individual chats,
Shift-click to select a range, or Shift-drag over rows to select them. With a
chat row focused, Command+A or Ctrl+A selects the displayed list and Escape
clears selection. To open a chat in a split, use its row menu or
Option-Command-click (Alt-Ctrl-click on Windows and Linux).

## Chat groups

When the list is organized by project, chats that share a chat group appear in
a named folder inside their project, placed where the group's highest-sorted
chat would sit. The folder row shows the group name and how many chats it
holds; click it to fold or unfold it, double-click the name to rename it, or
right-click it for Rename and Ungroup. Only top-level chats join a folder:
sub-chats stay under their parent, pinned chats stay in Pinned and shelved
chats stay in the Shelf. Folded groups are stored in the `collapsedGroups`
preference. The list publishes its multi-selection to Omnyo so Omnyo's Group
command and selection menu can act on it, and clears its selection when Omnyo
does. The chronological and machine modes show grouped chats as ordinary
chats, and dragging a chat into or out of a folder is not supported yet.

Disable the plugin to hide the list; another thread-list plugin can take its place under Settings → Appearance.
