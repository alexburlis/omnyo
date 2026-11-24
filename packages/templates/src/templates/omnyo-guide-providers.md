---
kind: instruction
title: Omnyo Guide — Providers
summary: Command reference for discovering providers and models.
intent: Provide complete provider command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Provider commands

Native Claude profiles are an opt-in pilot on the coordinator's local Mac.
Enable the pilot with `omnyo provider claude-profile pilot enable`. The pilot
currently requires Claude Code 2.1.331; other hosts or CLI versions report
unavailable. Account Pooler presents the same profile management and sign-in
controls.

  omnyo provider claude-profile list [--machine ID] [--project ID] --json
  omnyo provider claude-profile add LABEL [--adopt-existing] [--machine ID]
  omnyo provider claude-profile login PROFILE_ID [--machine ID]
  omnyo provider claude-profile login-status PROFILE_ID [--machine ID]
  omnyo provider claude-profile login-cancel PROFILE_ID [--machine ID]
  omnyo provider claude-profile status PROFILE_ID [--machine ID]
  omnyo provider claude-profile default PROFILE_ID|unprofiled [--project ID]

Sign-in stays in the installed Claude Code binary and opens Anthropic's browser
page on the local Mac. Omnyo stores profile identity and readiness, not Claude
credentials. A successful adoption becomes the machine default only when no
machine default was saved. A project default overrides the machine default for
new chats. Existing chats keep their profile and machine. Use
`omnyo provider claude-profile pilot disable` to hide the controls without
deleting profiles or chat bindings.

A provider limit stops the chat on its pinned account. Omnyo never switches
accounts or resends the prompt automatically.

SDK: `providers.claudeProfiles.list`, `add`, `status`, `loginStart`, `loginGet`,
`loginCancel`, `defaultsSet`, and `pilotSet`. Pass `hostId` to profile operations
and `projectId` to list or defaultsSet when selecting a project default.

Manage agents in Settings → Providers. Enabled providers can be reordered, made
default or disabled through the row menu; disabled providers stay listed under
Disabled with an Enable button. Install provider plugins in Settings → Plugins.

  omnyo provider disable <id>
  omnyo provider enable <id>
  omnyo provider list --all

Disable hides one provider from pickers and the ordinary list and rejects new
sessions and turns. It preserves its CLI, plugin, siblings and thread history;
in-flight turns can finish. Enable also enables its supplying plugin if needed,
while preserving other providers' individual opt-outs. list --all shows the global
catalog including disabled plugins, without machine/environment selectors.
SDK: providers.catalog() and providers.setEnabled({ providerId, enabled }).
Enable restores automatic discovery, so installed-only agents again appear only
where their CLI is installed. Disabling the default clears its selection; new
threads use the next enabled provider in saved order, including in projects whose
last-used provider is disabled. Explicit or existing-thread choices never
silently switch.

Providers are agent backends (e.g., codex, claude-code). Each supports different models.

  omnyo provider list [--machine <id-or-name> | --environment <id>]
                                          List available providers
  omnyo provider models [providerId] [--machine <id-or-name> | --environment <id>]
                                          List models for a provider

Use these before spawning threads if you are unsure which provider or model to use.

