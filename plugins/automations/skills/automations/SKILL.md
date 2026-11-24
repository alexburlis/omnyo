---
name: automations
description: "Schedule or manage recurring and one-shot Omnyo agent or script automations."
---

# Automations

An automation is a scheduled task. When due it runs in one of two modes:

agent Spawn a thread or re-prompt a target thread with a configured prompt.
script Run a stored script on its execution host and capture stdout/stderr/exit.

Use the top-level `omnyo automation` command. The CLI routes it to this plugin.

Pass `--project` explicitly for every automation command. Inside a thread, automations are stamped origin `agent` and record the creating thread automatically. Threads created by automations cannot create automations, and neither can a thread while an automation run is executing in it; once that run finishes, the thread can create automations again.

Personal supports automations with `--project proj_personal`. Use `omnyo project list --include-personal --json` to include it in discovery; an empty default project list does not mean Personal is unavailable.

Choosing a mode:

Use `script` when the output is fully determined by code: watchdogs, threshold alerts, health checks, heartbeats, and API pollers with a fixed output shape. Scripts run on the Omnyo server unless Automations settings select `scriptHostId`; reload the plugin after changing it. New standard-project scripts use the selected host’s project source when one exists; Personal and projects without one run in the plugin's shared script storage directory. Existing scripts without a saved policy also run there. Use `--working-directory automation-storage|project|<absolute-server-path>` to select the policy. Script automations do not have an environment field and do not accept environment flags.

Design the script to print nothing when there is nothing to report: an exit-0 run with empty stdout/stderr, or a last non-empty line of `{"wakeAgent": false}`, is recorded as a skipped silent tick. Any other output is captured; non-zero exit or timeout is recorded as a failed run. The first failure in a row and the automatic pause after 3 failures notify the owner, so do not add a separate failure alert to the script.

Use `agent` when the run needs reasoning: summarize a feed, pick interesting items, draft a human-friendly message, or branch on content.

Creating:

```bash
omnyo automation create --project <id> --name "..." [schedule flags] [mode flags]
```

For creation flags and mode-specific defaults, read
[references/creation.md](references/creation.md).

Read `references/script-runtime.md` before you use a script file, depend on
injected variables, or diagnose retries, timeouts, restarts, and silent runs.

Managing:

```bash
omnyo automation list --project <id>
omnyo automation show <automationId> --project <id>
omnyo automation update <automationId> --project <id> [--name <name>] [schedule flags] [partial agent or script flags | complete execution flags]
omnyo automation pause <automationId> --project <id>
omnyo automation resume <automationId> --project <id>
omnyo automation run <automationId> --project <id> [--idempotency-key <key>]
omnyo automation runs <automationId> --project <id> [--limit <count>] [--output <runId>]
omnyo automation delete <automationId> --project <id> --yes
```

Run-history reads preserve the historical `recovered` status when present. It is
a retained recovery outcome, not a new execution or a relabeled success.

For partial updates, mode replacement, execution targets, or damaged records,
read [references/updates.md](references/updates.md). Every command supports `--json`.

`omnyo automation <command> --help` prints that command's exact arguments, options,
accepted values, and rules. Unknown commands, unknown options, and stray
arguments are rejected rather than ignored, and a failure under `--json` also
prints a `{"ok":false,"error":{"code","message","hint"}}` envelope on stdout.

## Imported workflows

Use `omnyo automation workflow --help` to inspect a package and install it as a
disabled copy. For `workflow bind`, pass recipient JSON with `hostId`,
`providerId: "codex"` or `"claude-code"`, an actual connected CLI `model`, and
`inputs`. Use `omnyo automation workflow options --host HOST_ID --json` to select a connected host and its available
models. Imported files supply text only; they cannot select a provider. In Weekly Content Feed, enter one product fact per line. Seven distinct facts give each day its own initial focus. Numbering is optional. In the app, you can preview the week before choosing a connected CLI model.

### Saved OpenSEO evidence

The owner sets or clears the workspace API key in Automations settings for
this Omnyo installation. The key carries the issuing user’s OpenSEO workspace
permissions. Omnyo uses it for project listing and saved keyword reads. From
a terminal outside a chat, use
`omnyo automation workflow openseo-status COPY --project ID` to check setup.
Use `openseo-projects` with `--site HOSTNAME` to list exact domain matches.
Use `openseo-connect` and `openseo-keywords` with `--site HOSTNAME` and
`--openseo-project OPEN_SEO_PROJECT_ID` to authorize the site's project for the
copy and retrieve up to 50 existing saved keywords at zero credits.

In the JSON for `workflow bind`, set `source` to
`{"kind":"openseo","readId":"…","keywordIds":["…"]}` using the returned read
and keyword IDs. The read expires after 15 minutes or when the copy's binding
changes. A confirmed schedule uses the frozen evidence until the owner updates
the brief and confirms the new revision. `openseo-disconnect COPY --project ID`
removes the authorization and preserves approved evidence. Bind with
`"source":{"kind":"notes"}` to remove research from the brief.
