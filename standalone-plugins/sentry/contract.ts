import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { relativePath, sha, text } from "./src/contract-fields";
import { completionSchema, verificationSchema } from "./src/repair-result-contract";
import { workflowRpc } from "./src/workflow-contract";

export {
  completionSchema,
  verificationSchema,
  type Completion,
  type Verification,
} from "./src/repair-result-contract";

const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const modelSelectionSchema = z
  .object({
    providerId: id,
    model: z.string().min(1).max(200),
    reasoningLevel: z.string().min(1).max(40),
    serviceTier: z.string().min(1).max(80).optional(),
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const modelRoleSchema = z.enum(["solver", "coordinator", "reviewer"]);

export type ModelRole = z.infer<typeof modelRoleSchema>;

export const builtinModelDefaults = {
  solver: {
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "max",
    serviceTier: "default",
  },
  coordinator: {
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "ultra",
    serviceTier: "default",
  },
  reviewer: {
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "max",
    serviceTier: "default",
  },
} satisfies Record<ModelRole, ModelSelection>;

export const modelDefaultsSchema = z
  .object({
    solver: modelSelectionSchema.default(builtinModelDefaults.solver),
    coordinator: modelSelectionSchema.default(builtinModelDefaults.coordinator),
    reviewer: modelSelectionSchema.default(builtinModelDefaults.reviewer),
  })
  .strict();

export type ModelDefaults = z.infer<typeof modelDefaultsSchema>;

const checkSchema = z
  .object({
    name: z.string().min(1).max(80),
    command: z.string().min(1).max(500),
    args: z.array(z.string().max(2000)).max(80).default([]),
    timeoutMs: z.number().int().min(1000).max(1200000).default(120000),
  })
  .strict();

export const routeSchema = z
  .object({
    id,
    name: z.string().min(1).max(80),
    version: z.number().int().positive().default(1),
    enabled: z.boolean().default(false),
    watch: z.boolean().default(true),
    organization: z.string().regex(/^[a-z0-9-]+$/u),
    sentryProjectId: z.string().regex(/^\d+$/u),
    environment: z.string().min(1).max(80),
    levels: z
      .array(z.enum(["debug", "info", "warning", "error", "fatal"]))
      .min(1)
      .default(["error", "fatal"]),
    service: z.string().min(1).max(80).nullable().default(null),
    channel: z.string().min(1).max(80).nullable().default(null),
    releases: z.array(z.string().min(1).max(200)).max(30).default([]),
    query: z.string().max(1000).default("is:unresolved"),
    projectId: id,
    hostId: id,
    repositoryPath: z.string().min(1).max(1000),
    baseRef: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (value) =>
          !value.startsWith("-") &&
          !/\s/u.test(value) &&
          !Array.from(value).some((character) => character.codePointAt(0)! < 32),
      ),
    githubRepository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
      .nullable()
      .default(null),
    delivery: z.enum(["local", "pr"]).default("local"),
    checks: z.array(checkSchema).min(1).max(10),
    instructionPaths: z.array(z.string().min(1).max(1000)).max(10).default([]),
  })
  .strict()
  .refine(
    (value) => value.delivery !== "pr" || value.githubRepository !== null,
    "PR mode requires the exact GitHub repository",
  );

export type Route = z.infer<typeof routeSchema>;

export const incidentSchema = z
  .object({
    key: z.string().min(1),
    id: z.string().regex(/^\d+$/u),
    shortId: z.string().max(100),
    organization: z.string(),
    projectId: z.string(),
    url: z.url(),
    level: z.enum(["debug", "info", "warning", "error", "fatal"]),
    exceptionType: z.string().max(100),
    firstSeen: z.iso.datetime({ offset: true }),
    lastSeen: z.iso.datetime({ offset: true }),
    status: z.string().max(40),
    substatus: z.string().max(80),
    release: z.string().max(200).nullable(),
    environment: z.string().max(80),
    matchedRouteIds: z.array(id).max(50),
  })
  .strict();

export type Incident = z.infer<typeof incidentSchema>;

export const publicationSchema = z
  .object({
    url: z.url(),
    number: z.number().int().positive(),
    head: sha,
    branch: z.string(),
    baseBranch: z.string(),
    draft: z.literal(true),
  })
  .strict();

export type Publication = z.infer<typeof publicationSchema>;

const runStateSchema = z.enum([
  "queued",
  "preparing",
  "investigating",
  "verifying",
  "publishing",
  "local-ready",
  "pr-open",
  "no-fix",
  "needs-evidence",
  "failed",
  "cancelled",
]);

export const runSchema = z.object({
  id,
  incident: incidentSchema,
  route: routeSchema,
  manual: z.boolean(),
  batchId: id.nullable().default(null),
  relatedIncidents: z.array(incidentSchema).max(100).default([]),
  packageTitle: z.string().max(160).nullable().default(null),
  packageHandoff: text.nullable().default(null),
  manualStartRequestedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  reasoningLevel: z.enum(["max", "ultra"]).default("max"),
  model: modelSelectionSchema.nullable().default(null),
  state: runStateSchema,
  threadId: z.string().nullable(),
  spawnRequestedAt: z.string().nullable().default(null),
  environmentId: z.string().nullable(),
  environmentKey: z.string().nullable().default(null),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  baseSha: sha.nullable(),
  preservedSha: sha.nullable().default(null),
  result: completionSchema.nullable(),
  verification: verificationSchema.nullable(),
  publication: publicationSchema.nullable(),
  reason: z.string().max(500).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reportRequests: z.number().int(),
  interruptedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  lastTurnSeq: z.number().int().nonnegative().nullable().default(null),
  publishAttemptedAt: z.iso.datetime({ offset: true }).nullable().default(null),
});

export type Run = z.infer<typeof runSchema>;

export const syncSchema = z.object({
  cursor: z.string().nullable(),
  scanStartedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  retryAt: z.number().nullable(),
  error: z.string().max(500).nullable(),
});

export type Sync = z.infer<typeof syncSchema>;

const repositorySchema = z
  .object({
    repositoryPath: z.string(),
    commonDirectory: z.string(),
    baseSha: sha,
    branch: z.string(),
    remoteUrl: z.string().nullable(),
    dirtyPaths: z.array(z.string()),
  })
  .strict();

const discoveredRepositorySchema = z
  .object({
    name: z.string(),
    path: z.string(),
    baseRef: z.string(),
    githubRepository: z.string().nullable(),
    checks: z.array(checkSchema),
    instructionPaths: z.array(z.string()),
  })
  .strict();

const projectRepositorySchema = discoveredRepositorySchema.extend({ hostId: id });

export type ProjectRepository = z.infer<typeof projectRepositorySchema>;

export const sentryProjectSchema = z
  .object({ id: z.string().regex(/^\d+$/u), slug: z.string(), name: z.string() })
  .strict();

export type SentryProject = z.infer<typeof sentryProjectSchema>;

const blockedIssueSchema = z.object({ issueKey: z.string().min(1), reason: text }).strict();

export const packageInputSchema = z
  .object({
    routeId: id,
    issueKeys: z.array(z.string().min(1)).min(1).max(100),
    title: text.max(160),
    rationale: text,
  })
  .strict();

export const batchFinishSchema = z
  .object({ summary: text, blocked: z.array(blockedIssueSchema).max(10000) })
  .strict();

export const batchSchema = z.object({
  id,
  projectId: id,
  hostId: id.nullable(),
  sourceId: id.nullable(),
  rootPath: z.string().nullable(),
  routes: z.array(routeSchema),
  incidents: z.array(incidentSchema).max(10000),
  state: z.enum([
    "preparing",
    "planning",
    "waiting",
    "summarizing",
    "stopping",
    "complete",
    "failed",
    "cancelled",
  ]),
  threadId: z.string().nullable(),
  spawnRequestedAt: z.string().nullable(),
  summaryMarker: z.string().nullable(),
  summarySentAt: z.string().nullable(),
  runIds: z.array(id),
  blocked: z.array(blockedIssueSchema).max(10000),
  summary: text.nullable(),
  reason: z.string().max(500).nullable(),
  reportRequests: z.number().int().nonnegative(),
  lastTurnSeq: z.number().int().nonnegative().nullable().default(null),
  model: modelSelectionSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectBatch = z.infer<typeof batchSchema>;

export const batchSummarySchema = batchSchema
  .omit({ routes: true, incidents: true, blocked: true })
  .extend({ issueCount: z.number().int().nonnegative() });

const workflowRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/omnyo(?:-plugins|-private)?$/u);

const nativeSurfaceSchema = z.enum(["macos", "windows", "ios"]);

export const workflowPlanInputSchema = z.strictObject({
  runId: id,
  path: z.string().min(1),
  repository: workflowRepositorySchema,
  mergeCommit: sha,
  baseCommit: sha,
  changedFiles: z.array(relativePath).min(1).max(100),
  selectionPath: relativePath.nullable(),
  nativeRequired: z.array(nativeSurfaceSchema).max(3),
});

const workflowDeliveryInputSchema = z.strictObject({
  runId: id,
  planPath: z.string(),
  planDigest: sha,
});

const workflowDeliveryKindSchema = z.enum(["none", "plugin", "web", "runtime"]);

export const workflowDeliverySchema = z.strictObject({
  status: z.enum(["complete", "pending", "blocked", "release-failed"]),
  kind: workflowDeliveryKindSchema,
  sourceCommit: sha,
  receiptPath: z.string().nullable(),
  offeredVersion: z.string().nullable(),
  reason: z.string().nullable(),
});

export const hostContract = defineRpcContract({
  discoverRepositories: {
    input: z.object({ rootPath: z.string() }).strict(),
    output: z.array(discoveredRepositorySchema),
  },
  inspectRepository: {
    input: z
      .object({
        repositoryPath: z.string(),
        baseRef: z.string(),
        expectedRepository: z.string().nullable(),
      })
      .strict(),
    output: repositorySchema,
  },
  coordinatorWorkspace: {
    input: z.object({ pathKey: id, action: z.enum(["ensure", "remove"]) }).strict(),
    output: z.object({ path: z.string() }).strict(),
  },
  worktreePath: {
    input: z.object({ pathKey: id }).strict(),
    output: z.object({ path: z.string() }).strict(),
  },
  createWorktree: {
    input: z
      .object({
        sourcePath: z.string(),
        path: z.string(),
        branch: z.string(),
        baseSha: sha,
        restore: z.boolean().default(false),
      })
      .strict(),
    output: z.object({ path: z.string(), baseSha: sha, branch: z.string() }).strict(),
  },
  removeWorktree: {
    input: z.strictObject({ sourcePath: z.string(), path: z.string(), branch: z.string() }),
    output: z.object({ removed: z.literal(true), preservedSha: sha.nullable() }).strict(),
  },
  verify: {
    input: z
      .object({
        runId: id,
        path: z.string(),
        baseSha: sha,
        head: sha,
        repairBranch: z.string().min(1).optional(),
        changedFiles: z.array(relativePath),
        checks: z.array(checkSchema).min(1),
      })
      .strict(),
    output: verificationSchema,
  },
  publish: {
    input: z
      .object({
        path: z.string(),
        repository: z.string(),
        head: sha,
        branch: z.string(),
        baseBranch: z.string(),
        runId: id,
        title: text,
        body: z.string().min(1).max(20000),
      })
      .strict(),
    output: publicationSchema,
  },
  workflowWorktreePath: {
    input: z
      .object({ runId: id, repositoryPath: z.string().min(1), suffix: z.enum(["fix", "delivery"]) })
      .strict(),
    output: z.object({ path: z.string() }).strict(),
  },
  workflowMerge: {
    input: z
      .object({
        runId: id,
        path: z.string().min(1),
        repository: workflowRepositorySchema,
        prNumber: z.number().int().positive(),
        head: sha,
        branch: z.string().min(1),
        baseBranch: z.literal("main"),
        review: z
          .object({ head: sha, approved: z.literal(true), evidencePath: relativePath })
          .strict(),
      })
      .strict(),
    output: z
      .object({
        status: z.enum(["pending", "merged", "blocked"]),
        head: sha,
        mergeCommit: sha.nullable(),
        prUrl: z.url(),
        reason: z.string().nullable(),
      })
      .strict(),
  },
  workflowPlan: {
    input: workflowPlanInputSchema,
    output: z
      .object({
        status: z.enum(["planned", "blocked"]),
        kind: workflowDeliveryKindSchema,
        sourceCommit: sha,
        planPath: z.string(),
        planDigest: sha,
        nativeRequired: z.array(nativeSurfaceSchema),
        releaseRequired: z.boolean(),
        reason: z.string().nullable(),
      })
      .strict(),
  },
  workflowRelease: {
    input: workflowDeliveryInputSchema,
    output: workflowDeliverySchema,
  },
  workflowDeliver: {
    input: workflowDeliveryInputSchema,
    output: workflowDeliverySchema,
  },
  workflowPluginTargets: {
    input: workflowDeliveryInputSchema,
    output: z
      .object({
        sourceCommit: sha,
        planDigest: sha,
        targets: z
          .array(
            z
              .object({
                pluginId: id,
                source: z.string(),
                version: z.string(),
                snapshotDigest: sha,
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
  },
  workflowVerify: {
    input: workflowDeliveryInputSchema,
    output: z
      .object({
        status: z.enum(["verified", "pending", "blocked"]),
        sourceCommit: sha,
        proof: z.string(),
      })
      .strict(),
  },
  stop: {
    input: z.object({ runId: id }).strict(),
    output: z.object({ stopped: z.literal(true) }).strict(),
  },
});

export const projectPolicySchema = z
  .object({
    projectId: id,
    autoSolve: z.boolean().default(false),
    dailyLimit: z.number().int().min(1).max(1000).default(10),
  })
  .strict();

export type ProjectPolicy = z.infer<typeof projectPolicySchema>;

const policyUsageSchema = projectPolicySchema.extend({
  day: z.string(),
  started: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});

export const badgeSchema = z.object({
  count: z.number().int().nonnegative(),
  watchedRoutes: z.number().int().nonnegative(),
  freshness: z.enum(["live", "stale", "partial", "unconfigured"]),
  lastSyncedAt: z.string().nullable(),
});

export const statusSchema = z.object({
  connected: z.boolean(),
  syncing: z.boolean().optional(),
  apiOrigin: z.string(),
  lastError: z.string().nullable(),
  routes: z.array(routeSchema),
  incidents: z.array(incidentSchema),
  runs: z.array(runSchema),
  syncs: z.array(z.object({ routeId: z.string(), state: syncSchema })),
  notificationLimit: z.string(),
  projectPolicies: z.array(policyUsageSchema),
  batches: z.array(batchSummarySchema).default([]),
  projectIssueCounts: z
    .array(z.object({ projectId: id, count: z.number().int().nonnegative() }))
    .default([]),
  badge: badgeSchema,
  models: modelDefaultsSchema.default(builtinModelDefaults),
  mergeReviewedPullRequests: z.boolean().default(false),
});

export type InboxStatus = z.infer<typeof statusSchema>;

export const inboxPageSize = 200;

const inboxQuerySchema = z
  .object({
    projectId: id.nullable().default(null),
    routeId: id.nullable().default(null),
    search: z.string().max(1000).default(""),
    severity: z.enum(["", "error", "fatal"]).default(""),
    sort: z.enum(["recent", "oldest", "severity"]).default("recent"),
    offset: z.number().int().nonnegative().max(1_000_000).default(0),
  })
  .strict();

const inboxPageSchema = z.object({
  incidents: z.array(incidentSchema).max(inboxPageSize),
  total: z.number().int().nonnegative(),
});

export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export type InboxPage = z.infer<typeof inboxPageSchema>;

const coordinatorCallbackStatusSchema = z
  .object({
    threadId: id,
    batchId: id,
    state: z.enum(["queued", "running", "waiting", "blocked"]),
    packageCount: z.number().int().nonnegative().max(10000),
    queued: z.number().int().nonnegative().max(10000),
    running: z.number().int().nonnegative().max(10000),
    reason: z.string().max(500).nullable(),
  })
  .strict();

export type CoordinatorCallbackStatus = z.infer<typeof coordinatorCallbackStatusSchema>;

export const callbackStatusSchema = z
  .object({ coordinators: z.array(coordinatorCallbackStatusSchema).max(100) })
  .strict();

export const rpcContract = defineRpcContract({
  ...workflowRpc,
  status: { input: z.null(), output: statusSchema },
  "inbox.list": { input: inboxQuerySchema, output: inboxPageSchema },
  badge: { input: z.null(), output: badgeSchema },
  "callback.status": { input: z.null(), output: callbackStatusSchema },
  "queue.reconcile": {
    input: z.null(),
    output: z.object({ reconciled: z.literal(true) }).strict(),
  },
  "projects.policy": { input: projectPolicySchema, output: policyUsageSchema },
  "projects.catalog": {
    input: z.object({ organization: z.string().regex(/^[a-z0-9-]+$/u) }).strict(),
    output: z.array(sentryProjectSchema),
  },
  "projects.repositories": {
    input: z.object({ projectId: id }).strict(),
    output: z.array(projectRepositorySchema),
  },
  "projects.add": { input: routeSchema, output: routeSchema },
  "projects.solveAll": {
    input: z
      .object({ projectId: id, model: modelSelectionSchema.nullable().default(null) })
      .strict(),
    output: batchSchema,
  },
  "models.save": {
    input: z.object({ role: modelRoleSchema, selection: modelSelectionSchema }).strict(),
    output: modelDefaultsSchema,
  },
  "batches.stop": { input: z.object({ id }).strict(), output: batchSchema },
  "batches.resume": { input: z.object({ id }).strict(), output: batchSchema },
  targets: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
      hosts: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  doctor: {
    input: z.object({ routeId: id.nullable().default(null) }).strict(),
    output: z.object({
      ready: z.boolean(),
      checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
    }),
  },
  "routes.save": { input: routeSchema, output: routeSchema },
  "routes.enable": { input: z.object({ id, enabled: z.boolean() }).strict(), output: routeSchema },
  "sync.start": { input: z.null(), output: z.object({ accepted: z.literal(true) }) },
  sync: {
    input: z.object({ dryRun: z.boolean().default(false) }).strict(),
    output: z.object({
      candidates: z.array(incidentSchema),
      scanned: z.number(),
      dryRun: z.boolean(),
    }),
  },
  investigate: {
    input: z
      .object({
        routeId: id,
        issueUrl: z.url(),
        mode: z.enum(["local", "pr"]).default("local"),
        model: modelSelectionSchema.nullable().default(null),
      })
      .strict(),
    output: runSchema,
  },
  "runs.show": { input: z.object({ id }).strict(), output: runSchema },
  "runs.stop": { input: z.object({ id }).strict(), output: runSchema },
  "runs.retry": { input: z.object({ id }).strict(), output: runSchema },
});
