---
kind: instruction
title: Omnyo Guide — Plugins
summary: Command reference for installing, configuring, running, and authoring Omnyo plugins and their contributed CLI commands.
intent: Provide complete plugin command documentation plus an authoring walkthrough for agents and humans building Omnyo plugins.
editingNotes: Keep flags accurate against the CLI implementation (apps/cli/src/commands/plugin.ts, apps/cli/src/commands/marketplace.ts) and the server plugin service; a CLI test asserts every `omnyo plugin` and `omnyo marketplace` subcommand appears in this chapter. The full authoring reference is the omnyo-plugin-authoring builtin skill.
---

Plugin commands

A omnyo plugin is a TypeScript package that extends the omnyo server in-process and
may also declare one bundled Node entry for enrolled hosts: background
services, cron schedules, HTTP/RPC endpoints, thread lifecycle handlers,
settings, storage, host-local operations — and `omnyo` CLI subcommands that agents
and humans run like any other command. Plugins are full-trust code in both
runtimes.

Plugins are on by default. Builtin plugins (`builtin:<name>`) ship with Omnyo.
Core builtins can be disabled but not removed. The included plugins from Omnyo's
plugin collection can be removed; they stay removed across restarts and updates
until you install them again from Omnyo Official. `omnyo plugin list --json`
reports `removable` for each installed plugin. User-installed plugins come from
`omnyo plugin install` or the official store.
Plugin state lives under `<omnyo-data-dir>/plugins/<id>/` (per-plugin SQLite file,
secrets, logs).

The builtin Prompt Library plugin is disabled by default. Enable it with
`omnyo plugin enable omnyo--prompt-library` or Settings → Plugins. Open **+ → Prompts…**
or press **Ctrl+R** in a composer to search, preview, star, and insert prompts.
`omnyo prompts search [query...] [--project ID | --thread ID] [--json]` searches
history; `omnyo prompts list [--json]`, `omnyo prompts star <text...> [--json]`, and
`omnyo prompts unstar <id> [--json]` manage starred text and mentions. History restores text, mentions, and attachments into an empty composer. Inserting never sends a message.

The builtin Custom instructions plugin adds a multiline editor under Settings
→ Custom instructions. Saved text is persisted on this Omnyo host and included in
agent task instructions; blank text contributes nothing.

The builtin Account Pooler plugin routes explicitly added Anthropic API keys
and Codex accounts. For a Claude subscription, sign in through Claude Code on
the machine that runs the chat and use Claude Code’s `/usage` for quota.
Previous pooled Claude subscription entries remain in the account list for
reference and removal, with routing disabled. Composer Predictions uses Codex for every chat provider.
When a previous Claude chat's pool credential is unknown, use
`omnyo pool bypass <thread-id>` to run it with the machine's Claude Code sign-in.

```
printf '%s\n' "$ANTHROPIC_API_KEY" | omnyo pool account add --provider claude --api-key-stdin
omnyo pool account add --provider codex --login
omnyo pool account login-poll --session <id>
omnyo pool account add --provider codex --import
omnyo pool account list [--json]
omnyo pool account remove <id>
omnyo pool account enable <id>
omnyo pool account disable <id>
omnyo pool account priority <id> <n>
omnyo pool account reorder <claude|codex> <id>...
omnyo pool account refresh <id>
omnyo pool account reset-credits <id> [--json]
omnyo pool account reset <id> --confirm --request-id <uuid> [--credit-id <provider-id>] [--json]
omnyo pool status [--json]
omnyo pool routing <claude|codex> [--off]
omnyo pool config
omnyo pool config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold|parentMode> <value>
omnyo pool token rotate --machine <id-or-name>
omnyo pool bypass <thread-id> [--off]
```

Codex login uses device authorization. The import path reads the Codex login
on the Omnyo server host. Use standard input for Anthropic API keys. The
compatibility option `--api-key <key>` exposes the value in process arguments,
shell history, and agent transcripts.

With an eligible account, the pool gives sessions a provider route and a
machine-scoped token. Codex receives `CODEX_OPENAI_BASE_URL` and
`CODEX_POOL_AUTH_TOKEN` without editing its config file. The hub starts before
accounts are configured, so additions take effect without a reload. Machine
token rotation keeps the prior token valid for ten minutes. The upstream URL
configuration is for verification against controlled test endpoints.

Composer Predictions uses an existing Account Pooler Codex subscription for
every chat provider. It requires fresh included allowance and zero paid credits.
`omnyo composer-predictions status <thread-id> --json` reads the current
prediction. `omnyo composer-predictions diagnostics <thread-id> --json` reads the
last safe failure and skip without requesting inference.

Accounts run sequentially per provider: lower priority numbers first, with ties
following the order accounts were added. New conversations use the current
account until it reaches the switch threshold or fails; the pool then advances
to the next eligible account and wraps at the end. It keeps using that fallback
even when an earlier account recovers. Existing conversations stay pinned while
their account remains eligible. Short temporary rate limits wait on the same
account once; longer holds return Retry-After for pinned conversations while new
conversations can advance. A model-family limit detours only requests for that
family without moving the session's main pin or the provider cursor. The cursor
and session pins survive hub restarts. Session pins expire after 65 idle minutes,
and the pool retains the 4,096 most recently used pins.

Codex can use provider-reported extra usage when allowed. Spending-control and
credit-depletion restrictions block routing. An available allowance does not
indicate current billing activity.

Use the up/down arrows in Account Pooler settings, or
`omnyo pool account reorder <claude|codex> <id>...`, to set the complete order for
one provider. Include disabled accounts too. Reordering changes the next failover
sequence without moving the current account. `omnyo pool account priority <id> <n>`
sets an individual priority; the same operations are available through the
`account.reorder` and `account.setPriority` plugin RPCs.

The builtin Keep Awake plugin prevents macOS idle sleep while Omnyo is running.
Its settings page lets you target all hosts or selected hosts. The CLI
equivalents are:

```
omnyo keep-awake status [--json]
omnyo keep-awake enable [--json]
omnyo keep-awake disable [--json]
omnyo keep-awake hosts all
omnyo keep-awake hosts <host-id>...
```

It reconciles when the plugin starts, a host connects, its configuration
changes, or a worker exits unexpectedly. Disabling the plugin disposes its host
workers and their child processes.

The builtin Concurrency limit plugin controls how many threads run at once.
Its settings page has an optional overall limit and one limit per host. Host
limits default to Auto: one thread per available processor.
Leave an override blank to return it to Auto; use 0 to pause new work. The CLI
equivalents are:

```
omnyo concurrency-limit status [--json]
omnyo concurrency-limit global [unlimited|<limit>] [--json]
omnyo concurrency-limit host <host-id> [auto|<limit>] [--json]
```

