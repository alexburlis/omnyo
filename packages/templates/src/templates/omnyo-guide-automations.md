---
kind: instruction
title: Omnyo Guide Automations
summary: Command reference for scheduled agent and script work.
intent: Help agents create, edit, inspect, and run automations through the CLI.
---

Automations schedule recurring or one-shot work. Agent automations run a prompt
in a thread; script automations run stored code without model usage.

omnyo automation list --project <id>
omnyo automation show <automationId> --project <id>
omnyo automation create --project <id> --name <name> <schedule> <execution>
omnyo automation update <automationId> --project <id> [changes]
omnyo automation pause|resume <automationId> --project <id>
omnyo automation run <automationId> --project <id>
omnyo automation runs <automationId> --project <id> [--limit <count>]
omnyo automation delete <automationId> --project <id> --yes

Schedules:

--cron <expression> --timezone <iana-timezone>
--at <iso-date-time>
--in <duration> For example: 30s, 5m, 2h, or 1d

Agent execution:

--prompt <text> --provider <id> --model <model>
[--reasoning <level>]
[--service-tier <tier>]
[--permission-mode <accept-edits|auto|full>]
[--environment <environment-id|path> | --new-environment worktree]
[--base-branch <branch>] [--target-thread <thread-id>]

Script execution:

--script <inline> | --script-file <path> [--host <name-or-id>]
[--interpreter <bash|sh|node|python3>]
[--timeout <milliseconds, or a duration such as 90s or 5m>] [--env-json '{"KEY":"value"}']
[--working-directory <automation-storage|project|absolute-server-path>]

`--script-file` reads the file relative to your current directory from the
thread's environment host, or from the server host outside a thread. Pass
`--host <name-or-id>` to read from another machine. The plugin stores a private
copy that runs execute. The copy is a snapshot: edits to the source file do not
apply until you run `update <automationId> --script-file <path>` again;
`create` and `update` print that exact command. `create`, `update`, and `show`
print the stored copy path on the `Script:` line (`execution.storedScriptPath`
with `--json`).

Scripts run on the omnyo server host. New standard-project scripts use its project
source when one exists; Personal and projects without one run in the plugin's
shared script storage directory. Existing scripts without a saved policy also
run there. `--working-directory` selects `automation-storage`, `project`, or an
absolute server-host
path. A missing selected directory fails the run. A failed process reports the
exit code and sanitized first non-empty stderr line in the `Detail` column.

`update` can combine name, schedule, and execution changes. Partial updates
keep every omitted execution field. Partial updates to an existing agent accept
`--prompt`, `--provider`, `--model`, `--reasoning`, `--service-tier <tier>`,
`--clear-service-tier`, `--permission-mode`, or one target option.
`--clear-service-tier` and `--service-tier` cannot be combined; `none` is a
literal tier id. Partial updates to an existing script accept `--script` or
`--script-file [--host <name-or-id>]`, `--interpreter`, `--timeout`,
`--env-json`, and `--working-directory`. `--env-json` replaces the whole
variable map, and `'{}'` removes every variable. A new `--script-file` keeps the
current interpreter. `--prompt`, `--provider`, and `--model` together always
replace the execution with an agent. Script flags on an agent automation
replace it with a script and require `--script` or `--script-file`. A
replacement gives omitted settings their creation defaults. Agent and script
flags cannot be combined. Pass provider, model, reasoning, service tier, and
permission together when switching providers.

Add `--json` for machine-readable output. The JSON returned by `list` and
`show` is a union discriminated by `problem`: canonical records omit it;
degraded records use `"missing-agent-prompt"` or `"invalid-stored-data"`.
The missing-prompt variant retains the full readable automation, while the
invalid-data variant contains only its identity fields and `problem`. Use
`runs --output <runId>` to print a script run's captured output.

`list` and `show` keep damaged stored records visible as `Prompt required` or
`Invalid data` instead of failing the whole read. Opening a `Prompt required`
record in the Automations panel takes you through the standard editor, where
you can add the prompt while reviewing its other settings. The same repair is
available through the CLI:

omnyo automation update <automationId> --project <id> --prompt "<prompt>"

Writes remain strict. Run, pause, and resume reject damaged records; update
succeeds only when the resulting complete record is canonical.

Automations plugin settings expose `scriptHostId`, which selects an enrolled
host for every script automation. Empty uses the Omnyo server. Set it with
`omnyo plugin config automations set scriptHostId <host-id>`
and reload the plugin. Explicit paths and project sources refer to that host;
`automation-storage` uses its stable plugin-owned script storage. A remote
host failure fails the run without running it locally. Read the Automations
skill’s script runtime reference for stored copies and environment behavior.

Weekly Content Feed can use saved OpenSEO keywords. Set the workspace API key in
Automations settings. The key belongs to this Omnyo installation and carries the issuing user’s
OpenSEO workspace permissions. From an owner
terminal outside a chat, use `omnyo automation workflow openseo-projects COPY
--project ID --site HOSTNAME` to find a matching project. Use
`openseo-connect` and then `openseo-keywords` with the same arguments plus
`--openseo-project OPEN_SEO_PROJECT_ID`. The read returns at most 50 saved
keywords and uses zero credits. Pass a `source` object with `kind: "openseo"`,
`readId` and selected `keywordIds` in the JSON for `workflow bind`. A
`source` of `{"kind":"notes"}` clears the saved research from the brief.
