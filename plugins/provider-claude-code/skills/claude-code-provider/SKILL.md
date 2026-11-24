---
name: claude-code-provider
description: "Configure or troubleshoot Omnyo-specific Claude Code provider settings and session behavior."
---

# Claude Code provider

Read settings with `omnyo plugin config provider-claude-code`; change a declared key
with `omnyo plugin config provider-claude-code set <key> <value>`.

- `allowModelFallback` defaults to `false`. Omnyo keeps the selected model when it
  is unavailable or cannot continue. Enable automatic model switching with
  `omnyo plugin config provider-claude-code set allowModelFallback true` or
  **Allow model fallback** in Settings → Providers → Claude Code. Changes apply
  before the next turn and preserve context. Fallback history does not change
  the model selected for later user turns.
- `subagentsDisabled` defaults to `false`. Enable with
  `omnyo plugin config provider-claude-code set subagentsDisabled true` to remove
  native Agent, Task, and ListAgents tools from the model context. Changes
  restart Claude before the next turn, preserving the conversation. A deny hook
  also blocks native delegation during an active turn after disabling it.
- `disable1MContext` defaults to `false`. Enable with
  `omnyo plugin config provider-claude-code set disable1MContext true` to set
  `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (`0` when off). Changes restart the
  thread's Claude process before its next turn, preserving context.
- `chromeEnabled` defaults to `false`. It starts Claude Code with `--chrome` for
  Claude in Chrome tools. The host needs the extension and a claude.ai login.
  A change restarts the thread's Claude process before its next turn, preserving
  context.
- Select the Fast service tier in the model picker or pass `--service-tier fast`
  to `omnyo thread spawn` for supported Opus models. Use
  `omnyo thread tell --service-tier fast` to change a thread on its next turn;
  `default` turns it off. Fast mode requires eligible Claude access;
  subscription accounts need usage credits. It is billed at premium rates.
  The provider passes the selection as a session-scoped SDK setting, so it
  does not change the user's Claude defaults.
- `sandboxEnabled` defaults to `true`. In Accept Edits and Approve for me modes
  Omnyo runs Claude Code's Bash commands in its sandbox. Set it to `false` to use
  Claude Code's own command approvals and sandbox settings instead. A change
  restarts the thread's Claude process before its next turn, preserving context.
- `fullAccessApprovalsEnabled` defaults to `false`, so Full Access approves
  every request Claude Code sends, and unattended threads never wait. Set it to
  `true` to show Claude Code's own prompts in Full Access: `permissions.ask`
  rules, PreToolUse hooks that answer `ask`, and its built-in safety checks
  (such as `rm` on a possibly-empty variable). It applies from the thread's
  next turn without a restart. When Omnyo runs as root, Full Access always
  approves, because Claude Code refuses `bypassPermissions` there.
- Omnyo passes only `OMNYO_CLAUDE_CODE_EXECUTABLE` and `CLAUDE_CODE_OAUTH_TOKEN` to
  the CLI. Mint the token with `claude setup-token` for machines with no
  interactive login.
- Each bridge also sets `CLAUDE_CODE_ENABLE_TELEMETRY=1` and `OTEL_*` log-export
  variables that point at its own authenticated `127.0.0.1` receiver. The
  receiver keeps only the token counts of `/compact` API requests and records
  them on the standalone `/compact` turn, whose SDK result reports no usage.
  The turn still ends at once; only its usage row waits, up to 10 seconds, for
  the event. Only logs-specific `OTEL_EXPORTER_OTLP_LOGS_*` variables are set,
  so host metrics and traces settings still apply. Thread environment
  overrides of these variables take precedence and turn the measurement off
  without any wait.
- Structured plan, message editing, and compaction are supported through the
  corresponding `omnyo thread` commands. Unlisted model IDs are accepted by the
  provider; verify actual availability on the target host.
- When the ask-user-question plugin is enabled, questions go through its
  durable `AskUserQuestion` tool, which opens an Omnyo question and returns
  immediately, so a waiting chat can go idle and idle updates can proceed.
  Omnyo redirects Claude Code's own blocking tool to it, except in plan mode,
  where questions keep blocking the plan turn. With the plugin disabled,
  Claude Code keeps its own tool.

Inspect the thread and provider state after a change; do not restart unrelated
threads or change settings merely to answer a question.

Automatic context breakdowns run in a separate, non-persisted fork of the saved
conversation. Reporting never sends prompts or control requests to the live
Claude session. A timeout, replacement, or thread stop closes the reporter;
the live conversation does not wait for reporting or restart because of it.