The builtin Provider retry plugin is enabled on fresh installations. It retries
Codex and Claude Code turns after structured provider overloads and subscription
window limits. A pending retry is a queued row on the thread, so a server
restart does not lose it, and that row — on the queue card above the composer,
with its reason, time and Cancel — is the durable retry owner. The recovery card
shows its countdown, Continue now and model selection. Inspect it with `omnyo provider-retry status`; use
`omnyo provider-retry explain <thread-id>` for the last scheduling or skip decision.
Pooled rate limits use Account Pooler’s availability even without provider quota
events. See
`omnyo guide providers` for the eligibility rules. The plugin only reacts to a
failed turn — it never blocks a send. Prior output or tool activity does not
block recovery. Its `maximumWait` setting defaults to `No limit`; choose
`6 hours` or `24 hours` from the plugin detail page, or configure it with
`omnyo plugin config provider-retry set maximumWait <value>`.

The builtin Workflows plugin runs durable provider-independent JavaScript
orchestration. It is disabled on fresh installations; enable `workflows` under
Settings → Installed plugins or run `omnyo plugin enable workflows` before using:

omnyo workflows validate (--script '<javascript>'|--source '<javascript>'|
--file <path>|--name <name>)
omnyo workflows run (--script '<javascript>'|--source '<javascript>'|
--file <path>|--name <name>)
[--args '<json>'] [--resume <run-id>]
omnyo workflows status <run-id>
omnyo workflows history <run-id> [--cursor <call-index>] [--limit <1-100>]
omnyo workflows list [--limit <1-50>]
omnyo workflows stop <run-id>

Commands must run from an Omnyo project thread. Workflows has six plugin
settings, configurable with `omnyo plugin config workflows set <key> <value>`:
`maxActiveRuns` (default 4, range 1–32), `maxConcurrentAgents` (8, 1–64),
`maxAgentCalls` (100, 1–1000), `totalRunTimeoutMs` (86400000, 60000–604800000),
`retentionDays` (7, 1–3650), and `maxNotificationBytes` (16384,
1024–262144). `maxActiveRuns` applies live; the other five are snapshotted for
each new run. Settings changes do not require a plugin reload.

`status` is a bounded polling summary, and `list` returns only compact run
summaries. Detailed run and call records are paged JSONL: redirect `history`
into `$OMNYO_THREAD_STORAGE` before inspecting it, and continue with the final
page record's `nextCursor`. The invoking shell writes
that file on the thread's execution host, so this works the same on local and
remote hosts without granting the plugin arbitrary filesystem access. Use `omnyo
provider list --environment "$OMNYO_ENVIRONMENT_ID" --json` and then `omnyo provider
models <provider-id> --environment "$OMNYO_ENVIRONMENT_ID" --json` before writing
an explicit selection; never guess ACP model IDs.

The Memory plugin is an opt-in install, bundled with the app:
`omnyo plugin install memory`. Once installed, it injects a compact global and
current-project memory index into agent context and progressively discloses
full records through CLI-only commands. Because its store works across
providers, we recommend disabling provider-native memory under Settings →
Providers to avoid duplicate or conflicting stores. Settings → Memory lists
every global and project memory and supports version-checked edits and soft
deletion.

omnyo memory catalog [--scope project|global|all] [--json]
omnyo memory search <query> [--scope project|global|all] [--json]
omnyo memory get <id> [--scope project|global|all] [--json]
omnyo memory add --scope project|global --name <name> --summary <text>
--details <text> --reason <text> [--kind <kind>]
[--tag <tag>]... [--importance <0-100>] [--pinned] [--json]
omnyo memory update <id> --expected-version <n> [fields...] [--json]
omnyo memory forget <id> --expected-version <n> --reason <text> [--json]
omnyo memory history <id> [--scope project|global|all] [--limit 1-100] [--json]

Project writes use the invoking CLI's current project. Global writes require
the explicit `--scope global` flag.

The Docs plugin is an opt-in official plugin bundled with the app:
`omnyo plugin install docs`. Read-only discovery remains direct, while edits use
a manifest-backed local workspace:

omnyo docs vaults [--json]
omnyo docs list [--vault <id>] [--json]
omnyo docs read <path> [--vault <id>]
omnyo docs pull <path> [--folder] [--vault <id>] [--into <dir>]
omnyo docs pull --all [--vault <id>] [--into <dir>]
omnyo docs status [workspace-dir] [--delete] [--diff] [--json]
omnyo docs push [workspace-dir] [--delete] [--dry-run] [--diff] [--json]

Pull preserves vault-relative paths and writes `.omnyo-docs-state.json`; edit the
ordinary files and leave that state file untouched. Push uses pulled SHA-256
versions as compare-and-swap guards. Concurrent changes stop with exit 3.
Status exits 0 when no changes exist and exits 4 when changes exist. Exit 4 is
a successful result. Review its output, then run push separately. Do not
connect status and push with `&&`.
Local file and empty-directory deletions are warnings unless `--delete` is
explicit; a pulled folder root is retained, so pull its parent or the whole
vault to remove that folder. Use `--workspace-host <id>` when a standalone
CLI's working directory is not on the server machine. Direct `write`, `mkdir`,
`move`, and `remove` remain only as deprecated compatibility commands.

Docs can also propose revisions without overwriting the saved document:

omnyo docs proposal <path> [--vault <id>] [--json]
omnyo docs propose <path> --file <candidate.md> --expected-sha256 <hash> --version <none|N> [--vault <id>] [--json]
omnyo docs proposal-update <path> --content <markdown> --version <N> [--vault <id>] [--json]
Omnyo docs accept|reject|undo|redo <path> --version <N> [--vault <id>] [--json]

Read the current file and proposal before proposing. Use `none` only when no
proposal exists; otherwise pass its current version. Markdown Docs cards are
editable in the timeline and can open in a tab. Pending proposals show a live
diff for the user to accept, reject, edit, or request further changes.

The Tasks plugin is an opt-in official plugin bundled with the app:
`omnyo plugin install tasks`. It adds a task tracker, agent delegation,
and the `omnyo tasks` command. Common agent operations are:

omnyo tasks show <key-or-id> [--json]
omnyo tasks list [--project <prefix-or-id>] [filters...] [--sort manual|priority|due] [--limit 1-500] [--cursor <opaque>] [--json]
omnyo tasks comment <key-or-id> (--body <markdown> | --body-file <path>) [--json]
omnyo tasks attachment add <key-or-comment-id> --file <path> [--json]
omnyo tasks attachment get <attachment-id> --out <path> [--json]
omnyo tasks attach <key-or-id> [--thread <thread-id>] [--json]
omnyo tasks detach <key-or-id> [--thread <thread-id>] [--json]
omnyo tasks update <key-or-id> --status in_review [--json]
omnyo tasks update <key-or-id> (--parent <parent-key-or-id> | --no-parent) [--json]

