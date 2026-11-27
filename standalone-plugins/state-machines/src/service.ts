import { z } from "zod";
import type Database from "better-sqlite3";
import { createLocalCheckLoop, createReleaseLoopDraft } from "../templates/index.js";
import {
  machineSchema,
  draftViewSchema,
  instanceViewSchema,
  versionSchema,
  instanceSchema,
  entrySchema,
  subscriptionSchema,
  inboxEventSchema,
  invocationSchema,
  attentionSchema,
  valueRowSchema,
  numberRowSchema,
  countRowSchema,
  idRowSchema,
  sequenceRowSchema,
  environmentRowSchema,
  receiptSchema,
  historyRowSchema,
  checkpointSchema,
  type Machine,
  type Version,
  type Instance,
  type Entry,
  type Subscription,
  type InboxEvent,
  type Invocation,
  type AttentionItem,
  type AttentionCause,
} from "./data/records.js";

export type { AttentionItem, AttentionCause } from "./data/records.js";

import { createHash, randomUUID } from "node:crypto";
import {
  isJsonObject,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
  type MachineDefinition,
  type StateDefinition,
} from "./contracts/definition.js";
import {
  canonicalJson,
  validateDefinition,
  compileDraft,
  createEmptyDraft,
  parseDraft,
  selectTransition,
  applyContextPatch,
} from "./definition/index.js";
import { semanticHash, snapshotHash } from "./definition/hash.js";
import { parseActionResult } from "./contracts/result.js";
import { migrateStateMachines, row, rows, type StateMachineDatabase } from "./data/store.js";
import { runtimeLimits as limits } from "./settings.js";
import type {
  Actor,
  AttemptStatus,
  HomeThreadRequest,
  InvocationObservation,
  InvocationResult,
  StateMachineAdapter,
} from "./runtime/adapter.js";

export type StartHome =
  | { kind: "new"; title: string | null }
  | { kind: "thread"; threadId: string }
  | { kind: "none" };

interface AuthorityDecision {
  allowed: boolean;
  reference?: string;
  scope?: string;
}

export class StateMachineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: JsonValue = null,
  ) {
    super(message);
    this.name = "StateMachineError";
  }
}

export interface ServiceOptions {
  database: StateMachineDatabase;
  adapter: StateMachineAdapter;
  clock?: () => number;
  onChange?: (change: { kind: string; id: string; revision: number }) => void;
}

export interface InstanceView extends Omit<
  Instance,
  "starts" | "budget" | "sequence" | "context" | "quarantine"
> {
  latestVersionNumber: number;
  asOf: number;
  summary: string;
  pendingResultCount: number;
  context: { path: string; value: JsonValue; display: string }[];
  budgets: { label: string; used: number; limit: number; subject: string }[];
  steps: {
    invocationId: string;
    entryId: string;
    attemptId: string;
    generation: number;
    specHash: string;
    stateId: string;
    kind: "agent" | "command";
    status: AttemptStatus;
    admissionReason: string | null;
    attempt: number;
    maxAttempts: number;
    dispatchedAt: number | null;
    deadlineAt: number | null;
    nextRetryAt: number | null;
    environmentId: string;
    threadId: string | null;
    confirmedLive: boolean;
  }[];
  unknownOutcomes: { invocationId: string; blocksRestartIn: string | null }[];
  standingAuthority: { stateId: string; reference: string; scope: string }[];
  quarantined: { code: string; reference: string } | null;
}

const terminal = new Set<AttemptStatus>(["succeeded", "failed", "timed-out", "cancelled"]);

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function hash<T>(value: T): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function fail(code: string, message: string, details: JsonValue = null): never {
  throw new StateMachineError(code, message, details);
}

function boundJson<T>(value: T, bytes: number): void {
  if (Buffer.byteLength(canonicalJson(value)) > bytes)
    fail("OUTPUT_LIMIT", `Value exceeds ${bytes} bytes.`);
}

function needString(value: string, label: string): void {
  if (!z.string().trim().min(1).max(256).safeParse(value).success)
    fail("VALIDATION_FAILED", `${label} is required.`);
}

export class StateMachineService {
  private readonly db: StateMachineDatabase;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly versions = new Map<string, Version>();
  private readonly adapter: StateMachineAdapter;
  private readonly clock: () => number;
  private readonly generation: number;
  private readonly onChange: ServiceOptions["onChange"];
  private wakeResolver: (() => void) | null = null;
  private ticking = false;
  constructor(options: ServiceOptions) {
    this.db = options.database;
    this.adapter = options.adapter;
    this.clock = options.clock ?? Date.now;
    this.onChange = options.onChange;
    migrateStateMachines(this.db);
    this.generation = this.db.transaction(() => {
      this.query(
        "INSERT INTO sm_meta(key,value) VALUES('generation',1) ON CONFLICT(key) DO UPDATE SET value=value+1",
      ).run();

      return valueRowSchema.parse(
        this.query("SELECT value FROM sm_meta WHERE key='generation'").get(),
      ).value;
    })();
    this.reconcileStoppedGates();
  }
  private resolveStoppedGates(instance: Instance): boolean {
    if (instance.lifecycle !== "stopped") return false;
    const now = this.clock();

    return (
      this.query(
        "UPDATE sm_attention SET resolved_at=?,document=json_set(document,'$.resolvedAt',?) WHERE instance_id=? AND entry_id=? AND resolved_at IS NULL AND json_extract(document,'$.kind')='gate'",
      ).run(now, now, instance.instanceId, instance.entryId).changes > 0
    );
  }
  private reconcileStoppedGates(): void {
    const instances = this.activeRows(
      instanceSchema,
      this.query(
        "SELECT i.id AS instance_id,i.document FROM sm_instances i WHERE i.lifecycle='stopped' AND EXISTS(SELECT 1 FROM sm_attention a WHERE a.instance_id=i.id AND a.entry_id=json_extract(i.document,'$.entryId') AND a.resolved_at IS NULL AND json_extract(a.document,'$.kind')='gate')",
      ).all(),
    );

    for (const original of instances) {
      const revision = this.tx(() => {
        const instance = this.instance(original.instanceId);

        if (!this.resolveStoppedGates(instance)) return null;
        instance.revision++;
        this.saveInstance(instance);

        return instance.revision;
      });

      if (revision !== null) this.changed("instance", original.instanceId, revision);
    }
  }
  private query(sql: string): Database.Statement {
    const existing = this.statements.get(sql);

    if (existing) return existing;
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);

