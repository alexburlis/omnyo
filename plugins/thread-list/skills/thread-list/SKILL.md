---
name: thread-list
description: "Inspect or change the sidebar thread list's layout preferences: organization mode, sort, section order, hidden groups, collapsed groups, and thread row actions."
---

# Thread list preferences

The Thread list plugin owns the sidebar's layout state. Read it with
`omnyo thread-list prefs list --json`; keys are `showProviderIcons`, `showEmptyProjects`, `threadLifecycles`, `organizationMode`,
`environmentGrouping`, `groupByReadStatus`, `chronologicalSort`, `sortDirection`, `sectionOrder`,
`manualSectionOrder`, `machineSectionOrder`, `hiddenGroups` (including the
built-in `threads` group), `rowActions`,
`collapsedSections`, `shelfExpanded`, `collapsedProjects`,
`collapsedEnvironments`, `collapsedThreadSections`, `collapsedMachines`, and
`collapsedGroups`.

```sh
omnyo thread-list prefs list [--json]
omnyo thread-list prefs get <key> [--json]
omnyo thread-list prefs set <key> <value> [--json]
omnyo thread-list prefs reset <key> [--json]
```

`set` takes JSON; a bare word is read as a string, so
`omnyo thread-list prefs set organizationMode machine` and
`omnyo thread-list prefs set manualSectionOrder '["pinned","sections","threads"]'`
both work. A value the key's schema rejects fails with
`invalid_preference_value` and leaves the stored value alone. Every open
window applies a change immediately. Sections themselves and a thread's
section are Omnyo core state: use `omnyo thread section` and `omnyo thread update`.

On first load the plugin copies any non-default `sidebar.*` values from
`omnyo settings ui` once; after that the two are independent.

`collapsedGroups` lists the chat group ids whose folders are collapsed when the
list is organized by project.

Collapsed groups stay collapsed when background threads appear or become
unread. Their headers retain activity indicators. Opening a thread reveals
its containing groups in that window only; neither opening a thread nor
background activity changes collapse preferences.

The header's Filter menu selects Active, Archived, or both; at least one must
remain selected. `omnyo thread-list prefs set threadLifecycles '["archived"]'`
shows archived threads, and `'["active","archived"]'` shows both. The default
is `'["active"]'`. Archived results load in pages; use Show more at the end
of the list. The same preference is available through `setPreference` RPC.

Organized by project, the Filter menu's Empty projects item toggles
`showEmptyProjects` (default `true`). With
`omnyo thread-list prefs set showEmptyProjects false`, project groups with no
visible threads are left out; hidden threads and threads shown under Pinned
do not count. A project reappears once it has a visible thread.

Every write is broadcast on the plugin's `preferences` realtime channel as
`{ key, value, origin }`. `setPreference` takes an optional `origin` string
that the broadcast repeats, so an open window can ignore the echo of its own
write; CLI writes and resets broadcast `origin: null`.

The Shelf section lists shelved threads in the owner's Shelf order, with
their sub-chats nested under them. A newly shelved thread starts at the top;
drag a top-level Shelf row to move it, or run
`omnyo thread reorder-shelved <id> [--after <id>] [--before <id>]`. It loads whenever the Filter menu shows active
threads, and shelved threads appear nowhere else in the list. The Shelf appears only while
at least one shelved thread is loaded. It starts folded, and its header shows
how many top-level shelved threads are loaded. `shelfExpanded` stores whether
it is open; `omnyo thread-list prefs set shelfExpanded true` opens it.
`collapsedSections` covers only `pinned` and `threads`. Every section order
ends with `shelf` unless the stored order puts it elsewhere. A Shelf row's
quick action is always Unshelve (`omnyo--core/shelve`), whatever `rowActions`
holds. Shelved results load in pages; use Show more at the end of the open
Shelf.

`rowActions` picks up to three quick-action buttons a thread row shows on
hover, left to right before its actions menu, as thread action keys: Omnyo's
`omnyo--core/split`, `omnyo--core/copyLink`, `omnyo--core/read`,
`omnyo--core/pin`, `omnyo--core/shelve`, `omnyo--core/rename`, `omnyo--core/archive`, `omnyo--core/delete`, the list's
`thread-list/move` (opens a section menu), or another plugin's
`<pluginId>/<actionId>`. Bare legacy ids such as `archive` and `core/<id>`
keys still work. The default is `'["omnyo--core/archive"]'` and `'[]'` leaves
only the menu. For example,
`omnyo thread-list prefs set rowActions '["omnyo--core/pin","omnyo--core/archive"]'`.
In the app, a thread
row's actions menu has Customize row actions, which turns that row's quick
actions into three editable slots in place; each slot picks an action, a filled
slot can Hide, and filled slots drag to reorder. Done, Escape, or a click
elsewhere finishes.

Organize → Rows → Provider icons toggles the icon before each thread title.
`showProviderIcons` defaults to `true`; use
`omnyo thread-list prefs set showProviderIcons false` to hide them. Unknown
provider ids have no icon.

`environmentGrouping` collapses sibling threads sharing one worktree into a
single row. Children sharing their parent's worktree stay directly beneath the
parent without another worktree header.

Organize → Groups → By read status lists threads that show the unread dot above
the rest, keeping the selected sort within each group. `groupByReadStatus`
defaults to `false`; use `omnyo thread-list prefs set groupByReadStatus true` to
turn it on. While it is on, `environmentGrouping` is ignored. The open thread keeps
its place until another thread is opened.

New threads inherit the sidebar group where creation was invoked. Pinned
creates pinned threads; custom sections supply their section; project, machine,
and general thread groups start unsectioned and unpinned. Environment rows
reuse their environment and the containing group's placement. In Pinned,
they retain the group's common underlying section for unpinning; mixed-section
groups use no underlying section.
