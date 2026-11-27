import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const cleanupItem = z.object({
  projectId: z.string(),
  projectName: z.string(),
  repo: z.string(),
  kind: z.enum(["folder", "branch"]),
  target: z.string(),
  head: z.string(),
  base: z.string(),
  estimatedBytes: z.number().nonnegative().nullable(),
});

export const cleanupResult = z.object({
  removed: z.array(
    cleanupItem.extend({ freedBytes: z.number().nonnegative().nullable() }),
  ),
  skipped: z.array(cleanupItem.extend({ reason: z.string() })),
});

const scope = z.object({ projectId: z.string().min(1) });

const selection = scope.extend({
  repo: z.string(),
  target: z.string(),
  base: z.string(),
  mode: z.enum(["working", "branch"]),
});

const worktree = z.object({
  path: z.string(),
  head: z.string(),
  branch: z.string().nullable(),
  locked: z.boolean(),
  missing: z.boolean(),
  bare: z.boolean(),
  error: z.string().nullable(),
  dirty: z.boolean(),
  dirtyFiles: z.array(z.string()),
  ignored: z.boolean(),
  lastActivityAt: z.number().nullable().default(null),
  unsavedCommitCount: z.number().int().nonnegative().nullable().default(null),
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
  storage: z.object({
    status: z.enum(["measured", "partial", "unavailable"]),
    allocatedBytes: z.number().nonnegative().nullable(),
    reclaimableBytes: z.number().nonnegative().nullable(),
    measuredAt: z.string(),
    error: z.string().nullable(),
  }),
  purgeReady: z.boolean(),
  preserveIn: z.string().nullable(),
  reasons: z.array(z.string()),
});

const repository = z.object({
  path: z.string(),
  base: z.string().nullable(),
  baseRef: z.string().nullable().default(null),
  branches: z.array(
    z.object({
      name: z.string(),
      head: z.string(),
      ahead: z.number().nullable(),
      behind: z.number().nullable(),
      worktrees: z.array(z.string()),
      deleteReady: z.boolean(),
      deleteBase: z.string().nullable(),
      reasons: z.array(z.string()),
    }),
  ),
  worktrees: z.array(worktree),
});

export const sidebarRepository = repository
  .pick({ path: true, base: true })
  .extend({
    branches: z.array(
      repository.shape.branches.element.pick({
        name: true,
        head: true,
        ahead: true,
        worktrees: true,
      }),
    ),
    worktrees: z.array(
      worktree.pick({
        path: true,
        head: true,
        branch: true,
        dirty: true,
        dirtyFiles: true,
        ahead: true,
        error: true,
      }),
    ),
  });

export const scanInventory = z.object({
  entries: z.array(
    z.object({
      projectId: z.string(),
      projectName: z.string(),
      path: z.string(),
      repo: repository.nullable(),
      error: z.string().nullable(),
    }),
  ),
  issues: z.array(z.string()),
  missingInactiveEnvironments: z
    .array(z.object({ projectId: z.string(), path: z.string() }))
    .optional(),
  scannedAt: z.string(),
});

export const savedScan = scanInventory.extend({
  id: z.string(),
  durationMs: z.number().nonnegative(),
  items: z.array(cleanupItem),
});

export type SavedScan = z.infer<typeof savedScan>;

export const cleanupOutcome = cleanupResult.extend({ finishedAt: z.string() });

export type CleanupOutcome = z.infer<typeof cleanupOutcome>;

export const savedRecord = z.object({
  snapshot: savedScan.nullable(),
  lastError: z.string().nullable(),
  lastCleanup: cleanupOutcome.nullable().default(null),
});

const scanState = savedRecord.extend({
  scanning: z.boolean(),
  startedAt: z.string().nullable(),
  nextScanAt: z.string(),
});

