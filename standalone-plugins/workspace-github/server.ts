import { discoveryContract } from "./host-contract.js";
import {
  CLOSED_ISSUE_PAGE,
  CLOSED_PR_PAGE,
  ISSUE_PAGE,
  PR_PAGE,
  SYNC_INTERVAL_MINUTES,
} from "./limits.js";
import {
  defineRpcContract,
  PluginCliError,
  cliCommand,
  defineCli,
  type PluginApi,
  type PluginCliResult,
} from "@omnyo/plugin-sdk";
import { z } from "zod";

const SYNC_INTERVAL_MS = SYNC_INTERVAL_MINUTES * 60_000;

const SYNC_RETRY_MAX_MS = 5 * 60_000;

const SYNC_RETRY_BASE_MS = 30_000;

const MERGE_RECHECK_LIMIT = 40;

const MERGE_RECHECK_DELAY_MS = 4_000;

const repoNameSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);

const itemNumberSchema = z.number().int().positive();

const itemInputSchema = z.object({ repo: repoNameSchema, number: itemNumberSchema }).strict();

const mergeMethodSchema = z.enum(["squash", "merge", "rebase"]);

const itemActionsSchema = z
  .object({
    canClose: z.boolean(),
    canReopen: z.boolean(),
    canMerge: z.boolean(),
    mergeMethods: z.array(mergeMethodSchema),
    headOid: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    mergeBlockReason: z.string().nullable(),
  })
  .strict();

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");

const repoInfoSchema = z
  .object({ repo: repoNameSchema, projectId: z.string().nullable() })
  .strict();

const pullReviewSchema = z.enum([
  "changes-requested",
  "conflicts",
  "review-required",
  "approved",
  "draft",
  "open",
]);

const checkRollupSchema = z.enum(["success", "failure", "pending"]);

const reviewerSchema = z
  .object({
    login: z.string().min(1),
    state: z.enum(["approved", "changes-requested", "commented", "requested"]),
  })
  .strict();

const itemMetaFields = {
  createdAt: z.string().optional(),
  closedAt: z.string().optional(),
  mergedAt: z.string().optional(),
  comments: z.number().int().nonnegative().optional(),
  labelColors: z.record(z.string(), z.string().regex(/^[0-9a-fA-F]{6}$/)).optional(),
  headRef: z.string().optional(),
  baseRef: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  checks: checkRollupSchema.optional(),
  reviewers: z.array(reviewerSchema).optional(),
  linkedIssues: z
    .array(z.object({ repo: repoNameSchema, number: itemNumberSchema }).strict())
    .optional(),
};

const storedMetaSchema = z.object(itemMetaFields);

type ItemMeta = z.infer<typeof storedMetaSchema>;

const itemSchema = z
  .object({
    repo: repoNameSchema,
    number: itemNumberSchema,
    kind: z.enum(["issue", "pr"]),
    title: z.string(),
    state: z.string(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string(),
    pullReview: pullReviewSchema.optional(),
    pullMerge: z.string().optional(),
    ...itemMetaFields,
  })
  .strict();

const syncResultSchema = z
  .object({
    repos: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
  })
  .strict();

const okResultSchema = z.object({ ok: z.literal(true) }).strict();

const commentSchema = z
  .object({ author: z.string(), body: z.string(), createdAt: z.string() })
  .strict();

const threadLinkSchema = z
  .object({
    kind: z.enum(["issue", "pr"]),
    repo: repoNameSchema,
    number: itemNumberSchema,
    threadId: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();

const pullSchema = z
  .object({
    repo: repoNameSchema,
    number: itemNumberSchema,
    title: z.string(),
    state: z.string(),
    author: z.string(),
    body: z.string(),
    url: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    baseRefName: z.string(),
    headRefName: z.string(),
    additions: z.number().nonnegative(),
    deletions: z.number().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    reviewDecision: z.string(),
    mergeStateStatus: z.string(),
    reviewRequests: z.array(z.string()),
    checks: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(["success", "failure", "pending", "neutral"]),
          url: z.string(),
        })
        .strict(),
    ),
    comments: z.array(commentSchema),
    reviews: z.array(
      z
        .object({
          author: z.string(),
          state: z.string(),
          body: z.string(),
          createdAt: z.string(),
        })
        .strict(),
    ),
    reviewThreads: z.array(
      z
        .object({
          path: z.string(),
          line: z.number().int().nonnegative().nullable(),
          diffHunk: z.string(),
          comments: z.array(commentSchema),
        })
        .strict(),
    ),
    files: z.array(
      z
        .object({
          path: z.string(),
          status: z.string(),
          additions: z.number().nonnegative(),
          deletions: z.number().nonnegative(),
          patch: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const githubRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z
      .object({
        ghOk: z.boolean(),
        ghState: z.enum(["ready", "needs_configuration", "unavailable"]),
        ghError: z.string().nullable(),
        repos: z.array(repoInfoSchema),
        projects: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
        lastSyncedAt: z.string().nullable(),
        warnings: z.array(z.string()),
        notices: z.array(z.string()),
      })
      .strict(),
  },
  counts: {
    input: z.null(),
    output: z
      .object({
        issues: z.number().int().nonnegative(),
        prs: z.number().int().nonnegative(),
        lastSyncedAt: z.string().nullable(),
        stale: z.boolean(),
      })
      .strict(),
  },
  repositorySettings: {
    input: z.object({ refresh: z.boolean().optional() }).strict(),
    output: z
      .object({
        repos: z.array(
          repoInfoSchema.extend({ excluded: z.boolean(), available: z.boolean() }).strict(),
        ),
        projects: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
        warnings: z.array(z.string()),
      })
      .strict(),
  },
  setRepoExcluded: {
    input: z.object({ repo: repoNameSchema, excluded: z.boolean() }).strict(),
    output: okResultSchema,
  },
  refresh: { input: z.null(), output: syncResultSchema },
  listItems: {
    input: z
      .object({
        kind: z.enum(["issue", "pr"]).optional(),
        repo: repoNameSchema.optional(),
        query: z.string().optional(),
        state: z.enum(["open", "closed"]).optional(),
        mine: z.boolean().optional(),
        includeBody: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ items: z.array(itemSchema) }).strict(),
  },
  viewer: {
    input: z.null(),
    output: z.object({ login: z.string().min(1) }).strict(),
  },
  assignableUsers: {
    input: z.object({ repo: repoNameSchema }).strict(),
    output: z.object({ users: z.array(z.string().min(1)) }).strict(),
  },
  repositoryLabels: {
    input: z.object({ repo: repoNameSchema }).strict(),
    output: z.object({ labels: z.array(z.string().min(1)) }).strict(),
  },
  itemActions: {
    input: itemInputSchema.extend({ kind: z.enum(["issue", "pr"]) }).strict(),
    output: itemActionsSchema,
  },
  setPullState: {
    input: itemInputSchema.extend({ state: z.enum(["open", "closed"]) }).strict(),
    output: okResultSchema,
  },
  mergePull: {
    input: itemInputSchema
      .extend({ method: mergeMethodSchema, headOid: z.string().regex(/^[a-f0-9]{40}$/) })
      .strict(),
    output: okResultSchema,
  },
  setIssueState: {
    input: itemInputSchema.extend({ state: z.enum(["open", "closed"]) }).strict(),
    output: okResultSchema,
  },
  setAssignees: {
    input: itemInputSchema.extend({ assignees: z.array(z.string().min(1)) }).strict(),
    output: z.object({ ok: z.literal(true), assignees: z.array(z.string().min(1)) }).strict(),
  },
  setLabels: {
    input: itemInputSchema.extend({ labels: z.array(z.string()) }).strict(),
    output: z.object({ ok: z.literal(true), labels: z.array(z.string().min(1)) }).strict(),
  },
  getIssue: {
    input: itemInputSchema,
    output: z
      .object({
        issue: z
          .object({
            repo: repoNameSchema,
            number: itemNumberSchema,
            title: z.string(),
            state: z.string(),
            author: z.string(),
            body: z.string(),
            labels: z.array(z.string()),
            assignees: z.array(z.string()),
            url: z.string(),
            updatedAt: z.string(),
            comments: z.array(commentSchema),
          })
          .strict(),
      })
      .strict(),
  },
  getPull: {
    input: itemInputSchema,
    output: z.object({ pull: pullSchema }).strict(),
  },
  commentPull: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  pullForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        pull: z
          .object({
            repo: repoNameSchema,
            number: itemNumberSchema,
            environmentId: z.string().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  },
  commentIssue: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  createIssue: {
    input: z
      .object({
        repo: repoNameSchema,
        title: nonBlankStringSchema,
        body: z.string().optional(),
      })
      .strict(),
    output: z.object({ number: itemNumberSchema.nullable(), url: z.string() }).strict(),
  },
  startWork: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  startReview: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  listLinks: {
    input: z.null(),
    output: z.object({ links: z.record(z.string(), z.array(threadLinkSchema)) }).strict(),
  },
});

type RepoInfo = z.infer<typeof repoInfoSchema>;

const hostDiscoverySchema = z.record(
  z.string(),
  z
    .object({
      repos: z.array(z.object({ repo: repoNameSchema, path: z.string() }).strict()),
      discoveredAt: z.string(),
    })
    .strict(),
);

function discoveredOn(at: string): string {
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

type CachedItem = z.infer<typeof itemSchema>;

type ThreadLink = z.infer<typeof threadLinkSchema>;

const ghLoginSchema = z.object({ login: z.string() });

const ghLabelSchema = z.object({ name: z.string() });

const ghCommentSchema = z.object({
  author: ghLoginSchema.nullish(),
  body: z.string(),
  createdAt: z.string(),
});

const ghListEntrySchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  author: ghLoginSchema.nullish(),
  labels: z.array(ghLabelSchema).optional(),
  assignees: z.array(ghLoginSchema).optional(),
  url: z.string(),
  body: z.string(),
  updatedAt: z.string().optional(),
});

const ghIssueSchema = ghListEntrySchema.extend({ comments: z.array(ghCommentSchema).optional() });

const ghPullSchema = ghIssueSchema.extend({
  isDraft: z.boolean(),
  createdAt: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number().optional(),
  reviewDecision: z.string(),
  mergeStateStatus: z.string(),
  statusCheckRollup: z
    .array(
      z.object({
        conclusion: z.string().nullish(),
        state: z.string().optional(),
        status: z.string().optional(),
        name: z.string().optional(),
        context: z.string().optional(),
        detailsUrl: z.string().optional(),
        targetUrl: z.string().optional(),
      }),
    )
    .nullish(),
  reviews: z
    .array(
      z.object({
        author: ghLoginSchema.nullish(),
        state: z.string(),
        body: z.string(),
        submittedAt: z.string(),
      }),
    )
    .optional(),
  reviewRequests: z
    .array(
      z.object({
        login: z.string().optional(),
        name: z.string().optional(),
        slug: z.string().optional(),
      }),
    )
    .optional(),
});

const ghReviewCommentSchema = z.object({
  id: z.number(),
  in_reply_to_id: z.number().optional(),
  path: z.string(),
  line: z.number().nullable().optional(),
  original_line: z.number().nullable().optional(),
  diff_hunk: z.string(),
  body: z.string(),
  created_at: z.string(),
  user: ghLoginSchema.nullish(),
});

const ghPullFileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().optional(),
});

