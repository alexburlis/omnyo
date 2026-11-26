---
name: codex-provider
description: "Diagnose Omnyo-specific Codex session controls, MCP elicitation and Computer Use app access, model acceptance, and durable goals."
---

# Codex provider

The provider requires Codex CLI 0.136.0 or newer. On Codex 0.145.0 and newer,
`Disable provider subagents` disables native subagent tools through
`agents.enabled` and overrides `features.multi_agent_v2` to false for Omnyo
sessions. Older versions retain the legacy subagent settings.

Omnyo passes ordinary contributed environment variables to each Codex process.
Executable search paths, home directories, loaders, shell startup variables,
proxy and TLS settings, and `CODEX_`/`OPENAI_` controls retain the trusted launch
environment. `CODEX_HOME` and Account Pool routing use their existing provider
configuration. Reserved `OMNYO_` and `NODE_ENV` contributions remain sanitized.
Shell tools inherit trusted versions of these reserved process and routing values,
subject to Codex's own shell environment policy. Individual tools can interpret
other contributed variables. Only Omnyo's
`OMNYO_PROJECT_ID`, `OMNYO_ENVIRONMENT_ID`, `OMNYO_THREAD_STORAGE`, `OMNYO_CLI`,
`OMNYO_SERVER_URL`, `OMNYO_HOST_DAEMON_PORT`, and authoritative `OMNYO_THREAD_ID`
context values enter `shell_environment_policy.set`. Codex applies its shell
environment policy to the remaining values.

Workspace turns honor explicit Codex network settings and managed permission
requirements. A configured named profile, including `:read-only`, remains
authoritative for filesystem rules, including writable roots. A full-access
machine default uses `:workspace` for workspace threads, subject to Codex
requirements. Full-access requests fail when policy
disallows them. Unreadable configuration or an unavailable profile fails visibly.

Codex supports structured plan requests, editing and rerunning eligible messages,
and compaction through the corresponding core `omnyo thread` commands.
`omnyo thread clear-goal <id>` clears its durable active Goal and waits for provider
confirmation. Inspect the thread before recovery actions.

Codex questions from `request_user_input` pause the turn until answered.
Questions from `request_user_input_async` do not pause it: the plugin opens a
question card for each one that stays open for up to an hour after the turn
ends. Submitting sends the answer to the thread as a message
(steering an active turn or starting a new one); dismissing sends nothing.
From the CLI, find it with `omnyo thread interactions list <thread>` and answer
with `omnyo thread interactions respond <interactionId> <thread> --value
'{"answers":{"question-1":{"selected":["option-2"]}}}'`. Questions and options
are numbered from 1 in order; use `"freeText"` for a typed answer.

Codex relays MCP elicitations (`mcpServer/elicitation/request`) as a
`provider-codex/mcp-elicitation` interaction that pauses the turn. Every card
names the requesting MCP server. Computer Use app access (only from Codex's
`cua_repl` server; Computer Use metadata from any other server shows as a plain
tool approval) shows the app name and native icon, keeps high-risk warnings
visible, and offers Allow for this session or Always allow only when Codex
offers that scope; Codex stores the grant. MCP tool-call approvals
(`codex_approval_kind: "mcp_tool_call"`) show the tool and its arguments and
offer Allow, plus Allow for this session or Always allow when Codex offers
them. These are separate from macOS
Accessibility and Screen Recording permissions. Standard forms accept text,
numbers, integers, booleans, and single or multiple choices with defaults,
required fields, and supported constraints; answers are validated in the UI
and again before reaching Codex. URL requests show the destination and open
only on user action; acceptance means the URL opened, not that the external
flow finished. Unsupported schemas offer only Decline. Answer from the CLI with
`omnyo thread interactions respond <interactionId> <thread> --value '<json>'`
(SDK: `threads.interactions.respond`), passing
`{"action":"accept","persist":"session"}` (or `"always"` when `scopes`
includes it) for app access, `{"action":"accept"}` or an offered `persist` for
tool approvals, `{"action":"accept","content":{...}}` for forms,
`{"action":"accept"}` for URLs after the user opens them, or
`{"action":"decline"}` / `{"action":"cancel"}`. Invalid responses never grant
access. Stopping the turn answers the request with `cancel`.

Unlisted model IDs are accepted by this provider; acceptance does not establish
account access. Inspect models on the actual execution host with
`omnyo provider models codex` using the machine or environment selector.

Service tiers are `default`, `fast`, and `ultrafast`. Codex reports the tiers
each model accepts for the signed-in account, so the model picker and
`omnyo provider models codex` (Service tiers column, `supportedServiceTiers` in
`--json`) list Ultrafast only for eligible models and accounts. Pass the id to
`--service-tier` on `omnyo thread spawn` or `omnyo thread tell`; Omnyo sends an explicit
tier to Codex as given. When the model does not list it, Codex runs the turn
at its default tier and the thread shows its warning that the tier "is not
advertised as supported" and was omitted.

Daybreak appears as a separate model when the model list advertises
`gpt-daybreak-*-latest`. When the Account Pooler routes Codex on that machine,
the list combines the lists of its enabled accounts, and the pool runs the model
on an account whose plan offers it; otherwise the list comes from the machine's
own Codex sign-in. The model picker notes when new chats do not use your first
pooled account. Select it in the model picker or pass its
model ID to `omnyo thread spawn --model`. Each turn requests that model's Daybreak
cyber program; selecting an ordinary model uses its standard program.
Existing threads with a stored Daybreak option keep their history, but model
selection determines the program used for the next turn.

Use the core CLI skill for command syntax and official Codex guidance for
upstream product behavior.
