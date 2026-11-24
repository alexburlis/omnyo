Pick up your recent Codex CLI and Claude Code chats in Omnyo. Chat import finds the chats you had going on your machine and turns each one into an Omnyo chat that shows the earlier conversation and continues where you left off.

## What you get

- A count of your recent chats, split by agent, with a list you can tick and untick before anything is imported.
- A window you choose: chats with messages in the last 2 days by default, or any number of days up to 365.
- Each chat placed in the project for its folder. When no project matches, Omnyo names the new project before it creates it.
- Imported chats at their original times, marked as read. Like any finished chat, each one shows in the Inbox until you archive or shelve it.

## How it works

The plugin reads the chat files of Codex CLI and Claude Code on the machine and never changes them, so you can still continue a chat in the CLI. Omnyo stores a copy of the visible conversation. The first message you send forks the agent's own session, so the agent remembers the whole chat while your CLI history stays as it was.

Chats that Omnyo ran itself, scripted runs such as `codex exec`, and subagent logs are left out. Chats in your home folder or in a folder that no longer exists are listed with the reason they cannot be imported.

Use it from first-run onboarding, from the plugin settings page, or from the CLI:

- `omnyo chat-import scan --days 7` counts and lists chats from the last 7 days.
- `omnyo chat-import run` imports every ready chat, one at a time. Add `--chat PROVIDER:ID` to import only specific chats.

Add `--json` to either command for machine-readable output.

## Requirements

Codex CLI chats continue in Omnyo while Account Pooler does not route Codex. Claude Code chats continue with the Claude Code login Omnyo already uses on that machine.