const cachedRowSchema = z.object({
  repo: z.string(),
  number: z.number(),
  kind: z.enum(["issue", "pr"]),
  title: z.string(),
  state: z.string(),
  author: z.string(),
  labels: z.string(),
  assignees: z.string(),
  url: z.string(),
  body: z.string(),
  updated_at: z.string(),
  pull_review: pullReviewSchema.nullable(),
  pull_merge: z.string().nullable(),
  meta: z.string(),
});

function metaJson(item: ItemMeta): string {
  return JSON.stringify(storedMetaSchema.parse(item));
}

type GhRunner = (args: string[]) => Promise<string>;

const errorMessage = z
  .unknown()
  .transform((error) => (error instanceof Error ? error.message : String(error))).parse;

function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), {
    name: "NeedsConfigurationError",
  });
}

function isNeedsConfigurationError(error: unknown): error is Error {
  return error instanceof Error && error.name === "NeedsConfigurationError";
}

function ghUnavailable(message: string): Error {
  return Object.assign(new Error(message), { name: "GhUnavailableError" });
}

function isGhUnavailableError(error: unknown): error is Error {
  return error instanceof Error && error.name === "GhUnavailableError";
}

const GH_HOST = "github.com";

function isRepoName(value: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(value);
}

export function parseExtraRepos(raw: string) {
  const repos: string[] = [];
  const ignored: string[] = [];

  for (const entry of raw.split(/[\s,]+/)) {
    if (entry === "") continue;

    if (isRepoName(entry)) {
      if (!repos.includes(entry)) repos.push(entry);
    } else if (!ignored.includes(entry)) {
      ignored.push(entry);
    }
  }

  return { repos, ignored };
}

function describeIgnoredExtraRepos(ignored: string[]): string {
  return (
    `ignoring ${ignored.length} extraRepos ${ignored.length === 1 ? "entry" : "entries"} ` +
    `that ${ignored.length === 1 ? "is" : "are"} not "owner/repo": ${ignored.join(", ")}`
  );
}

export function parsePaginatedGhApi(raw: string) {
  const pages = z.array(z.array(z.record(z.string(), z.json()))).parse(JSON.parse(raw));

  return pages.flat();
}

function requireRepoName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  if (!isRepoName(value)) {
    throw new PluginCliError(`Invalid repository "${value}"; expected owner/repo.`, {
      code: "invalid_repository",
    });
  }

  return value;
}

const listNodeSchema = z.object({
  number: itemNumberSchema,
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  author: z.object({ __typename: z.string(), login: z.string() }).nullable(),
  labels: z.object({
    nodes: z.array(z.object({ name: z.string(), color: z.string().optional() })).max(100),
  }),
  assignees: z.object({
    nodes: z.array(z.object({ login: z.string() })).max(100),
  }),
  url: z.string(),
  body: z.string(),
  updatedAt: z.string(),
  createdAt: z.string().optional(),
  closedAt: z.string().nullish(),
  comments: z.object({ totalCount: z.number().int().nonnegative() }).optional(),
});

const pullSizeNodeFields = {
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
};

const openPullNodeSchema = listNodeSchema.extend({
  state: z.literal("OPEN"),
  isDraft: z.boolean().optional(),
  mergeable: z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]).optional(),
  mergeStateStatus: z.string().optional(),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullish(),
  ...pullSizeNodeFields,
  commits: z
    .object({
      nodes: z.array(
        z.object({
          commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }),
        }),
      ),
    })
    .optional(),
  reviewRequests: z
    .object({
      nodes: z.array(
        z.object({
          requestedReviewer: z
            .object({ login: z.string().optional(), slug: z.string().optional() })
            .nullable(),
        }),
      ),
    })
    .optional(),
  latestReviews: z
    .object({
      nodes: z.array(
        z.object({ state: z.string(), author: z.object({ login: z.string() }).nullable() }),
      ),
    })
    .optional(),
  closingIssuesReferences: z
    .object({
      nodes: z.array(
        z.object({
          number: itemNumberSchema,
          repository: z.object({ nameWithOwner: repoNameSchema }),
        }),
      ),
    })
    .optional(),
});

const closedPullNodeSchema = listNodeSchema.extend({
  state: z.enum(["CLOSED", "MERGED"]),
  mergedAt: z.string().nullish(),
  ...pullSizeNodeFields,
});

function checkRollup(
  node: z.infer<typeof openPullNodeSchema>,
): z.infer<typeof checkRollupSchema> | undefined {
  const state = node.commits?.nodes.at(-1)?.commit.statusCheckRollup?.state;

  if (state === "SUCCESS") return "success";

  if (state === "FAILURE" || state === "ERROR") return "failure";

  if (state === "PENDING" || state === "EXPECTED") return "pending";

  return undefined;
}

const REVIEW_STATES = new Map<string, z.infer<typeof reviewerSchema>["state"]>(
  Object.entries({
    APPROVED: "approved",
    CHANGES_REQUESTED: "changes-requested",
    COMMENTED: "commented",
  }),
);

function pullReviewers(node: z.infer<typeof openPullNodeSchema>): z.infer<typeof reviewerSchema>[] {
  const reviewers = new Map<string, z.infer<typeof reviewerSchema>>();

  for (const review of node.latestReviews?.nodes ?? []) {
    const state = REVIEW_STATES.get(review.state);

    if (review.author !== null && state !== undefined) {
      reviewers.set(review.author.login, { login: review.author.login, state });
    }
  }

  for (const request of node.reviewRequests?.nodes ?? []) {
    const login = request.requestedReviewer?.login ?? request.requestedReviewer?.slug;

    if (login !== undefined && login.length > 0) {
      reviewers.set(login, { login, state: "requested" });
    }
  }

  return [...reviewers.values()];
}

function listMeta(entry: z.infer<typeof listNodeSchema>): ItemMeta {
  const meta: ItemMeta = {};

  if (entry.createdAt !== undefined) meta.createdAt = entry.createdAt;

  if (entry.closedAt !== undefined && entry.closedAt !== null) meta.closedAt = entry.closedAt;

  if (entry.comments !== undefined) meta.comments = entry.comments.totalCount;

  const colors: Record<string, string> = {};

  for (const label of entry.labels.nodes) {
    if (label.color !== undefined && /^[0-9a-fA-F]{6}$/.test(label.color)) {
      colors[label.name] = label.color;
    }
  }

  if (Object.keys(colors).length > 0) meta.labelColors = colors;

  return meta;
}

function pullSizeMeta(entry: {
  headRefName?: string;
  baseRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}): ItemMeta {
  const meta: ItemMeta = {};

  if (entry.headRefName !== undefined) meta.headRef = entry.headRefName;

  if (entry.baseRefName !== undefined) meta.baseRef = entry.baseRefName;

  if (entry.additions !== undefined) meta.additions = entry.additions;

  if (entry.deletions !== undefined) meta.deletions = entry.deletions;

  if (entry.changedFiles !== undefined) meta.changedFiles = entry.changedFiles;

  return meta;
}

function openPullMeta(entry: z.infer<typeof openPullNodeSchema>): ItemMeta {
  const meta: ItemMeta = pullSizeMeta(entry);
  const checks = checkRollup(entry);

  if (checks !== undefined) meta.checks = checks;

  if (entry.latestReviews !== undefined || entry.reviewRequests !== undefined) {
    meta.reviewers = pullReviewers(entry);
  }

  if (entry.closingIssuesReferences !== undefined) {
    meta.linkedIssues = entry.closingIssuesReferences.nodes.map((issue) => ({
      repo: issue.repository.nameWithOwner,
      number: issue.number,
    }));
  }

  return meta;
}

function closedPullMeta(entry: z.infer<typeof closedPullNodeSchema>): ItemMeta {
  const meta: ItemMeta = pullSizeMeta(entry);

  if (entry.mergedAt !== undefined && entry.mergedAt !== null) meta.mergedAt = entry.mergedAt;

  return meta;
}

