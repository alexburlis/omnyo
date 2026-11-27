import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import type { hostContract } from "../contract";
import type {
  WorkflowDelivery,
  WorkflowDeliveryInput,
  WorkflowVerification,
} from "./workflow-host-types";

type WorkflowPluginTargets = z.infer<typeof hostContract.workflowPluginTargets.output>;

type Target = WorkflowPluginTargets["targets"][number];

type InstallerHost = {
  call(
    method: "workflowPluginTargets",
    input: WorkflowDeliveryInput,
    options: { hostId: string; timeoutMs: number },
  ): Promise<WorkflowPluginTargets>;
};

const targetSchema = z.object({
  pluginId: z.string(),
  source: z.string(),
  version: z.string(),
  snapshotDigest: z.string(),
});

const stateSchema = z.object({
  input: z.object({ runId: z.string(), planPath: z.string(), planDigest: z.string() }),
  sourceCommit: z.string(),
  entries: z.array(
    z.object({
      target: targetSchema,
      attempted: z.boolean(),
      jobId: z.string().nullable(),
      complete: z.boolean(),
    }),
  ),
});

type InstallState = z.infer<typeof stateSchema>;

type InstallEntry = InstallState["entries"][number];

export class WorkflowInstall {
  private db;
  private active = new Map<string, Promise<WorkflowDelivery>>();

  constructor(private api: PluginApi) {
    this.db = api.storage.database();
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS workflow_plugin_installs(run_id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    );
  }

  private read(input: WorkflowDeliveryInput): InstallState | null {
    const row = this.db
      .prepare("SELECT payload FROM workflow_plugin_installs WHERE run_id=?")
      .get(input.runId);

    if (!row) return null;

    const state = stateSchema.parse(
      JSON.parse(z.object({ payload: z.string() }).parse(row).payload),
    );

    if (
      state.input.planPath !== input.planPath ||
      state.input.planDigest !== input.planDigest ||
      state.input.runId !== input.runId
    )
      throw new Error("Plugin install input changed");

    return state;
  }

