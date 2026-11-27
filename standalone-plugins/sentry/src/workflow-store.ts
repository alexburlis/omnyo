import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { hostContract, incidentSchema } from "../contract";
import { completionSchema, verificationSchema } from "./repair-result-contract";
import {
  diagnosisSchema,
  reviewSchema,
  workflowInvocationSchema,
  workflowObservationSchema,
  workflowPolicySchema,
  workflowWorkerResultSchema,
  type WorkflowPolicy,
} from "./workflow-contract";

export const workflowTableDefinitions = [
  "CREATE TABLE workflow_bindings (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
  "CREATE TABLE workflow_policies (route_id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
] as const;

const stepSchema = z.object({
  invocation: workflowInvocationSchema,
  state: z.enum(["pending", "running", "complete", "unknown", "cancelled"]),
  threadId: z.string().nullable(),
  workerResult: workflowWorkerResultSchema.nullable(),
  observation: workflowObservationSchema.nullable(),
  reason: z.string().nullable(),
});

const taskSchema = z.object({
  runId: z.string(),
  issueKey: z.string(),
  generation: z.string(),
  policy: workflowPolicySchema,
  instanceId: z.string().nullable(),
  recoveredFrom: z.string().nullable().default(null),
  rootThreadId: z.string().nullable().default(null),
  homeThreadId: z.string().nullable().default(null),
  retainedEnvironments: z.array(z.string()).default([]),
  status: z.enum(["active", "resolved", "deferred", "blocked"]),
  waiting: z.boolean().default(false),
  createdAt: z.string(),
  finishedAt: z.string().nullable().default(null),
  diagnosis: diagnosisSchema.nullable(),
  repair: completionSchema.nullable(),
  verification: verificationSchema.nullable(),
  review: reviewSchema.extend({ threadId: z.string() }).nullable(),
  merge: hostContract.workflowMerge.output.nullable(),
  plan: hostContract.workflowPlan.output
    .extend({
      releaseRequired: hostContract.workflowPlan.output.shape.releaseRequired.default(false),
    })
    .nullable(),
  release: hostContract.workflowRelease.output.nullable().default(null),
  delivery: hostContract.workflowDeliver.output.nullable(),
  deliveryPath: z.string().nullable(),
  verifiedSource: z.string().nullable().default(null),
  runtimeProof: z
    .object({
      sourceCommit: z.string(),
      passed: z.boolean(),
      evidence: z.array(z.string()),
      summary: z.string(),
    })
    .nullable(),
  steps: z.array(stepSchema),
});

export type WorkflowTask = z.infer<typeof taskSchema>;

export type WorkflowStep = z.infer<typeof stepSchema>;

const payloadRow = z.object({ payload: z.string() });

export class WorkflowStore {
  constructor(private readonly db: ReturnType<PluginApi["storage"]["database"]>) {}

  hasRun(runId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM workflow_bindings WHERE run_id=?").get(runId));
  }

  isEnabledRoute(routeId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM workflow_policies WHERE route_id=? AND json_extract(payload, '$.enabled')=1",
        )
        .get(routeId),
    );
  }

  policies(): WorkflowPolicy[] {
    return this.db
      .prepare("SELECT payload FROM workflow_policies ORDER BY route_id")
      .all()
      .map((row) => workflowPolicySchema.parse(JSON.parse(payloadRow.parse(row).payload)));
  }

  tasks(): WorkflowTask[] {
    return this.db
      .prepare("SELECT payload FROM workflow_bindings ORDER BY rowid")
      .all()
      .map((row) => taskSchema.parse(JSON.parse(payloadRow.parse(row).payload)));
  }

  task(runId: string): WorkflowTask {
    const row = this.db.prepare("SELECT payload FROM workflow_bindings WHERE run_id=?").get(runId);

    if (!row) throw new Error("Workflow does not own this run");

    return taskSchema.parse(JSON.parse(payloadRow.parse(row).payload));
  }

  save(task: WorkflowTask) {
    this.db
      .prepare(
        "INSERT INTO workflow_bindings(run_id,payload) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(task.runId, JSON.stringify(taskSchema.parse(task)));
  }

  savePolicy(policy: WorkflowPolicy) {
    this.db
      .prepare(
        "INSERT INTO workflow_policies VALUES(?,?) ON CONFLICT(route_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(policy.routeId, JSON.stringify(workflowPolicySchema.parse(policy)));
  }

  incidents(routeId: string) {
    return this.db
      .prepare(
        "SELECT incidents.payload FROM incidents JOIN route_incidents ON route_incidents.incident_id=incidents.id WHERE route_incidents.route_id=? ORDER BY json_extract(incidents.payload, '$.lastSeen') DESC, incidents.rowid",
      )
      .all(routeId)
      .map((row) => incidentSchema.parse(JSON.parse(payloadRow.parse(row).payload)));
  }

  transaction(change: () => void) {
    this.db.transaction(change)();
  }
}