export const ownerRpcContract = defineRpcContract({
  inventory: { input: z.null(), output: scanInventory },
  cleanSaved: {
    input: z
      .object({ token: z.string(), items: z.array(cleanupItem) })
      .strict(),
    output: cleanupResult,
  },
  catalog: {
    input: z.null(),
    output: z.object({
      projects: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          repos: z.array(z.string()),
        }),
      ),
      errors: z.array(z.string()),
    }),
  },
  sidebar: {
    input: z.object({ projectIds: z.array(z.string()).max(256) }),
    output: z.object({
      projects: z.array(
        z.object({
          id: z.string(),
          repos: z.array(sidebarRepository),
          errors: z.array(z.string()),
        }),
      ),
      checkedAt: z.string(),
    }),
  },
  inspect: { input: scope.extend({ repo: z.string() }), output: repository },
  storage: {
    input: scope.extend({ repo: z.string() }),
    output: z.array(
      z.object({ path: z.string(), storage: worktree.shape.storage }),
    ),
  },
  cleanupSummary: {
    input: z.null(),
    output: z.object({
      folders: z.number().int().nonnegative(),
      estimatedBytes: z.number().nonnegative(),
      unknownFolders: z.number().int().nonnegative(),
      checkedAt: z.string(),
      issues: z.array(z.string()),
    }),
  },
  projects: {
    input: z.null(),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
  },
  scan: {
    input: scope,
    output: z.object({
      repos: z.array(repository),
      errors: z.array(z.string()),
      scannedAt: z.string(),
    }),
  },
  files: { input: selection, output: z.array(z.string()) },
  diff: {
    input: selection.extend({ path: z.string() }),
    output: z.object({ patch: z.string() }),
  },
  prepare: {
    input: scope.extend({ repo: z.string(), path: z.string() }),
    output: z.object({
      token: z.string(),
      path: z.string(),
      branch: z.string(),
      base: z.string(),
      estimatedBytes: z.number().nonnegative().nullable(),
    }),
  },
  prepareBranch: {
    input: scope.extend({ repo: z.string(), branch: z.string() }),
    output: z.object({
      token: z.string(),
      branch: z.string(),
      base: z.string(),
    }),
  },
  deleteBranch: {
    input: z.object({ token: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  prepareAll: {
    input: z.null(),
    output: z.object({
      token: z.string(),
      items: z.array(cleanupItem),
      issues: z.array(z.string()),
    }),
  },
  cleanupAll: {
    input: z.object({ token: z.string() }),
    output: cleanupResult,
  },
  purge: {
    input: z.object({ token: z.string() }),
    output: z.object({
      removed: z.boolean(),
      freedBytes: z.number().nonnegative().nullable(),
    }),
  },
});

export const reclaimSelection = z
  .object({
    projectId: z.string().min(1),
    repo: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

export const reclaimResult = z.object({
  status: z.enum(["completed", "unsupported", "disabled", "cancelled"]),
  sharedFiles: z.number().int().nonnegative(),
  privateBytesReleased: z.number().nonnegative(),
  volumeFreeBytesChange: z.number().safe().nullable().optional(),
  skippedFiles: z.number().int().nonnegative(),
  skippedWorktrees: z.array(z.object({ path: z.string(), reason: z.string() })),
});

export const rpcContract = defineRpcContract({
  ...ownerRpcContract,
  hostInventory: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: scanInventory,
  },
  cancelReclaim: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: z.object({ cancelled: z.boolean() }),
  },
  reclaimSpace: {
    input: z
      .object({
        hostId: z.string().min(1),
        worktrees: z.array(reclaimSelection).min(1).max(256),
      })
      .strict(),
    output: reclaimResult,
  },
  files: {
    ...ownerRpcContract.files,
    input: selection.extend({ hostId: z.string().min(1).optional() }),
  },
  diff: {
    ...ownerRpcContract.diff,
    input: selection.extend({
      path: z.string(),
      hostId: z.string().min(1).optional(),
    }),
  },
  savedScan: { input: z.null(), output: scanState },
  rescan: { input: z.null(), output: scanState },
  cleanSaved: {
    input: z.object({ snapshotId: z.string().min(1) }).strict(),
    output: ownerRpcContract.cleanupAll.output,
  },
});