function pullReview(
  node: z.infer<typeof openPullNodeSchema>,
): z.infer<typeof pullReviewSchema> | undefined {
  if (node.isDraft === true) return "draft";

  if (node.mergeable === "CONFLICTING") return "conflicts";

  if (node.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";

  if (node.reviewDecision === "REVIEW_REQUIRED") return "review-required";

  if (node.reviewDecision === "APPROVED") return "approved";

  if (node.isDraft === false) return "open";

  return undefined;
}

const repoPermissionSchema = z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]).nullable();

function canWrite(permission: z.infer<typeof repoPermissionSchema>): boolean {
  return permission === "ADMIN" || permission === "MAINTAIN" || permission === "WRITE";
}

function isVisibleItem(
  item: Pick<CachedItem, "kind" | "author">,
  viewer: string,
  writable: boolean,
): boolean {
  if (item.author.toLowerCase() === viewer.toLowerCase()) return true;

  return item.kind === "pr" && writable && /^app\/./.test(item.author);
}

const repositoryListsSchema = z.object({
  data: z.object({
    repository: z.object({
      nameWithOwner: repoNameSchema,
      hasIssuesEnabled: z.boolean(),
      viewerPermission: repoPermissionSchema,
      openIssues: z.object({
        nodes: z.array(listNodeSchema.extend({ state: z.literal("OPEN") })).max(ISSUE_PAGE),
      }),
      closedIssues: z.object({
        nodes: z
          .array(listNodeSchema.extend({ state: z.literal("CLOSED") }))
          .max(CLOSED_ISSUE_PAGE),
      }),
      openPrs: z.object({
        nodes: z.array(openPullNodeSchema).max(PR_PAGE),
      }),
      closedPrs: z.object({
        nodes: z.array(closedPullNodeSchema).max(CLOSED_PR_PAGE),
      }),
    }),
  }),
  errors: z.array(z.unknown()).max(0).optional(),
});

const listFields = `
  number title state author { __typename login }
  labels(first: 100) { nodes { name color } }
  assignees(first: 100) { nodes { login } }
  url body updatedAt createdAt closedAt comments { totalCount }
`;

const repositoryNameQuery = `query RepositoryName($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { nameWithOwner }
}`;

const repositoryNameSchema = z.object({
  data: z.object({
    repository: z.object({ nameWithOwner: repoNameSchema }).nullable(),
  }),
});

const mergeStatesSchema = z.object({
  data: z.object({
    repository: z.record(
      z.string(),
      z
        .object({
          mergeStateStatus: z.string(),
          mergeable: z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]),
        })
        .nullable(),
    ),
  }),
});

const pullSizeFields = "headRefName baseRefName additions deletions changedFiles";

const openPullFields = `isDraft mergeable mergeStateStatus reviewDecision ${pullSizeFields}
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug } } } }
  latestReviews(first: 10) { nodes { state author { login } } }
  closingIssuesReferences(first: 5) { nodes { number repository { nameWithOwner } } }`;

const repositoryListsQuery = `query RepositoryLists($owner: String!, $name: String!, $viewer: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    hasIssuesEnabled
    viewerPermission
    openIssues: issues(first: ${ISSUE_PAGE}, states: [OPEN], filterBy: {createdBy: $viewer}, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { ${listFields} }
    }
    closedIssues: issues(first: ${CLOSED_ISSUE_PAGE}, states: [CLOSED], filterBy: {createdBy: $viewer}, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { ${listFields} }
    }
    openPrs: pullRequests(first: ${PR_PAGE}, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { ${listFields} ${openPullFields} }
    }
    closedPrs: pullRequests(first: ${CLOSED_PR_PAGE}, states: [CLOSED, MERGED], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { ${listFields} mergedAt ${pullSizeFields} }
    }
  }
}`;