When a provider's models declare options (a mode, an on/off switch), `omnyo provider
models` lists them under the table with their ids, values and defaults; `--json`
carries them per model as `sessionOptions`. Choose values at creation with
`omnyo thread spawn --option <id>=<value>` and on an existing thread with
`omnyo thread options --set <id>=<value>`. A model may accept only some values
(`fixed: true` on an on/off option, or a shorter `values` list): a spawn
without `--model` starts on a model that fits the chosen options, and a spawn
whose `--model` cannot run with them is refused with the name of one that can.

Service tiers are provider-defined ids. `omnyo provider list --json` reports each
provider's `serviceTiers` ({id, label, description?}); `default` always means
the provider's standard tier. A model may narrow that list: `omnyo provider
models` shows a Service tiers column, and `--json` reports
`supportedServiceTiers` per model (absent when the provider does not report
tiers per model, in which case the model accepts every tier the provider
lists). Pass a tier id to `--service-tier`; a tier the provider does not list
is rejected.
`--host` is an alias for `--machine`. Machine and environment selectors are
mutually exclusive because an environment already selects its machine. When no
selector is supplied, both commands intentionally inspect the server machine.
When provider and model are omitted from omnyo thread spawn, the project's
remembered defaults apply. If the project has no remembered choice, Omnyo uses
the explicitly requested provider or Codex, then resolves the model marked
default by that provider on the target machine (falling back to the first
catalog model when none is marked).

Model lists answer from the machine's last stored list while a background
refresh runs, so a list can be hours old. When the Account Pooler routes a
provider on that machine, its model list comes from the account the pool uses
for new chats there. For Codex, the pool also adds the models that its other
enabled accounts' plans offer and runs each model on an account whose plan
offers it. A provider whose refresh keeps
failing or timing out keeps answering from its last stored list.

When no list can be served, omnyo provider models prints the failing provider,
the failure code, and the underlying host message on stderr, then reports the
empty catalog on stdout. The model pickers show the same underlying message
beneath their summary line.

A plugin can add one notice to a provider's list, such as "OpenAI used up
until Tue 18:18 · Using openai2@" from the Account Pooler. omnyo provider
models prints it on stderr, and the model picker shows it under the provider
and once in Favorites. The notice disappears after the time it names.

Model picker

The composer's model picker (Mod+Shift+M) opens on a compact grid of favorites,
one row per favorite model with its favorite levels in aligned columns, then All
models; with no favorites it opens on All models. A current choice that is not
a favorite shows as a dashed placeholder where it would go, with a star that
adds it in place. All models, or typing anything, opens the full grid of every
provider's models with the search focused, and Escape steps back to favorites.
Clicking a level switches provider, model, and reasoning in one step and closes
the picker; clicking a model name keeps the current level when the model offers
it, or the closest supported level. Speed is a separate mode: ⚡ beside the
model button turns fast mode on or off and steps Fast, Ultrafast, then off when
a model offers both; choosing another model or favorite keeps the speed when
that model offers it. Search matches model names, ids, and provider names; a
trailing level such as `sol xh` lands on that level, and Enter applies the
highlighted row. Up and Down move through the rows, Left and Right step the
selected row's reasoning live, and Escape closes without a change. Alt+M, Alt+P, and Alt+T still cycle models, providers,
and reasoning; there are no number shortcuts for favorites.

Favorites save provider, model, and reasoning; one saved with a tier from
Settings also applies that tier. Edit, in All models, hides or shows models and
stars or unstars individual levels. On desktop, favorites replace the composer's model button with one
switcher: the current model shows its favorite levels, every other favorite
model is one chip that switches to its favorite level closest to the current
one, and ⌄ opens the full picker, counting any favorites that did not fit. Sent
and queued message editors, side chats, provider- or execution-locked
composers, phones, and the plugin experimental_ProviderModelPicker keep the
model button. A favorite the machine cannot run is dimmed with the reason and
never replaced by a nearby model. In an existing chat, another provider's
favorites appear as new-chat chips and as Favorites rows with a New chat label;
choosing one starts a handoff to a new thread. Hidden models fold under the
provider's "N more" row and stay searchable; hiding never changes defaults or
saved selections.

  omnyo settings ui get modelPicker.favorites
  omnyo settings ui set modelPicker.favorites '[{"providerId":"claude-code","model":"claude-opus-5-5","reasoningLevel":"ultracode"}]'
  omnyo settings ui set modelPicker.hiddenModels '{"codex":["gpt-5.6-sol"]}'
  omnyo settings ui set modelPicker.footerFavorites false
  omnyo settings ui reset modelPicker.favorites

`modelPicker.footerFavorites` (default true) shows the switcher; false keeps
the model button.
Settings → Providers → Favorite models shows favorites as the picker groups
them, with every level as a star to add or remove, and drag to reorder a model
within its provider; Hidden models shows hidden models again. The SDK uses
`sdk.system.uiPreferences.set({ key, value, expectedRevision })`. The
customization chapter lists each key's shape.

Provider-native memory can be controlled on the separate Settings → Providers
→ Codex and Settings → Providers → Claude Code pages. Codex memory controls
both recall (`memories.use_memories`) and future generation
(`memories.generate_memories`). Claude Code memory controls native auto-memory
reads and writes (`autoMemoryEnabled`). Both preferences default on and apply
when a provider thread is started, resumed, or forked; they do not interrupt
an active turn. These settings are separate from Omnyo's optional Memory plugin,
an official plugin bundled with the app.

Provider-native subagents can also be disabled on those provider pages. For
Codex, Omnyo turns off the native multi-agent feature and caps V2 sessions at the
root thread so remote session policy cannot start a child. For Claude Code, Omnyo
removes the native Agent, Task, and ListAgents tools, and a change restarts
Claude before the thread's next turn, preserving the conversation. The
preferences default off and apply when a provider thread is started, resumed,
or forked; they do not modify the provider's global configuration.

Provider failure recovery

The builtin Provider retry plugin is enabled on fresh installations and
recognizes structured Codex and Claude Code subscription windows and provider
overloads. Subscription limits wait for the reported reset plus a short buffer
and jitter. Overloads use exponential backoff and jitter, starting after 5–10
seconds. If the provider accepted the failed input, core sends an agent-only
continuation; if it rejected the input before starting, core re-sends the
original message as agent-only. Prior output or tool activity does not block
recovery. Provider-native retries remain authoritative while the provider
reports that it will retry on its own.

The plugin never blocks a send. It only reacts to a failure, because a
remembered rate limit is a stale picture of the provider's state: if you raised
your plan or the window opened early, the next send simply works. Several
threads on one exhausted subscription therefore each fail once, then each
schedule their own jittered retry. Connection recovery stops after five total
attempts. Models at capacity and unknown account availability use slow
15-minute rechecks; known subscription resets stay scheduled.

Automatic waits default to `No limit`. Explicit `6 hours` and `24 hours`
settings remain in force. Set `maximumWait` under the plugin settings, or run:

  omnyo plugin config provider-retry set maximumWait "24 hours"

  omnyo provider-retry status [thread-id] [--json]    Inspect pending retries
  omnyo provider-retry explain [thread-id] [--json]   Explain the last retry decision
  omnyo provider-retry cancel <thread-id> [--json]    Cancel an automatic retry
  omnyo provider-retry retry <thread-id> [--json]     Send a pending retry now

For Account Pooler routes, the pool supplies the earliest usable account for
the failed request’s model, including parent pools. A generic 429 without a
provider quota snapshot can still schedule a retry. Unknown resets and
unavailable sources schedule slow availability rechecks. Authentication failures
remain paused until sign-in is repaired.
`explain` reports the last recorded decision, including skips; it is historical,
while `status` reports the current queue. Decisions are not backfilled.

A pending retry is a queued row on the thread, so it survives a server restart
and appears above the composer with its reason and time. Credit and
spend-control exhaustion does not reset on a clock, so nothing is scheduled for
it — waiting does not fix it.

Claude Code's native Workflow tool can be disabled separately on its provider
page. This preference also defaults off and applies to newly started, resumed,
or forked provider sessions.

Claude Code's **Allow model fallback** provider setting (`allowModelFallback`)
defaults to `false`. Omnyo keeps the selected model when it is unavailable or cannot
continue. Enable automatic switching with
`omnyo plugin config provider-claude-code set allowModelFallback true`, or turn on
**Allow model fallback** in Settings → Providers → Claude Code. The setting
applies before the next turn and preserves conversation context. A reported
fallback does not change the model selected for later user turns.

Claude Code's **Disable 1M context** provider setting (`disable1MContext`)
defaults to `false`. Enable it with
`omnyo plugin config provider-claude-code set disable1MContext true`.
Omnyo sets `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` when enabled and `0` when off.
Changes restart the thread's Claude process before its next turn, preserving
conversation context.

Claude Code runs without its Claude in Chrome browser tools under Omnyo by
default. Enable them with
`omnyo plugin config provider-claude-code set chromeEnabled true`. The host needs
the Chrome extension and a claude.ai login. A change restarts the thread's
Claude process before its next turn and keeps the conversation.

Claude Code asks questions through the ask-user-question plugin's durable
`AskUserQuestion` tool while that plugin is enabled. The call returns
immediately, the question waits under Needs you, and the chat can go idle so
idle updates are not held. Omnyo redirects Claude Code's own blocking tool to it
outside plan mode; plan-mode questions keep blocking the plan turn.

Claude Code runs Bash commands in its sandbox under Omnyo in Accept Edits and
Approve for me modes. Disable it with
`omnyo plugin config provider-claude-code set sandboxEnabled false` to use Claude
Code's own command approvals and sandbox settings. A change restarts the
thread's Claude process before its next turn and keeps the conversation.

Full Access approves every request Claude Code sends by default. Show Claude
Code's own prompts there (`permissions.ask` rules, PreToolUse hooks that answer
`ask`, and its built-in safety checks) with
`omnyo plugin config provider-claude-code set fullAccessApprovalsEnabled true`.
The change applies from the thread's next turn without a restart.

Known ACP agents can appear automatically when their CLI is installed on the
host. For example, opencode, omp, Grok Build's grok CLI, or Hermes' hermes CLI
on PATH appears as provider acp-opencode, acp-omp, acp-grok, or
acp-hermes-agent.

Omnyo indexes the native user and project skill roots for Codex, Claude Code, Pi,
Cursor, OpenCode, omp, Grok Build, and Hermes Agent. This includes compatibility
roots such as .agents/skills and .claude/skills when the provider supports them.
It also includes project ancestor roots for providers that search to the Git
repository root. Configured Pi, omp, Grok, and Hermes directories are included.
Enabled provider plugins also contribute skills to the selected provider's `/`
command menu. `omnyo skill list` shows native skills for Claude Code, Codex, and
Cursor. A skill file that more than one provider reads (for example under
~/.agents/skills) is listed once as shared, with provider null.

Omnyo launches OpenCode sessions with `OPENCODE_CLIENT=acp` and
`OPENCODE_ENABLE_QUESTION_TOOL=false`, overriding inherited and custom launch
values. Native questions have no ACP interaction handler in Omnyo; agents use the
ask-user-question plugin’s `AskUserQuestion` tool instead. This also applies to
custom agents with `dialect: "opencode"` and does not change OpenCode config files.

ACP providers discover models from the agent itself. For acp-opencode, the
list mirrors the OpenCode catalog, so a custom model from the OpenCode config
appears automatically. Discover and select one with:

  omnyo provider models acp-opencode --environment "$OMNYO_ENVIRONMENT_ID"
  omnyo thread spawn --provider acp-opencode --model <provider/model>

Omnyo applies the selected model to the ACP session before the first prompt.

OpenCode Go quotas appear in Provider usage for the selected machine after
signing in to Go in OpenCode on that machine. Inspect the same five-hour,
weekly, and monthly windows with omnyo settings usage --machine <id-or-name> --json
or api.sdk.system.usageLimits({ hostId, providerId: "acp-opencode" }).
The collector uses OPENCODE_API_KEY, the active Console account in OpenCode's
opencode.db, active v2 credential-table API keys or official Console OAuth credentials
(opencode-go before opencode),
then OPENCODE_AUTH_CONTENT/auth.json under XDG_DATA_HOME (default
~/.local/share), including custom launch env overrides. Database storage is read
only; OpenCode owns refreshing expired sessions.
Custom OpenCode wrappers need dialect: "opencode" and providerUsage: true.
This reports the Go subscription, not usage for other OpenCode providers or
Zen pay-as-you-go spending.

An OpenCode model and an OpenCode agent are different selections. An OpenCode
agent (build, plan, or a custom primary agent such as an orchestrator) is a
session mode, not a model. Omnyo does not select OpenCode agents; configure the
default agent in the OpenCode config and the ACP session uses it.

Top-level customModels in the app data-dir config.json adds extra picker
entries. Each entry has a providerId (a built-in provider id or any acp-*
provider id), a model id, and an optional displayName. Omnyo skips an invalid
entry with a warning. The entry then appears in omnyo provider models output and
in the model picker, but the provider must still accept the id: claude-code
and codex accept unlisted ids, while an ACP agent can reject an id it does
not know at session start. OpenCode rejects unlisted ids, so add an OpenCode
model to the OpenCode config instead. Edit the JSON and run omnyo-app config
refresh; there is no set/unset CLI surface. The streamerMode
General setting hides every entry from these lists; see the customization
chapter.

Custom ACP agents live in the ACP providers plugin's customAgents setting, a
JSON array. Set it with omnyo plugin config provider-acp set customAgents '[...]'.
Each entry needs id (lowercase letters, digits and dashes), displayName, and
command. Omnyo derives provider id acp-<id> from the slug id. The id is permanent.
The id cursor is reserved because Omnyo always lists that agent. The ids opencode,
omp, grok and hermes-agent are not reserved, so an entry with one of those ids
replaces the shipped agent. Use args, env, and cwd for the launch, modelCli
for CLI model listing/selection, reasoningCli for launch-time reasoning flags,
nativeReasoning for ACP session/set_config_option reasoning, permissionCli for
permission-mode launch flags, and dialect (cursor, opencode, omp, or grok) for
the vendor side channels Omnyo reads. Use nativeSkillRoots to add native skills to
the composer.
Give it a user list and a project list. User roots resolve from the target host
home directory. Project roots resolve from the selected workspace. Each root
must use a relative path without dot segments. Set supportsManualCompaction to true only
if the agent accepts an explicit compaction request; it defaults to false, and
Omnyo hides the /compact command for agents that do not declare it. The plugin
re-registers its providers as soon as the setting changes, so no restart or
config refresh is needed.

Use top-level sharedSkillRoots for one provider-neutral skill collection. The
user and project paths use the same relative-path rules. Omnyo indexes these roots
as read-only sources. It then injects the selected skills into all providers.
The Omnyo user and project roots keep higher precedence than matching shared roots.

OpenCode ACP declares support for the built-in /compact command. Cursor ACP does
not expose compatible manual compaction through ACP.