Run `omnyo tasks --help` for project, folder, task, label, attachment, and demo-data
commands, plus preset management, delegation, and attached-thread inspection.
Delegated threads are attached automatically; use `omnyo tasks attach` only when
work started outside Tasks, and `omnyo tasks detach` when a thread is done with a
task or a respawned worker replaced it. `omnyo tasks threads <key>` lists live
threads first, newest first. Task update resolves both task keys and IDs for
`--parent`; use `--no-parent` to promote a subtask to the top level. File paths
in tasks commands resolve on the invoking machine (the thread's machine inside
an agent thread, otherwise the server's); pass `--machine <id-or-name>` to
target another enrolled machine.
Task lists default to 100 rows. JSON pages include `nextCursor`; human pages
print the exact continuation option when more rows exist. Cursors are bound to
the filters, sort, and task-list revision. Any add, removal, reorder, update,
label-link/name change, active-thread change, or project-prefix change invalidates an
outstanding cursor; restart without `--cursor` instead of accepting a mixed
snapshot.

The builtin Secrets plugin provides a secure credential form and guarded
dotenv reconciliation:

omnyo secret request <NAME...> --write-env <path>
[--purpose <text>] [--describe <NAME> <text>]...

The command blocks until the user submits or cancels the form. Secret values
never appear in command arguments, model-visible output, or persisted
interaction data; success prints only the path, variable names, and
added/updated/unchanged counts.

omnyo plugin search <query> Search the store: the plugins bundled with
the app plus every registered marketplace
catalog. Results include a Category column
omnyo plugin install <entry> Install a bundled plugin by name or plugin
id (docs, memory, tasks, or an
included plugin you removed),
<entry-id>@<marketplace>, a Git repository
URL, local path, builtin:<name>,
git:<url>[@<ref|semver-range>], or
npm:<package>[@<version|tag|range>]
(installs prompt —
pass --yes to skip). Managed git:/npm:
installs refuse engines.omnyo / engines.omnyoPluginSdk
mismatches, manifest/artifact identity
mismatches, and ids reserved by bundled plugins
Omitted npm specs, ranges, dist-tags, omitted
Git refs, Git branches, and Git semver ranges
track; exact npm versions, Git tags, and Git
commits are pinned
--subdirectory <path> installs one plugin
directory of a multi-plugin git:/path:
repository; --plugin <name> installs the
.omnyo/plugins.json entry with that name
(the two flags are mutually exclusive)
--tag-prefix <prefix> resolves a git: semver
range over <prefix>vX.Y.Z tags
Installing a local path for an id that is
already installed from another local path
moves it there and keeps its settings
Installs run one at a time as server jobs
that continue if the CLI or app disconnects;
a repeat request joins the active job.
--no-wait starts the job and prints its id
omnyo plugin install-jobs List queued, running, and recently finished
installs (--json for the jobs)
omnyo plugin cancel-install <job> Cancel an install: a queued job is dropped;
a running job stops its download or build
and installs nothing, unless it already
started registering, which then finishes
omnyo plugin outdated Check installed plugins for compatible
updates (table; --json for raw results).
Columns: installed, latest compatible,
blocked newer (incompatible releases not
selected), status. Dev builds (Omnyo 0.0.0)
annotate that engines.omnyo is not enforced
omnyo plugin update <id> | --all Apply compatible updates for one plugin or
every tracking plugin with an update. Same
full-trust confirmation as
install (--yes skips; non-TTY refuses without
--yes). Use outdated to preview; pinned
installs stay put
omnyo plugin update <id> --directory <local-runtime> [--replace-active <artifact>] --yes
Upload and activate a prepared bundled
runtime from the CLI machine. One installed
bundled ID only; --all is refused. Keeps
configuration and uses normal rollback.
Refuses a dirty source, a lower version, or a
candidate missing the installed source;
--replace-active names the exact active
artifact (or packaged) to override.
omnyo plugin list Status, services, schedules, handler timings.
`omnyo status` also names enabled plugins that
are incompatible, failed, or missing
omnyo plugin source <id> [--json] Show requested/resolved source, subdirectory,
semver range with its tag prefix and resolved
tag, engine ranges, install time, and recent
activation history
omnyo plugin enable|disable <id> Load or unload an installed plugin
omnyo plugin safe-mode [on|off] Show or change safe mode. `on` stops every
plugin you installed (official store plugins
included) without changing its enabled
setting; plugins included with Omnyo keep
running. `off` restarts the ones that were
enabled and exits 1 if any fail to start.
Installs and updates of stopped plugins are
refused until it is off. Also in the command
palette
omnyo plugin reload [id] Re-run factories against current sources.
Exits 1 when a plugin does not come up on
them (previous instance kept, or degraded
because a service ignored its abort). Naming
a local path plugin that runs a verified
snapshot loads it from its source folder,
keeping its configuration; if it cannot
start there, the snapshot stays. Reloading
all plugins keeps snapshots and lists them
omnyo plugin config <id> [set <key> <value> | unset <key>]
Show or change a plugin's declared settings
omnyo plugin logs <id> [-n N] [-f] Print (or follow) a plugin's api.log output
omnyo plugin run <id> [args...] Run a plugin command explicitly (also works when core owns its name)
omnyo plugin token <id> [--rotate] Print the token for auth:"token" HTTP
routes; --rotate generates a new token,
invalidating the old one
omnyo plugin remove <id> Uninstall and delete the plugin's settings,
secrets, and schedules (managed git:/npm:
files deleted; local path sources stay on
disk). A removed included plugin stays
removed across restarts and updates until
you install it again; core plugins can only
be disabled, and removing one exits 1 with
the server's reason
omnyo plugin prune [--dry-run] [--max-items N] [--max-bytes BYTES]
Delete cached git:/npm: plugin versions no
installed plugin uses (left by earlier Omnyo
releases, rolled-back updates, or
interrupted operations) and leftover cache
directories, and print what was freed.
Updates and removals already delete what
they replace. Never touches a running
version or a local path source. Also in the
command palette
Optional limits select complete removal-root groups under the same registration
lock, preferring larger eligible groups. A group that exceeds either limit
stays intact. Reported cache allocation is not exclusive SSD space reclaimed.
omnyo plugin relocate <from> <to> [--dry-run]
Point local path plugins at a folder that
moved, such as a renamed checkout. <from>
must still lead to <to> through a link.
Verified snapshots are kept; plugins that run
from the folder reload from <to>. Settings,
secrets, and schedules are kept
omnyo plugin new <name> Scaffold a private todo-list plugin and install
its dependencies. The verified private SDK
shipped with the selected runtime is copied
into vendor/ and pinned by archive digest.
No public SDK registry lookup is required.
--event-source instead creates a headless
wait event family, tests and a skill using
the same verified private SDK artifact.
omnyo plugin types [path] Sync the selected private SDK and declared
runtime-shim type dependencies (default: cwd).
--check writes nothing and verifies the local
artifact bytes as well as the manifest pin.
Legacy SDK layouts must migrate first.
omnyo plugin migrate [path] Import legacy metadata, SDK imports and public
SDK symbols into the private Omnyo layout.
Remove legacy tsconfig maps and preserve
declaration bytes in vendor/legacy-plugin-sdk-v1/.
Conflicting identities or archive paths refuse
before writes. Prints the bound plan and asks;
--yes skips confirmation.
omnyo plugin build [path] Compile the plugin into dist/ — the backend
bundle (server.js, server.meta.json); when
omnyo.app is declared, the minified frontend
bundle (app.js, app.css, app.meta.json); when
omnyo.host is declared, the self-contained Node
host bundle (host.js, host.js.map,
host.meta.json recording its digest — host
daemons fetch and verify the bundle by that
digest, and run it as a host RPC worker, a
provider bridge, or both). Each
*.meta.json is stamped with SDK
major/version, artifactFormatVersion,
pluginId, pluginVersion, and builtWith (Omnyo +
plugin SDK versions); no server required
omnyo plugin dev [path] Watch a plugin's sources (default: cwd) and
on every change rebuild its declared frontend
(unminified, for readable stack traces),
host, and provider-bridge bundles, then
reload the plugin; Ctrl+C to stop

omnyo marketplace add <source> Add a marketplace from an https manifest URL,
git:<url>[@<ref>], or path:<directory>. Omnyo
validates the manifest, caches the catalog,
and fetches the entry icons. Adding a
marketplace installs nothing. For a git:
source, --subdirectory <path> reads
marketplace.json from that directory of the
repository instead of its root
omnyo marketplace list Name, source, entry count, and last refresh of
every marketplace (--json for raw rows)
omnyo marketplace refresh [name] Re-read one catalog, or every one of them.
Discovery metadata and icons only — a refresh
never installs, updates, or runs plugin code.
A failed refresh keeps the last catalog Omnyo
validated and exits non-zero
omnyo marketplace remove <name> Forget a marketplace. Its catalog rows and
cached icons are deleted; plugins installed
from it keep running as direct installs and
keep checking for updates from their recorded
source. omnyo-official cannot be removed

Multi-plugin repositories

One repository can hold several plugins. Each plugin directory stays an
ordinary plugin package with its own package.json and Omnyo manifest. An optional
collection manifest at .omnyo/plugins.json indexes them:

{
"$schema": "https://app.omnyo.link/schemas/plugins.schema.json",
"schemaVersion": 1,
"name": "acme-plugins",
"plugins": [
{ "name": "sidebar", "source": "./plugins/sidebar" },
{ "name": "status", "source": "./apps/status" }
]
}

Every source is a repository-relative directory that starts with "./".
Absolute paths, "..", and a source that selects the repository root are
rejected, and so are duplicate entry names and unknown fields. The file is an
index only: identity, branding, entry points, and engine ranges stay in each
plugin's own manifest.

Install one plugin of the repository:

omnyo plugin install git:github.com/acme/repo@main --plugin sidebar
omnyo plugin install git:github.com/acme/repo@main --subdirectory plugins/sidebar
omnyo plugin install path:/work/repo --plugin sidebar

--subdirectory is the primitive and works without a collection manifest.
--plugin resolves a name from .omnyo/plugins.json. Installs from one repository
and commit share a single checkout. When a repository has a collection
manifest, is not a plugin itself, and neither flag is given, the install fails
and lists the entry names. Omnyo records the subdirectory, so outdated, update,
rollback, and remove keep working per plugin.

Omnyo Official plugins

Omnyo's official plugins ship inside the app. The reserved `omnyo-official`
marketplace describes these plugins with the standard v2 format. Its catalog
uses a local path. It never uses the network. `omnyo marketplace list` shows it
first. You cannot add or remove it.

The plugins appear in the first Browse shelf, Omnyo Official. They also appear in
their category shelves. Install a plugin by its bare name or its qualified name.
For example, use
`omnyo plugin install docs` or `omnyo plugin install docs@omnyo-official`. Omnyo copies the
plugin from the app bundle. An app update also updates the packaged copy.
Omnyo Official also lists the included plugins from Omnyo's plugin collection.
After you remove one, Omnyo does not put it back on restart or update; install
it from its detail page or with `omnyo plugin install <name>` to bring it back.
An explicitly activated independent artifact remains selected across restart
and maintenance resume instead of reverting to that packaged copy.

Omnyo stores the last catalog that it validated for every marketplace. An
invalid manifest keeps that catalog. A refresh runs at startup and every two
hours. It changes discovery data and icons only. It never installs, updates, or
runs plugin code. The server fetches and serves entry icons. The detail page
loads screenshots from the URLs that the marketplace declares. An entry can
also carry a long-form markdown description. The detail page renders it below
the short description, and `omnyo plugin search --json` returns it as `overview`.
An install uses the normal git or npm source pipeline. Omnyo records the source
marketplace.

While a plugin that ships installed with Omnyo is installed, it shows a "Built
in" badge in the store and in the Badge column of `omnyo plugin search`; a
listing published in the last 30 days shows "New". The store sorts by name or publication date.

Third-party marketplaces

Anyone can host a marketplace manifest. Add one with its https manifest URL,
with git:<url>[@<ref>] (Omnyo reads marketplace.json from the checkout), or with
path:<directory> on the Omnyo server's machine:

omnyo marketplace add https://plugins.acme.dev/marketplace.json
omnyo marketplace add git:github.com/acme/omnyo-marketplace@main
omnyo marketplace add git:github.com/acme/agent-plugins@main --subdirectory omnyo
omnyo marketplace add path:/work/acme-marketplace

A git repository can keep its catalog in a subdirectory. --subdirectory names
a relative path inside the checkout, with the same rules as
`omnyo plugin install --subdirectory`. Omnyo reads marketplace.json and relative
icons from that directory on every refresh. `source.git.subdir` in a catalog
entry stays relative to the repository root.

The manifest `name` is the marketplace identity. Omnyo refuses a duplicate name.
The `omnyo-official` name is reserved. You cannot add or remove that
marketplace. A third-party marketplace can use manifest v1 or v2. A git or
path marketplace reads icons
from its checkout. An HTTPS marketplace resolves relative icon URLs against
the manifest URL. The server fetches and serves all icons. The detail page
loads screenshots from the URLs that the marketplace declares. Omnyo clones a
git marketplace into a temporary checkout. Omnyo keeps only the validated
manifest and icon bytes.

Omnyo ignores unknown v2 fields, except in npm and git source objects. Omnyo rejects
unknown source keys because a source key changes the installed code.

Install an entry of a specific marketplace with <entry-id>@<marketplace>:

omnyo plugin install thread-hover-cards@acme-plugins

A bare id resolves across every marketplace. Exactly one match installs.
Several matches fail and list the id@marketplace choices. Every other source
form — Git repository URLs, path:, npm:, git:, builtin:, and path-like
syntax — is unchanged and still bypasses catalog resolution.

Before an install from a third-party marketplace, Omnyo resolves and
shows the true source: the npm package with its range or dist-tag, or the git
URL with its ref or semver range, its subdirectory, and the exact release tag
and commit that range currently lands on. The confirmation names the
marketplace and the entry's author. `--yes` skips the prompt, not the
resolution. The same disclosure appears in the app's install dialog, and
Settings → Plugin marketplaces adds, refreshes, and removes marketplaces with
the same server routes the CLI uses.
The install must still match these confirmed source facts. Omnyo refuses the
install when the listing or its resolved git commit changes after confirmation.

Removing a marketplace never disturbs installed code. Each plugin it listed
becomes a direct install that keeps its full source intent and exact
resolution, so `omnyo plugin outdated` and `omnyo plugin update` keep working from
the recorded source. Only the catalog rows and the cached icons are deleted.

The Browse tab groups entries by publisher: Omnyo Official for the plugins
bundled with the app, and each third-party marketplace under its own display
name. Grouping keys on the
marketplace identity, not on the display name, so a marketplace cannot join
another publisher's group by copying its name. Only the reserved marketplace
can use the Omnyo Official label; a third-party marketplace that claims it is
listed under its marketplace name instead. Entry cards show the author.

For direct git:/npm: installs, updates are manual: `omnyo plugin outdated`
checks tracking sources and `omnyo plugin update` applies compatible candidates.
Reinstalling an already-installed managed plugin is refused — use
`omnyo plugin update`. A failed activation restores the pre-update snapshot and
leaves the latest failure visible as needing attention. Exact npm versions,
git tags and commits, path sources, and bundled official plugins are pinned;
npm ranges/omitted specs/dist-tags, omitted Git refs (the repository default
branch), Git branches, and Git semver ranges track compatible updates. A
pinned git:/npm: source changes only through `omnyo plugin remove` (which
deletes the plugin's settings, secrets, and schedules) and a fresh install. A
local path plugin is never removed to change it: edit it in place and
`omnyo plugin reload <id>`, or `omnyo plugin install path:<new dir>` to move it to
another directory; both keep its configuration. `omnyo plugin reload <id>` also
moves a plugin that runs a verified snapshot onto its source folder.

Bundled plugins also accept an explicit prepared runtime. From the source
checkout, run `pnpm exec turbo run prepare:bundled --filter=<plugin-package>`.
Then run `omnyo plugin update <id> --directory plugins/<name>/.bundled-runtime --yes`.
The directory is local to the CLI machine; the command uploads the runtime to
the coordinator and reloads it through the existing update job. Identity,
Omnyo/SDK ranges, prebuilt artifacts and byte digests must pass before replacement.
The CLI also refuses uncommitted changes in `plugins/<name>`, a lower version, and a
candidate that does not contain the installed artifact's source commit. If the
candidate does not descend from that commit, merge it, rebuild and retry. If it does
descend, it removed those paths: restore them. The upload records its source commit in
`dist/omnyo-source.json`, which is added to the uploaded files only. An installed
artifact without that file produces a warning and proceeds. `--replace-active
<artifact>`, with the exact active artifact id or `packaged`, overrides a refusal;
use it only to remove your own live change or for a replacement you were explicitly
told to make.
Settings, secrets and enabled state survive; failed activation restores the
previous state. Managed overrides survive restart and maintenance resume on
the same Omnyo runtime. The first startup on a different Omnyo runtime retires the
override and loads that runtime's bundled copy, so commit the plugin change
before the next release. No core release or Mac build is needed when the
existing runtime supports the candidate. This explicit route does not add a periodic update feed.

Git semver ranges

A git source can track releases the way an npm range does, over the
repository's tags:

omnyo plugin install git:github.com/acme/repo@^1.2.0
omnyo plugin install git:github.com/acme/repo@semver:^1.2.0
omnyo plugin install git:github.com/acme/repo@^1.2.0 --tag-prefix notes/

Omnyo lists refs/tags, keeps the tags named [<tag-prefix>]vX.Y.Z that parse as
semver, and installs the highest one the range allows. Prereleases are
excluded unless the range itself names one (^1.0.0-beta.1), exactly as for an
npm range. Without --tag-prefix the tags are repository-wide (v1.2.3); with
it they version one plugin of a repository (notes/v1.2.3).

Omnyo records the tag it selected and the commit that tag pointed at. If that
tag later points at another commit, Omnyo refuses to resolve it and names both
commits: a released version is not allowed to change under you. Remove and
reinstall the plugin to accept the new commit.

A bare spec that reads as a range (`^1.2.0`, `1.x`, `>=1 <2`) resolves over
tags only when the repository has no branch or tag of that literal name; when
it has both, the install fails and asks you to choose. Write
`@semver:<range>` for the range or `@ref:<name>` for the literal ref. Bare
version tags such as `v1` and `v1.2.3` are always the literal tag.

`omnyo plugin search <query>` matches an id, name, description, category, or tag.
It searches omnyo-official and each other registered marketplace. The output has a
Category column. Status shows installed, compatible, requires newer Omnyo, or
`id in use by <source>` when another installed plugin, such as a local `path:`
checkout, already uses the entry's id.
Install a bundled plugin by its bare entry name or its plugin id; for example,
`omnyo plugin install chime` and `omnyo plugin install chime-local` install the
same plugin. Direct
HTTP(S) Git repository URLs, `path:`, `npm:`, `git:`, and `builtin:`
sources—and path-like syntax—continue to bypass official-plugin resolution.

Builds are automatic once installed. Git installs run `npm install`
(lifecycle scripts disabled), then compile both bundles — so a git plugin may
depend on third-party packages. node_modules is kept, because bundling cannot
inline data files a dependency reads at runtime. A committed dist/ is always
replaced by the bundles Omnyo builds. Path installs compile dist/ at install time
from dependencies you have already installed. A build failure fails the
install. npm packages must ship a metadata-validated prebuilt app or the
install is refused. The server rebuilds source-built apps after an Omnyo upgrade.

Omnyo ships a pinned npm for plugin installation and updates; npm and Node do
not need to be on PATH. Git sources still require `git`. Git installs use
`--omit=dev --omit=optional --ignore-scripts`. Plugins may keep normal
development dependencies in their manifests; npm resolves these but does not
install them.
Checking for updates does not install dependencies: a check reads the candidate's manifest and stops, so
polling never resolves a dependency tree or builds. A candidate that fails to
build is reported as available and fails when you apply it.

Omnyo ships no build toolchain. The first time a git or path plugin is built on
a machine, Omnyo downloads a pinned esbuild + Tailwind set into
`<dataDir>/plugins/toolchain-<versions>/` and reuses it afterwards. Installing
a prebuilt npm plugin never triggers that download.

To build a plugin yourself — in CI, or to check it compiles without a running
Omnyo — depend on the published `omnyo-app` package and call the CLI:

```jsonc
// your plugin's package.json
"devDependencies": { "omnyo-app": "^0.35.1" },
"scripts": { "build": "omnyo plugin build" }
```

`omnyo plugin build` talks to no server. Depending on `omnyo-app@X` builds with
exactly that release's shim configuration, so the bundle cannot be built
against a mismatched host runtime. Cache the toolchain directory in CI to skip
the download on later runs. Only `omnyo plugin dev` needs a running Omnyo, because
it reloads the installed plugin after each rebuild.

The backend half is prebuilt too: when a builtin/official/git/npm install ships
a dist/server.js built for the running SDK major, the server loads it instead
of the TypeScript source. A declared `omnyo.host` is bundled into a self-contained
Node 22 ESM artifact and delivered lazily to the targeted daemon after digest
verification. Host production code may import public
`@omnyo/plugin-sdk` entrypoints, Node APIs, and ordinary dependencies, but no
private `@omnyo/*` workspace packages; the host build rejects direct, transitive,
type-only, and relative imports that resolve into those packages.
Keep the SDK in exact devDependencies: the builder supplies and bundles its
small host runtime, so managed installs and remote workers do not resolve an
SDK package at runtime. That covers the bare `@omnyo/plugin-sdk` import. An
SDK subpath (`@omnyo/plugin-sdk/host`, `/provider-bridge`,
`/provider-bridge/acp`) imported from server or host code is
bundled from the plugin's own installed SDK, so a plugin that imports one
needs the SDK as a real dependency; the build names the missing install
rather than shipping an import Omnyo cannot serve.
Path installs compile server.ts into a versioned Omnyo-owned cache and load the
result with native ESM. The cache follows source, SDK, Omnyo, and Node versions,
so `omnyo plugin dev`/reload sees edits immediately without running the source
transformer on the server event loop.

`omnyo plugin dev` is the edit loop: it requires the directory to already be
installed as a plugin (`omnyo plugin install .` first), ignores dist/,
node_modules/, and .git/, batches saves, and prints one line per cycle. A
build or reload failure prints the error and keeps watching (a failed build
skips that cycle's reload). Reloads reach open app pages live — changed
frontend bundles re-import and their UI slots remount without a page refresh —
and replace host worker generations on their next call.

Frontend entries (app.tsx) default-export `definePluginApp` from
`@omnyo/plugin-sdk/app` and register UI slots: homepageSection (root compose),
settingsSection (per-plugin settings page below the host-rendered settings
form; no props in V1, optional host-rendered title),
navPanel (own navigation rail destination + /plugins/<id>/<path>/* route; the
remainder arrives as the component's subPath prop for panel-internal deep
links; the host always renders the shared plugin title bar and the component
owns a zero-padding full-bleed body, including its scrolling; the optional
experimental_sidebarAccessory field is accepted, but no host surface mounts it
because the rail is icon-only),
threadPanelAction
(a thread-only entry in an existing thread's right-panel new-tab Actions list;
it is never offered on root compose, and its run() can
open closable panel tabs with recursive `JsonValue` params; restored
components read a required `threadId` plus `JsonValue | null`),
experimental_newThreadPanelAction (the root New thread counterpart, with
`projectId: string | null` instead of `threadId`), pendingInteraction (temporarily replace a thread composer with a
plugin form), fileOpener (register as a per-extension file viewer/editor;
users pick defaults under Settings → File openers and can right-click a
file link for a one-off choice), messageDirective (replace a leaf
`::name{k="v"}` block inside assistant / nested-agent Markdown with a plugin
component; unknown, disabled, incomplete, code-fenced, or crashing
directives fall back to the original source; on a one-line registered
directive, Omnyo first repairs quoted values that contain bare or
backslash-escaped quotes, a stray `}"` between attributes or a missing closing
quote, so attributes keep the intended quote characters and `source` shows
them as `&quot;`; components receive a nullable
openWorkspaceFile(path) callback for opening a worktree-relative file in the
host workspace viewer and a nullable
openThreadPanel({ actionId, title?, params? }) callback for opening one of the
same plugin's thread-panel actions), and experimental_codeFenceRenderer
(render fenced code blocks of claimed languages in the same assistant /
nested-agent Markdown with a plugin component receiving { code, language,
status, index, message, Original }, mounted once per fence for the whole
stream; Omnyo's code block is the fallback for a disabled plugin, a language two
plugins claim, and a fence whose component throws). Hooks:
useRpc, usePluginResource (keyed page reads shared across slots, with the
previous result available during refresh), useRealtime, useRealtimeConnectionState (the shared realtime socket's
connecting/connected/reconnecting lifecycle; reconcile on later connected
transitions, not the initial connection), useSettings (secrets excluded),
experimental_useAppContext,
experimental_useAppNavigate (including openUrl(url), which applies the current
client's in-app/external-browser preference, plus
experimental_openFilePreview({ target, location }) and
experimental_openFileExternally({ target, location }) for explicit live
workspace/host/thread-storage files, and experimental_openTerminal({
terminalId }), which shows a terminal created with useSdk().terminals.create
in the current surface's terminal panel), and useComposer (one stable handle for
the bound composer: read its text, mentions, reactive picker selection, scope, layout, run and submit
state, and why submitting is blocked; replace/update/clear text; insert text
and mentions at the cursor or end; apply a class-based text effect, lock input,
quote selections, submit exactly as Enter would, and focus the composer),
and useComposers (a handle for every composer on screen, so a panel can write
into the one the user picks).
Plain-text edits preserve attachments and reconcile only inline mentions
overlapped by the edit. Define RPC methods with `defineRpcContract`
and Standard Schema-compatible input/output validators (Zod works directly),
register via `api.rpc.register(contract, handlers)`, then use a type-only
backend contract import with `useRpc<typeof contract>()` for exact frontend
method/input/result inference. The server validates both schemas and rejects
non-JSON results (including cyclic and non-finite values) with structured
error codes. Components are vendored shadcn source the plugin owns (the
shadcn model): `omnyo plugin new` pre-vendors a starter set into
components/ui/ and `npx shadcn add ./vendor/omnyo-ui/<name>.json` pulls more from the Omnyo
component registry (the full stock shadcn set, version-matched to the
running Omnyo from the registry files bundled with the scaffold). Product capabilities are
the exception: UrlLink renders a real anchor whose ordinary
HTTP(S) activation uses the same client preference as first-party links while
leaving app routes, modifiers, copying, unsupported schemes, and explicit
targets browser-owned. A `_blank` or named target preserves your `rel` tokens
but adds `noopener noreferrer` unless `rel` explicitly contains `opener`.
experimental_FileLink renders a real explicit live-file anchor whose ordinary activation uses the same
preview/file-opener controller as first-party links. Valid targets expose an
encoded, scheme-safe href; traversal paths, ill-formed Unicode, and other
malformed runtime targets are inert in both the app and SDK test harness. Its
lazy context menu adds Open with, preferred-external, installed-app, and copy
actions without reading the file or discovering editors on mount.
experimental_ProviderModelPicker is the controlled
`{ providerId, model, reasoningLevel, serviceTier? }` selector backed by the
same catalog and picker as Omnyo's composers. One click on a reasoning cell, model
name, or favorite emits a complete value from that provider's verified catalog
and closes the picker; the user's favorites and hidden models apply, and
`allowProviderChange={false}` shows only the value's provider. Its optional
`routing` targets a host or existing environment; `disabled` renders the same
selection summary read-only. Tasks presets and Automations use this component
instead of plugin-owned catalog RPCs.
Every `fixedTabs` registration must include `panelId` equal to its
containing nav panel's `id`; it is also an owner-scoped reference. Add
`experimental_target: { validate }` for a typed JSON-safe transient target,
select it with `experimental_useAppPanel().openFixedTab({ surface: { kind:
"current" }, tab, target? })`, and read the target state inside the fixed tab
with `experimental_useFixedTabTarget(tab)`. Target state survives tab, panel,
and route remounts for the current app session; call `clear()` when returning to
the tab's untargeted state. Selection persists across refreshes, but targets do
not. A plugin can address only its own eligible tab on the current nav panel.
`import { toast } from
"sonner"` reaches the host toaster; react, the portaling radix families,
sonner, vaul, @pierre/diffs, and the host-resident clsx, tailwind-merge, and
class-variance-authority libraries are runtime-shimmed (never bundled). Shimmed
does not mean undeclared: tsc resolves their declarations through node_modules,
so each shimmed package a plugin imports is a type-only devDependency at the
host's version — the scaffold declares all of them and `omnyo plugin types`
repins declared packages; unused packages may be removed. Never list one in dependencies, which would bundle a second copy —
though source and diffs should go through the host's own
experimental_SourceCode / experimental_Diff components rather than
@pierre/diffs directly, so Omnyo owns patch normalization, syntax
highlighting, and the live code theme. A Diff caller that has loaded complete
old/new UTF-8 file contents can pass them through
`experimental_fullFileContents` to enable
expand-context controls without exposing Pierre types. Omnyo's original renderer
validates those paths and hunk lines before enabling expansion; a replacement
that implements its own expansion must do the same.
Everything else (zod included) bundles from the plugin's node_modules (`npm install` for authors; Omnyo installs
release packages with their declared production dependencies). A crashing slot collapses to a
"plugin <id> crashed" chip without
touching the rest of the app. Installed plugins and their declared settings
(same data as `omnyo plugin config`) appear under both Settings → Installed plugins
and Plugins → Installed plugins. Both locations manage the same installed plugins.
On a plugin's detail page, the settings button beside the enable switch opens
its settings in place; Plugin details returns to the page. A local plugin's
Source section opens or copies its path.

Plugin CLI commands: a plugin can register one top-level subcommand (for
example `omnyo github …`). Unknown `omnyo` commands are looked up against installed
plugins and proxied to the server, so plugin commands work exactly like core
commands; core command names always win. A collision logs an activation warning,
and `omnyo plugin list` shows the required `omnyo plugin run <id>` form. Inside agent
threads the generated `plugin-commands` skill lists the available plugin commands.

Settings changes do not auto-reload a plugin — run `omnyo plugin reload <id>`
after configuring. Add --json to plugin commands for machine-readable output.
Plugin CLI stdout plus stderr is capped at 1,048,576 UTF-8 bytes from the
shared `@omnyo/plugin-sdk` constant. Results above the ceiling are rejected in
full with a structured `plugin_cli_output_too_large` error; output is never
silently clipped. Page growing collections and use file/streaming commands for
large content.

Authoring a plugin

The loop: `omnyo plugin new <name>` scaffolds `./omnyo-plugin-<name>` — a working
todo list with a backend, a sidebar page, a `omnyo <name>` command, and a skill;
delete what you do not need; `omnyo plugin new <name> --event-source` creates a
headless wait event family for `omnyo wait --event`; `omnyo plugin install .` registers it; `omnyo plugin
dev` watches and reloads on every save. The manifest is package.json: required
`omnyo.name` and `omnyo.description` human identity, required `omnyo.branding` with at
least `icon` or `logo.light`, `omnyo.server`
(backend entry, loaded as TypeScript — no build step), optional `omnyo.app`
(frontend entry), optional singular `omnyo.host` (full-trust Node entry run by
targeted enrolled daemons), optional `omnyo.skills` (static skill directories auto-imported
into agent threads unless filtered by `api.agents.configure`; default
`skills/`), `engines.omnyo` (supported Omnyo range),
and optional `engines.omnyoPluginSdk` (the lowest plugin SDK you need, read as a
floor rather than a ceiling; scaffolding uses the selected runtime's SDK floor). Use
`omnyo-plugin-hello` for the package name by
default. Scoped names such as `@acme/omnyo-plugin-hello` are also supported. The
plugin id is the final package-name component minus `omnyo-plugin-`, so both forms
use `hello`.

The scaffold also writes `PLUGIN_OVERVIEW.md` beside package.json: the
long-form store listing, shown in an Overview section under `omnyo.description` on
the plugin detail page in the app. It says the same thing as
`omnyo.description` at length, so update both together. Keep it under 4000
characters, use headings, paragraphs, emphasis, code, blockquotes, lists,
thematic breaks, and absolute https links only, and do not open with a `#`
title. A submission to upstream bb's community marketplace requires the file.

Plugins can contribute palettes with `omnyo.themes`: an array of
`{ id, name, description?, css, codeTheme? }`, where `css` is a
plugin-relative `.css` file and optional `codeTheme` is
`{ dark?, light? }` (a bundled Shiki / Pierre name or a plugin-relative
VS Code theme `.json`). Loaded plugin palettes appear in Settings →
Appearance and `omnyo theme list`; their selectable id is
`plugin:<plugin-id>:<theme-id>`. Disabling or removing the owning plugin
makes Omnyo fall back to the default palette.

Branding is explicit. Declare `omnyo.branding.icon` as either the plugin's
canonical Omnyo icon name or a plugin-relative compact SVG such as
`./assets/icon.svg`. Omnyo validates and hash-serves path-shaped SVGs, then
renders them as masks that inherit the surrounding text color. Compact chrome
prefers the manifest icon, then a contribution's local icon hint, and finally
Zap. Roomy surfaces reuse the same icon when no logo override is declared.

Add `omnyo.branding.logo.light` only for intentionally different rich/full-size
identity artwork; optional `omnyo.branding.logo.dark` is preferred in dark mode.
Logo paths must be plugin-relative `.svg`, `.png`, or `.webp` files.
`omnyo plugin build` refuses an SVG logo that carries a script vector (a
`script`, `handler` or `listener` element, an `on*` attribute, or a
`javascript:` href) and takes any other tool export as-is; install and load
never refuse a logo, and every SVG Omnyo serves carries `nosniff` and a
`default-src 'none'` CSP. Root logo files are not auto-detected, and a dark
logo requires a light logo. Logo-only
manifests remain supported for compatibility, so at least an icon or light logo
is required. Do not duplicate the same artwork across fields. Omnyo rejects nulls,
empty strings, missing or escaping assets, and unsupported extensions. Reload
the plugin to pick up branding changes.

The backend entry default-exports a factory receiving the full plugin API:

import type { PluginApi } from "@omnyo/plugin-sdk";
export default async function plugin(api: PluginApi) { ... }

The selected Omnyo runtime ships a verified private SDK archive. Scaffolding
copies its exact bytes into vendor/ and records a digest-bearing local file
pin in devDependencies. Keep that archive with the plugin source so a clean
consumer can install the same declarations without a core checkout or public
SDK registry publication. Read node_modules/@omnyo/plugin-sdk/bundled-types/
omnyo-plugin-sdk.d.ts and its app/host siblings for exact signatures.

`omnyo plugin types` verifies the selected runtime artifact, copies it locally
and syncs declared runtime-shim type dependencies. `--check` writes nothing and
fails for a stale pin, missing artifact or changed bytes. Unused shim packages
are optional; declare packages imported by the plugin.

The finite legacy layout importer is `omnyo plugin migrate`. It accepts the
recorded @get-bb/plugin-sdk and @bb/plugin-sdk package identities, converts
metadata and source-bound imports, removes their tsconfig maps, and preserves
original declaration bytes under vendor/legacy-plugin-sdk-v1/. User bindings,
prose, unknown files and plugin IDs remain intact. Differing dual identities,
malformed source and archive collisions refuse before mutation. The command
prints a content-bound plan and asks before applying it; --yes selects that
same checked migration without a prompt. Run pnpm install afterward.

Need a symbol the types do not explain? The selected upstream remains useful.
Clone the repo: https://github.com/get-bb/bb. The API in
one line each — api.log (plugin-scoped logger behind `omnyo plugin logs`);
api.settings.define (declarative settings incl. secrets, editable via
`omnyo plugin config`); api.storage.kv (JSON rows ≤256KB) and
api.storage.database()+migrate (the plugin's own database); api.sdk (the full
Omnyo SDK — handlers/services only, not the factory; spawned threads are
attributed to the plugin; `visibility: "hidden"` creates directly addressable
background workers omitted from sidebar organization and unread/pending
favicon attention, with other behavior unchanged; a child thread inherits
its parent's visibility and still notifies that parent; plugins must archive
finished hidden workers when appropriate and call `threads.stop` in a
`finally` block to release each agent runtime promptly);
api.events.on (observe thread.created/idle/failed/deleted);
api.http.route (routes under /api/v1/plugins/<id>/http/* with
local/token/none auth); defineRpcContract + api.rpc.register (Standard
Schema-validated frontend data plane with inferred backend handlers and
type-only frontend method/input/result inference);
defineRpcContract + api.hosts.experimental_client (typed calls, typed ephemeral
host signals, and unexpected-worker-exit notifications to the plugin's own
`omnyo.host` entry; the host context also provides plugin-scoped data/temp paths
and daemon-owned native file watching; active calls and watches retain the
lazy worker automatically, while independent background work can hold an
explicit `experimental_retainWorker()` lease; the host entry uses
experimental_defineHostEntry from
`@omnyo/plugin-sdk/host` and can be unit-tested with
experimental_createHostEntryHarness from
`@omnyo/plugin-sdk/testing/host`);
api.realtime.publish (ephemeral signals to open app pages);
api.background.service (long-lived, AbortSignal, restart w/ backoff) and
api.background.schedule (durable cron rows); api.cli.register (a top-level
`omnyo <name>` command agents run through bash, with a shared 1 MiB combined
stdout/stderr ceiling and atomic structured over-limit errors); api.agents.registerTool
(static native tools with zod or JSON-schema parameters) and
api.agents.configure (one synchronous per-resolution callback selecting this
plugin's own tool/skill ids and optional dynamic instructions; tools apply on
the next provider session start/resume, while busy skill runtimes defer catalog
changes); api.ui
registerMentionProvider (host-rendered UI — no
frontend bundle needed); api.status.needsConfiguration (report
"unconfigured" instead of crashing); api.onDispose (LIFO cleanup on
reload/disable/shutdown).

Frontend entries register React slots (homepageSection, settingsSection,
navPanel, threadPanelAction, experimental_newThreadPanelAction, fileOpener,
messageDirective, experimental_codeFenceRenderer) and composer
customizations via `app.composer.customize({ actions, plusMenu, sendMenu,
banners, richText })`; action/banner components use `useComposer()`, while the
host renders plus-menu and send-menu rows and editor decorations. The deprecated pre-1.0 `slots.composerAccessory` footer API was
removed; migrate controls to actions or the plus menu and larger content to
banners. Register all frontend surfaces via
definePluginApp, use the hooks
listed above, and render vendored components; styling is Tailwind against
the host theme's tokens only (semantic classes like bg-background and
tw-animate-css utilities compile in plugin builds).

For the complete authoring reference — exact signatures, working snippets
for every surface, the reload lifecycle, testing tips, and gotchas — use
the built-in `omnyo-plugin-authoring` skill (agents: it loads on demand;
humans: plugins/omnyo-guide/skills/omnyo-plugin-authoring/
in a checkout). The builtin `inline-vis` plugin shows an HTML page as part
of the reply, in a borderless sandboxed frame that follows the page's height
and Omnyo's theme. The page comes from `::inline-vis{file="demo.html"}` (a
workspace or thread-storage file; an optional `height` caps the frame) or
from a fenced `inline-vis` code block whose body is the page. A button that
appears on hover opens the file in the sidebar, or reveals a block's source.
The `plugins/` directory contains the core builtins and the store-only Omnyo
Official Docs, Memory, Tasks and Theme Preview plugins. The included plugins from
Omnyo's plugin collection are built from their own repository. The
`examples/plugins/` reference plugins cover slack-bot (webhook bot),
agent-enrichment (agent surfaces), and composer-customization (all composer
regions).

Modal setup uses `omnyo modal account inspect --json` to check credentials, then
`omnyo machine create --provider modal-sandbox --json` to create a
machine. Settings edits its shared Dockerfile; `omnyo modal image set --file PATH [--json]` saves it and `omnyo modal image reset [--json]` restores the bundled default for future machines; `omnyo modal image show [--json]`
reads the same file without cloud access. The image builds automatically and is reused across projects;
core installs the daemon on demand. Project dependencies and services belong in
`.omnyo-env-setup.sh`. Read the plugin's skill for connection and lifecycle details.

Contributed commands may accept `--stdin`: the calling CLI transfers up to
256 KiB of multiline text as `--input-text`, without reading server-local files.
The existing `--<flag>-stdin` form still accepts one line.

Modal image debugging: `omnyo modal image build [--json]` prepares the saved image; `omnyo modal sandbox run [--json]` starts a 30-minute standalone sandbox; `omnyo modal sandbox exec ID [--json] -- COMMAND...` runs a command (60-second timeout); `omnyo modal sandbox stop ID [--json]` cleans up. These debug sandboxes skip Omnyo enrollment, clone and setup. Logs are returned after the build finishes.

## Inspect plugin RPC

`omnyo plugin rpc list [plugin-id] [--method <exact-name>] [--json]` lists discoverable methods from running plugins, optionally restricted to one plugin. `omnyo plugin rpc inspect <plugin-id> [method] [--json]` dumps registration and method descriptions plus input/output JSON Schemas. Copy the relevant schema into your consumer and call the existing plugin RPC endpoint. Discovery is opt-in advertising, not access control; method names may carry versions such as `provider-usage.v1.listResources`.

`omnyo plugin rpc call <plugin-id> <method> [--input-file <json-path>] [--json]` invokes a method using server-side schema validation. Omitting the input file sends JSON null. Input files avoid putting sensitive values in command arguments.

### Background updates

`omnyo plugin update <id> --yes` starts a server job and waits by polling, so the activation stability check does not hold one HTTP request open. Add `--no-wait` to return immediately. Use `omnyo plugin update-jobs [job-id] --json` for progress and results, including automatic rollback. Queued/running updates continue after the CLI or app disconnects. Finished jobs remain for ten minutes; jobs do not survive server restarts. Running updates cannot be cancelled midway through activation.

SDK: `plugins.applyUpdate({ pluginId })` waits; `plugins.experimental_startUpdate({ pluginId })` returns the job. Inspect with `plugins.experimental_updateJobs.list()` or `.get({ jobId })`. Raw HTTP callers opt in with `Prefer: respond-async`; legacy callers still receive the completed result.

For an explicit bundled update, both SDK methods accept `bundledCandidate`
with the expected installed version, expected active artifact ID and file
records containing relative paths, base64 bytes and SHA256 digests. The server
rejects stale registrations, unsafe paths, duplicate files and oversized input.
