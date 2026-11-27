import { randomUUID } from "node:crypto";
import { type PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  actionsSchema,
  CHECK_TIMEOUT_MS,
  clipText,
  configSchema,
  hostContract,
  hostSignals,
  replaceSchema,
  rpcContract,
  type Action,
  type Config,
  type Run,
  type State,
} from "./contract";

type CommandAction = Extract<Action, { kind: "command" }>;

type CheckOutput = z.infer<typeof hostContract.check.output>;

/** A poll that arrives this much before a check's interval ends still runs it. */
const CHECK_SLACK_MS = 500;

const CHECK_TEXT = { on: "Running", off: "Not running", attention: "Needs attention" } as const;

/** Maps a status check's exit to its tone; `null` means the machine did not answer. */
export function checkState(id: string, output: CheckOutput | null): Omit<State, "checkedAt"> {
  if (!output) return { id, tone: "unknown", text: "Could not reach the machine to check." };

  if (output.startError)
    return { id, tone: "unknown", text: `Status check could not start (${output.startError})` };
  const written = output.activity?.text ?? "";

  const tone =
    output.exitCode === 0
      ? "on"
      : output.exitCode === 1
        ? "off"
        : output.exitCode === 2
          ? "attention"
          : null;

  if (tone) return { id, tone, text: written || CHECK_TEXT[tone] };

  const reason =
    output.signal === "SIGKILL"
      ? "timed out"
      : `failed (${output.signal ?? output.exitCode ?? "unknown exit"})`;

  return {
    id,
    tone: "unknown",
    text: clipText(written ? `Status check ${reason}: ${written}` : `Status check ${reason}`),
  };
}

export function replaceConfig(current: Config, revision: number, actions: Action[]): Config {
  if (current.revision !== revision)
    throw new Error("Project actions changed. List them again before editing.");

  return { revision: current.revision + 1, actions: actionsSchema.parse(actions) };
}

