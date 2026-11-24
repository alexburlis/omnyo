# Plugin management commands

## Plugins

- A omnyo plugin is a TypeScript package running inside the Omnyo server, extending
  it with services, schedules, HTTP/RPC endpoints, settings — and `omnyo` CLI
  subcommands that agents run through bash like any other command.
- Use `omnyo plugin list` to inspect installed plugins and their current state.
- **Omnyo plugin catalog** (store under `/api/v1/plugin-catalog`):
  - The reserved **Omnyo Official marketplace** has the name `omnyo-official`. It
    describes all plugins in the app bundle with a generated v2 document.
    Its source is a local path. It never uses the network. It appears first in
    `omnyo marketplace list`. Its plugins appear in the first Browse shelf, Omnyo
    Official, and in their category shelves. It can be neither added nor
    removed.
  - Every other marketplace is one you add (below). The server re-reads each
    one at startup and every two hours. A refresh only updates discovery
    metadata and icons; it never installs, updates, or runs plugin code, and a
    failed refresh keeps the last catalog Omnyo validated.
  - `omnyo plugin search <query> [--json]` — search the catalog by id,
    name, description, category, or tag; status shows installed / compatible /
    requires newer Omnyo / id in use by `<source>` (another installed plugin, such
    as a local `path:` checkout, already uses the entry's id). The table includes a **Category** column. Omnyo
    shows no install counts (`installs` is null in `--json`). With
    `--json`, `overview` holds the entry's long-form markdown description when
    the marketplace publishes one; the detail page renders it below the short
    description.
- **Third-party marketplaces** (routes under `/api/v1/marketplaces`):
  - `omnyo marketplace add <source>` — add a marketplace from an https manifest
    URL, `git:<url>[@<ref>]` (Omnyo reads `marketplace.json` from the checkout),
    or `path:<directory>`. The CLI resolves a relative path from its current
    directory before it sends the request. For a `git:` source,
    `--subdirectory <relative-path>` reads `marketplace.json` and relative
    icons from that directory of the repository instead of its root; Omnyo stores
    the subdirectory and reuses it on every refresh. Omnyo validates the
    manifest, caches the catalog, and fetches its icons. **Adding a
    marketplace installs nothing.** The manifest's own `name` is the
    marketplace's identity, so a name collision is refused. The `omnyo-official`
    name is reserved; you can neither add nor remove it.
    A third-party manifest can use v1 or v2. The server serves its icons.
    The detail page loads screenshots from the declared URLs.
    Omnyo ignores unknown v2 fields, except in npm and git source objects. Omnyo
    rejects unknown source keys because a source key changes the installed
    code.
  - `omnyo marketplace list [--json]` — name, source, entry count, last refresh.
  - `omnyo marketplace refresh [name] [--json]` — re-read one catalog or every
    one of them. Discovery metadata and icons only. A failed refresh keeps the
    last catalog Omnyo validated and exits non-zero.
  - `omnyo marketplace remove <name> [--json]` — forget a marketplace. Its
    catalog rows and cached icons are deleted; every plugin it listed keeps
    running as a direct install with its full source intent and exact
    resolution, so `omnyo plugin outdated`/`update` keep working from the
    recorded source.
  - Install a specific marketplace's entry with
    `omnyo plugin install <entry-id>@<marketplace>`. A bare entry id resolves
    across every marketplace. Exactly one match installs. Several matches fail
    and list the `id@marketplace` choices.
  - A third-party marketplace install first resolves and
    prints the true source — npm package with its range or dist-tag, or git
    URL with its ref or semver range, subdirectory, and the exact release tag
    and commit that range currently lands on — plus the marketplace and the
    entry's author. `--yes` skips the prompt, not the resolution. The install
    fails if the listing or its resolved git commit changes after confirmation.
  - Install a bundled plugin by its bare name, its plugin id, or
    `<entry-id>@omnyo-official`. Omnyo copies it from the app bundle. The same
    command reinstalls an included plugin that you removed, for example
    `omnyo plugin install chime` or `omnyo plugin install chime-local`.
- Commands:
  - `omnyo plugin install <src>` — `<entry-id>@<marketplace>`, an HTTP(S) Git
    repository URL, a local path,
    `git:<url>[@<ref|semver-range>]`, or `npm:<package>[@<version|tag|range>]`
    (using Omnyo's shipped npm). Repository URLs and prefixes `path:` /
    `npm:` / `git:` skip catalog resolution. To pin or
    range an npm package, install with `npm:<package>@…`.
    Omit the npm spec to track compatible stable releases; ranges and dist-tags
    track, while exact versions are pinned. Omit the Git ref to track the
    repository's default branch; explicit branches track, while tags and
    commits are pinned. A Git semver range
    (`git:github.com/acme/repo@^1.2.0`) tracks the repository's `vX.Y.Z` tags,
    picking the highest release the range allows and excluding prereleases
    unless the range names one. `--tag-prefix <prefix>` ranges over
    `<prefix>vX.Y.Z` tags instead, for a repository that versions each plugin
    on its own. Omnyo records the selected tag and its commit and refuses to
    resolve that tag again if it moved. A bare spec that reads as a range
    resolves over tags only when no branch or tag has that literal name; when
    both exist the install fails — write `@semver:<range>` or `@ref:<name>`.
    Installs prompt for confirmation (plugins are full-trust code);
    pass `--yes` to skip. Reinstalling an already-installed managed plugin is
    refused — use `omnyo plugin update`. Installing a local path for an id that
    is already installed from another local path moves the plugin to the new
    directory and keeps its settings, secrets, and schedules. Plugins that
    declare a frontend (`omnyo.app`) are built at install time for path sources
    and git sources without a prebuilt app when their imported dependencies
    are already available;
    git/npm packages can also ship a metadata-validated prebuilt `dist/`, and
    npm packages must. Git installs use `--omit=dev`, `--omit=optional`, and
    `--ignore-scripts`; plugins may keep normal development dependencies in
    their manifests.
    npm and Node do not need to be on PATH; Git sources still require `git`.
    Managed git/npm installs refuse `engines.omnyo` /
    `engines.omnyoPluginSdk` mismatches, manifest vs. artifact identity mismatches,
    and reserved ID mismatches.
    A `git:`/`path:` repository can hold several plugins. Install one with
    `--subdirectory <relative-path>`, or with `--plugin <name>` to resolve an
    entry of the repository's `.omnyo/plugins.json` collection manifest (the two
    flags are mutually exclusive, and neither applies to `npm:` sources).
    Installs from one repository and commit share a single checkout.
    A repository that has a collection manifest and is not a plugin itself
    refuses an unselected install and lists its entry names.
    Every install (CLI, SDK, or app) is a server job. Jobs run one at a time
    in request order and keep going when the client disconnects or the app
    reloads; a second request for the same source or catalog entry joins the
    active job. `--no-wait` starts the job and prints its id instead of
    waiting.
  - `omnyo plugin install-jobs` — list queued, running, and recently finished
    installs (finished jobs stay for ten minutes; `--json` for the jobs).
  - `omnyo plugin cancel-install <job-id>` — a queued install is dropped. A
    running install kills its git/npm step and installs nothing; once it has
    started registering the plugin, it finishes and reports success (remove
    it afterwards if unwanted).
  - `omnyo plugin outdated` — check installed plugins for compatible updates
    (table; `--json` for raw results). Shows latest compatible candidate and
    any blocked incompatible newer release. Dev builds (Omnyo `0.0.0`) annotate
    that `engines.omnyo` is not enforced.
  - `omnyo plugin update <id>` / `omnyo plugin update --all` — apply compatible
    updates for tracking sources, including newer tags that satisfy a Git
    semver range. Same full-trust confirmation as install (`--yes` skips;
    non-TTY refuses without it). Use `omnyo plugin outdated` to preview available
    updates. Changing a pinned git:/npm: source requires `omnyo plugin remove`
    (which deletes the plugin's settings, secrets, and schedules) and a fresh
    install. A local path plugin is never removed to change it: edit it in
    place and `omnyo plugin reload <id>`, or `omnyo plugin install path:<new dir>`
    to move it; both keep its configuration.
  - `omnyo plugin update <id> --directory <local-runtime> --yes` uploads a prepared
    bundled-plugin runtime from the CLI machine and activates it through the
    existing update job. Build the selected plugin with Turbo's
    `prepare:bundled` task and select its `.bundled-runtime` directory. The
    plugin must already be installed under its canonical bundled ID. The
    server checks identity, Omnyo/SDK compatibility, built artifacts and uploaded
    digests before replacement; settings, secrets and enabled state survive.
    The CLI refuses uncommitted changes in `plugins/<name>`, a lower version and
    a candidate missing the installed artifact's source commit. If the candidate
    does not descend from that commit, merge it, rebuild and retry. If it does
    descend, it removed those paths: restore them. An artifact with no recorded source warns and
    proceeds. `--replace-active <artifact>` takes the exact active artifact id
    or `packaged`, and is only for removing your own live change or a replacement
    you were explicitly told to make.
    A failed activation restores the previous artifact and state. Overrides
    survive restart and maintenance resume on the same Omnyo runtime; the first
    startup on a different runtime retires them and loads its bundled copy.
    This flag requires one ID and
    cannot use `--all`; `--no-wait` returns the existing background job.
  - `omnyo plugin list` — status, background services, schedules, handler timings,
    and each plugin's contributed `omnyo` command. An `official` mark follows
    the status of every plugin Omnyo hosts: the plugins in its bundle and Omnyo
    Official, including a local checkout of one of them. `author` and
    `repository` credit the plugin's original author and source from its
    `package.json`; `--json` reports them as `official`, `author` and
    `repositoryUrl`.
  - `omnyo plugin source <id> [--json]` — requested and resolved source, the
    repository subdirectory for a nested plugin, the semver range with its tag
    prefix and resolved tag for a Git range install, engine ranges, install
    time, integrity/registry details, and recent activation history.
  - `omnyo plugin enable|disable <id>` — a plugin included with Omnyo that you have
    never enabled or disabled follows Omnyo's default, so a later release can turn
    it on; once you enable or disable it, that choice survives every release.
    Disabling is the only way to turn off a core plugin.
  - `omnyo plugin reload [id]` (exits 1 when a
    reloaded plugin does not come up on its current sources: the previous
    instance was kept, or it is degraded because a service ignored its abort;
    naming a local path plugin that runs a verified snapshot loads it from its
    source folder with its configuration, and keeps the snapshot if it cannot
    start there; reloading all plugins keeps snapshots and lists them),
    `omnyo plugin remove <id>` (deletes the plugin's settings, secrets, and
    schedules; managed git/npm files are deleted, and local path sources stay
    on disk). Included plugins from Omnyo's plugin collection can be removed;
    they stay removed across restarts and updates until you reinstall them from
    Omnyo Official. Core plugins cannot be removed: the command exits 1 with the
    server's reason. `omnyo plugin list --json` reports `removable`.
  - `omnyo plugin relocate <from> <to> [--dry-run] [--json]` — after a local
    plugin folder moves (for example a renamed checkout), point every installed
    path plugin under `<from>` at the same folder under `<to>`. `<from>` must
    still lead to `<to>` through a link, so keep that link until this finishes.
    Plugins that run from a verified snapshot keep it and do not rebuild;
    plugins that run from the folder reload from `<to>`; disabled ones stay
    disabled. Settings, secrets, and schedules are kept. Use it instead of
    `omnyo plugin install path:<new folder>`, which replaces a verified
    snapshot with a live install of the folder.
  - `omnyo plugin prune [--dry-run] [--max-items N] [--max-bytes BYTES] [--json]` — delete cached git:/npm: plugin
    versions under `<data>/plugins/cache` that no installed plugin uses
    (left by earlier Omnyo releases, rolled-back updates, or interrupted
    operations) and unrecorded cache directories. A successful update already
    deletes the version it replaced, and `omnyo plugin remove` deletes the
    plugin's versions. Prints each removed version
    with its size and the total freed; `--dry-run` only lists them. Active
    versions, pending rollbacks, and local path sources are never touched.
    The command palette's Clean up plugin cache runs the same prune.
    Optional limits are enforced under the registration lock. Selection keeps
    shared removal-root groups intact and prefers larger eligible groups.
    Reported allocation is not a measurement of exclusive SSD space reclaimed.
  - `omnyo plugin safe-mode [on|off] [--json]` — show or change plugin safe
    mode. `on` stops every plugin you installed, official store plugins
    included, while keeping each plugin's enabled setting; plugins included
    with Omnyo keep running. `off` restarts the ones that were enabled and exits 1
    naming any that fail to start. Installing or updating a stopped plugin is
    refused while safe mode is on. The command palette offers the same toggle.
  - `omnyo plugin config <id> [set <key> <value> | unset <key>]` — declared
    settings; boolean and number arguments are converted to their declared
    types. Reload the plugin after configuring (`omnyo plugin reload <id>`).
  - `omnyo plugin token <id>` — print a short-lived bearer token for that plugin.
  - List, reload, enable, disable, config, and remove support `--json`.
  - `omnyo plugin logs <id> [-n N] [-f]` — the plugin's `api.log` output.
  - `omnyo plugin run <id> [args...]` — explicit form; collisions log an activation
    warning and are annotated by `omnyo plugin list`.
  - `omnyo plugin new <name> --event-source` — create a headless wait event
    family for `omnyo wait --event`, with tests and a skill, using the same
    verified private SDK artifact.
  - `omnyo plugin new <name>` — scaffold a plugin with backend, app, skill,
    and an `omnyo <name>` CLI command. The selected runtime supplies a verified
    private SDK archive; scaffolding copies its exact bytes into `vendor/`
    and records a digest-bearing local file pin in `devDependencies`.
    Keep the archive with the plugin source so clean consumers can install
    the same declarations without a core checkout or public SDK publication.
    Read `node_modules/@omnyo/plugin-sdk/bundled-types/` for exact signatures.
  - `omnyo plugin build [path]` — compile backend `server.js` and
    `server.meta.json`, optional `omnyo.app` frontend assets and metadata,
    and optional `omnyo.host` self-contained host artifact and digest.
    Enrolled daemons verify that digest before running the host artifact.
  - `omnyo plugin types [path]` — verify the selected runtime's private SDK,
    copy it locally, update its exact digest pin and sync declared runtime-shim
    type dependencies. Declare packages imported by the plugin; unused shims
    are optional. `--check` writes nothing and fails for stale pins, missing
    artifacts or changed bytes. Run `pnpm install` after an update.
  - `omnyo plugin migrate [path] [--yes]` — import the finite recorded
    `@get-bb/plugin-sdk` and `@bb/plugin-sdk` layouts into the private SDK
    contract. It converts metadata and source-bound imports, removes their
    tsconfig maps, and preserves original declarations under
    `vendor/legacy-plugin-sdk-v1/`. User bindings, prose, unknown files and
    plugin IDs remain intact. Differing dual identities, malformed source
    and archive collisions refuse before mutation. The command prints a
    content-bound plan and asks before applying it; `--yes` selects that
    same checked plan. Run `pnpm install` afterward.
  - `omnyo plugin dev [path]` — watch loop for an installed plugin (default:
    cwd): on every change it rebuilds the frontend bundle (when `omnyo.app` is
    declared; unminified, unlike `omnyo plugin build`) and reloads the plugin;
    open app pages pick the new UI up live.
    Build/reload failures print and keep watching; Ctrl+C stops.
  - Frontend entries default-export `definePluginApp` from
    `@omnyo/plugin-sdk/app` and register UI slots (homepageSection,
    settingsSection, navPanel, threadPanelAction, fileOpener) with hooks
    (useRpc, useRealtime, useRealtimeConnectionState,
    useSettings, experimental_useAppContext,
    experimental_useAppNavigate, useComposer for scoped text editing / quote / mention /
    focus access); components are vendored shadcn source the
    plugin owns. Installed
    plugins and their settings also appear under Settings → Installed plugins.
- **Writing a plugin?** Use the `omnyo-plugin-authoring` skill — the complete
  authoring reference for the backend `PluginApi` (settings, storage, sdk,
  http/rpc/realtime, background services and schedules, CLI commands, agent
  tools and context, host-rendered UI, lifecycle) and the frontend
  `@omnyo/plugin-sdk/app` contract (slots, hooks, UI kit), with working patterns
  and gotchas. `omnyo guide plugins` has the short walkthrough.

## Inspect plugin RPC

`omnyo plugin rpc list [plugin-id] [--method <exact-name>] [--json]` lists discoverable methods from running plugins, optionally restricted to one plugin. `omnyo plugin rpc inspect <plugin-id> [method] [--json]` dumps registration and method descriptions plus input/output JSON Schemas. Copy the relevant schema into your consumer and call the existing plugin RPC endpoint. Discovery is opt-in advertising, not access control; method names may carry versions such as `provider-usage.v1.listResources`.

`omnyo plugin rpc call <plugin-id> <method> [--input-file <json-path>] [--json]` invokes a method using server-side schema validation. Omitting the input file sends JSON null. Input files avoid putting sensitive values in command arguments.

### Background updates

`omnyo plugin update <id> --yes` starts a server job and waits by polling, so the activation stability check does not hold one HTTP request open. Add `--no-wait` to return immediately. Use `omnyo plugin update-jobs [job-id] --json` for progress and results, including automatic rollback. Queued/running updates continue after the CLI or app disconnects. Finished jobs remain for ten minutes; jobs do not survive server restarts. Running updates cannot be cancelled midway through activation.

SDK: `plugins.applyUpdate({ pluginId })` waits; `plugins.experimental_startUpdate({ pluginId })` returns the job. Inspect with `plugins.experimental_updateJobs.list()` or `.get({ jobId })`. Raw HTTP callers opt in with `Prefer: respond-async`; legacy callers still receive the completed result.