async function fetchRepoItems(
  gh: GhRunner,
  repo: string,
  viewer: string,
): Promise<{ repo: string; items: CachedItem[] }> {
  const [owner, name] = repoNameSchema.parse(repo).split("/");

  const raw = await gh([
    "api",
    "graphql",
    "--hostname",
    GH_HOST,
    "-f",
    `query=${repositoryListsQuery}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `viewer=${viewer}`,
  ]);

  const {
    data: { repository },
  } = repositoryListsSchema.parse(JSON.parse(raw));

  const writable = canWrite(repository.viewerPermission);

  const toItem = (entry: z.infer<typeof listNodeSchema>, kind: "issue" | "pr"): CachedItem => ({
    repo: repository.nameWithOwner,
    number: entry.number,
    kind,
    title: entry.title,
    state: entry.state,
    author:
      entry.author === null
        ? "app/"
        : entry.author.__typename === "Bot"
          ? `app/${entry.author.login}`
          : entry.author.login,
    labels: entry.labels.nodes.map((label) => label.name),
    assignees: entry.assignees.nodes.map((user) => user.login),
    url: entry.url,
    body: entry.body,
    updatedAt: entry.updatedAt,
    ...listMeta(entry),
  });

  return {
    repo: repository.nameWithOwner,
    items: [
      ...(repository.hasIssuesEnabled
        ? [
            ...repository.openIssues.nodes.map((entry) => toItem(entry, "issue")),
            ...repository.closedIssues.nodes.map((entry) => toItem(entry, "issue")),
          ]
        : []),
      ...repository.openPrs.nodes.map((entry) => ({
        ...toItem(entry, "pr"),
        ...openPullMeta(entry),
        pullReview: pullReview(entry),
        pullMerge: entry.mergeStateStatus,
      })),
      ...repository.closedPrs.nodes.map((entry) => ({
        ...toItem(entry, "pr"),
        ...closedPullMeta(entry),
      })),
    ].filter((item) => isVisibleItem(item, viewer, writable)),
  };
}

export default async function plugin(api: PluginApi) {
  const savedExclusions = await api.storage.kv.get<string[]>("repo-exclusions");

  let exclusions =
    savedExclusions === undefined ? [] : z.array(repoNameSchema).parse(savedExclusions);

  const settings = api.settings.define({
    extraRepos: {
      type: "string",
      label: "Extra repositories",
      description:
        'Comma-separated "owner/repo" list to track in addition to repos discovered from Omnyo projects.',
      experimental_schema: z.string().superRefine((value, context) => {
        const { ignored } = parseExtraRepos(value);

        if (ignored.length > 0) {
          context.addIssue({
            code: "custom",
            message: `Use "owner/repo" for every entry. Invalid: ${ignored.join(", ")}`,
          });
        }
      }),
      default: "",
    },
    defaultProject: {
      type: "project",
      label: "Default Omnyo project",
      description: "Where agent threads spawn for repos that are not attached to an Omnyo project.",
    },
  });

  const lifetime = new AbortController();
  api.onDispose(() => lifetime.abort());
  const discovery = api.hosts.experimental_client({ contract: discoveryContract });

  type GhState = "ready" | "needs_configuration" | "unavailable";

  let ghState: GhState = "unavailable";
  let ghAuthError: string | null = "checking gh…";

  const ghMachineUnavailable =
    "The machine running Omnyo is not connected, so GitHub CLI cannot run.";

  let ghHost: Promise<string> | null = null;

  function ghHostId(): Promise<string> {
    if (ghHost === null) {
      const lookup = api.sdk.system.config().then(({ primaryHostId }) => {
        if (primaryHostId === null) throw ghUnavailable(ghMachineUnavailable);

        return primaryHostId;
      });

      ghHost = lookup;
      lookup.catch(() => {
        if (ghHost === lookup) ghHost = null;
      });
    }

    return ghHost;
  }

  async function gh(args: string[], timeoutMs = 30_000): Promise<string> {
    const result = await discovery.call(
      "gh",
      { args, timeoutMs },
      { hostId: await ghHostId(), timeoutMs: timeoutMs + 10_000, signal: lifetime.signal },
    );

    return result.stdout;
  }

  async function probeAuth(): Promise<void> {
    const status = await ghHostId()
      .then((hostId) =>
        discovery.call("authStatus", null, { hostId, timeoutMs: 30_000, signal: lifetime.signal }),
      )
      .catch(() => {
        lifetime.signal.throwIfAborted();
        ghState = "unavailable";
        ghAuthError = ghMachineUnavailable;
        throw ghUnavailable(ghAuthError);
      });

    ghState = status.state;
    ghAuthError = status.error;

    if (status.state === "needs_configuration")
      throw needsConfiguration(status.error ?? "GitHub authentication is unavailable.");

    if (status.state === "unavailable")
      throw ghUnavailable(status.error ?? "GitHub is unavailable.");
  }

  let authProbe: Promise<void> | null = null;

  function checkAuth(): Promise<void> {
    if (authProbe === null) {
      authProbe = probeAuth().finally(() => {
        authProbe = null;
      });
    }

    return authProbe;
  }

  let discoveryWarnings: string[] = [];
  let discoveryNotices: string[] = [];
  let syncWarnings: string[] = [];

  let repoCache: RepoInfo[] | null = null;

  let ignoredExtraRepos: string[] = [];
  let lastIgnoredExtraReposKey: string | null = null;

  let repoDiscovery: Promise<RepoInfo[]> | null = null;

  const savedAliases = z
    .array(z.tuple([repoNameSchema, repoNameSchema]))
    .parse((await api.storage.kv.get<[string, string][]>("repo-aliases")) ?? []);

  const repoAliases = new Map(savedAliases);
  const canonicalRepo = (repo: string) => repoAliases.get(repo.toLowerCase()) ?? repo;
  let projectList: { id: string; name: string }[] = [];

  function isExcludedRepo(repo: string): boolean {
    const name = canonicalRepo(repo).toLowerCase();

    return exclusions.some((excluded) => canonicalRepo(excluded).toLowerCase() === name);
  }

  async function rememberRepoAlias(origin: string, canonical: string): Promise<void> {
    repoAliases.set(origin.toLowerCase(), canonical);
    await api.storage.kv.set("repo-aliases", [...repoAliases]);
  }

  settings.onChange((next, previous) => {
    if (next.extraRepos === previous.extraRepos) return;
    repoCache = null;
    api.realtime.publish("data-changed", {});
  });

  async function collectRepos(): Promise<RepoInfo[]> {
    const byRepo = new Map<string, RepoInfo>();
    const warnings: string[] = [];
    const notices: string[] = [];

    const [projects, hosts, savedDiscovery] = await Promise.all([
      api.sdk.projects.list(),
      api.sdk.hosts.list(),
      api.storage.kv.get("host-discovery"),
    ]);

    const lastDiscovery = hostDiscoverySchema.parse(savedDiscovery ?? {});
    const hostById = new Map(hosts.map((host) => [host.id, host]));
    projectList = projects.map(({ id, name }) => ({ id, name }));
    const sources = new Map<string, { path: string; projectId: string }[]>();

    for (const project of projects) {
      for (const source of project.sources ?? []) {
        if (source.type !== "local_path") continue;
        const group = sources.get(source.hostId) ?? [];
        group.push({ path: source.path, projectId: project.id });
        sources.set(source.hostId, group);
      }
    }

    async function discoverHost(
      hostId: string,
      roots: { path: string }[],
    ): Promise<{ found: { repo: string; path: string }[]; warnings: string[]; notice?: string }> {
      const host = hostById.get(hostId);
      const name = host?.name ?? hostId;
      const previous = lastDiscovery[hostId];

      if (host?.status === "disconnected") {
        if (previous === undefined)
          return {
            found: [],
            warnings: [`${name} is offline. Its repositories appear once it reconnects.`],
          };

        return {
          found: previous.repos,
          warnings: [],
          notice: `${name} is offline. Showing its repositories found on ${discoveredOn(previous.discoveredAt)}.`,
        };
      }

      try {
        const discovered = await discovery.call(
          "discover",
          { roots: roots.map((source) => source.path) },
          { hostId, signal: lifetime.signal },
        );

        lastDiscovery[hostId] = {
          repos: discovered.repos,
          discoveredAt: new Date().toISOString(),
        };

        return { found: discovered.repos, warnings: discovered.problems };
      } catch {
        lifetime.signal.throwIfAborted();

        return {
          found: previous?.repos ?? [],
          warnings: [
            previous === undefined
              ? `Could not discover repositories on ${name}. Check its Omnyo connection.`
              : `Could not discover repositories on ${name}. Showing its repositories found on ${discoveredOn(previous.discoveredAt)}.`,
          ],
        };
      }
    }

    const groups = [...sources].map(([hostId, roots]) => {
      roots.sort((a, b) => b.path.length - a.path.length);

      return { roots, discovered: discoverHost(hostId, roots) };
    });

    const results = await Promise.all(groups.map(({ discovered }) => discovered));

    for (const [index, { roots }] of groups.entries()) {
      const result = results[index];

      warnings.push(...result.warnings);

      if (result.notice !== undefined) notices.push(result.notice);

      for (const entry of result.found) {
        const owner = roots.find(
          (source) =>
            entry.path === source.path ||
            entry.path.startsWith(source.path + "/") ||
            entry.path.startsWith(source.path + "\\"),
        );

        const repo = canonicalRepo(entry.repo);

        if (owner !== undefined && !byRepo.has(repo.toLowerCase())) {
          byRepo.set(repo.toLowerCase(), { repo, projectId: owner.projectId });
        }
      }
    }

    await api.storage.kv.set("host-discovery", lastDiscovery);

    const { extraRepos } = await settings.get();
    const parsed = parseExtraRepos(extraRepos);

    for (const raw of parsed.repos) {
      const repo = canonicalRepo(raw);

      if (!byRepo.has(repo.toLowerCase())) {
        byRepo.set(repo.toLowerCase(), { repo, projectId: null });
      }
    }

    const ignoredKey = parsed.ignored.join(",");

    if (ignoredKey !== lastIgnoredExtraReposKey) {
      lastIgnoredExtraReposKey = ignoredKey;

      if (parsed.ignored.length > 0) {
        api.log.warn(describeIgnoredExtraRepos(parsed.ignored));
      }
    }

    ignoredExtraRepos = parsed.ignored;
    const repos = [...byRepo.values()];
    discoveryWarnings = warnings;
    discoveryNotices = notices;
    repoCache = repos;

    return repos;
  }

  function discoverRepoCatalog(force = false): Promise<RepoInfo[]> {
    if (repoDiscovery !== null) return repoDiscovery;

    if (!force && repoCache !== null) {
      return Promise.resolve(repoCache);
    }

    repoDiscovery = collectRepos().finally(() => {
      repoDiscovery = null;
    });

    return repoDiscovery;
  }

  async function discoverRepos(force = false): Promise<RepoInfo[]> {
    return (await discoverRepoCatalog(force)).filter(({ repo }) => !isExcludedRepo(repo));
  }

  async function getRepositorySettings(refresh = false) {
    const catalog = await discoverRepoCatalog(refresh);

    const repos = new Map(
      catalog.map((entry) => [
        entry.repo.toLowerCase(),
        {
          ...entry,
          excluded: isExcludedRepo(entry.repo),
          available: true,
        },
      ]),
    );

    for (const excluded of exclusions) {
      const repo = canonicalRepo(excluded);

      if (!repos.has(repo.toLowerCase())) {
        repos.set(repo.toLowerCase(), { repo, projectId: null, excluded: true, available: false });
      }
    }

    return {
      repos: [...repos.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
      projects: projectList,
      warnings: discoveryWarnings,
    };
  }

  let exclusionWrite = Promise.resolve();

  async function setRepoExcluded(repo: string, excluded: boolean): Promise<void> {
    const update = async () => {
      const next = new Map(
        exclusions.map((entry) => {
          const canonical = canonicalRepo(entry);

          return [canonical.toLowerCase(), canonical];
        }),
      );

      const canonical = canonicalRepo(repo);

      if (excluded) next.set(canonical.toLowerCase(), canonical);
      else next.delete(canonical.toLowerCase());

      const saved = [...next.values()];
      await api.storage.kv.set("repo-exclusions", saved);
      exclusions = saved;
      api.realtime.publish("data-changed", {});
    };

    const write = exclusionWrite.then(update, update);
    exclusionWrite = write;
    await write;
  }

  const db = api.storage.database();
  api.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS items (
       repo TEXT NOT NULL,
       number INTEGER NOT NULL,
       kind TEXT NOT NULL,
       title TEXT NOT NULL,
       state TEXT NOT NULL,
       author TEXT NOT NULL,
       labels TEXT NOT NULL,
       url TEXT NOT NULL,
       body TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (repo, kind, number)
     )`,
    `ALTER TABLE items ADD COLUMN assignees TEXT NOT NULL DEFAULT '[]'`,
    `DELETE FROM items`,
    `ALTER TABLE items ADD COLUMN pull_review TEXT`,
    `ALTER TABLE items ADD COLUMN pull_merge TEXT`,
    `ALTER TABLE items ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'`,
  ]);

  function parseStringArray(raw: string): string[] {
    return z.array(z.string()).parse(JSON.parse(raw));
  }

  function rowToItem(row: z.infer<typeof cachedRowSchema>): CachedItem {
    const item: CachedItem = {
      ...storedMetaSchema.parse(JSON.parse(row.meta)),
      repo: String(row.repo),
      number: Number(row.number),
      kind: row.kind === "pr" ? "pr" : "issue",
      title: String(row.title),
      state: String(row.state),
      author: String(row.author),
      labels: parseStringArray(row.labels),
      assignees: parseStringArray(row.assignees),
      url: String(row.url),
      body: String(row.body),
      updatedAt: String(row.updated_at),
    };

    if (row.pull_review !== null) item.pullReview = row.pull_review;

    if (row.pull_merge !== null) item.pullMerge = row.pull_merge;

    return item;
  }

  function listCachedItems(options: {
    kind?: "issue" | "pr";
    repo?: string;
    query?: string;
    state?: "open" | "closed";
    assignee?: string;
    includeBody?: boolean;
  }): CachedItem[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }

    if (options.repo !== undefined) {
      clauses.push("repo = ?");
      params.push(options.repo);
    }

    if (options.state === "open") {
      clauses.push("state = 'OPEN'");
    } else if (options.state === "closed") {
      clauses.push("state != 'OPEN'");
    }

    if (options.assignee !== undefined) {
      clauses.push("assignees LIKE ?");
      params.push(`%${JSON.stringify(options.assignee)}%`);
    }

    const query = options.query?.trim() ?? "";

    if (query.length > 0) {
      clauses.push("(title LIKE ? OR CAST(number AS TEXT) LIKE ? OR repo LIKE ?)");
      const like = `%${query.replace(/^#/, "")}%`;
      params.push(like, like, like);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const columns =
      options.includeBody === false
        ? "repo, number, kind, title, state, author, labels, assignees, url, '' AS body, updated_at, pull_review, pull_merge, meta"
        : "*";

    const rows = db
      .prepare(`SELECT ${columns} FROM items ${where} ORDER BY updated_at DESC`)
      .all(...params);

    return rows
      .map((row) => rowToItem(cachedRowSchema.parse(row)))
      .filter((item) => !isExcludedRepo(item.repo));
  }

  function getCachedItem(kind: "issue" | "pr", repo: string, number: number): CachedItem | null {
    const row = db
      .prepare("SELECT * FROM items WHERE repo = ? AND kind = ? AND number = ?")
      .get(repo, kind, number);

    return row === undefined ? null : rowToItem(cachedRowSchema.parse(row));
  }

  function replaceRepoRows(repo: string, items: CachedItem[], originRepo: string): void {
    const insert = db.prepare(
      `INSERT INTO items (repo, number, kind, title, state, author, labels, assignees, url, body, updated_at, pull_review, pull_merge, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    db.transaction(() => {
      db.prepare("DELETE FROM items WHERE repo IN (?, ?)").run(repo, originRepo);

      for (const item of items) {
        insert.run(
          item.repo,
          item.number,
          item.kind,
          item.title,
          item.state,
          item.author,
          JSON.stringify(item.labels),
          JSON.stringify(item.assignees),
          item.url,
          item.body,
          item.updatedAt,
          item.pullReview ?? null,
          item.pullMerge ?? null,
          metaJson(item),
        );
      }
    })();
  }

  function patchCachedItem(
    kind: "issue" | "pr",
    repo: string,
    number: number,
    patch: { state?: string; assignees?: string[]; labels?: string[] },
  ): void {
    if (patch.state !== undefined) {
      db.prepare(
        "UPDATE items SET state = ?, pull_review = NULL, pull_merge = NULL WHERE repo = ? AND kind = ? AND number = ?",
      ).run(patch.state, repo, kind, number);
    }

    if (patch.assignees !== undefined) {
      db.prepare(
        "UPDATE items SET assignees = ? WHERE repo = ? AND kind = 'issue' AND number = ?",
      ).run(JSON.stringify(patch.assignees), repo, number);
    }

    if (patch.labels !== undefined) {
      db.prepare(
        "UPDATE items SET labels = ? WHERE repo = ? AND kind = 'issue' AND number = ?",
      ).run(JSON.stringify(patch.labels), repo, number);
    }

    api.realtime.publish("data-changed", {});
  }

  const renameChecked = new Set<string>();

  async function resolveRenamedRows(active: Set<string>): Promise<void> {
    const stored = z
      .array(z.object({ repo: z.string() }))
      .parse(db.prepare("SELECT DISTINCT repo FROM items").all());

    for (const { repo } of stored) {
      const key = repo.toLowerCase();

      if (active.has(key) || renameChecked.has(key) || isExcludedRepo(repo) || !isRepoName(repo))
        continue;
      const [owner, name] = repo.split("/");
      let canonical: string | null;

      try {
        const raw = await gh([
          "api",
          "graphql",
          "--hostname",
          GH_HOST,
          "-f",
          `query=${repositoryNameQuery}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
        ]);

        canonical =
          repositoryNameSchema.parse(JSON.parse(raw)).data.repository?.nameWithOwner ?? null;
        renameChecked.add(key);
      } catch (error) {
        api.log.warn(`could not check ${repo} for a rename: ${errorMessage(error)}`);
        continue;
      }

      if (canonical === null || canonical.toLowerCase() === key) continue;
      await rememberRepoAlias(repo, canonical);
      const target = canonical;

      db.transaction(() => {
        if (active.has(target.toLowerCase())) {
          db.prepare("DELETE FROM items WHERE repo = ?").run(repo);
        } else {
          db.prepare("UPDATE OR REPLACE items SET repo = ? WHERE repo = ?").run(target, repo);
        }
      })();
      api.log.info(`${repo} was renamed to ${target}; moved its cached rows`);
    }
  }

  async function resolveUnknownMerges(): Promise<number> {
    const rows = z
      .array(z.object({ repo: repoNameSchema, number: itemNumberSchema }))
      .parse(
        db
          .prepare(
            "SELECT repo, number FROM items WHERE kind = 'pr' AND state = 'OPEN' AND pull_merge = 'UNKNOWN' ORDER BY updated_at DESC LIMIT ?",
          )
          .all(MERGE_RECHECK_LIMIT),
      )
      .filter(({ repo }) => !isExcludedRepo(repo));

    if (rows.length === 0) return 0;

    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        lifetime.signal.removeEventListener("abort", onAbort);
        resolve();
      }, MERGE_RECHECK_DELAY_MS);

      lifetime.signal.addEventListener("abort", onAbort, { once: true });
    });

    if (lifetime.signal.aborted) return 0;
    let updated = 0;
    const byRepo = new Map<string, number[]>();

    for (const { repo, number } of rows) byRepo.set(repo, [...(byRepo.get(repo) ?? []), number]);

    const update = db.prepare(
      `UPDATE items SET pull_merge = ?,
         pull_review = CASE WHEN ? = 'CONFLICTING' AND pull_review IS NOT 'draft' THEN 'conflicts' ELSE pull_review END
       WHERE repo = ? AND kind = 'pr' AND number = ? AND state = 'OPEN' AND pull_merge = 'UNKNOWN'`,
    );

    for (const [repo, numbers] of byRepo) {
      const [owner, name] = repo.split("/");

      const fields = numbers
        .map(
          (number) => `pr${number}: pullRequest(number: ${number}) { mergeStateStatus mergeable }`,
        )
        .join(" ");

      try {
        const raw = await gh([
          "api",
          "graphql",
          "--hostname",
          GH_HOST,
          "-f",
          `query=query MergeStates($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
        ]);

        const states = mergeStatesSchema.parse(JSON.parse(raw)).data.repository;

        db.transaction(() => {
          for (const number of numbers) {
            const state = states[`pr${number}`];

            if (state === undefined || state === null || state.mergeStateStatus === "UNKNOWN")
              continue;
            updated += update.run(state.mergeStateStatus, state.mergeable, repo, number).changes;
          }
        })();
      } catch (error) {
        api.log.warn(`could not recheck merge state in ${repo}: ${errorMessage(error)}`);
      }
    }

    return updated;
  }

  let syncing: Promise<z.infer<typeof syncResultSchema>> | null = null;

  function syncAll(): Promise<z.infer<typeof syncResultSchema>> {
    syncing ??= runSync().finally(() => {
      syncing = null;
    });

    return syncing;
  }

  async function runSync(): Promise<{ repos: number; items: number }> {
    try {
      await checkAuth();
    } catch (error) {
      api.realtime.publish("data-changed", {});
      throw error;
    }

    let viewer: string;

    try {
      viewer = await refreshViewer();
    } catch (error) {
      syncWarnings = [
        "Could not read the signed-in GitHub account; any displayed rows are from the previous sync.",
      ];
      api.realtime.publish("data-changed", {});
      throw ghUnavailable(`could not read the signed-in GitHub account: ${errorMessage(error)}`);
    }

    const repos = await discoverRepos(true);

    const warnings: string[] = [];
    const synced = new Map<string, number>();
    let failed = 0;
    let lastFailure = "";

    const included = repos.filter(({ repo }) => !isExcludedRepo(repo));

    for (let offset = 0; offset < included.length; offset += 2) {
      type Outcome = { repo: string } & (
        | { fetched: Awaited<ReturnType<typeof fetchRepoItems>> }
        | { error: unknown }
      );

      const batch = included.slice(offset, offset + 2).filter(({ repo }) => !isExcludedRepo(repo));

      const results = await Promise.all(
        batch.map(async ({ repo }): Promise<Outcome> => {
          try {
            return { repo, fetched: await fetchRepoItems(gh, repo, viewer) };
          } catch (error) {
            return { repo, error };
          }
        }),
      );

      for (const result of results) {
        const { repo } = result;

        if (isExcludedRepo(repo)) continue;

        try {
          if ("error" in result) throw result.error;
          await rememberRepoAlias(repo, result.fetched.repo);

          if (isExcludedRepo(repo)) continue;
          replaceRepoRows(result.fetched.repo, result.fetched.items, repo);
          synced.set(result.fetched.repo.toLowerCase(), result.fetched.items.length);
        } catch (error) {
          if (isExcludedRepo(repo)) continue;
          failed += 1;
          lastFailure = errorMessage(error);
          warnings.push(`Sync failed for ${repo}; any displayed rows are from the previous sync.`);
          api.log.warn(`sync failed for ${repo}: ${lastFailure}`);
        }
      }
    }

    syncWarnings = warnings;

    if (failed > 0 && synced.size === 0) {
      api.realtime.publish("data-changed", {});
      throw ghUnavailable(`sync failed for all ${failed} repo(s); last error: ${lastFailure}`);
    }

    repoCache = null;
    const total = [...synced.values()].reduce((sum, count) => sum + count, 0);
    const activeRepoNames = new Set<string>();

    for (const { repo } of repos) {
      if (!isExcludedRepo(repo)) activeRepoNames.add(canonicalRepo(repo).toLowerCase());
    }

    const repoCount = activeRepoNames.size;

    if (discoveryWarnings.length === 0) await resolveRenamedRows(activeRepoNames);

    await api.storage.kv.set("sync-cursor", {
      lastSyncedAt: new Date().toISOString(),
    });

    // A completed sync updates freshness even when the cached rows are unchanged.
    api.realtime.publish("data-changed", { items: total });

    api.log.info(`synced ${total} item(s) across ${repoCount} repo(s)`);

    void resolveUnknownMerges().then(
      (updated) => {
        if (updated > 0 && !lifetime.signal.aborted) {
          api.realtime.publish("data-changed", { items: updated });
        }
      },
      (error) => api.log.warn(`merge state recheck failed: ${errorMessage(error)}`),
    );

    return { repos: repoCount, items: total };
  }

  api.background.service("sync", {
    async start(signal) {
      let failures = 0;

      while (!signal.aborted) {
        let delayMs = SYNC_INTERVAL_MS;

        try {
          await syncAll();
          failures = 0;
        } catch (error) {
          if (!isGhUnavailableError(error)) throw error;
          failures += 1;
          delayMs = Math.min(SYNC_RETRY_BASE_MS * 2 ** (failures - 1), SYNC_RETRY_MAX_MS);
          api.log.warn(
            `sync failed (retry in ${Math.round(delayMs / 1000)}s): ${errorMessage(error)}`,
          );
        }

        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };

          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);

          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    },
  });

  try {
    await checkAuth();
  } catch (error) {
    if (isNeedsConfigurationError(error)) {
      api.status.needsConfiguration(error.message);
    } else if (isGhUnavailableError(error)) {
      api.log.warn(error.message);
    } else {
      throw error;
    }
  }

  function linkKey(kind: "issue" | "pr", repo: string, number: number): string {
    return `link:${kind}:${repo}#${number}`;
  }

  async function addLink(link: ThreadLink): Promise<void> {
    const key = linkKey(link.kind, link.repo, link.number);
    const existing = (await api.storage.kv.get<ThreadLink[]>(key)) ?? [];
    await api.storage.kv.set(key, [...existing, link]);
    api.realtime.publish("links-changed", { key });
  }

  async function listAllLinks(): Promise<Record<string, ThreadLink[]>> {
    const keys = await api.storage.kv.list("link:");
    const result: Record<string, ThreadLink[]> = {};

    for (const key of keys) {
      const links = await api.storage.kv.get<ThreadLink[]>(key);

      if (links !== undefined && links.length > 0) {
        result[key.slice("link:".length)] = links;
      }
    }

    return result;
  }

  async function resolveProjectId(repo: string): Promise<string> {
    const repos = await discoverRepos();
    const info = repos.find((entry) => entry.repo === repo);

    if (info?.projectId != null) return info.projectId;
    const { defaultProject } = await settings.get();

    if (defaultProject) return defaultProject;
    throw new Error(
      `No Omnyo project is attached to ${repo}. Create a project whose checkout has ` +
        "that origin remote, or set the defaultProject plugin setting.",
    );
  }

  async function spawnOnItem(
    kind: "issue" | "pr",
    repo: string,
    number: number,
  ): Promise<{ threadId: string }> {
    const item = getCachedItem(kind, repo, number);
    const title = item?.title ?? `${kind === "pr" ? "PR" : "issue"} #${number}`;
    const projectId = await resolveProjectId(repo);
    const ref = `${repo}#${number}`;

    const prompt =
      kind === "issue"
        ? [
            `Work on GitHub issue ${ref}: ${title}`,
            "",
            "Read the full issue and its comments first:",
            `  gh issue view ${number} -R ${repo} --comments`,
            "",
            item !== null && item.body.length > 0
              ? `Issue description:\n\n${item.body}`
              : "(no cached description — read it with the command above)",
            "",
            "Implement a fix or the requested change in this checkout. " +
              `If you open a pull request, include "Fixes #${number}" in its body.`,
          ].join("\n")
        : [
            `Review GitHub pull request ${ref}: ${title}`,
            "",
            "Read the PR and its diff:",
            `  gh pr view ${number} -R ${repo} --comments`,
            `  gh pr diff ${number} -R ${repo}`,
            "",
            "Review the change for correctness, missing tests, and design issues. " +
              "Summarize your findings with file/line references. Do not push " +
              "changes or post to GitHub unless asked.",
          ].join("\n");

    const thread = await api.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      title: `${ref}: ${title}`.slice(0, 120),
      prompt,
    });

    await addLink({
      kind,
      repo,
      number,
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
    api.log.info(`spawned thread ${thread.id} for ${kind} ${ref}`);

    return { threadId: thread.id };
  }

  let viewerCache: { login: string; fetchedAt: number } | null = null;

  async function getViewer(): Promise<string> {
    if (viewerCache !== null && Date.now() - viewerCache.fetchedAt < 60 * 60_000) {
      return viewerCache.login;
    }

    return await refreshViewer();
  }

  async function refreshViewer(): Promise<string> {
    const raw = await gh(["api", "user"], 15_000);
    const login = ghLoginSchema.parse(JSON.parse(raw)).login;

    if (login.length === 0) throw new Error("could not resolve the gh viewer login");
    viewerCache = { login, fetchedAt: Date.now() };

    return login;
  }

  const assignableCache = new Map<string, { users: string[]; fetchedAt: number }>();
  const labelsCache = new Map<string, { labels: string[]; fetchedAt: number }>();

  async function getAssignableUsers(repo: string): Promise<string[]> {
    const cached = assignableCache.get(repo);

    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.users;
    }

    const raw = await gh(["api", `repos/${repo}/assignees?per_page=100`], 15_000);
    const entries = z.array(ghLoginSchema).parse(JSON.parse(raw));

    const users = entries
      .map((entry) => String(entry?.login ?? ""))
      .filter((login) => login.length > 0)
      .sort((a, b) => a.localeCompare(b));

    assignableCache.set(repo, { users, fetchedAt: Date.now() });

    return users;
  }

  async function getRepoLabels(repo: string): Promise<string[]> {
    const cached = labelsCache.get(repo);

    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.labels;
    }

    const raw = await gh(["api", `repos/${repo}/labels?per_page=100`], 15_000);
    const entries = z.array(ghLabelSchema).parse(JSON.parse(raw));

    const labels = entries
      .map((entry) => String(entry?.name ?? "").trim())
      .filter((name) => name.length > 0)
      .sort((a, b) => a.localeCompare(b));

    labelsCache.set(repo, { labels, fetchedAt: Date.now() });

    return labels;
  }

  async function getItemActions(
    kind: "issue" | "pr",
    repo: string,
    number: number,
  ): Promise<z.infer<typeof itemActionsSchema>> {
    const [owner, name] = repoNameSchema.parse(repo).split("/");
    itemNumberSchema.parse(number);
    const fields = kind === "pr" ? "headRefOid isDraft mergeStateStatus" : "";

    const raw = await gh([
      "api",
      "graphql",
      "-f",
      `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed item:${kind === "pr" ? "pullRequest" : "issue"}(number:${number}){state viewerCanClose viewerCanReopen ${fields}}}}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    ]);

    const permissionItem = z.object({
      state: z.enum(["OPEN", "CLOSED", "MERGED"]),
      viewerCanClose: z.boolean(),
      viewerCanReopen: z.boolean(),
    });

    const {
      data: { repository },
    } = z
      .object({
        data: z.object({
          repository: z
            .object({
              viewerPermission: repoPermissionSchema,
              mergeCommitAllowed: z.boolean(),
              squashMergeAllowed: z.boolean(),
              rebaseMergeAllowed: z.boolean(),
              item: permissionItem
                .extend({
                  headRefOid: z.string().optional(),
                  isDraft: z.boolean().optional(),
                  mergeStateStatus: z.string().optional(),
                })
                .nullable(),
            })
            .nullable(),
        }),
      })
      .parse(JSON.parse(raw));

    if (repository === null || repository.item === null)
      throw new Error(
        "GitHub could not find this repository or item, or your account cannot access it.",
      );

    const actions: z.infer<typeof itemActionsSchema> = {
      canClose: repository.item.viewerCanClose,
      canReopen: repository.item.viewerCanReopen,
      canMerge: false,
      mergeMethods: [],
      headOid: null,
      mergeBlockReason: null,
    };

    if (kind === "issue") return actions;

    const pull = permissionItem
      .extend({
        headRefOid: z.string().regex(/^[a-f0-9]{40}$/),
        isDraft: z.boolean(),
        mergeStateStatus: z.string(),
      })
      .parse(repository.item);

    actions.headOid = pull.headRefOid;

    if (repository.squashMergeAllowed) actions.mergeMethods.push("squash");

    if (repository.mergeCommitAllowed) actions.mergeMethods.push("merge");

    if (repository.rebaseMergeAllowed) actions.mergeMethods.push("rebase");

    if (!canWrite(repository.viewerPermission))
      actions.mergeBlockReason =
        "Your GitHub account needs write permission to merge this pull request.";
    else if (pull.state !== "OPEN")
      actions.mergeBlockReason = "This pull request is no longer open.";
    else if (pull.isDraft)
      actions.mergeBlockReason =
        "Mark this pull request ready for review on GitHub before merging.";
    else if (!["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pull.mergeStateStatus))
      actions.mergeBlockReason =
        "GitHub merge requirements are not met. Check reviews, required checks, conflicts, and branch rules on GitHub.";
    else if (actions.mergeMethods.length === 0)
      actions.mergeBlockReason = "This repository has no enabled merge method.";
    actions.canMerge = actions.mergeBlockReason === null;

    return actions;
  }

  async function setItemState(
    kind: "issue" | "pr",
    repo: string,
    number: number,
    state: "open" | "closed",
  ): Promise<{ ok: true }> {
    const actions = await getItemActions(kind, repo, number);

    if (!(state === "closed" ? actions.canClose : actions.canReopen))
      throw new Error(
        "Your GitHub account does not have permission to change this item's state, or it is already in that state.",
      );
    await gh([kind, state === "closed" ? "close" : "reopen", String(number), "-R", repo]);
    patchCachedItem(kind, repo, number, { state: state === "closed" ? "CLOSED" : "OPEN" });

    return { ok: true };
  }

  api.rpc.register(githubRpcContract, {
    async itemActions({ kind, repo, number }) {
      return await getItemActions(kind, repo, number);
    },
    async setPullState({ repo, number, state }) {
      return await setItemState("pr", repo, number, state);
    },
    async mergePull({ repo, number, method, headOid }): Promise<{ ok: true }> {
      const actions = await getItemActions("pr", repo, number);

      if (!actions.canMerge)
        throw new Error(actions.mergeBlockReason ?? "GitHub merge requirements are not met.");

      if (actions.headOid !== headOid)
        throw new Error(
          "The pull request changed. Reload it and review the new commit before merging.",
        );

      if (!actions.mergeMethods.includes(method))
        throw new Error("This merge method is disabled for the repository.");

      const raw = await gh([
        "api",
        "--method",
        "PUT",
        `repos/${repo}/pulls/${number}/merge`,
        "-f",
        `sha=${headOid}`,
        "-f",
        `merge_method=${method}`,
      ]);

      const result = z.object({ merged: z.boolean() }).parse(JSON.parse(raw));

      if (!result.merged)
        throw new Error(
          "GitHub did not merge this pull request. Reload it and check its merge requirements.",
        );
      patchCachedItem("pr", repo, number, { state: "MERGED" });

      return { ok: true };
    },
    async repositorySettings(input) {
      return await getRepositorySettings(input.refresh);
    },

    async setRepoExcluded(input): Promise<{ ok: true }> {
      await setRepoExcluded(input.repo, input.excluded);

      return { ok: true };
    },

    async status() {
      if (ghState !== "ready") {
        try {
          await checkAuth();
        } catch {}
      }

      const cursor = await api.storage.kv.get<{
        lastSyncedAt: string;
      }>("sync-cursor");

      const repos = await discoverRepos();

      return {
        ghOk: ghState === "ready",
        ghState,
        ghError: ghAuthError,
        repos,
        projects: projectList,
        lastSyncedAt: cursor?.lastSyncedAt ?? null,
        warnings: [...discoveryWarnings, ...syncWarnings],
        notices: discoveryNotices,
      };
    },

    async counts() {
      const rows = z
        .array(
          z.object({
            repo: z.string(),
            kind: z.enum(["issue", "pr"]),
            count: z.number().int().nonnegative(),
          }),
        )
        .parse(
          db
            .prepare(
              "SELECT repo, kind, COUNT(*) AS count FROM items WHERE state = 'OPEN' GROUP BY repo, kind",
            )
            .all(),
        );

      let issues = 0;
      let prs = 0;

      for (const row of rows) {
        if (isExcludedRepo(row.repo)) continue;

        if (row.kind === "issue") issues += row.count;
        else prs += row.count;
      }

      const cursor = await api.storage.kv.get<{ lastSyncedAt: string }>("sync-cursor");
      const lastSyncedAt = cursor?.lastSyncedAt ?? null;

      return {
        issues,
        prs,
        lastSyncedAt,
        stale:
          lastSyncedAt === null ||
          ghState !== "ready" ||
          discoveryWarnings.length > 0 ||
          syncWarnings.length > 0,
      };
    },

    async refresh() {
      return await syncAll();
    },

    async listItems(input) {
      return {
        items: listCachedItems({
          kind: input.kind,
          repo: input.repo,
          query: input.query,
          state: input.state,
          assignee: input.mine === true ? await getViewer() : undefined,
          includeBody: input.includeBody,
        }),
      };
    },

    async viewer() {
      return { login: await getViewer() };
    },

    async assignableUsers(input) {
      return { users: await getAssignableUsers(input.repo) };
    },

    async repositoryLabels(input) {
      return { labels: await getRepoLabels(input.repo) };
    },

    async setIssueState({ repo, number, state }): Promise<{ ok: true }> {
      return await setItemState("issue", repo, number, state);
    },

    async setAssignees({ repo, number, assignees }): Promise<{ ok: true; assignees: string[] }> {
      const next = [...new Set(assignees)];
      const current = getCachedItem("issue", repo, number)?.assignees ?? [];
      const add = next.filter((login) => !current.includes(login));
      const remove = current.filter((login) => !next.includes(login));

      if (add.length === 0 && remove.length === 0) return { ok: true, assignees: next };
      const args = ["issue", "edit", String(number), "-R", repo];

      if (add.length > 0) args.push("--add-assignee", add.join(","));

      if (remove.length > 0) args.push("--remove-assignee", remove.join(","));
      await gh(args);
      patchCachedItem("issue", repo, number, { assignees: next });

      return { ok: true, assignees: next };
    },

    async setLabels({ repo, number, labels }): Promise<{ ok: true; labels: string[] }> {
      const next = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];

      const currentRaw = await gh(
        ["issue", "view", String(number), "-R", repo, "--json", "labels"],
        15_000,
      );

      const currentDetail = z
        .object({ labels: z.array(ghLabelSchema) })
        .parse(JSON.parse(currentRaw));

      const current = (currentDetail.labels ?? [])
        .map((label) => String(label?.name ?? "").trim())
        .filter((label) => label.length > 0);

      const add = next.filter((label) => !current.includes(label));
      const remove = current.filter((label) => !next.includes(label));

      if (add.length === 0 && remove.length === 0) return { ok: true, labels: next };
      const args = ["issue", "edit", String(number), "-R", repo];

      for (const label of add) args.push("--add-label", label);

      for (const label of remove) args.push("--remove-label", label);
      await gh(args);
      patchCachedItem("issue", repo, number, { labels: next });

      return { ok: true, labels: next };
    },

    async getIssue({ repo, number }) {
      const raw = await gh([
        "issue",
        "view",
        String(number),
        "-R",
        repo,
        "--json",
        "number,title,body,state,author,createdAt,updatedAt,labels,assignees,url,comments",
      ]);

      const detail = ghIssueSchema.parse(JSON.parse(raw));

      return {
        issue: {
          repo,
          number,
          title: String(detail.title ?? ""),
          state: String(detail.state ?? ""),
          author: String(detail.author?.login ?? ""),
          body: detail.body,
          labels: (detail.labels ?? []).map((label) => String(label?.name ?? "")),
          assignees: (detail.assignees ?? []).map((user) => String(user?.login ?? "")),
          url: String(detail.url ?? ""),
          updatedAt: String(detail.updatedAt ?? ""),
          comments: (detail.comments ?? []).map((comment) => ({
            author: String(comment.author?.login ?? ""),
            body: comment.body,
            createdAt: String(comment.createdAt ?? ""),
          })),
        },
      };
    },

    async getPull({ repo, number }) {
      const prFields =
        "number,title,body,state,isDraft,author,createdAt,updatedAt,labels," +
        "assignees,url,baseRefName,headRefName,additions,deletions," +
        "changedFiles,reviewDecision,mergeStateStatus,statusCheckRollup," +
        "comments,reviews,reviewRequests";

      const [viewRaw, reviewCommentsRaw, filesRaw] = await Promise.all([
        gh(["pr", "view", String(number), "-R", repo, "--json", prFields], 30_000),
        gh(
          ["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/comments?per_page=100`],
          30_000,
        ),
        gh(
          ["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/files?per_page=100`],
          30_000,
        ),
      ]);

      const view = ghPullSchema.parse(JSON.parse(viewRaw));

      const checks = (view.statusCheckRollup ?? []).map((entry) => {
        const conclusion = String(entry.conclusion ?? entry.state ?? "").toUpperCase();

        const running =
          entry.conclusion === "" ||
          ["IN_PROGRESS", "QUEUED", "PENDING", "EXPECTED", "WAITING"].includes(
            String(entry.status ?? entry.state ?? "").toUpperCase(),
          );

        const status: "success" | "failure" | "pending" | "neutral" =
          conclusion === "SUCCESS"
            ? "success"
            : conclusion === "FAILURE" || conclusion === "ERROR" || conclusion === "TIMED_OUT"
              ? "failure"
              : running
                ? "pending"
                : "neutral";

        return {
          name: String(entry.name ?? entry.context ?? "check"),
          status,
          url: String(entry.detailsUrl ?? entry.targetUrl ?? ""),
        };
      });

      const reviewComments = z
        .array(ghReviewCommentSchema)
        .parse(parsePaginatedGhApi(reviewCommentsRaw));

      interface ReviewThread {
        path: string;
        line: number | null;
        diffHunk: string;
        comments: Array<{ author: string; body: string; createdAt: string }>;
      }

      const threadByRootId = new Map<number, ReviewThread>();

      for (const comment of reviewComments) {
        const id = Number(comment.id ?? NaN);
        const replyTo = Number(comment.in_reply_to_id ?? NaN);

        const entry = {
          author: String(comment.user?.login ?? ""),
          body: comment.body,
          createdAt: String(comment.created_at ?? ""),
        };

        const rootThread = Number.isFinite(replyTo) ? threadByRootId.get(replyTo) : undefined;

        if (rootThread !== undefined) {
          rootThread.comments.push(entry);

          if (Number.isFinite(id)) threadByRootId.set(id, rootThread);
          continue;
        }

        const line = Number(comment.line ?? comment.original_line ?? NaN);

        const thread: ReviewThread = {
          path: String(comment.path ?? ""),
          line: Number.isFinite(line) ? line : null,
          diffHunk: comment.diff_hunk,
          comments: [entry],
        };

        if (Number.isFinite(id)) threadByRootId.set(id, thread);
      }

      const reviewThreads = [...new Set(threadByRootId.values())];

      const files = z
        .array(ghPullFileSchema)
        .parse(parsePaginatedGhApi(filesRaw))
        .map((file) => {
          const patch = file.patch ?? null;

          return {
            path: String(file.filename ?? ""),
            status: String(file.status ?? "modified"),
            additions: Number(file.additions ?? 0),
            deletions: Number(file.deletions ?? 0),
            patch: patch !== null && patch.length <= 20_000 ? patch : null,
          };
        });

      return {
        pull: {
          repo,
          number,
          title: String(view.title ?? ""),
          state:
            view.isDraft === true && String(view.state ?? "") === "OPEN"
              ? "DRAFT"
              : String(view.state ?? ""),
          author: String(view.author?.login ?? ""),
          body: view.body,
          url: String(view.url ?? ""),
          createdAt: String(view.createdAt ?? ""),
          updatedAt: String(view.updatedAt ?? ""),
          baseRefName: String(view.baseRefName ?? ""),
          headRefName: String(view.headRefName ?? ""),
          additions: Number(view.additions ?? 0),
          deletions: Number(view.deletions ?? 0),
          changedFiles: Number(view.changedFiles ?? files.length),
          labels: (view.labels ?? []).map((label) => String(label?.name ?? "")),
          assignees: (view.assignees ?? []).map((user) => String(user?.login ?? "")),
          reviewDecision: String(view.reviewDecision ?? ""),
          mergeStateStatus: String(view.mergeStateStatus ?? ""),
          reviewRequests: (view.reviewRequests ?? [])
            .map((entry) => String(entry.login ?? entry.name ?? entry.slug ?? ""))
            .filter((name) => name.length > 0),
          checks,
          comments: (view.comments ?? []).map((comment) => ({
            author: String(comment.author?.login ?? ""),
            body: comment.body,
            createdAt: String(comment.createdAt ?? ""),
          })),
          reviews: (view.reviews ?? []).map((review) => ({
            author: String(review.author?.login ?? ""),
            state: String(review.state ?? ""),
            body: review.body,
            createdAt: String(review.submittedAt ?? ""),
          })),
          reviewThreads,
          files,
        },
      };
    },

    async commentPull({ repo, number, body }): Promise<{ ok: true }> {
      await gh(["pr", "comment", String(number), "-R", repo, "--body", body]);

      return { ok: true };
    },

    async pullForThread({ threadId }) {
      let environmentId: string | null = null;

      try {
        const thread = await api.sdk.threads.get({ threadId });

        if (thread?.environmentId) {
          environmentId = thread.environmentId;

          const result = await api.sdk.environments.pullRequest({
            environmentId: thread.environmentId,
          });

          const url = result.outcome === "available" ? result.pullRequest.url : null;

          const match =
            url !== null ? url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/) : null;

          if (match !== null) {
            return {
              pull: {
                repo: match[1],
                number: Number(match[2]),
                environmentId,
              },
            };
          }
        }
      } catch {}

      const links = await listAllLinks();

      for (const [key, threadLinks] of Object.entries(links)) {
        const match = key.match(/^pr:([\w.-]+\/[\w.-]+)#(\d+)$/);

        if (match === null) continue;

        if (threadLinks.some((link) => link.threadId === threadId)) {
          return {
            pull: {
              repo: match[1],
              number: Number(match[2]),
              environmentId,
            },
          };
        }
      }

      return { pull: null };
    },

    async commentIssue({ repo, number, body }): Promise<{ ok: true }> {
      await gh(["issue", "comment", String(number), "-R", repo, "--body", body]);

      return { ok: true };
    },

    async createIssue(input) {
      const body = input.body ?? "";

      const stdout = await gh([
        "issue",
        "create",
        "-R",
        input.repo,
        "--title",
        input.title,
        "--body",
        body,
      ]);

      const match = stdout.trim().match(/\/issues\/(\d+)\s*$/);
      const number = match !== null ? Number(match[1]) : null;

      try {
        const fetched = await fetchRepoItems(gh, input.repo, await getViewer());
        await rememberRepoAlias(input.repo, fetched.repo);

        if (!isExcludedRepo(input.repo)) replaceRepoRows(fetched.repo, fetched.items, input.repo);
        repoCache = null;
        api.realtime.publish("data-changed", {});
      } catch {}

      return { number, url: stdout.trim() };
    },

    async startWork({ repo, number }) {
      return await spawnOnItem("issue", repo, number);
    },

    async startReview({ repo, number }) {
      return await spawnOnItem("pr", repo, number);
    },

    async listLinks() {
      return { links: await listAllLinks() };
    },
  });

  function mentionItems(kind: "issue" | "pr", query: string) {
    return listCachedItems({ kind, query, state: "open" })
      .slice(0, 8)
      .map((item) => ({
        id: `${item.repo}#${item.number}`,
        title: `#${item.number} ${item.title}`,
        subtitle: item.repo,
      }));
  }

  function parseMentionId(itemId: string) {
    const match = itemId.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);

    if (match === null) throw new Error(`malformed mention id "${itemId}"`);

    return { repo: match[1], number: Number(match[2]) };
  }

  async function mentionContext(
    kind: "issue" | "pr",
    itemId: string,
  ): Promise<{ context: string }> {
    const { repo, number } = parseMentionId(itemId);
    const noun = kind === "pr" ? "pull request" : "issue";

    try {
      const raw = await gh(
        kind === "pr"
          ? [
              "pr",
              "view",
              String(number),
              "-R",
              repo,
              "--json",
              "number,title,body,state,author,url",
            ]
          : [
              "issue",
              "view",
              String(number),
              "-R",
              repo,
              "--json",
              "number,title,body,state,author,url",
            ],
        15_000,
      );

      const detail = ghListEntrySchema.parse(JSON.parse(raw));

      return {
        context: [
          `# GitHub ${noun} ${repo}#${number}: ${String(detail.title ?? "")}`,
          "",
          `State: ${String(detail.state ?? "")} · Author: ${String(detail.author?.login ?? "")}`,
          `URL: ${String(detail.url ?? "")}`,
          "",
          detail.body.length > 0 ? detail.body : "(no description)",
          "",
          `For full comments/diff run: gh ${kind === "pr" ? "pr" : "issue"} view ${number} -R ${repo} --comments`,
        ].join("\n"),
      };
    } catch (error) {
      const cached = getCachedItem(kind, repo, number);

      if (cached === null) throw error instanceof Error ? error : new Error(String(error));

      return {
        context: [
          `# GitHub ${noun} ${repo}#${number}: ${cached.title}`,
          "",
          `State: ${cached.state} · Author: ${cached.author}`,
          `URL: ${cached.url}`,
          "",
          cached.body.length > 0 ? cached.body : "(no description)",
        ].join("\n"),
      };
    }
  }

  api.ui.registerMentionProvider({
    id: "issue",
    label: "GitHub issues",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("issue", query);
    },
    resolve(itemId) {
      return mentionContext("issue", itemId);
    },
  });

  api.ui.registerMentionProvider({
    id: "pr",
    label: "GitHub pull requests",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("pr", query);
    },
    resolve(itemId) {
      return mentionContext("pr", itemId);
    },
  });

  async function guarded(run: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PluginCliError) throw error;
      throw new PluginCliError(errorMessage(error));
    }
  }

  function cachedItemSummary(item: CachedItem) {
    return {
      repo: item.repo,
      number: item.number,
      kind: item.kind,
      state: item.state,
      title: item.title,
      author: item.author,
      labels: item.labels,
      assignees: item.assignees,
      url: item.url,
      updatedAt: item.updatedAt,
      pullReview: item.pullReview,
      pullMerge: item.pullMerge,
      ...storedMetaSchema.parse(item),
    };
  }

  function listCachedItemsCommand(kind: "issue" | "pr") {
    return cliCommand({
      summary: kind === "pr" ? "List cached open pull requests" : "List cached open issues",
      description:
        "Reads the local cache only; run `omnyo workspace-github sync` to refresh it from GitHub.",
      positionals: [
        {
          name: "repo",
          description: "Limit the listing to one owner/repo; omit for every tracked repository",
        },
      ],
      options: {
        json: {
          type: "boolean",
          description: "Emit the cached rows as JSON instead of a text table",
        },
      },
      run(input) {
        return guarded(async () => {
          const repo = requireRepoName(input.positionals.repo);

          const items = listCachedItems({
            kind,
            repo,
            state: "open",
            includeBody: false,
          });

          if (input.options.json) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                ok: true,
                items: items.map(cachedItemSummary),
              }),
            };
          }

          if (items.length === 0) {
            return {
              exitCode: 0,
              stdout: "Nothing cached. Run `omnyo workspace-github sync` first.",
            };
          }

          return {
            exitCode: 0,
            stdout: items
              .map((item) => `${item.repo}#${item.number}\t[${item.state}]\t${item.title}`)
              .join("\n"),
          };
        });
      },
    });
  }

  api.cli.register(
    defineCli({
      name: "workspace-github",
      summary: "Browse tracked GitHub repos, issues, and PRs",
      description:
        "Tracked repositories come from attached projects' GitHub remotes plus the extraRepos setting.",
      commands: {
        repos: cliCommand({
          summary: "List tracked repositories",
          options: {
            json: {
              type: "boolean",
              description:
                "Emit the repositories as JSON, including extraRepos entries that were ignored",
            },
          },
          run(input) {
            return guarded(async () => {
              const repos = await discoverRepos(true);

              const warning =
                ignoredExtraRepos.length > 0
                  ? {
                      stderr: `${describeIgnoredExtraRepos(ignoredExtraRepos)}\n`,
                    }
                  : {};

              if (input.options.json) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({
                    ok: true,
                    repos,
                    ignoredExtraRepos,
                  }),
                  ...warning,
                };
              }

              if (repos.length === 0) {
                return {
                  exitCode: 0,
                  stdout:
                    "No tracked repos. Attach a project with a GitHub remote or set extraRepos.",
                  ...warning,
                };
              }

              return {
                exitCode: 0,
                stdout: repos
                  .map(
                    (entry) =>
                      `${entry.repo}${entry.projectId !== null ? `\t(${entry.projectId})` : ""}`,
                  )
                  .join("\n"),
                ...warning,
              };
            });
          },
        }),
        issues: listCachedItemsCommand("issue"),
        prs: listCachedItemsCommand("pr"),
        sync: cliCommand({
          summary: "Refresh the cache from GitHub now",
          options: {
            json: {
              type: "boolean",
              description: "Emit the refreshed repo and item counts as JSON",
            },
          },
          run(input) {
            return guarded(async () => {
              const { repos, items } = await syncAll();

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ ok: true, repos, items })
                  : `Synced ${items} item(s) across ${repos} repo(s).`,
              };
            });
          },
        }),
      },
    }),
  );
}