  private save(state: InstallState) {
    this.db
      .prepare(
        "INSERT INTO workflow_plugin_installs(run_id,payload) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(state.input.runId, JSON.stringify(state));
  }

  private result(
    state: InstallState,
    status: WorkflowDelivery["status"],
    reason: string,
  ): WorkflowDelivery {
    return {
      status,
      kind: "plugin",
      sourceCommit: state.sourceCommit,
      receiptPath: "workflow_plugin_installs:" + state.input.runId,
      offeredVersion: null,
      reason,
    };
  }

  async run(
    input: WorkflowDeliveryInput,
    host: InstallerHost,
    hostId: string,
  ): Promise<WorkflowDelivery> {
    const current = this.active.get(input.runId);

    if (current) return current;

    const operation = this.perform(input, host, hostId).finally(() =>
      this.active.delete(input.runId),
    );

    this.active.set(input.runId, operation);

    return operation;
  }

  private async installed(target: Target): Promise<boolean> {
    const list = await this.api.sdk.plugins.list();
    const plugin = list.plugins.find((entry) => entry.id === target.pluginId);

    if (!plugin || plugin.status !== "running" || plugin.source !== target.source) return false;
    const source = await this.api.sdk.plugins.getSource({ pluginId: target.pluginId });

    return (
      source.requested === target.source &&
      source.resolved === target.source &&
      plugin.version === target.version &&
      target.source.endsWith("/" + target.snapshotDigest)
    );
  }

  private async findJob(entry: InstallEntry) {
    const jobs = await this.api.sdk.plugins.installJobs.list();

    const matching = jobs.filter(
      (job) =>
        job.target.kind === "source" &&
        job.target.source === entry.target.source &&
        (!job.target.selection || job.target.selection.kind === "root"),
    );

    if (entry.jobId) return matching.find((job) => job.id === entry.jobId) ?? null;

    if (matching.length > 1)
      throw new Error("Multiple installation owners match this exact plugin source");

    return matching[0] ?? null;
  }

  private async installationHold(entry: InstallEntry): Promise<string | null> {
    const list = await this.api.sdk.plugins.list();
    const plugin = list.plugins.find((value) => value.id === entry.target.pluginId);

    if (!plugin) throw new Error("The selected plugin is not installed");

    if (!plugin.source.startsWith("path:"))
      return "The existing managed plugin must retain its current update channel";

    if (
      entry.target.pluginId === "account-pool" ||
      plugin.providerIds.length ||
      entry.target.pluginId.startsWith("provider-")
    )
      return "The model-serving plugin requires its independent idle update owner";

    return null;
  }

  private async perform(
    input: WorkflowDeliveryInput,
    host: InstallerHost,
    hostId: string,
  ): Promise<WorkflowDelivery> {
    let state = this.read(input);

    if (!state) {
      const targets = await host.call("workflowPluginTargets", input, { hostId, timeoutMs: 60000 });

      if (targets.planDigest !== input.planDigest || !targets.targets.length)
        throw new Error("Plugin targets do not match the delivery plan");
      state = {
        input,
        sourceCommit: targets.sourceCommit,
        entries: targets.targets.map((target) => ({
          target,
          attempted: false,
          jobId: null,
          complete: false,
        })),
      };
      this.save(state);
    }

    for (const entry of state.entries) {
      if (await this.installed(entry.target)) {
        entry.complete = true;
        this.save(state);
        continue;
      }

      if (entry.complete)
        return this.result(
          state,
          "blocked",
          "A previously verified plugin source is no longer active",
        );
      let job = await this.findJob(entry);

      if (!job && entry.attempted)
        return this.result(
          state,
          "blocked",
          "The installation outcome is unknown; the exact core job and installed source must be reconciled without replay",
        );

      if (!job) {
        const current = await host.call("workflowPluginTargets", input, {
          hostId,
          timeoutMs: 60000,
        });

        if (
          current.sourceCommit !== state.sourceCommit ||
          current.planDigest !== input.planDigest ||
          !current.targets.some(
            (target) =>
              target.pluginId === entry.target.pluginId &&
              target.source === entry.target.source &&
              target.snapshotDigest === entry.target.snapshotDigest &&
              target.version === entry.target.version,
          )
        )
          throw new Error("The prepared plugin target changed before installation");

        const hold = await this.installationHold(entry);

        if (hold) return this.result(state, "pending", hold);
        entry.attempted = true;
        this.save(state);

        try {
          job = await this.api.sdk.plugins.startInstall({
            source: entry.target.source,
          });
        } catch {
          job = await this.findJob(entry);

          if (!job)
            return this.result(
              state,
              "blocked",
              "Core did not confirm the install submission; it will not be replayed",
            );
        }
      }

      entry.jobId = job.id;
      this.save(state);

      if (["queued", "running", "cancelling"].includes(job.state))
        return this.result(
          state,
          "pending",
          "The core-owned plugin installer is applying the pinned source",
        );

      if (job.state !== "succeeded")
        return this.result(state, "blocked", "The core-owned plugin installation did not succeed");

      if (!(await this.installed(entry.target)))
        return this.result(
          state,
          "blocked",
          "Core finished installation but the pinned running source was not confirmed",
        );
      entry.complete = true;
      this.save(state);
    }

    return this.result(
      state,
      "complete",
      "Every selected plugin is running from the exact pinned commit",
    );
  }

  async verifyInstalled(
    input: WorkflowDeliveryInput,
    host: InstallerHost,
    hostId: string,
  ): Promise<WorkflowVerification> {
    const state = this.read(input);

    if (!state) throw new Error("There is no owned plugin installation to verify");
    const current = await host.call("workflowPluginTargets", input, { hostId, timeoutMs: 60000 });

    if (
      current.sourceCommit !== state.sourceCommit ||
      current.planDigest !== input.planDigest ||
      JSON.stringify(current.targets) !== JSON.stringify(state.entries.map((entry) => entry.target))
    )
      throw new Error("Installed snapshot identity differs from the prepared delivery");

    for (const entry of state.entries)
      if (!entry.complete || !(await this.installed(entry.target)))
        return {
          status: "pending",
          sourceCommit: state.sourceCommit,
          proof: "The exact selected plugin source is not yet verified running",
        };

    return {
      status: "verified",
      sourceCommit: state.sourceCommit,
      proof:
        "The core installer and active source agree; independent behavioral proof remains required",
    };
  }
}
