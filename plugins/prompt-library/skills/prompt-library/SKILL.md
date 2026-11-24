---
name: prompt-library
description: Search prompt history and manage starred reusable prompts in Omnyo.
---

# Prompt library

With Skills 0.6.0 or later running, starred prompts migrate without deleting the original records. Existing commands and RPCs forward to Skills only after it reports migration readiness. Skills owns the prompt interface; without compatible Skills, Prompt Library continues to work on its own.

Open **+ → Prompts…** or press **Ctrl+R** in a composer. Search matches
starred prompts and recent history. Select **Thread**, **Project**, or **All**;
the scope is remembered per composer kind on this device. The new-thread
composer offers Project and All. Arrow keys select, Tab switches scope, Enter
inserts, and Escape closes. Desktop shows a full Markdown preview beside the
list; narrow layouts open the preview when a row is tapped, with Back and Insert.

Click the star or press Cmd/Ctrl+S to star or unstar the selected prompt.
**Star current draft** saves the draft. Starred prompts keep text and mentions,
deduplicate by text, persist across reloads, and sort by most recent use.
History attachments are retained when restoring into an empty composer.
Starred prompts omit attachments. A nonempty composer receives text and mentions
at the kept cursor. Inserting never sends a message.

The first search loads and indexes all prompt history; later searches fetch only
newer prompts. Each query word, ignoring case, must match a single word of the
prompt: exactly, as its start, with one typo (words of four or more letters),
inside it, or as an abbreviation that starts at its first letter (`tmln` finds
`timeline`). Letters are never matched across words. Results include up to 20
starred and 30 recent prompts in scope. Without a query, starred prompts come
first, then recent ones. A query returns one ranked list: prompts that start
with the query first, then by match type in that order, then starred prompts
and prompts of the composer's kind (prompts that started a thread in the
new-thread composer, follow-ups in a thread composer), then by relevance (rarer
words, repeated words, and shorter prompts score higher) decayed by age with a
seven-day half-life; a starred prompt's age counts from its last use.
A starred
prompt appears once, as its starred row. History contains user prompts; core records them without agent-only input. Prompts stay searchable until the server restarts, even if their
thread is deleted.

## CLI and SDK

- `omnyo prompts search [query...] [--project ID | --thread ID] [--composer new-thread|follow-up] [--json]`; `--composer` defaults to `follow-up`
- `omnyo prompts list [--json]`
- `omnyo prompts star <text...> [--json]`
- `omnyo prompts unstar <id> [--json]`

Use `api.sdk.plugins.callRpc({ pluginId: "omnyo--prompt-library", method, input })`:
`search` takes `{ query, scope: "thread" | "project" | "global", projectId, threadId, composer: "new-thread" | "follow-up" }`
with nullable IDs and returns `{ prompts }`, each row with `kind: "starred" | "recent"`; `star` takes `{ prompt: { text, mentions } }`; `unstar` and
`markUsed` take `{ id }`.

The bundled plugin is disabled by default. Enable it in Settings → Plugins or
with `omnyo plugin enable omnyo--prompt-library`. Its Search prompts shortcut is
rebindable in Keyboard Settings. Plugins can page through the same core history
with `api.sdk.experimental_promptHistory.list({ cursor, limit })`.
