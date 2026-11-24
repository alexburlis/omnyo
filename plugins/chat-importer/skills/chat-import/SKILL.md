---
name: chat-import
description: Import recent Codex CLI and Claude Code chats into Omnyo with omnyo chat-import, check which chats are ready, and explain why a chat cannot be imported.
---

# Chat import

The Chat import plugin (`omnyo--chat-importer`, enabled by default) finds Codex
CLI and Claude Code chats on a machine and turns each one into an idle Omnyo
chat. The Omnyo chat shows the earlier conversation and continues it with the
agent's full native context.

Surfaces: Settings → Plugins → Chat import, the **Chats** step of first-run
onboarding, and the CLI below.

```sh
omnyo chat-import scan
omnyo chat-import scan --days 7
omnyo chat-import scan --days 30 --host HOST_ID --json
omnyo chat-import scan --chat claude-code:SESSION_ID --chat codex:THREAD_ID
omnyo chat-import run
omnyo chat-import run --days 7 --json
omnyo chat-import run --chat claude-code:SESSION_ID --chat codex:THREAD_ID
```

- `--days N` (1–365, default 2) keeps chats whose last message is in the last
  N days.
- `--host ID` scans another machine. The default is the server machine. List
  machines with `omnyo machine list`.
- `scan` prints counts and one row per chat:
  `status  PROVIDER:ID  last active  project or reason  title`.
  `--json` prints the full preview: `counts`, `chats[]` (each with `key`,
  `status`, `reason`, `threadId`, `project`), `dropped[]` and `newProjects[]`.
  JSON output drops `firstPrompt` when the list would exceed the 1 MiB CLI
  output limit. A plain `scan` plans projects as if every `ready` chat is
  imported. `--chat PROVIDER:ID` (repeatable) lists only those chats, with the
  projects and `New projects` that `run` uses for the same keys.
- `run` imports every `ready` chat, or only the `--chat` keys printed by `scan`,
  one at a time. It prints one result per chat. `--json` prints
  `{results: [{key, title, status, threadId, projectId, createdProject,
message, omittedTurns, skippedLines}], counts: {imported, alreadyImported,
failed}}`. A failed chat still reports `projectId` and `createdProject: true`
  when its new project was created before the import failed. The exit code is 1
  when any chat failed. Near the 1 MiB CLI output limit, `run`
  drops titles and success messages, then lists failures first and reports
  the rest as `omittedResults`; `counts` always covers every chat.
- Re-running is safe: a chat that is already in Omnyo reports
  `already-imported` with its thread id.

## Statuses

| Status (`scan` label)                 | Meaning                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ready` (`ready`)                     | Will be imported into the project shown.                                                 |
| `already-imported` (`imported`)       | An earlier import owns this chat; `threadId` names it.                                   |
| `omnyo-chat` (`omnyo`)                | Omnyo ran this session, or it is a copy of a chat already in Omnyo; `threadId` names it. |
| `folder-missing` (`missing`)          | The chat's working folder no longer exists on that machine.                              |
| `not-a-project-folder` (`no-project`) | The folder is the home folder, `/`, an Omnyo data folder, or a Codex or Claude folder.   |
| `cwd-mismatch` (`moved`)              | The Claude Code chat changed folders, so it cannot be resumed from its store.            |

`dropped` counts files that are not chats at all: scripted `codex exec` and SDK
runs, subagent logs, sessions Omnyo ran, files without a message from the user,
unreadable files, and chats whose last message is older than the window.

## Projects

A chat goes to the existing project whose local folder on that machine contains
the chat's folder (the longest match wins; chat and project folders reached
through a symlink also match by their real paths, and a Git worktree also
matches its main repository's project). Otherwise the import creates a project
at the Git top-level folder, or at the chat's folder when it is not a
repository, using the real path. A chat inside the new project of another chat
in the same import goes into that project, so the plan depends on which chats
are imported together. The settings panel and onboarding relabel the rows when
chats are ticked or unticked, `scan --chat` shows the plan for named chats,
and the import files each chat exactly where that plan showed. `New projects`
lists the projects before anything is created, and one batch creates each new
project once.

## How continuing works

- Import writes only Omnyo's database. Native chat files under `~/.codex` and
  `~/.claude` (or `CODEX_HOME` and `CLAUDE_CONFIG_DIR`) are only read, never
  changed, so the chat can still be continued in the CLI.
- Imported chats keep their original times and show as read. Import writes no
  Inbox receipt, but each chat shows in the Inbox like any finished chat until
  it is archived or shelved. No agent starts at import.
- The first message sent in Omnyo forks the native session: Codex runs
  `thread/fork` and Claude Code forks the session file. The fork is a new native
  session that Omnyo owns; the original stays as it was. Editing the first
  imported message starts a fresh session instead, as editing a first message
  always does.
- Very long chats show only their newest turns; `omittedTurns` counts the rest.
  The agent still has the whole conversation through the fork.
- `skippedLines` counts lines of the chat file that could not be read, such as
  a line still being written or one larger than 16 MiB; they are missing from
  the history shown in Omnyo. The result message names both counts.

## Limitation: Codex with the Account Pool

While Account Pooler routes Codex, the Codex bridge refuses to fork a session
that was not created through the pool. Plain Codex CLI chats record the default
model provider, so their first send in Omnyo fails with the existing visible
guard message. They continue once Account Pooler no longer routes Codex;
clearing the chat's context instead starts a fresh session without the earlier
native context. Claude Code chats are not affected.
