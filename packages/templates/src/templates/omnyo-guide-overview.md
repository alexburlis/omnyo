---
kind: instruction
title: Omnyo Guide Overview
summary: System overview and chapter index for the Omnyo CLI guide.
intent: Orient agents to Omnyo core concepts and help them find the right guide chapter.
editingNotes: Keep this concise. Concepts only — command details belong in chapter files.
---
Omnyo is an agent orchestration tool for managing multiple agents.

Core concepts:

- Project — maps to a repository. All threads belong to a project.
- Thread — a single agent conversation. The fundamental unit of work.
- Environment — where a thread runs. Kinds: project checkout or isolated worktree. Multiple threads can share an environment.
- Machine — an execution host where project sources and thread environments live.
- Terminal — a persistent PTY session scoped to a thread, environment, or machine path. Use terminals for long-running commands such as dev servers.
- Preview — a registered local server with an exact launch recipe, private remote access, observed readiness and duplicate-safe restart.
- Provider — the agent backend powering a thread (e.g., codex, claude-code). Each provider supports different models.

Threads can have a parent-child relationship. The parent coordinates the child, answers its questions in place of the owner, and receives lifecycle notifications when it completes, fails, or is interrupted. Threads without a parent are managed directly by the user.

Context variables set automatically inside a thread environment:

- OMNYO_PROJECT_ID — current project
- OMNYO_THREAD_ID — current thread
- OMNYO_ENVIRONMENT_ID — current environment
- OMNYO_CLI — absolute path to the daemon-managed `omnyo` executable (prefer this if bare `omnyo` is wrong; official entrypoints also re-exec to it)

Core omnyo commands send OMNYO_THREAD_ID, and a script automation's
OMNYO_AUTOMATION_ID and OMNYO_AUTOMATION_RUN_ID, with every request. The server
treats those calls as an agent or an automation, never the owner, so
owner-only actions such as Inbox moves refuse them.

The CLI target is the explicit OMNYO_SERVER_URL, repository development defaults
when supplied, or the saved serverUrl in OMNYO_DATA_DIR/config.json (otherwise
~/.omnyo/config.json), in that order. Only a missing saved selection defaults to
http://127.0.0.1:38886. Invalid overrides or saved config fail visibly.
OMNYO_HOST_DAEMON_PORT keeps its separate defaults.

Run `omnyo status` to see your current context (resolved project and thread IDs).
It also warns when an enabled plugin is not running (incompatible after an Omnyo
upgrade, failed to load, or missing); run `omnyo plugin list` for the detail.

All commands support --json for machine-readable output. With --json a failure
prints `{"ok": false, "error": {code, message, hint}}` on stdout; `omnyo guide json`
lists the output shape of each command.

Browse skill packs, prompts, workflows, plugins and guides with
`omnyo explore [--type prompt|workflow|skill|plugin|guide] [--query <text>]`. Pass a key
such as `prompt/review-a-product-update` for one item, and add `--text` to print
that prompt's exact text. Unlike other core commands, `omnyo explore` talks to
https://omnyohq.com, not the coordinator, and sends none of the thread or
automation headers above.

Browse the public source-skill library with `omnyo explore skills [--query <text>]
[--json]`. Each result identifies its publisher, license, reviewed revision,
source URL, and detail page. Search matches every word across the skill slug,
title, publisher, category, summary, and keywords. This reads the public catalog;
it does not install or execute a skill.

Browse skills, workflows and connectors together with `omnyo explore marketplace
[--type skill|workflow|connector] [--query <text>] [--category <category>]
[--publisher <publisher>] [--json]`. Category and publisher filters match exact
values. Search matches every word across the slug, title, summary, publisher,
category and keywords. Results link to setup or source details; browsing installs
nothing.

Pass long or multi-line text from a file, not inline: `omnyo thread tell <id>
--message-file <path>` and `omnyo thread spawn --prompt-file <path>` (use `-` for
stdin). Inside double quotes the shell runs `backticks` and `$(...)` before Omnyo
sees the message.

Transcribe audio files, such as attached voice memos, with `omnyo voice transcribe
<path>`. It uses the voice service chosen with `omnyo settings ai-services`;
`omnyo guide customization` lists its size limits.

When a command fails, read the whole error: Omnyo prints the nearest command or
option, the flag to add with the current project, thread, or machine ID filled
in, and the usage line. `omnyo guide commands <group>` lists every command in a
group with its options on one page.

To make a repo work with Omnyo worktrees, run `omnyo guide environments` for the
repo-level `.omnyo-env-setup.sh` and `.omnyo-env-teardown.sh` hooks. Run `omnyo guide
agent-configuration` for the data-dir and workspace files that customize agent
behavior.

Run `omnyo guide <chapter>` for command details:

  threads              Spawning, inspecting, messaging, and managing threads
  environments         Environment lifecycle hooks, operations, commits, and merges
  agent-configuration  AGENTS.md and skills files that shape agents
  providers            Discovering providers and models
  projects             Project CRUD and sources
  machines             Listing and targeting execution machines, moving the
                       server
  terminals            Persistent PTY sessions across all supported scopes
  previews             Managed preview links, readiness and recorded restart
  browser              Experimental built-in browser tabs and control leases
  customization        Theming the app palette, settings, mobile push
                       notifications
  plugins              Installing plugins, plugin marketplaces, and their
                       contributed Omnyo commands
  automations          Scheduling and editing recurring or one-shot work
  json                 The --json contract: output shapes and the error envelope
  commands [group]     Every core command on one page; add a group for options

Omnyo profile migrations use an installer-owned `stateMigration` binding in
the runtime configuration. Startup refuses an invalid journal before admitting
profile writes. Do not remove the binding to force a downgrade; use the
migration owner's recovery route. See `docs/configuration.md` in source.
