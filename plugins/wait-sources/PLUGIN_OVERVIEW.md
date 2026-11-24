Let a waiting chat sleep until something outside Omnyo happens: a URL answers, a file appears, or a shell command succeeds. The chat wakes on its own, with what happened as its result.

## What you get

- `http:<url>[#<text>]` wakes the chat when the URL answers with a 2xx status, and, after `#`, when the page contains that text.
- `file:<hostId>:<absolute path>` wakes it when the file or folder exists on that machine.
- `command:<hostId>:<shell command>` wakes it when the command exits 0 on that machine. Its output becomes the result.

## How it works

Agents and you wait on these keys with `omnyo wait --event <key>`. Omnyo checks every minute (commands every two minutes) while a chat waits, backs off when a check keeps failing, and tells you when a key cannot be checked. A wait that an agent sets on an `http` or `command` key is a proposal: nothing runs until you accept it in the Inbox, and the card shows the exact URL or command.

`omnyo wait sources` lists every key format with its health. `omnyo wait check <key>` tries a key once without waiting on it.

## Requirements

`http` checks run from the Omnyo server. `file` and `command` checks run on the named machine, which must be connected; while it is away, the chat keeps waiting. Commands run in the machine's home directory through its default shell, stop after 20 seconds, and get the machine's environment without Omnyo's own variables.
