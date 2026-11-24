Schedule work once or on a repeat, and let Omnyo run it while you do something else. An automation can start an agent thread with a prompt, or run a stored script on the Omnyo server.

## What you get

- A Workflows dashboard in the sidebar. Create, edit, pause, resume, and run scheduled automations. Open state machines and review installed workflow packages in the same dashboard.
- Two schedule types. Use a cron expression with a timezone for repeating work. Use a date, or a delay such as `2h`, for one-shot work.
- Agent mode. Pick the provider, model, reasoning level, and permission mode. Start a new thread, re-prompt an existing thread, or create a new worktree for each run.
- Script mode. Store a bash, sh, node, or python3 script. Each run records stdout, stderr, and the exit code. A script that prints nothing is recorded as a silent tick.
- Failure notices. A scheduled automation retries a failed run with backoff and pauses itself after 3 failures in a row; transient provider failures keep retrying without pausing. The first failure in a row and the pause each queue a web and desktop notification through Push notifications, so a broken automation does not fail silently. Notices for runs older than a day are not sent.

## For agents

Agents get the `automations` skill and the `omnyo automation` command: `create`, `list`, `show`, `update`, `pause`, `resume`, `run`, `runs`, and `delete`. All commands accept `--json`. Threads that an automation starts cannot create automations.

Scripts run on the machine that hosts the Omnyo server. New standard-project scripts use that host's project source when available; Personal and projects without one run in the plugin's shared script storage. Existing scripts run there until changed. A script can instead select an absolute server-host path, and its detail view shows the resolved directory. Agent runs use the providers you already have installed.
