---
kind: instruction
title: Omnyo Guide — Agent Configuration
summary: User and workspace files that customize agent instructions and skills.
intent: Document the user and workspace files that shape agent behavior for threads.
editingNotes: Keep accurate against the server's agent-instructions reader and skill loader.
---
Agent configuration

Omnyo reads agent configuration from the app data dir and from a project's .omnyo/
directory. These files shape how agents behave in provider-backed threads.
The journaled workspace prepare step imports legacy `.bb` data into `.omnyo`
before context reads. Conflicting or malformed roots stop preparation.

User instructions (<dataDir>/AGENTS.md):

  Add an AGENTS.md file to the Omnyo data dir (usually ~/.omnyo/AGENTS.md) to give
  every provider-backed thread across all projects default user-level
  instructions. Omnyo reads <dataDir>/AGENTS.md and appends its contents to the
  thread system prompt for all providers when a provider session starts.

Workspace instructions (.omnyo/AGENTS.md):

  Add a .omnyo/AGENTS.md file to a workspace to give every thread that runs there
  repo-specific instructions. Omnyo reads <workspace>/.omnyo/AGENTS.md and appends its
  contents to the thread system prompt for all providers, after any
  <dataDir>/AGENTS.md instructions, when a provider session starts. Track it with
  git so fresh managed worktrees include it.

  Only the plural AGENTS.md is read, only from the exact data-dir and
  workspace-root .omnyo/ locations above (Omnyo does not walk parent directories), and
  an empty file is ignored. This is Omnyo's own provider-agnostic instruction
  injection, separate from provider-native instruction files. Codex reads a
  repo-root AGENTS.md. Claude Code 2.1.277 and later also reads AGENTS.md when
  no project or ancestor CLAUDE.md or CLAUDE.local.md takes precedence. Older
  Claude Code versions and sessions without its built-in AGENTS.md support
  still require CLAUDE.md.

Skills (.omnyo/skills/):

  A skill is a reusable instruction file that Omnyo injects into a thread and
  exposes to the agent as a slash command. Place project skills under
  .omnyo/skills/<name>/SKILL.md in a workspace. Each SKILL.md has YAML frontmatter
  with `name` (lowercase, hyphenated, matching the directory) and `description`,
  followed by the instruction body.

  Omnyo resolves skills from three sources, in increasing precedence:

    plugin     Skills from enabled plugins, including the bundled Omnyo guide.
    user       <dataDir>/skills (e.g. ~/.omnyo/skills).
    project    <workspace>/.omnyo/skills.

  A project skill overrides a user or plugin skill with the same name. Two
  skills with the same name within one source collide and are both dropped.

  Use `omnyo skill list` to inspect installed and discovered skills and copy the
  opaque skill ID. `omnyo skill show|files <skill-id>` reads that exact skill;
  `omnyo skill show <skill-id> --json` returns the revision required by `omnyo skill
  update <skill-id> --revision <sha256>`. `omnyo skill delete <skill-id>` and
  update are restricted to editable, user-owned skills. These workspace-scoped
  commands default to `OMNYO_PROJECT_ID`, then the personal project; pass
  `--project` or `--environment` when a different workspace is required.

  When Skills is enabled, use `omnyo skill-discovery catalog-search`
  to search its shipped curated catalog. `catalog-review` previews the exact
  files and workspace, and `catalog-confirm` installs the reviewed digest.
  `catalog-prepare` returns the reference for one-time use in a draft.

  Use `omnyo skill-discovery pack-review --file /absolute/path/skill.md` to
  review Markdown or a `.omnyoskillpack` before installing. For a Marketplace
  skill, pass `--marketplace --slug SLUG --digest SHA256`. Confirm with the
  returned review ID and digest using `pack-confirm --review ID --digest SHA256
  --yes`. Use `omnyo skill show <skill-id> > skill.md` to export an exact source.

  Use `omnyo skill search` to browse skills.sh. The result reports search
  coverage. Stage an exact registry ID with
  `omnyo skill registry stage <registry-skill-id>`. Use
  `omnyo skill registry stage-file <registry-skill-id> <digest> <path>` to read
  an included text file. Install the reviewed tree with
  `omnyo skill install <registry-skill-id> --digest <digest>`. Without
  `--digest`, install stages and adds the skill in one call. The destination
  is Omnyo’s skill library on the coordinator.

  Use `omnyo skill install-cli-skills` to copy Omnyo's built-in CLI skills into a
  machine's global agent skill roots (`~/.agents/skills` and
  `~/.claude/skills`) so agents running outside Omnyo can drive it. It installs on
  every connected machine unless you pass `--machine <id-or-name>`, which is
  repeatable. Settings → Skills exposes the same action; it asks which machines
  only when more than one is enrolled. Machines install independently, so the
  command reports each machine's outcome and exits non-zero if any failed. The
  install replaces a previously installed copy of the same skill and leaves
  other skills alone. `omnyo skill cli-skills-status` reports whether each machine
  is installed, out of date, missing, or unknown (disconnected or unreachable);
  the settings row shows the same as a badge.

  Use the skill-creator skill to author and iterate on skills.

Omnyo guide plugin:

  The enabled-by-default Omnyo guide plugin owns the Omnyo introduction and the
  omnyo-cli, omnyo-plugin-authoring, and skill-creator skills. Settings → Installed
  plugins → Omnyo guide exposes introduction, a master skills switch, and one
  switch per skill. All default to true. Use:

    omnyo plugin config omnyo-guide set introduction false
    omnyo plugin config omnyo-guide set skills false
    omnyo plugin config omnyo-guide set omnyoCli false
    omnyo plugin config omnyo-guide set pluginAuthoring false
    omnyo plugin config omnyo-guide set skillCreator false

  Changes apply when agent configuration is next assembled. They do not erase
  existing conversation text or disable independently installed copies.

Connect agent instructions:

  Settings → Installed plugins → Connect → Tell agents about remote access
  controls the message telling remotely used agents to expose public server
  links. It defaults to true and still requires active/recent remote usage.
  Use `omnyo plugin config connect set sendRemoteInstructions false` to turn it
  off. Port sharing remains available.

Private desktop updates:

  A private macOS desktop reads private-updates.json beneath Electron userData.
  Missing or disabled configuration keeps updates off. Schema1 enabled=true
  requires the installed channel and a non-secret HTTPS directory URL; no
  headers, PATs, URL userinfo/query/hash or GitHub release URLs. Local
  preparation configures no live feed. Settings → Updates invokes the desktop
  bridge; omnyo updates app targets the server separately. Remote-only desktop
  updates never hold or stop the shared remote coordinator. Compatible signed
  replacement boot must release only its exact durable handoff owner.

  A completed server-update cancellation reports cancelled rather than failed.
  Healthy startup acknowledges an older failure only when the exact target
  revision is now running; its diagnostics remain stored. Restart failures and
  unresolved maintenance holds still require recovery.