export default function plugin(api: PluginApi) {
  const db = api.storage.database();
  api.storage.migrate(db, [
    "CREATE TABLE project_actions (project_id TEXT PRIMARY KEY, config TEXT NOT NULL)",
  ]);

  const host = api.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  const lifetime = new AbortController();
  const runs = new Map<string, Run>();
  const active = new Map<string, { runId: string; hostId: string; projectId: string }>();
  const busy = (run: Run | undefined) => run?.status === "running" || run?.status === "stopping";
  const key = (projectId: string, id: string) => JSON.stringify([projectId, id]);
  const changed = (projectId: string) => api.realtime.publish("changed", { projectId });

  const finished = (id: string, status: Run["status"], detail: string, url: string | null = null) =>
    ({ id, status, detail, url, startedAt: null, activity: null }) satisfies Run;

  // Each check's last result, kept while its machine, folder and settings stay the same.
  // `startedAt` is when the latest check started, so the interval runs start to start.
  const checks = new Map<
    string,
    {
      signature: string;
      state: State | null;
      startedAt: number;
      pending: Promise<void> | null;
      again: boolean;
    }
  >();

  const signatureOf = (action: CommandAction) =>
    JSON.stringify([action.hostId, action.cwd, action.check]);

  /**
   * Runs the action's status check unless one started within its interval; `force` always
   * runs it. Returns the check in flight, if any.
   */
  function check(projectId: string, action: Action, force = false): Promise<void> | null {
    if (action.kind !== "command" || !action.check) return null;
    const settings = action.check;
    const checkKey = key(projectId, action.id);
    const signature = signatureOf(action);
    let entry = checks.get(checkKey);

    if (!entry || entry.signature !== signature) {
      entry = { signature, state: null, startedAt: 0, pending: null, again: false };
      checks.set(checkKey, entry);
    }

    // A forced check that arrives mid-check runs again once the current one answers.
    if (entry.pending) {
      entry.again ||= force;

      return entry.pending;
    }

    if (!force && Date.now() - entry.startedAt < settings.intervalMs - CHECK_SLACK_MS) return null;
    const current = entry;
    const startedAt = Date.now();
    current.startedAt = startedAt;

    current.pending = host
      .call(
        "check",
        { cwd: action.cwd, argv: settings.argv, timeoutMs: CHECK_TIMEOUT_MS },
        { hostId: action.hostId, timeoutMs: CHECK_TIMEOUT_MS + 5000, signal: lifetime.signal },
      )
      .catch(() => null)
      .then((output) => {
        if (lifetime.signal.aborted || checks.get(checkKey) !== current) return;
        const next = checkState(action.id, output);
        const same = current.state?.tone === next.tone && current.state.text === next.text;
        current.state = { ...next, checkedAt: startedAt };

        if (!same) changed(projectId);
      })
      .finally(() => {
        current.pending = null;

        if (!current.again || checks.get(checkKey) !== current) return;
        current.again = false;
        void check(projectId, action, true);
      });

    return current.pending;
  }

  // A state older than this is not shown: nothing has polled it lately, so it may be wrong.
  const fresh = (state: State, intervalMs: number) =>
    Date.now() - state.checkedAt <= 2 * intervalMs + CHECK_TIMEOUT_MS;

  const stopActivity = host.experimental_onSignal("activity", ({ hostId, payload }) => {
    const { runId, ...activity } = payload;

    for (const [runKey, target] of active) {
      if (target.runId !== runId || target.hostId !== hostId) continue;
      const current = runs.get(runKey);

      if (!current || !busy(current)) return;
      runs.set(runKey, { ...current, activity });
      changed(target.projectId);

      return;
    }
  });

  api.onDispose(() => {
    lifetime.abort();
    stopActivity();
  });

  function read(projectId: string): Config {
    const row = db
      .prepare("SELECT config FROM project_actions WHERE project_id = ?")
      .get(projectId);

    if (!row) return { revision: 0, actions: [] };

    return configSchema.parse(JSON.parse(z.object({ config: z.string() }).parse(row).config));
  }

  function replace(input: z.infer<typeof replaceSchema>) {
    const next = db.transaction(() => {
      const config = replaceConfig(read(input.projectId), input.revision, input.actions);

      if (
        read(input.projectId).actions.some((action) =>
          busy(runs.get(key(input.projectId, action.id))),
        )
      )
        throw new Error("Wait for the running action before editing.");
      db.prepare(
        "INSERT INTO project_actions VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET config = excluded.config",
      ).run(input.projectId, JSON.stringify(config));

      return config;
    })();

    for (const checkKey of checks.keys()) {
      const [projectId, id] = z.tuple([z.string(), z.string()]).parse(JSON.parse(checkKey));

      if (projectId === input.projectId && !next.actions.some((action) => action.id === id))
        checks.delete(checkKey);
    }

    changed(input.projectId);

    return next;
  }

  // Listing also starts each status check whose interval has passed; a changed result
  // publishes `changed`, so the header refreshes when it answers.
  function list(projectId: string) {
    const config = read(projectId);

    return {
      ...config,
      runs: config.actions.flatMap((action) => {
        const run = runs.get(key(projectId, action.id));

        return run ? [run] : [];
      }),
      states: config.actions.flatMap((action) => {
        if (action.kind !== "command" || !action.check) return [];
        void check(projectId, action);
        const entry = checks.get(key(projectId, action.id));

        return entry?.state &&
          entry.signature === signatureOf(action) &&
          fresh(entry.state, action.check.intervalMs)
          ? [entry.state]
          : [];
      }),
    };
  }

  /** For agents and the CLI, which list once: waits for any due check before listing. */
  async function listChecked(projectId: string) {
    await Promise.all(read(projectId).actions.map((action) => check(projectId, action)));

    return list(projectId);
  }

  async function run(projectId: string, id: string): Promise<Run> {
    const action = read(projectId).actions.find((item) => item.id === id);

    if (!action) throw new Error("Project action not found.");
    const runKey = key(projectId, id);

    if (busy(runs.get(runKey))) throw new Error("This action is already running.");
    runs.set(runKey, {
      id,
      status: "running",
      detail: "Running",
      url: null,
      startedAt: Date.now(),
      activity: null,
    });
    changed(projectId);
    let result: Run;

    try {
      if (action.kind === "url") result = finished(id, "succeeded", "Ready to open", action.url);
      else {
        const runId = randomUUID();
        active.set(runKey, { runId, hostId: action.hostId, projectId });

        const output = await host
          .call(
            "execute",
            { runId, action },
            {
              hostId: action.hostId,
              timeoutMs: action.timeoutMs + 10000,
              signal: lifetime.signal,
            },
          )
          .finally(() => active.delete(runKey));

        result = output.stopped
          ? finished(id, "stopped", "Force quit")
          : output.exitCode === 0
            ? finished(id, "succeeded", "Command completed")
            : finished(
                id,
                "failed",
                `Command failed (${output.signal ?? output.exitCode ?? "unknown exit"})`,
              );
      }
    } catch {
      result = finished(
        id,
        "failed",
        "Action failed. Check the machine, saved action and timeout.",
      );
    }

    runs.set(runKey, result);
    changed(projectId);

    // What the action manages has likely just changed.
    void check(projectId, action, true);

    return result;
  }

  async function stop(projectId: string, id: string): Promise<Run> {
    const runKey = key(projectId, id);
    const current = runs.get(runKey);
    const target = active.get(runKey);

    if (!current || !busy(current) || !target) throw new Error("This action is not running.");

    if (current.status === "running") {
      runs.set(runKey, { ...current, status: "stopping", detail: "Force quitting" });
      changed(projectId);
    }

    const restore = () => {
      const latest = runs.get(runKey);

      if (latest?.status !== "stopping") return;
      runs.set(runKey, { ...latest, status: "running", detail: "Running" });
      changed(projectId);
    };

    try {
      const { stopped } = await host.call(
        "stop",
        { runId: target.runId },
        { hostId: target.hostId, timeoutMs: 15000, signal: lifetime.signal },
      );

      if (!stopped) restore();
    } catch (error) {
      restore();
      throw error;
    }

    return runs.get(runKey) ?? current;
  }

  api.rpc.register(rpcContract, {
    list: ({ projectId }) => list(projectId),
    replace,
    run: ({ projectId, id }) => run(projectId, id),
    stop: ({ projectId, id }) => stop(projectId, id),
  });
  api.agents.registerTool({
    name: "project_actions",
    description:
      "List or replace persistent shortcuts for the caller's project. List first, preserve existing actions, then replace using its revision. Array order sets button order; omission removes an action. Never include credentials; a command that needs a secret must read it at run time. Command clicks run exact argv on the explicit machine; the header shows a running state, elapsed time and a confirmed force quit, so launch apps in the foreground rather than detached. Output stays private; a command shows live status by writing lines to the file named in $OMNYO_ACTION_STATUS, and a leading n/m (for example `2/4 Building`) draws a step bar. An optional `check: {argv, intervalMs}` runs a quick status command in the same folder every intervalMs (default 5000) while the header is visible: exit 0 shows a green dot (running and current), 1 a hollow dot (not running), 2 an amber dot (running, but the action would change something, such as loading a newer build), and the last line it writes to $OMNYO_ACTION_STATUS is the dot's text. list waits for any due check and returns each as `states` (tone, text, checkedAt). A saved action grants no extra deployment, sending or spending authority.",
    parameters: z.object({
      operation: z.enum(["list", "replace"]),
      revision: z.number().int().nonnegative().optional(),
      actions: actionsSchema.optional(),
    }),
    async execute(input, context) {
      if (!context.projectId) throw new Error("A project is required.");

      return JSON.stringify(
        input.operation === "list"
          ? await listChecked(context.projectId)
          : replace(replaceSchema.parse({ ...input, projectId: context.projectId })),
      );
    },
  });
  api.cli.register({
    name: "project-actions",
    summary: "Manage persistent project header actions",
    commands: [
      {
        name: "list",
        summary: "List actions and revision",
        usage: "omnyo project-actions list [--project ID]",
      },
      {
        name: "replace",
        summary: "Replace using revision",
        usage:
          'omnyo project-actions replace --value \'{"revision":0,"actions":[]}\' [--project ID]',
      },
      {
        name: "run",
        summary: "Run a saved action",
        usage: "omnyo project-actions run ID [--project ID]",
      },
      {
        name: "stop",
        summary: "Force quit a running action and its child processes",
        usage: "omnyo project-actions stop ID [--project ID]",
      },
    ],
    async run(argv, context) {
      try {
        const flag = (name: string) => {
          const at = argv.indexOf(name);

          return at < 0 ? undefined : argv[at + 1];
        };

        const projectId = flag("--project") ?? context.projectId;

        if (!projectId) throw new Error("Specify --project ID outside a project chat.");
        let output;

        if (argv[0] === "list") output = await listChecked(projectId);
        else if (argv[0] === "replace")
          output = replace(
            replaceSchema.parse({ ...JSON.parse(flag("--value") ?? "null"), projectId }),
          );
        else if (argv[0] === "run") output = await run(projectId, z.string().min(1).parse(argv[1]));
        else if (argv[0] === "stop")
          output = await stop(projectId, z.string().min(1).parse(argv[1]));
        else throw new Error("Use list, replace --value JSON, run ID, or stop ID.");

        return {
          exitCode: "status" in output && output.status === "failed" ? 1 : 0,
          stdout: JSON.stringify(output),
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : "Project action failed",
        };
      }
    },
  });
}