    return statement;
  }
  private tx<T>(operation: () => T): T {
    return this.db.transaction(() => {
      if (
        valueRowSchema.parse(this.query("SELECT value FROM sm_meta WHERE key='generation'").get())
          .value !== this.generation
      )
        fail("CAPABILITY_UNAVAILABLE", "This dispatcher has been replaced.");

      return operation();
    })();
  }
  private machine(machineId: string): Machine {
    return (
      row(
        machineSchema,
        this.query("SELECT document FROM sm_machines WHERE id=?").get(machineId),
      ) ?? fail("NOT_FOUND", "Machine not found.")
    );
  }
  private version(versionId: string): Version {
    const cached = this.versions.get(versionId);

    if (cached) return cached;

    const version =
      row(
        versionSchema,
        this.query("SELECT document FROM sm_versions WHERE id=?").get(versionId),
      ) ?? fail("NOT_FOUND", "Version not found.");

    this.versions.set(versionId, version);

    return version;
  }
  private quarantine(instanceId: string): void {
    this.tx(() =>
      this.query(
        "INSERT OR IGNORE INTO sm_quarantine(instance_id,code,reference,created_at) VALUES(?,?,?,?)",
      ).run(instanceId, "CORRUPT_RECORD", instanceId, this.clock()),
    );
  }
  private activeRows<T, Input>(schema: z.ZodType<T>, inputs: Input[]): T[] {
    const result: T[] = [];

    for (const input of inputs) {
      const envelope = z.object({ instance_id: z.string(), document: z.string() }).parse(input);

      try {
        result.push(schema.parse(JSON.parse(envelope.document)));
      } catch {
        this.quarantine(envelope.instance_id);
      }
    }

    return result;
  }
  private instance(instanceId: string): Instance {
    if (this.query("SELECT instance_id FROM sm_quarantine WHERE instance_id=?").get(instanceId))
      fail(
        "CAPABILITY_UNAVAILABLE",
        "This instance is quarantined. Its state and owned work were preserved.",
        { reference: instanceId },
      );

    try {
      return (
        row(
          instanceSchema,
          this.query("SELECT document FROM sm_instances WHERE id=?").get(instanceId),
        ) ?? fail("NOT_FOUND", "Instance not found.")
      );
    } catch (error) {
      if (error instanceof StateMachineError) throw error;
      this.quarantine(instanceId);
      fail("CAPABILITY_UNAVAILABLE", "The instance record is corrupt. It has not been reset.", {
        reference: instanceId,
      });
    }
  }
  private definition(instance: Instance): MachineDefinition {
    return this.version(instance.versionId).document;
  }
  private state(instance: Instance): StateDefinition {
    return (
      this.definition(instance).states.find((state) => state.id === instance.stateId) ??
      fail("VALIDATION_FAILED", "Pinned state is missing.")
    );
  }
  private saveInstance(instance: Instance): void {
    instance.updatedAt = this.clock();
    this.query(
      "INSERT INTO sm_instances(id,machine_id,version_id,project_id,environment_id,lifecycle,updated_at,document) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lifecycle=excluded.lifecycle,updated_at=excluded.updated_at,document=excluded.document",
    ).run(
      instance.instanceId,
      instance.machineId,
      instance.versionId,
      instance.projectId,
      instance.environmentId,
      instance.lifecycle,
      instance.updatedAt,
      JSON.stringify(instance),
    );
  }
  private saveMachine(machine: Machine): void {
    this.query(
      "INSERT INTO sm_machines(id,project_id,updated_at,document) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,document=excluded.document",
    ).run(machine.machineId, machine.projectId, machine.updatedAt, JSON.stringify(machine));
  }
  private saveInvocation(invocation: Invocation): void {
    this.query(
      "INSERT INTO sm_invocations(id,instance_id,entry_id,status,environment_id,owned,retired,due_at,document) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,owned=excluded.owned,retired=excluded.retired,due_at=excluded.due_at,document=excluded.document",
    ).run(
      invocation.invocationId,
      invocation.instanceId,
      invocation.entryId,
      invocation.status,
      invocation.environmentId,
      invocation.owned ? 1 : 0,
      invocation.retired ? 1 : 0,
      invocation.dueAt,
      JSON.stringify(invocation),
    );
  }
  private invocations(instanceId: string): Invocation[] {
    return rows(
      invocationSchema,
      this.query(
        "SELECT document FROM sm_invocations WHERE instance_id=? AND entry_id=? UNION SELECT document FROM sm_invocations WHERE instance_id=? AND owned=1",
      ).all(instanceId, this.instance(instanceId).entryId, instanceId),
    );
  }
  private saveSubscription(subscription: Subscription): void {
    this.query(
      "INSERT INTO sm_subscriptions(id,instance_id,entry_id,document) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
    ).run(
      subscription.subscriptionId,
      subscription.instanceId,
      subscription.entryId,
      JSON.stringify(subscription),
    );
  }
  private subscriptions(instanceId: string, entryId: string): Subscription[] {
    return rows(
      subscriptionSchema,
      this.query("SELECT document FROM sm_subscriptions WHERE instance_id=? AND entry_id=?").all(
        instanceId,
        entryId,
      ),
    );
  }
  private history(instance: Instance, kind: string, data: JsonValue): void {
    this.query("INSERT INTO sm_history(instance_id,kind,created_at,document) VALUES(?,?,?,?)").run(
      instance.instanceId,
      kind,
      this.clock(),
      JSON.stringify(data),
    );
  }
  private request<T, P>(
    scope: string,
    requestId: string,
    payload: P,
    resultSchema: z.ZodType<T>,
    operation: () => T,
  ): T {
    needString(requestId, "requestId");
    const payloadHash = hash(payload);

    const stored = this.query(
      "SELECT payload_hash,document FROM sm_requests WHERE scope=? AND request_id=?",
    ).get(scope, requestId);

    const existing = stored ? receiptSchema.parse(stored) : null;

    if (existing) {
      if (existing.payload_hash !== payloadHash)
        fail("EVENT_ID_CONFLICT", "The request ID was already used with different input.");

      return resultSchema.parse(JSON.parse(existing.document));
    }

    const result = resultSchema.parse(operation());
    this.query(
      "INSERT INTO sm_requests(scope,request_id,payload_hash,document,created_at) VALUES(?,?,?,?,?)",
    ).run(scope, requestId, payloadHash, JSON.stringify(result), this.clock());

    return result;
  }
  private changed(kind: string, idValue: string, revision: number): void {
    this.wake();
    this.onChange?.({ kind, id: idValue, revision });
  }
  createMachine(
    input: {
      projectId: string;
      name: string;
      description?: string;
      requestId: string;
      document?: unknown;
      template?: "blank" | "release-loop" | "local-check-loop";
      environmentId?: string;
    },
    _actor?: Actor,
  ): Machine {
    needString(input.projectId, "projectId");
    needString(input.name, "name");

    const result = this.tx(() =>
      this.request(`create:${input.projectId}`, input.requestId, input, machineSchema, () => {
        const machineId = id("mch");

        if (input.template === "local-check-loop")
          needString(input.environmentId ?? "", "environmentId");

        const document =
          input.template === "release-loop"
            ? createReleaseLoopDraft({
                machineId,
                name: input.name,
                environmentId: input.environmentId,
              })
            : input.template === "local-check-loop"
              ? createLocalCheckLoop({
                  machineId,
                  name: input.name,
                  environmentId: input.environmentId ?? "",
                })
              : createEmptyDraft({ machineId, name: input.name, description: input.description });

        if (input.description !== undefined) document.description = input.description;

        const machine: Machine = {
          machineId,
          projectId: input.projectId,
          name: input.name,
          description: input.description ?? document.description,
          draftRevision: 0,
          document: input.document ? parseDraft(input.document) : document,
          publishedVersionId: null,
          updatedAt: this.clock(),
        };

        this.saveMachine(machine);

        return machine;
      }),
    );

    this.changed("machine", result.machineId, result.draftRevision);

    return result;
  }
  listMachines(query: { projectId?: string; limit?: number } = {}, _actor?: Actor): Machine[] {
    const limit = Math.min(limits.readPage, Math.max(1, query.limit ?? limits.readPage));

    return rows(
      machineSchema,
      query.projectId
        ? this.query(
            "SELECT document FROM sm_machines WHERE project_id=? ORDER BY updated_at DESC LIMIT ?",
          ).all(query.projectId, limit)
        : this.query("SELECT document FROM sm_machines ORDER BY updated_at DESC LIMIT ?").all(
            limit,
          ),
    );
  }
  getDraft(input: { machineId: string }, _actor?: Actor) {
    const machine = this.machine(input.machineId);

    return {
      machineId: machine.machineId,
      revision: machine.draftRevision,
      document: machine.document,
      updatedAt: machine.updatedAt,
    };
  }
  saveDraft(
    input: { machineId: string; expectedRevision: number; document: unknown; requestId: string },
    _actor?: Actor,
  ) {
    boundJson(input.document, 262_144);

    const result = this.tx(() =>
      this.request(`draft:${input.machineId}`, input.requestId, input, draftViewSchema, () => {
        const machine = this.machine(input.machineId);

        if (machine.draftRevision !== input.expectedRevision)
          fail("REVISION_CONFLICT", "The draft changed. Reload the latest draft.");
        const document = parseDraft(input.document);

        if (document.machineId !== machine.machineId)
          fail("SCOPE_MISMATCH", "The draft belongs to a different machine.");
        machine.document = document;
        machine.name = document.name;
        machine.description = document.description;
        machine.draftRevision++;
        machine.updatedAt = this.clock();
        this.saveMachine(machine);

        return this.getDraft(input);
      }),
    );

    this.changed("machine", input.machineId, result.revision);

    return result;
  }
  validateDraft(
    input: { machineId: string; revision?: number },
    _actor?: Actor,
  ): ReturnType<typeof validateDefinition> {
    const machine = this.machine(input.machineId);

    if (input.revision !== undefined && machine.draftRevision !== input.revision)
      fail("REVISION_CONFLICT", "The draft changed.");

    return compileDraft(machine.document);
  }
  publishVersion(
    input: { machineId: string; expectedRevision: number; requestId: string; note?: string },
    _actor?: Actor,
  ): Version {
    const result = this.tx(() =>
      this.request(`publish:${input.machineId}`, input.requestId, input, versionSchema, () => {
        const machine = this.machine(input.machineId);

        if (machine.draftRevision !== input.expectedRevision)
          fail("REVISION_CONFLICT", "The draft changed.");
        const checked = compileDraft(machine.document);

        if (!checked.valid || !checked.definition)
          fail(
            "VALIDATION_FAILED",
            "Resolve the draft problems before publishing.",
            checked.problems.map((problem) => ({ ...problem })),
          );

        if (checked.definition.machineId !== machine.machineId)
          fail("SCOPE_MISMATCH", "The definition belongs to a different machine.");

        const number = numberRowSchema.parse(
          this.query(
            "SELECT COALESCE(MAX(number),0)+1 AS number FROM sm_versions WHERE machine_id=?",
          ).get(machine.machineId),
        ).number;

        const version: Version = {
          versionId: id("ver"),
          machineId: machine.machineId,
          number,
          document: checked.definition,
          semanticHash: semanticHash(checked.definition),
          snapshotHash: snapshotHash(checked.definition),
          note: z
            .string()
            .max(2000)
            .parse(input.note ?? ""),
          createdAt: this.clock(),
        };

        this.query("INSERT INTO sm_versions(id,machine_id,number,document) VALUES(?,?,?,?)").run(
          version.versionId,
          machine.machineId,
          number,
          JSON.stringify(version),
        );
        machine.publishedVersionId = version.versionId;
        this.saveMachine(machine);

        return version;
      }),
    );

    this.changed("machine", input.machineId, input.expectedRevision);

    return result;
  }
  listVersions(input: { machineId: string }, _actor?: Actor): Version[] {
    return rows(
      versionSchema,
      this.query(
        "SELECT document FROM sm_versions WHERE machine_id=? ORDER BY number DESC LIMIT 100",
      ).all(input.machineId),
    );
  }
  getVersion(input: { versionId: string }, _actor?: Actor): Version {
    return structuredClone(this.version(input.versionId));
  }
  exportDefinition(input: { machineId: string; versionId?: string }, _actor?: Actor) {
    const machine = this.machine(input.machineId);

    if (!input.versionId) return machine.document;
    const version = this.version(input.versionId);

    if (version.machineId !== input.machineId)
      fail("SCOPE_MISMATCH", "Version belongs to a different machine.");

    return structuredClone(version.document);
  }
  async startInstance(
    input: {
      machineId: string;
      versionId: string;
      environmentId: string;
      context?: JsonObject;
      home: StartHome;
      requestId: string;
    },
    _actor?: Actor,
  ): Promise<InstanceView> {
    const machine = this.machine(input.machineId);
    const version = this.version(input.versionId);

    if (version.machineId !== machine.machineId)
      fail("SCOPE_MISMATCH", "Version belongs to a different machine.");

    const existing = this.query(
      "SELECT document FROM sm_requests WHERE scope=? AND request_id=?",
    ).get(`start:${input.machineId}`, input.requestId);

    if (existing)
      return this.tx(() =>
        this.request(`start:${input.machineId}`, input.requestId, input, instanceViewSchema, () =>
          fail("NOT_FOUND", "Start receipt missing."),
        ),
      );

    const environment = await this.adapter.validateEnvironment({
      projectId: machine.projectId,
      environmentId: input.environmentId,
    });

    if (!environment.persistent)
      fail("ENVIRONMENT_LIFETIME_UNSUPPORTED", "Choose an existing persistent environment.");

    const context = input.context ?? version.document.initialContext;
    boundJson(context, 65_536);
    const checked = applyContextPatch(context, [], { context }, version.document.contextSchema);

    if (
      this.query(
        "SELECT id FROM sm_invocations WHERE environment_id=? AND owned=1 AND status='uncertain' LIMIT 1",
      ).get(input.environmentId)
    )
      fail("INVOCATION_UNCERTAIN", "An unresolved invocation still owns this environment.");

    const instanceId = id("ins");

    const homeThreadId = await this.prepareHome(input.home, {
      instanceId,
      projectId: machine.projectId,
      environmentId: input.environmentId,
      machineName: machine.name,
      requestId: input.requestId,
    });

    const result = this.tx(() =>
      this.request(`start:${input.machineId}`, input.requestId, input, instanceViewSchema, () => {
        const blocked = this.query(
          "SELECT id FROM sm_invocations WHERE environment_id=? AND owned=1 AND status='uncertain' LIMIT 1",
        ).get(input.environmentId);

        if (blocked)
          fail("INVOCATION_UNCERTAIN", "An unresolved invocation still owns this environment.");

        const instance: Instance = {
          instanceId,
          machineId: machine.machineId,
          versionId: version.versionId,
          versionNumber: version.number,
          projectId: machine.projectId,
          environmentId: input.environmentId,
          revision: 0,
          controlRevision: 0,
          lifecycle: "running",
          phase: "waiting",
          pauseAfterStep: false,
          stateId: version.document.initialStateId,
          entryId: "",
          context: checked,
          sequence: 0,
          createdAt: this.clock(),
          updatedAt: this.clock(),
          cyclesCompleted: 0,
          lastTransition: null,
          starts: [],
          budget: {},
          quarantine: null,
          homeThreadId,
        };

        this.enter(instance, instance.stateId, null);
        this.saveInstance(instance);
        this.history(instance, "started", {
          versionId: version.versionId,
          entryId: instance.entryId,
        });

        return this.inspectInstance({ instanceId: instance.instanceId });
      }),
    );

    this.changed("instance", result.instanceId, result.revision);

    return result;
  }
  private async prepareHome(home: StartHome, request: HomeThreadRequest): Promise<string | null> {
    if (home.kind === "none") return null;

    if (home.kind === "thread") {
      const problem = await this.adapter.homeThreadProblem({
        projectId: request.projectId,
        threadId: home.threadId,
      });

      if (problem !== null) fail("HOME_THREAD_INVALID", problem);

      return home.threadId;
    }

    try {
      return (
        await this.adapter.createHomeThread({
          ...request,
          machineName: home.title ?? request.machineName,
        })
      ).threadId;
    } catch (error) {
      fail(
        "HOME_THREAD_UNAVAILABLE",
        `Couldn't create this run's home chat: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  private enter(instance: Instance, stateId: string, cause: AttentionCause | null): void {
    instance.stateId = stateId;
    instance.entryId = id("ent");
    instance.sequence++;
    const state = this.state(instance);

    const entry: Entry = {
      entryId: instance.entryId,
      instanceId: instance.instanceId,
      stateId,
      sequence: instance.sequence,
      enteredAt: this.clock(),
      exitedAt: null,
      attempts: 0,
      exitTrigger: null,
    };

    this.query(
      "INSERT INTO sm_entries(id,instance_id,state_id,sequence,closed_at,document) VALUES(?,?,?,?,NULL,?)",
    ).run(entry.entryId, instance.instanceId, entry.stateId, entry.sequence, JSON.stringify(entry));
    instance.phase =
      state.kind === "manual"
        ? "needs-person"
        : state.kind === "agent" || state.kind === "command"
          ? "queued"
          : "waiting";

    if (state.kind === "end") {
      instance.lifecycle = state.outcome === "success" ? "completed" : "failed";
      instance.phase = null;
    }

    if (state.kind === "manual")
      this.attention(
        instance,
        "gate",
        state.title,
        state.prompt,
        null,
        state.decisions.map((decision) => ({
          name: decision.id,
          label: decision.label,
          targetStateId:
            this.definition(instance).transitions.find(
              (transition) =>
                transition.from === state.id &&
                transition.trigger.kind === "decision" &&
                transition.trigger.decisionId === decision.id,
            )?.to ?? null,
          evidenceRequired: decision.evidenceRequired,
          disabledReason: null,
        })),
        null,
        cause,
      );

    if (state.kind === "agent" || state.kind === "command") {
      const invocation: Invocation = {
        instanceId: instance.instanceId,
        entryId: instance.entryId,
        invocationId: id("inv"),
        attemptId: id("try"),
        generation: this.generation,
        specHash: hash({ state, context: instance.context }),
        projectId: instance.projectId,
        environmentId: state.action.environmentId,
        state,
        context: instance.context,
        dispatchedAt: 0,
        deadlineAt: 0,
        threadId: null,
        status: "pending",
        owned: false,
        retired: false,
        retainedBytes: 0,
        confirmedLive: false,
        attempt: 1,
        maxAttempts: Math.min(3, state.maxAttempts),
        nextRetryAt: null,
        admissionReason: null,
        candidate: null,
        receivedAt: null,
        quiescentAt: null,
        cancelReason: null,
        unknownAcknowledged: false,
        authority: null,
        retrySafe: false,
        dueAt: this.clock(),
        homeThreadId: instance.homeThreadId,
      };

      if (invocation.environmentId !== instance.environmentId)
        fail("SCOPE_MISMATCH", "Every action must use the instance environment.");
      this.saveInvocation(invocation);
    }

    const eventTypes = new Set(
      this.definition(instance)
        .transitions.filter(
          (transition) => transition.from === state.id && transition.trigger.kind === "event",
        )
        .map((transition) =>
          transition.trigger.kind === "event" ? transition.trigger.eventType : "",
        ),
    );

    if (state.kind === "wait")
      for (const trigger of state.triggers)
        if (trigger.kind === "event") eventTypes.add(trigger.eventType);

    for (const eventType of eventTypes)
      this.saveSubscription({
        subscriptionId: id("sub"),
        instanceId: instance.instanceId,
        entryId: instance.entryId,
        eventType,
        epoch: 1,
        openedAt: this.clock(),
        settled: 0,
        nextDue: null,
        everyMs: null,
        observation: null,
        observationHash: null,
        observedAt: null,
        observationCount: 0,
        sourceVersion: null,
        pendingEvent: null,
      });

    if (state.kind === "wait")
      for (const trigger of state.triggers)
        if (trigger.kind === "check")
          this.saveSubscription({
            subscriptionId: id("sub"),
            instanceId: instance.instanceId,
            entryId: instance.entryId,
            eventType: "timer",
            epoch: 1,
            openedAt: this.clock(),
            settled: 0,
            nextDue: this.clock() + trigger.everyMs,
            everyMs: trigger.everyMs,
            observation: null,
            observationHash: null,
            observedAt: null,
            observationCount: 0,
            sourceVersion: null,
            pendingEvent: null,
          });
  }
  private attention(
    instance: Instance,
    kind: string,
    title: string,
    bodyMarkdown: string,
    invocationId: string | null,
    decisions: AttentionItem["decisions"] = [],
    interactionId: string | null = null,
    cause: AttentionCause | null = null,
  ): AttentionItem {
    const existing = rows(
      attentionSchema,
      this.query(
        "SELECT document FROM sm_attention WHERE instance_id=? AND entry_id=? AND resolved_at IS NULL",
      ).all(instance.instanceId, instance.entryId),
    ).find(
      (item) =>
        item.kind === kind &&
        item.invocationId === invocationId &&
        item.interactionId === interactionId,
    );

    if (existing) return existing;
    instance.revision++;

    const item: AttentionItem = {
      attentionId: id("att"),
      kind,
      instanceId: instance.instanceId,
      entryId: instance.entryId,
      invocationId,
      revision: instance.revision,
      title,
      bodyMarkdown,
      evidenceSummary: null,
      interactionId,
      cause,
      createdAt: this.clock(),
      resolvedAt: null,
      decisions,
    };

    this.query(
      "INSERT INTO sm_attention(id,instance_id,entry_id,resolved_at,document) VALUES(?,?,?,NULL,?)",
    ).run(item.attentionId, item.instanceId, item.entryId, JSON.stringify(item));
    instance.phase = kind === "uncertain" ? "uncertain" : "needs-person";

    this.history(instance, "problem", {
      attentionId: item.attentionId,
      kind: item.kind,
      invocationId: item.invocationId,
    });

    return item;
  }
  eventCatalog(
    input: { instanceId: string },
    _actor?: Actor,
  ): {
    eventType: string;
    label: string;
    source: string;
    personOnly: boolean;
    subscriptionId: string;
    epoch: number;
    payloadSchema: JsonValue;
  }[] {
    const instance = this.instance(input.instanceId);

    return this.subscriptions(instance.instanceId, instance.entryId).map((subscription) => ({
      eventType: subscription.eventType,
      label: subscription.eventType,
      source: subscription.eventType === "timer" ? "observer" : "Omnyo client",
      personOnly: subscription.eventType.startsWith("person."),
      subscriptionId: subscription.subscriptionId,
      epoch: subscription.epoch,
      payloadSchema: {},
    }));
  }
  signalInstance(
    input: {
      instanceId: string;
      subscriptionId: string;
      epoch: number;
      sourceId: string;
      eventId: string;
      entryId: string;
      subject: string;
      type: string;
      payload: JsonValue;
      requestId?: string;
    },
    _actor?: Actor,
  ): { eventId: string; sequence: number; disposition: string; epoch: number } {
    boundJson(input.payload, 16_384);
    needString(input.sourceId, "sourceId");
    needString(input.eventId, "eventId");
    needString(input.subject, "subject");

    const result = this.tx(() => {
      const instance = this.instance(input.instanceId);

      if (instance.entryId !== input.entryId)
        fail("STALE_ENTRY", "This signal belongs to an earlier state visit.");

      const subscription = row(
        subscriptionSchema,
        this.query("SELECT document FROM sm_subscriptions WHERE id=?").get(input.subscriptionId),
      );

      if (
        !subscription ||
        subscription.instanceId !== input.instanceId ||
        subscription.entryId !== input.entryId ||
        subscription.eventType !== input.type
      )
        fail("STALE_SUBSCRIPTION", "The event is not subscribed in this visit.");

      if (subscription.epoch !== input.epoch)
        fail(
          input.epoch < subscription.epoch ? "EXPIRED_RECEIPT" : "STALE_SUBSCRIPTION",
          "This subscription window has expired.",
          { epoch: subscription.epoch },
        );
      const dedupKey = hash({ sourceId: input.sourceId, eventId: input.eventId });

      const payloadHash = hash({
        type: input.type,
        payload: input.payload,
        subject: input.subject,
      });

      const stored = this.query(
        "SELECT payload_hash,document FROM sm_inbox WHERE instance_id=? AND subscription_id=? AND epoch=? AND dedup_key=?",
      ).get(input.instanceId, input.subscriptionId, input.epoch, dedupKey);

      const prior = stored ? receiptSchema.parse(stored) : null;

      if (prior) {
        if (prior.payload_hash !== payloadHash)
          fail("EVENT_ID_CONFLICT", "The event ID was already accepted with different content.");
        const event = inboxEventSchema.parse(JSON.parse(prior.document));

        return {
          eventId: event.eventId,
          sequence: event.sequence,
          disposition: "accepted",
          epoch: input.epoch,
        };
      }

      if (["stopping", "stopped", "completed", "failed"].includes(instance.lifecycle))
        fail("STALE_SUBSCRIPTION", "This instance no longer accepts events.");

      const state = this.state(instance);

      if (state.kind === "wait") {
        const filters = state.triggers.filter(
          (trigger) => trigger.kind === "event" && trigger.eventType === input.type,
        );

        const payload = z.record(z.string(), jsonValueSchema).safeParse(input.payload);

        const matches = filters.some(
          (trigger) =>
            trigger.kind === "event" &&
            Object.entries(trigger.filter).every(
              ([key, value]) =>
                payload.success &&
                Object.hasOwn(payload.data, key) &&
                canonicalJson(payload.data[key]) === canonicalJson(value),
            ),
        );

        if (filters.length && !matches)
          fail("VALIDATION_FAILED", "The event payload does not match this subscription filter.");
      }

      const pending = countRowSchema.parse(
        this.query(
          "SELECT COUNT(*) AS count FROM sm_inbox WHERE instance_id=? AND status='pending'",
        ).get(instance.instanceId),
      ).count;

      if (pending >= limits.pendingEvents)
        fail("BACKPRESSURE", "The accepted event queue is full.");

      const event = this.enqueue(
        instance,
        input.type,
        input.payload,
        input.subject,
        input.subscriptionId,
        input.epoch,
        dedupKey,
        payloadHash,
      );

      this.saveInstance(instance);

      return {
        eventId: event.eventId,
        sequence: event.sequence,
        disposition: "accepted",
        epoch: input.epoch,
      };
    });

    this.changed("instance", input.instanceId, this.instance(input.instanceId).revision);

    return result;
  }
  private enqueue(
    instance: Instance,
    type: string,
    payload: JsonValue,
    subject: string,
    subscriptionId: string | null = null,
    epoch: number | null = null,
    dedupKey: string | null = null,
    payloadHash = hash({ type, payload }),
  ): InboxEvent {
    if (
      countRowSchema.parse(
        this.query(
          "SELECT COUNT(*) AS count FROM sm_inbox WHERE instance_id=? AND status='pending'",
        ).get(instance.instanceId),
      ).count >= limits.pendingEvents
    )
      fail("BACKPRESSURE", "The accepted event queue is full.");
    instance.sequence++;

    const event: InboxEvent = {
      eventId: id("evt"),
      instanceId: instance.instanceId,
      entryId: instance.entryId,
      sequence: instance.sequence,
      type,
      payload,
      subject,
      receivedAt: this.clock(),
      status: "pending",
      reason: null,
      subscriptionId,
      epoch,
    };

    this.query(
      "INSERT INTO sm_inbox(id,instance_id,entry_id,sequence,status,subscription_id,epoch,dedup_key,payload_hash,document) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      event.eventId,
      event.instanceId,
      event.entryId,
      event.sequence,
      event.status,
      subscriptionId,
      epoch,
      dedupKey,
      payloadHash,
      JSON.stringify(event),
    );

    return event;
  }
  controlInstance(
    input: {
      instanceId: string;
      expectedControlRevision: number;
      operation: "pause" | "pause-after-step" | "resume" | "stop" | "cancel-step" | "mark-unknown";
      requestId: string;
      entryId?: string;
      invocationId?: string;
      reason?: string;
      evidence?: string;
      expectedRevision?: number;
      acknowledged?: boolean;
    },
    _actor?: Actor,
  ): InstanceView {
    const result = this.tx(() =>
      this.request(
        `control:${input.instanceId}`,
        input.requestId,
        input,
        instanceViewSchema,
        () => {
          const instance = this.instance(input.instanceId);

          if (instance.controlRevision !== input.expectedControlRevision)
            fail("REVISION_CONFLICT", "Run controls changed. Reload the run.");

          if (input.entryId !== undefined && input.entryId !== instance.entryId)
            fail("STALE_ENTRY", "This control belongs to an earlier state visit.");

          const active = this.invocations(instance.instanceId).filter(
            (invocation) =>
              invocation.entryId === instance.entryId && !terminal.has(invocation.status),
          );

          const invocation = input.invocationId
            ? active.find((item) => item.invocationId === input.invocationId)
            : active[0];

          if (input.operation === "pause") {
            if (instance.lifecycle !== "running")
              fail("VALIDATION_FAILED", "Only a running instance can pause.");
            instance.lifecycle = "paused";
            instance.pauseAfterStep = false;
          }

          if (input.operation === "pause-after-step") {
            if (instance.lifecycle !== "running")
              fail("VALIDATION_FAILED", "Only a running instance can pause.");
            instance.pauseAfterStep = active.some((item) => item.owned);

            if (!instance.pauseAfterStep) instance.lifecycle = "paused";
          }

          if (input.operation === "resume") {
            if (instance.lifecycle !== "paused")
              fail("VALIDATION_FAILED", "Only a paused instance can resume.");
            instance.lifecycle = "running";
            instance.pauseAfterStep = false;
          }

          if (input.operation === "stop") {
            if (["completed", "failed", "stopped"].includes(instance.lifecycle))
              fail("VALIDATION_FAILED", "This instance has ended.");
            instance.lifecycle = "stopping";
            instance.pauseAfterStep = false;

            for (const item of active) {
              if (item.owned) {
                item.status = "cancel-requested";
                item.cancelReason = "stop";
                item.dueAt = this.clock();
              } else {
                item.status = "cancelled";
                item.retired = true;
                item.quiescentAt = this.clock();
              }

              this.saveInvocation(item);
            }

            if (!active.some((item) => item.owned)) {
              instance.lifecycle = "stopped";
              instance.phase = null;
            }
          }

          if (input.operation === "cancel-step") {
            if (!invocation || !input.invocationId || !input.entryId)
              fail("STALE_ENTRY", "Select the exact active step.");
            invocation.status = invocation.owned ? "cancel-requested" : "cancelled";

            if (!invocation.owned) invocation.retired = true;
            invocation.cancelReason = "cancel";
            invocation.dueAt = this.clock();

            if (!invocation.owned) this.enqueue(instance, "cancelled", {}, invocation.invocationId);
            this.saveInvocation(invocation);
          }

          if (input.operation === "mark-unknown") {
            if (
              instance.lifecycle !== "stopping" ||
              !invocation ||
              !input.invocationId ||
              !input.entryId
            )
              fail(
                "STOP_PENDING",
                "Mark outcome unknown is available only for an exact stopping step.",
              );

            if (input.expectedRevision !== instance.revision)
              fail("REVISION_CONFLICT", "The run changed.");

            if (input.acknowledged !== true)
              fail("VALIDATION_FAILED", "Acknowledge that this records an unknown outcome.");

            if (invocation.confirmedLive)
              fail("STOP_PENDING", "The step is confirmed running. Wait for it to stop.");
            needString(input.reason ?? "", "reason");
            needString(input.evidence ?? "", "evidence");
            invocation.status = "uncertain";
            invocation.unknownAcknowledged = true;
            invocation.owned = true;
            this.saveInvocation(invocation);
            instance.lifecycle = "stopped";
            instance.phase = "uncertain";
            this.attention(
              instance,
              "uncertain",
              "Outcome unknown",
              input.reason ?? "",
              invocation.invocationId,
              [
                {
                  name: "reconcile",
                  label: "Check outcome",
                  targetStateId: null,
                  evidenceRequired: false,
                  disabledReason: null,
                },
              ],
            );
          }

          this.resolveStoppedGates(instance);
          instance.controlRevision++;
          instance.revision++;
          this.saveInstance(instance);
          this.history(instance, "control", {
            operation: input.operation,
            entryId: instance.entryId,
            recordedBy: "Omnyo client",
          });

          return this.inspectInstance(input);
        },
      ),
    );

    this.changed("instance", input.instanceId, result.revision);

    return result;
  }
  countVersionInstances(input: { versionId: string }): number {
    return countRowSchema.parse(
      this.query("SELECT COUNT(*) AS count FROM sm_instances WHERE version_id=?").get(
        input.versionId,
      ),
    ).count;
  }
  countMachineAttention(input: { machineId: string }): number {
    return countRowSchema.parse(
      this.query(
        "SELECT COUNT(*) AS count FROM sm_attention a JOIN sm_instances i ON i.id=a.instance_id WHERE i.machine_id=? AND a.resolved_at IS NULL",
      ).get(input.machineId),
    ).count;
  }
  listAttention(
    input: { instanceId?: string; machineId?: string; limit?: number } = {},
    _actor?: Actor,
  ): AttentionItem[] {
    const clauses = ["a.resolved_at IS NULL"];
    const parameters: (string | number)[] = [];

    if (input.instanceId) {
      clauses.push("a.instance_id=?");
      parameters.push(input.instanceId);
    }

    if (input.machineId) {
      clauses.push("i.machine_id=?");
      parameters.push(input.machineId);
    }

    parameters.push(Math.min(100, Math.max(1, input.limit ?? 100)));

    return rows(
      attentionSchema,
      this.query(
        `SELECT a.document FROM sm_attention a JOIN sm_instances i ON i.id=a.instance_id WHERE ${clauses.join(" AND ")} ORDER BY a.rowid LIMIT ?`,
      ).all(...parameters),
    );
  }
  listHomeAttention(): { item: AttentionItem; homeThreadId: string }[] {
    return this.listAttention({ limit: 100 }).flatMap((item) => {
      if (item.kind === "agent-input") return [];
      const { homeThreadId } = this.instance(item.instanceId);

      return homeThreadId === null ? [] : [{ item, homeThreadId }];
    });
  }
  async resolveAttention(
    input: {
      instanceId: string;
      attentionId: string;
      entryId: string;
      expectedRevision: number;
      decision: string;
      evidence: string;
      requestId: string;
    },
    _actor?: Actor,
  ): Promise<InstanceView> {
    let observation: InvocationObservation | null = null;

    const original = row(
      attentionSchema,
      this.query("SELECT document FROM sm_attention WHERE id=?").get(input.attentionId),
    );

    if (original?.invocationId && input.decision === "reconcile") {
      const invocation = this.invocations(input.instanceId).find(
        (item) => item.invocationId === original.invocationId,
      );

      if (invocation) observation = await this.adapter.inspect(invocation);
    }

    const result = this.tx(() =>
      this.request(
        `resolve:${input.instanceId}`,
        input.requestId,
        input,
        instanceViewSchema,
        () => {
          const instance = this.instance(input.instanceId);

          if (instance.revision !== input.expectedRevision)
            fail("REVISION_CONFLICT", "The run changed.");

          if (instance.entryId !== input.entryId)
            fail("STALE_ENTRY", "This decision belongs to an earlier visit.");

          const attention = row(
            attentionSchema,
            this.query("SELECT document FROM sm_attention WHERE id=?").get(input.attentionId),
          );

          if (
            !attention ||
            attention.resolvedAt ||
            attention.instanceId !== input.instanceId ||
            attention.entryId !== input.entryId
          )
            fail("STALE_ENTRY", "This attention item is no longer current.");
          const decision = attention.decisions.find((item) => item.name === input.decision);

          if (!decision) fail("VALIDATION_FAILED", "Choose an allowed decision.");

          if (decision.disabledReason) fail("STOP_PENDING", decision.disabledReason);

          if (decision.evidenceRequired && !attention.invocationId)
            needString(input.evidence, "evidence");

          if (attention.invocationId) {
            if (!observation || observation.status !== "quiescent" || observation.confirmedLive)
              fail("INVOCATION_UNCERTAIN", "The exact step has not been confirmed stopped.");

            const invocation = this.invocations(instance.instanceId).find(
              (item) => item.invocationId === attention.invocationId,
            );

            if (!invocation) fail("NOT_FOUND", "Step not found.");
            invocation.unknownAcknowledged = false;
            this.applyObservation(instance, invocation, observation);
          } else
            this.enqueue(
              instance,
              `decision.${input.decision}`,
              { evidence: input.evidence },
              input.attentionId,
            );
          attention.resolvedAt = this.clock();
          attention.evidenceSummary = input.evidence.slice(0, 2_000);
          this.query("UPDATE sm_attention SET resolved_at=?,document=? WHERE id=?").run(
            attention.resolvedAt,
            JSON.stringify(attention),
            attention.attentionId,
          );
          instance.revision++;
          this.saveInstance(instance);
          this.history(instance, "decision", {
            attentionId: attention.attentionId,
            decision: input.decision,
            evidence: input.evidence,
            recordedBy: "Omnyo client",
          });

          return this.inspectInstance(input);
        },
      ),
    );

    this.changed("instance", input.instanceId, result.revision);

    return result;
  }
  submitResult(
    input: {
      instanceId: string;
      entryId: string;
      invocationId: string;
      attemptId: string;
      generation: number;
      result: unknown;
    },
    actor: Actor,
  ): { accepted: true; status: "result-ready"; receivedAt: number } {
    const result = this.tx(() => {
      const instance = this.instance(input.instanceId);

      if (instance.entryId !== input.entryId)
        fail("STALE_ENTRY", "This result belongs to an earlier visit.");

      const invocation = this.invocations(instance.instanceId).find(
        (item) => item.invocationId === input.invocationId,
      );

      if (
        !invocation ||
        invocation.attemptId !== input.attemptId ||
        invocation.generation !== input.generation ||
        invocation.state.kind !== "agent" ||
        !invocation.threadId ||
        actor.kind !== "worker" ||
        actor.threadId !== invocation.threadId ||
        !invocation.owned
      )
        fail("SCOPE_MISMATCH", "Result tool is restricted to the exact owned step.");
      const parsed = parseActionResult(invocation.state, input.result);

      const candidate: InvocationResult = {
        type: "result",
        outcome: parsed.outcome,
        payload: parsed.payload,
      };

      if (invocation.candidate) {
        if (hash(invocation.candidate) !== hash(candidate))
          fail("EVENT_ID_CONFLICT", "A different result was already submitted.");

        return {
          accepted: true as const,
          status: "result-ready" as const,
          receivedAt: invocation.receivedAt ?? this.clock(),
        };
      }

      if (terminal.has(invocation.status)) fail("STALE_ENTRY", "The step has already ended.");
      invocation.candidate = candidate;
      invocation.receivedAt = this.clock();

      if (
        invocation.cancelReason === null &&
        invocation.status !== "cancel-requested" &&
        invocation.status !== "uncertain"
      )
        invocation.status = "result-ready";
      invocation.dueAt = this.clock();
      this.saveInvocation(invocation);
      instance.revision++;
      this.saveInstance(instance);
      this.history(instance, "result-ready", {
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        receivedAt: invocation.receivedAt,
      });

      return {
        accepted: true as const,
        status: "result-ready" as const,
        receivedAt: invocation.receivedAt,
      };
    });

    this.changed("instance", input.instanceId, this.instance(input.instanceId).revision);

    return result;
  }
  inspectInstance(input: { instanceId: string }, _actor?: Actor): InstanceView {
    const instance = this.instance(input.instanceId);
    const invocations = this.invocations(instance.instanceId);

    const latest = numberRowSchema.parse(
      this.query(
        "SELECT COALESCE(MAX(number),0) AS number FROM sm_versions WHERE machine_id=?",
      ).get(instance.machineId),
    ).number;

    const { starts: _starts, budget, sequence: _sequence, context, quarantine, ...base } = instance;

    return {
      ...base,
      latestVersionNumber: latest,
      asOf: this.clock(),
      summary: this.state(instance).title,
      pendingResultCount: countRowSchema.parse(
        this.query(
          "SELECT COUNT(*) AS count FROM sm_inbox WHERE instance_id=? AND status='pending'",
        ).get(instance.instanceId),
      ).count,
      context: Object.entries(context).map(([path, value]) => ({
        path,
        value,
        display: canonicalJson(value),
      })),
      budgets: Object.entries(budget).map(([subject, used]) => ({
        label: "Repair rounds",
        used,
        limit: this.definition(instance).limits.repairAttemptsPerSubject,
        subject,
      })),
      steps: invocations
        .filter((invocation) => invocation.entryId === instance.entryId || invocation.owned)
        .map((invocation) => ({
          invocationId: invocation.invocationId,
          entryId: invocation.entryId,
          attemptId: invocation.attemptId,
          generation: invocation.status === "pending" ? this.generation : invocation.generation,
          specHash: invocation.specHash,
          stateId: invocation.state.id,
          kind: invocation.state.kind,
          status: invocation.status,
          admissionReason: invocation.admissionReason,
          attempt: invocation.attempt,
          maxAttempts: invocation.maxAttempts,
          dispatchedAt: invocation.dispatchedAt || null,
          deadlineAt: invocation.deadlineAt || null,
          nextRetryAt: invocation.nextRetryAt,
          environmentId: invocation.environmentId,
          threadId: invocation.threadId,
          confirmedLive: invocation.confirmedLive,
        })),
      unknownOutcomes: invocations
        .filter((invocation) => invocation.status === "uncertain")
        .map((invocation) => ({
          invocationId: invocation.invocationId,
          blocksRestartIn: invocation.owned ? invocation.environmentId : null,
        })),
      standingAuthority: invocations
        .filter((invocation) => invocation.authority !== null)
        .map((invocation) => ({
          stateId: invocation.state.id,
          reference: invocation.authority?.reference ?? "",
          scope: invocation.authority?.scope ?? "",
        })),
      quarantined: quarantine,
    };
  }
  listInstances(
    input: {
      machineId?: string;
      projectId?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    } = {},
    _actor?: Actor,
  ): InstanceView[] {
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];

    if (input.machineId) {
      clauses.push("machine_id=?");
      parameters.push(input.machineId);
    }

    if (input.projectId) {
      clauses.push("project_id=?");
      parameters.push(input.projectId);
    }

    if (input.status) {
      clauses.push("lifecycle=?");
      parameters.push(input.status);
    }

    if (input.cursor) {
      clauses.push("id>?");
      parameters.push(input.cursor);
    }

    parameters.push(Math.min(100, Math.max(1, input.limit ?? 100)));

    const matches = z
      .array(idRowSchema)
      .parse(
        this.query(
          `SELECT id FROM sm_instances ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id LIMIT ?`,
        ).all(...parameters),
      );

    return matches.map((item) => this.inspectInstance({ instanceId: item.id }));
  }
  listHistory(
    input: {
      instanceId: string;
      after?: number;
      before?: number;
      kinds?: string[];
      limit?: number;
    },
    _actor?: Actor,
  ) {
    this.instance(input.instanceId);

    if (input.after !== undefined && input.before !== undefined)
      fail("VALIDATION_FAILED", "Choose before or after, not both.");
    const descending = input.after === undefined;

    const parameters: (string | number)[] = [
      input.instanceId,
      descending ? (input.before ?? Number.MAX_SAFE_INTEGER) : (input.after ?? 0),
    ];

    const kinds = input.kinds?.slice(0, 32) ?? [];
    parameters.push(...kinds, Math.min(100, Math.max(1, input.limit ?? 100)));

    const matches = z
      .array(historyRowSchema)
      .parse(
        this.query(
          `SELECT sequence,kind,created_at,document FROM sm_history WHERE instance_id=? AND sequence${descending ? "<" : ">"}? ${kinds.length ? `AND kind IN (${kinds.map(() => "?").join(",")})` : ""} ORDER BY sequence ${descending ? "DESC" : "ASC"} LIMIT ?`,
        ).all(...parameters),
      );

    return {
      items: matches.map((item) => ({
        sequence: item.sequence,
        kind: item.kind,
        at: item.created_at,
        data: jsonValueSchema.parse(JSON.parse(item.document)),
      })),
      nextCursor: matches.at(-1)?.sequence ?? null,
      checkpoint: checkpointSchema
        .nullable()
        .parse(
          this.query(
            "SELECT through_sequence,events_pruned,entries_pruned FROM sm_checkpoints WHERE instance_id=?",
          ).get(input.instanceId) ?? null,
        ),
    };
  }
  listStateHistory(
    input: {
      instanceId: string;
      stateId?: string;
      after?: number;
      before?: number;
      limit?: number;
    },
    _actor?: Actor,
  ) {
    this.instance(input.instanceId);

    if (input.after !== undefined && input.before !== undefined)
      fail("VALIDATION_FAILED", "Choose before or after, not both.");
    const descending = input.after === undefined;

    const parameters: (string | number)[] = [
      input.instanceId,
      descending ? (input.before ?? Number.MAX_SAFE_INTEGER) : (input.after ?? 0),
    ];

    if (input.stateId) parameters.push(input.stateId);
    parameters.push(Math.min(100, Math.max(1, input.limit ?? 100)));

    const entries = rows(
      entrySchema,
      this.query(
        `SELECT document FROM sm_entries WHERE instance_id=? AND sequence${descending ? "<" : ">"}? ${input.stateId ? "AND state_id=?" : ""} ORDER BY sequence ${descending ? "DESC" : "ASC"} LIMIT ?`,
      ).all(...parameters),
    );

    return {
      items: entries,
      retainedSince: z
        .object({ at: z.number().nullable() })
        .parse(
          this.query(
            `SELECT MIN(json_extract(document,'$.enteredAt')) AS at FROM sm_entries WHERE instance_id=? ${input.stateId ? "AND state_id=?" : ""}`,
          ).get(...(input.stateId ? [input.instanceId, input.stateId] : [input.instanceId])),
        ).at,
      nextCursor: entries.at(-1)?.sequence ?? null,
      checkpoint: checkpointSchema
        .nullable()
        .parse(
          this.query(
            "SELECT through_sequence,entries_pruned FROM sm_checkpoints WHERE instance_id=?",
          ).get(input.instanceId) ?? null,
        ),
    };
  }
  async readLog(
    input: { invocationId: string; cursor?: number; limit?: number },
    _actor?: Actor,
  ): Promise<{ text: string; nextCursor: number; truncated: boolean }> {
    const invocation =
      row(
        invocationSchema,
        this.query("SELECT document FROM sm_invocations WHERE id=?").get(input.invocationId),
      ) ?? fail("NOT_FOUND", "Step not found.");

    if (invocation.retired) fail("NOT_FOUND", "This step's retained log was compacted.");

    return this.adapter.readLog({
      invocation,
      cursor: Math.max(0, input.cursor ?? 0),
      limit: Math.min(limits.logPageBytes, Math.max(1, input.limit ?? limits.logPageBytes)),
    });
  }
  wake(): void {
    this.wakeResolver?.();
    this.wakeResolver = null;
  }
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();

      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          this.wakeResolver = null;
          resolve();
        };

        const timer = setTimeout(done, 1_000);
        this.wakeResolver = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;

    try {
      const owned = this.activeRows(
        invocationSchema,
        this.query(
          "SELECT instance_id,document FROM sm_invocations WHERE owned=1 AND due_at<=? AND NOT EXISTS(SELECT 1 FROM sm_quarantine q WHERE q.instance_id=sm_invocations.instance_id) ORDER BY due_at,id LIMIT 100",
        ).all(this.clock()),
      );

      for (const invocation of owned) await this.reconcile(invocation);

      await this.retireClosed();

      const active = this.activeRows(
        instanceSchema,
        this.query(
          "SELECT id AS instance_id,document FROM sm_instances WHERE lifecycle IN ('running','paused','stopping') AND NOT EXISTS(SELECT 1 FROM sm_quarantine q WHERE q.instance_id=sm_instances.id) ORDER BY updated_at,id LIMIT 100",
        ).all(),
      );

      for (const original of active) {
        try {
          await this.observeDue(original);

          const revision = this.tx(() => {
            const instance = this.instance(original.instanceId);
            const before = instance.revision;

            if (instance.lifecycle === "running") this.reduce(instance);
            this.rotateSubscriptions(instance);
            this.saveInstance(instance);
            this.compact(instance);

            return instance.revision === before ? null : instance.revision;
          });

          if (revision !== null) this.changed("instance", original.instanceId, revision);

          const pending = this.invocations(original.instanceId).find(
            (invocation) =>
              invocation.status === "pending" &&
              (!invocation.nextRetryAt || invocation.nextRetryAt <= this.clock()),
          );

          if (pending) await this.dispatch(pending);
        } catch (error) {
          if (error instanceof StateMachineError && error.message.includes("replaced")) throw error;
          this.quarantine(original.instanceId);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  private scheduleRetirement(invocation: Invocation): void {
    this.query(
      "INSERT OR IGNORE INTO sm_retirements(attempt_id,instance_id,entry_id,due_at,created_at,byte_count,document) VALUES(?,?,?,?,?,?,?)",
    ).run(
      invocation.attemptId,
      invocation.instanceId,
      invocation.entryId,
      this.clock() + 1000,
      this.clock(),
      invocation.retainedBytes,
      JSON.stringify(invocation),
    );
  }
  private async retireClosed(): Promise<void> {
    const source = this.adapter.retire
      ? this.query(
          `WITH due AS MATERIALIZED(SELECT instance_id,MIN(created_at) AS oldest FROM sm_retirements WHERE due_at<=? AND NOT EXISTS(SELECT 1 FROM sm_quarantine q WHERE q.instance_id=sm_retirements.instance_id) AND NOT EXISTS(SELECT 1 FROM sm_attention a WHERE a.instance_id=sm_retirements.instance_id AND a.resolved_at IS NULL) GROUP BY instance_id ORDER BY oldest LIMIT 100), totals AS MATERIALIZED(SELECT d.instance_id,SUM(r.byte_count) AS bytes FROM due d CROSS JOIN sm_retirements r WHERE r.instance_id=d.instance_id GROUP BY d.instance_id), cutoffs AS MATERIALIZED(SELECT d.instance_id,(SELECT sequence FROM sm_entries WHERE instance_id=d.instance_id ORDER BY sequence DESC LIMIT 1 OFFSET 9999) AS sequence FROM due d), global_total AS MATERIALIZED(SELECT COALESCE(SUM(byte_count),0) AS bytes FROM sm_retirements), pressure AS MATERIALIZED(SELECT d.instance_id FROM due d JOIN totals t ON t.instance_id=d.instance_id CROSS JOIN global_total g WHERE t.bytes>=? OR g.bytes>=?), old_candidates AS MATERIALIZED(SELECT r.attempt_id,r.created_at FROM cutoffs c CROSS JOIN sm_entries e CROSS JOIN sm_retirements r WHERE e.instance_id=c.instance_id AND e.sequence<c.sequence AND e.closed_at IS NOT NULL AND r.entry_id=e.id AND r.due_at<=? ORDER BY r.created_at,r.attempt_id LIMIT 2), aged_candidates AS MATERIALIZED(SELECT r.attempt_id,r.created_at FROM due d CROSS JOIN sm_retirements r CROSS JOIN sm_entries e WHERE r.instance_id=d.instance_id AND r.created_at<? AND r.due_at<=? AND e.id=r.entry_id AND e.closed_at IS NOT NULL ORDER BY r.created_at,r.attempt_id LIMIT 2), pressure_candidates AS MATERIALIZED(SELECT r.attempt_id,r.created_at FROM pressure p CROSS JOIN sm_retirements r CROSS JOIN sm_entries e WHERE r.instance_id=p.instance_id AND r.due_at<=? AND e.id=r.entry_id AND e.closed_at IS NOT NULL ORDER BY r.created_at,r.attempt_id LIMIT 2), candidates AS(SELECT * FROM old_candidates UNION SELECT * FROM aged_candidates UNION SELECT * FROM pressure_candidates ORDER BY created_at,attempt_id LIMIT 2) SELECT r.instance_id,r.document FROM candidates c JOIN sm_retirements r ON r.attempt_id=c.attempt_id ORDER BY c.created_at,c.attempt_id`,
        ).all(
          this.clock(),
          45 * 1024 * 1024,
          225 * 1024 * 1024,
          this.clock(),
          this.clock() - limits.historyAgeMs,
          this.clock(),
          this.clock(),
        )
      : this.query(
          "SELECT r.instance_id,r.document FROM sm_retirements r JOIN sm_entries e ON e.id=r.entry_id WHERE r.due_at<=? AND e.closed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sm_quarantine q WHERE q.instance_id=r.instance_id) ORDER BY r.created_at,r.attempt_id LIMIT 2",
        ).all(this.clock());

    const invocations = this.activeRows(invocationSchema, source);

    for (const invocation of invocations) {
      let retired = false;

      try {
        await this.adapter.retire?.(invocation);
        retired = true;
      } catch {
        retired = false;
      }

      this.tx(() => {
        if (!retired) {
          this.query("UPDATE sm_retirements SET due_at=? WHERE attempt_id=?").run(
            this.clock() + limits.reconcileMs,
            invocation.attemptId,
          );

          return;
        }

        const current = row(
          invocationSchema,
          this.query("SELECT document FROM sm_invocations WHERE id=?").get(invocation.invocationId),
        );

        if (current?.attemptId === invocation.attemptId && !current.owned) {
          current.retired = true;
          this.saveInvocation(current);
        }

        this.query("DELETE FROM sm_retirements WHERE attempt_id=?").run(invocation.attemptId);
        const instance = this.instance(invocation.instanceId);
        this.history(instance, "retired", {
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          specHash: invocation.specHash,
          quiescentAt: invocation.quiescentAt,
          retainedBytes: invocation.retainedBytes,
        });
      });
    }
  }
  private enqueueInternal(
    instance: Instance,
    subscription: Subscription,
    event: { type: string; payload: JsonValue; subject: string },
  ): boolean {
    const existing = row(
      inboxEventSchema,
      this.query(
        "SELECT document FROM sm_inbox WHERE instance_id=? AND subscription_id=? AND epoch=0 AND status='pending' LIMIT 1",
      ).get(instance.instanceId, subscription.subscriptionId),
    );

    if (existing) {
      existing.type = event.type;
      existing.payload = event.payload;
      existing.subject = event.subject;
      this.query("UPDATE sm_inbox SET payload_hash=?,document=? WHERE id=?").run(
        hash(event),
        JSON.stringify(existing),
        existing.eventId,
      );

      return true;
    }

    if (
      countRowSchema.parse(
        this.query(
          "SELECT COUNT(*) AS count FROM sm_inbox WHERE instance_id=? AND status='pending'",
        ).get(instance.instanceId),
      ).count >= limits.pendingEvents
    )
      return false;
    this.query(
      "DELETE FROM sm_inbox WHERE subscription_id=? AND epoch=0 AND status!='pending'",
    ).run(subscription.subscriptionId);
    this.enqueue(
      instance,
      event.type,
      event.payload,
      event.subject,
      subscription.subscriptionId,
      0,
      "internal",
    );

    return true;
  }
  private async observeDue(original: Instance): Promise<void> {
    if (original.lifecycle !== "running") return;

    for (const subscription of this.subscriptions(original.instanceId, original.entryId)) {
      if (subscription.nextDue === null || subscription.nextDue > this.clock()) continue;

      if (subscription.pendingEvent) {
        this.tx(() => {
          const instance = this.instance(original.instanceId);

          if (instance.entryId !== original.entryId || instance.lifecycle !== "running") return;

          const current = this.subscriptions(instance.instanceId, instance.entryId).find(
            (item) => item.subscriptionId === subscription.subscriptionId,
          );

          if (!current?.pendingEvent) return;

          if (this.enqueueInternal(instance, current, current.pendingEvent)) {
            current.pendingEvent = null;
            current.nextDue = this.clock() + (current.everyMs ?? 300000);
          } else current.nextDue = this.clock() + 1000;
          this.saveSubscription(current);
          this.saveInstance(instance);
        });
        continue;
      }

      const state = this.state(original);

      let observation: Awaited<ReturnType<NonNullable<StateMachineAdapter["observe"]>>> | null =
        null;

      try {
        observation = this.adapter.observe
          ? await this.adapter.observe({
              instanceId: original.instanceId,
              entryId: original.entryId,
              subscriptionId: subscription.subscriptionId,
              state,
              context: original.context,
              environmentId: original.environmentId,
            })
          : null;

        if (observation) {
          boundJson(observation.value, 16384);

          if (observation.event) boundJson(observation.event.payload, 16384);
        }
      } catch (error) {
        this.tx(() => {
          const instance = this.instance(original.instanceId);

          if (instance.entryId === original.entryId) {
            this.attention(
              instance,
              "capability-unavailable",
              "Observation failed",
              error instanceof Error ? error.message : "The observer failed.",
              null,
            );
            subscription.nextDue = this.clock() + (subscription.everyMs ?? 300000);
            this.saveSubscription(subscription);
            this.saveInstance(instance);
          }
        });
        continue;
      }

      this.tx(() => {
        const instance = this.instance(original.instanceId);

        if (instance.entryId !== original.entryId || instance.lifecycle !== "running") return;

        const current = this.subscriptions(instance.instanceId, instance.entryId).find(
          (item) => item.subscriptionId === subscription.subscriptionId,
        );

        if (!current) return;
        current.nextDue = this.clock() + (current.everyMs ?? 300000);
        current.observedAt = this.clock();
        current.observationCount++;
        let event: { type: string; payload: JsonValue; subject: string } | null = null;

        if (observation) {
          const valueHash = hash(observation.value);

          const fresh =
            observation.sourceVersion === undefined ||
            current.sourceVersion === null ||
            observation.sourceVersion > current.sourceVersion;

          const changed = fresh && valueHash !== current.observationHash;

          if (fresh) {
            current.observation = observation.value;
            current.observationHash = valueHash;
            current.sourceVersion = observation.sourceVersion ?? current.sourceVersion;
          }

          if (changed && observation.event) event = observation.event;
        } else
          event = {
            type: "timer",
            subject: subscription.subscriptionId,
            payload: {
              intendedAt: subscription.nextDue,
              actualAt: this.clock(),
              missedCount: Math.max(
                0,
                Math.floor(
                  (this.clock() - (subscription.nextDue ?? this.clock())) /
                    (subscription.everyMs ?? 300000),
                ),
              ),
            },
          };

        if (event && !this.enqueueInternal(instance, current, event)) {
          current.pendingEvent = event;
          current.nextDue = this.clock() + 1000;
        }

        this.saveSubscription(current);
        this.saveInstance(instance);
      });
    }
  }
  private reduce(instance: Instance): void {
    let microsteps = 0;
    let processed = 0;

    while (instance.lifecycle === "running" && processed < 100) {
      const state = this.state(instance);

      const pending = row(
        inboxEventSchema,
        this.query(
          "SELECT document FROM sm_inbox WHERE instance_id=? AND status='pending' ORDER BY sequence LIMIT 1",
        ).get(instance.instanceId),
      );

      const stale = pending !== null && pending.entryId !== instance.entryId;

      const active = this.invocations(instance.instanceId).find(
        (invocation) =>
          invocation.entryId === instance.entryId &&
          (invocation.owned || !terminal.has(invocation.status)),
      );

      if (active && !stale) break;

      const event: InboxEvent | null =
        pending ??
        (state.kind === "choice"
          ? {
              eventId: id("evt"),
              instanceId: instance.instanceId,
              entryId: instance.entryId,
              sequence: instance.sequence,
              type: "always",
              payload: {},
              subject: instance.entryId,
              receivedAt: this.clock(),
              status: "pending",
              reason: null,
              subscriptionId: null,
              epoch: null,
            }
          : null);

      if (!event) break;
      processed++;
      let transition = null;

      try {
        if (!stale)
          transition = selectTransition(
            this.definition(instance),
            instance.stateId,
            { type: event.type, payload: event.payload, outcome: event.outcome },
            instance.context,
            event.type.startsWith("result.") ? event.payload : undefined,
          );
      } catch (error) {
        this.attention(
          instance,
          "instance-failed",
          "Transition could not be evaluated",
          error instanceof Error ? error.message : "Guard evaluation failed.",
          null,
        );
        instance.lifecycle = "paused";
        break;
      }

      if (transition && microsteps >= this.definition(instance).limits.microstepsPerWake) {
        this.attention(
          instance,
          "non-yielding-cycle",
          "NON_YIELDING_CYCLE",
          "The machine did not yield within its transition limit.",
          null,
        );
        instance.lifecycle = "paused";
        instance.revision++;
        break;
      }

      event.status = transition ? "consumed" : "ignored";
      event.reason = stale ? "stale visit" : transition ? null : "no matching transition";

      if (pending)
        this.query("UPDATE sm_inbox SET status=?,document=? WHERE id=?").run(
          event.status,
          JSON.stringify(event),
          event.eventId,
        );

      if (event.subscriptionId && event.epoch !== 0) {
        const subscription = row(
          subscriptionSchema,
          this.query("SELECT document FROM sm_subscriptions WHERE id=?").get(event.subscriptionId),
        );

        if (subscription && subscription.epoch === event.epoch) {
          subscription.settled++;
          this.saveSubscription(subscription);
        }
      }

      this.history(instance, "event", {
        eventId: event.eventId,
        type: event.type,
        disposition: event.status,
        reason: event.reason,
      });

      if (!transition) {
        if (!stale && (state.kind === "agent" || state.kind === "command")) {
          this.attention(
            instance,
            "instance-failed",
            "Step ended without a transition",
            "The step has stopped, but this definition has no matching outcome route. Stop this run and publish an explicit route before starting another instance.",
            event.subject,
            [],
            null,
            this.causeOf(instance, state, event),
          );
          instance.revision++;

          if (instance.pauseAfterStep) {
            instance.pauseAfterStep = false;
            instance.lifecycle = "paused";
          }

          break;
        }

        if (!pending) {
          this.attention(
            instance,
            "instance-failed",
            "No choice matched",
            "Add a default choice transition.",
            null,
          );
          instance.lifecycle = "paused";
          break;
        }

        continue;
      }

      let context: JsonObject;

      try {
        context = applyContextPatch(
          instance.context,
          transition.contextPatch,
          { context: instance.context, event: event.payload, result: event.payload },
          this.definition(instance).contextSchema,
        );
      } catch (error) {
        this.attention(
          instance,
          "instance-failed",
          "Context change failed",
          error instanceof Error ? error.message : "Invalid context.",
          null,
        );
        instance.lifecycle = "paused";
        break;
      }

      const entry = row(
        entrySchema,
        this.query("SELECT document FROM sm_entries WHERE id=?").get(instance.entryId),
      );

      if (!entry) fail("NOT_FOUND", "Current visit is missing.");

      const cause =
        this.definition(instance).states.find((candidate) => candidate.id === transition.to)
          ?.kind === "manual"
          ? this.causeOf(instance, state, event)
          : null;

      entry.exitedAt = this.clock();
      entry.exitTrigger = event.type;
      this.query("UPDATE sm_entries SET closed_at=?,document=? WHERE id=?").run(
        entry.exitedAt,
        JSON.stringify(entry),
        entry.entryId,
      );
      this.query(
        "UPDATE sm_attention SET resolved_at=? WHERE instance_id=? AND entry_id=? AND resolved_at IS NULL",
      ).run(this.clock(), instance.instanceId, instance.entryId);
      instance.context = context;
      instance.revision++;
      microsteps++;

      if (
        transition.to === this.definition(instance).initialStateId &&
        (event.type === "succeeded" || event.type.startsWith("result."))
      )
        instance.cyclesCompleted++;
      instance.lastTransition = { transitionId: transition.id, at: this.clock() };
      this.history(instance, "transition", {
        transitionId: transition.id,
        from: instance.stateId,
        to: transition.to,
        entryId: instance.entryId,
      });
      this.enter(instance, transition.to, cause);

      if (instance.pauseAfterStep) {
        instance.pauseAfterStep = false;

        if (instance.lifecycle === "running") instance.lifecycle = "paused";
        break;
      }

      if (this.state(instance).kind !== "choice") break;
    }
  }
  private async dispatch(original: Invocation): Promise<void> {
    const instance = this.instance(original.instanceId);

    if (
      instance.lifecycle !== "running" ||
      instance.entryId !== original.entryId ||
      this.listAttention({ instanceId: instance.instanceId }).some(
        (attention) => attention.entryId === instance.entryId && attention.kind !== "gate",
      )
    )
      return;
    let authority: AuthorityDecision = { allowed: original.state.effect !== "external-write" };

    try {
      if (this.adapter.authorize)
        authority = await this.adapter.authorize({
          ...original,
          generation: this.generation,
          deadlineAt: this.clock() + original.state.deadlineMs,
        });
    } catch {
      authority = { allowed: false };
    }

    const invocation = this.tx(() => {
      const latest = this.instance(instance.instanceId);

      const current = row(
        invocationSchema,
        this.query("SELECT document FROM sm_invocations WHERE id=?").get(original.invocationId),
      );

      if (
        !current ||
        current.status !== "pending" ||
        latest.lifecycle !== "running" ||
        latest.entryId !== current.entryId
      )
        return null;

      if (
        !authority.allowed ||
        (current.state.effect === "external-write" && (!authority.reference || !authority.scope))
      ) {
        this.attention(
          latest,
          "authority-required",
          "AUTHORITY_REQUIRED",
          "This action requires an exact existing standing authority. Client decisions cannot grant it.",
          current.invocationId,
        );
        this.saveInstance(latest);

        return null;
      }

      const owners = z
        .array(environmentRowSchema)
        .parse(this.query("SELECT environment_id FROM sm_invocations WHERE owned=1").all());

      latest.starts = latest.starts.filter((at) => at > this.clock() - limits.actionRateWindowMs);

      const reason =
        owners.length >= limits.globalActions
          ? "Plugin concurrency limit"
          : owners.some((owner) => owner.environment_id === current.environmentId)
            ? "Environment is busy"
            : latest.starts.length >= this.definition(latest).limits.actionStartsPerFiveMinutes
              ? "Action start rate limit"
              : null;

      if (reason) {
        if (current.admissionReason !== reason || latest.phase !== "queued") latest.revision++;
        current.admissionReason = reason;
        this.saveInvocation(current);
        latest.phase = "queued";
        this.saveInstance(latest);

        return null;
      }

      const repairProfile =
        current.state.kind === "agent" &&
        this.definition(latest).transitions.some(
          (edge) => edge.from === current.state.id && edge.trigger.kind === "budget-exhausted",
        );

      if (repairProfile) {
        const sourceSchema = this.definition(latest).contextSchema.properties.sourceSha;

        const source = z
          .string()
          .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
          .safeParse(latest.context.sourceSha);

        if (sourceSchema && !source.success) {
          this.attention(
            latest,
            "instance-failed",
            "VALIDATION_FAILED",
            "A repair needs the exact pinned source SHA.",
            current.invocationId,
          );
          this.saveInstance(latest);

          return null;
        }

        const subject = source.success ? source.data : latest.instanceId;

        if (!Object.hasOwn(latest.budget, subject) && Object.keys(latest.budget).length >= 1000) {
          this.attention(
            latest,
            "retries-exhausted",
            "Repair subject limit reached",
            "This instance retains 1,000 source repair counters. Inspect its evidence, stop and archive it, then explicitly start a new instance to continue. Existing counters are preserved.",
            current.invocationId,
          );
          this.saveInstance(latest);

          return null;
        }

        const used = latest.budget[subject] ?? 0;

        if (used >= this.definition(latest).limits.repairAttemptsPerSubject) {
          current.status = "cancelled";
          current.retired = true;
          this.saveInvocation(current);
          this.enqueue(latest, "budget-exhausted", { subject, used }, current.invocationId);
          latest.revision++;
          this.saveInstance(latest);

          return null;
        }

        latest.budget[subject] = used + 1;
      }

      const entry = row(
        entrySchema,
        this.query("SELECT document FROM sm_entries WHERE id=?").get(current.entryId),
      );

      if (entry) {
        entry.attempts++;
        this.query("UPDATE sm_entries SET document=? WHERE id=?").run(
          JSON.stringify(entry),
          entry.entryId,
        );
      }

      current.status = "dispatching";
      current.owned = true;
      current.dispatchedAt = this.clock();
      current.deadlineAt = this.clock() + current.state.deadlineMs;
      current.generation = this.generation;
      current.admissionReason = null;
      current.nextRetryAt = null;
      current.dueAt = this.clock() + 1_000;
      current.authority =
        authority.reference && authority.scope
          ? { reference: authority.reference, scope: authority.scope }
          : null;
      latest.starts.push(this.clock());
      latest.phase = "executing";
      latest.revision++;
      this.saveInvocation(current);
      this.saveInstance(latest);
      this.history(latest, "dispatch", {
        invocationId: current.invocationId,
        attemptId: current.attemptId,
        deadlineAt: current.deadlineAt,
        generation: this.generation,
      });

      return current;
    });

    if (!invocation) {
      const latest = this.instance(instance.instanceId);

      if (latest.revision !== instance.revision)
        this.changed("instance", latest.instanceId, latest.revision);

      return;
    }

    let observation: InvocationObservation;

    try {
      observation = await this.adapter.start(invocation);
    } catch (error) {
      observation = {
        status: "uncertain",
        confirmedLive: false,
        reason: error instanceof Error ? error.message : "Submission outcome is unknown.",
      };
    }

    this.tx(() => {
      const latest = this.instance(invocation.instanceId);

      const current = row(
        invocationSchema,
        this.query("SELECT document FROM sm_invocations WHERE id=?").get(invocation.invocationId),
      );

      if (current?.attemptId === invocation.attemptId)
        this.applyObservation(latest, current, observation);
      this.saveInstance(latest);
    });
    this.changed("instance", invocation.instanceId, this.instance(invocation.instanceId).revision);
  }
  private async reconcile(original: Invocation): Promise<void> {
    let observation: InvocationObservation;

    const timedOut =
      this.clock() >= original.deadlineAt &&
      (original.receivedAt === null || original.receivedAt > original.deadlineAt);

    const graceElapsed =
      original.receivedAt !== null &&
      this.clock() - original.receivedAt >= limits.quiescenceGraceMs;

    try {
      observation =
        original.cancelReason !== null ||
        original.status === "cancel-requested" ||
        timedOut ||
        graceElapsed
          ? await this.adapter.cancel(original)
          : await this.adapter.inspect(original);
    } catch (error) {
      observation = {
        status: "uncertain",
        confirmedLive: false,
        reason: error instanceof Error ? error.message : "The exact worker could not be inspected.",
      };
    }

    const revision = this.tx(() => {
      const instance = this.instance(original.instanceId);
      const before = instance.revision;

      const current = row(
        invocationSchema,
        this.query("SELECT document FROM sm_invocations WHERE id=?").get(original.invocationId),
      );

      if (!current || !current.owned || current.attemptId !== original.attemptId) return null;
      const status = current.status;
      const threadId = current.threadId;
      const live = current.confirmedLive;
      const candidate = current.candidate;
      const phase = instance.phase;
      const lifecycle = instance.lifecycle;

      if (timedOut && !current.cancelReason) current.cancelReason = "timeout";

      if (graceElapsed && !current.cancelReason) current.cancelReason = "grace";
      this.applyObservation(instance, current, observation);

      if (graceElapsed && observation.status !== "quiescent")
        this.makeUncertain(
          instance,
          current,
          "The result was submitted, but the worker has not stopped within 60 seconds.",
        );

      if (
        instance.revision === before &&
        (current.status !== status ||
          current.threadId !== threadId ||
          current.confirmedLive !== live ||
          current.candidate !== candidate ||
          instance.phase !== phase ||
          instance.lifecycle !== lifecycle)
      )
        instance.revision++;
      this.saveInstance(instance);

      return instance.revision === before ? null : instance.revision;
    });

    if (revision !== null) this.changed("instance", original.instanceId, revision);
  }

  private causeOf(
    instance: Instance,
    state: StateDefinition,
    event: InboxEvent,
  ): AttentionCause | null {
    if (state.kind !== "agent" && state.kind !== "command") return null;

    const invocation = row(
      invocationSchema,
      this.query("SELECT document FROM sm_invocations WHERE id=? AND instance_id=?").get(
        event.subject,
        instance.instanceId,
      ),
    );

    if (!invocation) return null;

    const stated = isJsonObject(event.payload)
      ? z.string().trim().min(1).safeParse(event.payload.reason)
      : null;

    const reported = rows(
      attentionSchema,
      this.query(
        "SELECT document FROM sm_attention WHERE instance_id=? AND entry_id=? ORDER BY rowid DESC",
      ).all(instance.instanceId, invocation.entryId),
    ).find((item) => item.invocationId === invocation.invocationId && item.bodyMarkdown !== "");

    const reason = stated?.success ? stated.data : (reported?.bodyMarkdown ?? null);

    return {
      stateId: state.id,
      stateTitle: state.title,
      outcome: event.type,
      reason: reason === null ? null : reason.slice(0, 2_000),
      invocationId: invocation.invocationId,
      threadId: invocation.threadId,
      at: invocation.quiescentAt ?? this.clock(),
    };
  }
  private makeUncertain(instance: Instance, invocation: Invocation, reason: string): void {
    invocation.status = "uncertain";
    invocation.owned = true;
    invocation.dueAt = this.clock() + limits.reconcileMs;
    instance.phase = "uncertain";
    this.attention(
      instance,
      "uncertain",
      "Outcome unknown",
      reason,
      invocation.invocationId,
      [
        {
          name: "reconcile",
          label: "Check outcome",
          targetStateId: null,
          evidenceRequired: false,
          disabledReason: invocation.confirmedLive ? "The step is confirmed running." : null,
        },
      ],
      null,
      {
        stateId: invocation.state.id,
        stateTitle: invocation.state.title,
        outcome: "uncertain",
        reason,
        invocationId: invocation.invocationId,
        threadId: invocation.threadId,
        at: this.clock(),
      },
    );
    this.saveInvocation(invocation);

    if (instance.pauseAfterStep) {
      instance.pauseAfterStep = false;
      instance.lifecycle = "paused";
    }
  }
  private updateAgentInput(
    instance: Instance,
    invocation: Invocation,
    observation: InvocationObservation,
  ): boolean {
    const waiting = observation.waitingForPerson;

    if (invocation.state.kind !== "agent" && !waiting) return true;

    if (
      waiting &&
      (invocation.state.kind !== "agent" ||
        waiting.threadId !== invocation.threadId ||
        !waiting.interactionId)
    ) {
      this.makeUncertain(
        instance,
        invocation,
        "The pending question could not be linked to the exact owned worker.",
      );

      return false;
    }

    const questions = rows(
      attentionSchema,
      this.query(
        "SELECT document FROM sm_attention WHERE instance_id=? AND entry_id=? AND resolved_at IS NULL AND json_extract(document,'$.kind')='agent-input' AND json_extract(document,'$.invocationId')=?",
      ).all(instance.instanceId, invocation.entryId, invocation.invocationId),
    );

    let resolved = false;

    for (const question of questions) {
      if (question.interactionId === waiting?.interactionId) continue;
      question.resolvedAt = this.clock();
      this.query("UPDATE sm_attention SET resolved_at=?,document=? WHERE id=?").run(
        question.resolvedAt,
        JSON.stringify(question),
        question.attentionId,
      );
      instance.revision++;
      resolved = true;
      this.history(instance, "problem", {
        attentionId: question.attentionId,
        kind: "agent-input",
        disposition: "resolved",
        interactionId: question.interactionId,
      });
    }

    if (waiting) {
      this.attention(
        instance,
        "agent-input",
        "Worker needs an answer",
        "Open the worker thread to answer its pending question.",
        invocation.invocationId,
        [],
        waiting.interactionId,
      );
    } else if (
      resolved &&
      instance.phase === "needs-person" &&
      !this.query(
        "SELECT id FROM sm_attention WHERE instance_id=? AND entry_id=? AND resolved_at IS NULL LIMIT 1",
      ).get(instance.instanceId, instance.entryId)
    ) {
      instance.phase = "executing";
    }

    return true;
  }
  private applyObservation(
    instance: Instance,
    invocation: Invocation,
    observation: InvocationObservation,
  ): void {
    invocation.threadId = observation.threadId ?? invocation.threadId;
    invocation.confirmedLive = observation.confirmedLive;
    invocation.retrySafe = observation.retrySafe ?? invocation.retrySafe;
    invocation.retainedBytes = observation.retainedBytes ?? invocation.retainedBytes;
    invocation.dueAt = this.clock() + 1_000;

    if (observation.status === "uncertain" || observation.status === "not-found") {
      this.makeUncertain(
        instance,
        invocation,
        observation.reason ?? "The submission may have started. It will not be submitted again.",
      );

      return;
    }

    if (!this.updateAgentInput(instance, invocation, observation)) return;

    if (observation.result && !invocation.candidate) {
      boundJson(observation.result, 16_384);
      invocation.candidate = observation.result;
      invocation.receivedAt = this.clock();
    }

    if (observation.status === "running" || observation.confirmedLive) {
      if (invocation.status !== "cancel-requested")
        invocation.status = invocation.candidate ? "result-ready" : "running";
      this.saveInvocation(invocation);

      return;
    }

    invocation.confirmedLive = false;
    invocation.quiescentAt = this.clock();
    invocation.owned = false;

    let result: InvocationResult = invocation.candidate ?? {
      type: invocation.state.kind === "agent" ? "no-result" : "failed",
      payload: {},
    };

    if (invocation.receivedAt !== null && invocation.receivedAt > invocation.deadlineAt)
      result = { type: "timed-out", payload: {} };

    if (invocation.cancelReason === "timeout") result = { type: "timed-out", payload: {} };

    if (invocation.cancelReason === "cancel" || invocation.cancelReason === "stop")
      result = { type: "cancelled", payload: {} };
    const success = result.type === "succeeded" || result.type === "result";
    invocation.status = success
      ? "succeeded"
      : result.type === "timed-out"
        ? "timed-out"
        : result.type === "cancelled"
          ? "cancelled"
          : "failed";

    this.scheduleRetirement(invocation);

    const retry =
      result.type === "failed" &&
      invocation.retrySafe &&
      invocation.attempt < invocation.maxAttempts &&
      instance.lifecycle === "running" &&
      !instance.pauseAfterStep &&
      (invocation.state.kind === "agent" ||
        invocation.state.action.retrySafety === "adapter-verified");

    this.history(instance, "attempt-ended", {
      invocationId: invocation.invocationId,
      attemptId: invocation.attemptId,
      status: invocation.status,
      quiescentAt: invocation.quiescentAt,
    });

    if (retry) {
      invocation.attempt++;
      invocation.attemptId = id("try");
      invocation.status = "pending";
      invocation.nextRetryAt =
        this.clock() + (limits.retryBackoffsMs[invocation.attempt - 2] ?? 30_000);
      invocation.candidate = null;
      invocation.receivedAt = null;
      invocation.cancelReason = null;
      invocation.threadId = null;
      invocation.dueAt = invocation.nextRetryAt;
      instance.phase = "retry-wait";
    } else if (instance.lifecycle === "stopping") {
      if (
        !this.invocations(instance.instanceId).some(
          (other) => other.invocationId !== invocation.invocationId && other.owned,
        )
      ) {
        instance.lifecycle = "stopped";
        instance.phase = null;
      }
    } else if (instance.lifecycle === "stopped") {
      instance.phase = null;
    } else if (instance.entryId === invocation.entryId && !invocation.unknownAcknowledged) {
      const event = this.enqueue(
        instance,
        result.type === "result" ? `result.${result.outcome ?? ""}` : result.type,
        result.payload,
        invocation.invocationId,
      );

      if (result.outcome) {
        event.outcome = result.outcome;
        this.query("UPDATE sm_inbox SET document=? WHERE id=?").run(
          JSON.stringify(event),
          event.eventId,
        );
      }
    }

    this.resolveStoppedGates(instance);
    instance.revision++;
    this.saveInvocation(invocation);
  }
  private rotateSubscriptions(instance: Instance): void {
    for (const subscription of this.subscriptions(instance.instanceId, instance.entryId)) {
      if (
        subscription.settled < limits.subscriptionWindow &&
        this.clock() - subscription.openedAt < limits.subscriptionWindowMs
      )
        continue;

      const pending = this.query(
        "SELECT id FROM sm_inbox WHERE subscription_id=? AND epoch=? AND status='pending' LIMIT 1",
      ).get(subscription.subscriptionId, subscription.epoch);

      if (pending) continue;
      this.query(
        "DELETE FROM sm_inbox WHERE subscription_id=? AND epoch=? AND status!='pending'",
      ).run(subscription.subscriptionId, subscription.epoch);
      subscription.epoch++;
      subscription.openedAt = this.clock();
      subscription.settled = 0;
      this.saveSubscription(subscription);
    }
  }
  private compact(instance: Instance): void {
    const cutoffRow = this.query(
      "SELECT sequence FROM sm_history WHERE instance_id=? ORDER BY sequence DESC LIMIT 1 OFFSET ?",
    ).get(instance.instanceId, limits.historyRecords - 1);

    const cutoff = cutoffRow ? sequenceRowSchema.parse(cutoffRow) : null;

    const hasExpired = this.query(
      "SELECT sequence FROM sm_history WHERE instance_id=? AND created_at<? LIMIT 1",
    ).get(instance.instanceId, this.clock() - limits.historyAgeMs);

    const expired = hasExpired
      ? z
          .object({ sequence: z.number().nullable() })
          .parse(
            this.query(
              "SELECT MAX(sequence) AS sequence FROM sm_history WHERE instance_id=? AND created_at<?",
            ).get(instance.instanceId, this.clock() - limits.historyAgeMs),
          )
      : { sequence: null };

    const through = Math.max(cutoff ? cutoff.sequence - 1 : 0, expired.sequence ?? 0);

    if (through > 0) {
      const result = this.query("DELETE FROM sm_history WHERE instance_id=? AND sequence<=?").run(
        instance.instanceId,
        through,
      );

      if (Number(result.changes))
        this.query(
          "INSERT INTO sm_checkpoints(instance_id,through_sequence,updated_at) VALUES(?,?,?) ON CONFLICT(instance_id) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence),updated_at=excluded.updated_at",
        ).run(instance.instanceId, through, this.clock());
    }

    const retainedRow = this.query(
      "SELECT sequence FROM sm_entries WHERE instance_id=? ORDER BY sequence DESC LIMIT 1 OFFSET ?",
    ).get(instance.instanceId, limits.historyRecords - 1);

    const retainedEntry = retainedRow ? sequenceRowSchema.parse(retainedRow) : null;

    if (retainedEntry) {
      const eligible = z
        .array(idRowSchema)
        .parse(
          this.query(
            "SELECT id FROM sm_entries WHERE instance_id=? AND sequence<? AND closed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sm_invocations i WHERE i.entry_id=sm_entries.id AND (i.owned=1 OR i.retired=0)) AND NOT EXISTS(SELECT 1 FROM sm_attention a WHERE a.entry_id=sm_entries.id AND a.resolved_at IS NULL) AND NOT EXISTS(SELECT 1 FROM sm_retirements r WHERE r.entry_id=sm_entries.id) LIMIT 100",
          ).all(instance.instanceId, retainedEntry.sequence),
        );

      for (const entry of eligible) {
        this.query("DELETE FROM sm_inbox WHERE entry_id=? AND status!='pending'").run(entry.id);
        this.query("DELETE FROM sm_subscriptions WHERE entry_id=?").run(entry.id);
        this.query("DELETE FROM sm_invocations WHERE entry_id=? AND owned=0").run(entry.id);
        this.query("DELETE FROM sm_attention WHERE entry_id=? AND resolved_at IS NOT NULL").run(
          entry.id,
        );
        this.query("DELETE FROM sm_entries WHERE id=?").run(entry.id);
      }
    }

    this.query("DELETE FROM sm_requests WHERE created_at<? AND scope NOT LIKE 'start:%'").run(
      this.clock() - limits.requestAgeMs,
    );
  }
}

export function createStateMachineService(options: ServiceOptions): StateMachineService {
  return new StateMachineService(options);
}
