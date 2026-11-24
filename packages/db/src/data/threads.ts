import { prepareCachedQuery } from "../connection.js";
import { markThreadPruningPolicyWork } from "./thread-pruning-work.js";
import { copyProjectAttachmentOwnership } from "./project-attachments.js";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  placeholder,
  sql,
  type SQL,
} from "drizzle-orm";
import type {
  JsonObject,
  ClaudeProfileBinding,
  ReasoningLevel,
  ThreadChangeKind,
  ThreadLifecycleEvent,
  ThreadLifecycleNoopReason,
  ThreadOriginKind,
  ThreadSearchSourceKind,
  ThreadStatus,
  ThreadVisibility,
} from "@omnyo/domain";
import {
  evaluateThreadLifecycleEvent,
  threadSearchSourceKindSchema,
} from "@omnyo/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbQueryConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import {
  environments,
  events,
  pendingInteractions,
  projects,
  terminalSessions,
  threadSearchSegments,
  threadCallbacks,
  threadHistoryEpochs,
  threads,
} from "../schema.js";
import { createThreadId } from "../ids.js";
import { NON_TERMINAL_SESSION_STATUSES } from "./terminal-sessions.js";
import { createOrderKeyBetween } from "./order-keys.js";
import { insertThreadPluginMetadata } from "./thread-plugin-metadata.js";
import {
  insertNativeThreadImportInTransaction,
  type NewNativeThreadImport,
} from "./native-thread-imports.js";

type ThreadWriteConnection = DbConnection | DbTransaction;

export const THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT = 20;

export const THREAD_SEARCH_LIMIT_PER_GROUP_MAX = 50;

const THREAD_SEARCH_SEGMENT_ORDINAL_BITS = 24;

const THREAD_SEARCH_SEGMENT_ORDINAL_MASK =
  2 ** THREAD_SEARCH_SEGMENT_ORDINAL_BITS - 1;

const THREAD_SEARCH_TITLE_ORDINAL = 0;

const THREAD_SEARCH_TITLE_FALLBACK_ORDINAL = 1;

const THREAD_SEARCH_FIRST_MESSAGE_ORDINAL = 2;

const THREAD_SEARCH_QUERY_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

const THREAD_SEARCH_HIGHLIGHT_RANGE_LIMIT = 8;

const THREAD_SEARCH_SNIPPET_MAX_CHARS = 160;

const THREAD_SEARCH_SNIPPET_LEAD_CHARS = 40;

const THREAD_SEARCH_SNIPPET_ELLIPSIS = "…";

type ThreadWhere = SQL | undefined;

function nonDeletedThreads(...where: ThreadWhere[]): ThreadWhere {
  return and(...where, isNull(threads.deletedAt));
}

function liveThreads(...where: ThreadWhere[]): ThreadWhere {
  return nonDeletedThreads(...where, isNull(threads.archivedAt));
}

function activeThreads(...where: ThreadWhere[]): ThreadWhere {
  return liveThreads(...where, isNull(threads.shelvedAt));
}

function shelvedThreadsFilter(shelved: boolean | undefined): ThreadWhere {
  if (shelved === undefined) return undefined;

  return shelved
    ? and(isNull(threads.archivedAt), isNotNull(threads.shelvedAt))
    : isNull(threads.shelvedAt);
}

function countThreadsWhere(
  db: ThreadWriteConnection,
  where: ThreadWhere,
): number {
  return (
    db.select({ count: count() }).from(threads).where(where).get()?.count ?? 0
  );
}

function listThreadsWhere(
  db: ThreadWriteConnection,
  where: ThreadWhere,
): ThreadRow[] {
  return db.select().from(threads).where(where).all();
}

export interface ThreadSearchHighlightRange {
  start: number;
  end: number;
}

export interface ThreadSearchMatch {
  sourceKind: ThreadSearchSourceKind;
  text: string;
  highlightRanges: ThreadSearchHighlightRange[];
  sourceSeq: number | null;
}

export interface ThreadSearchResult {
  thread: ThreadWithPendingInteractionState;
  matches: ThreadSearchMatch[];
}

export interface ThreadSearchResultGroup {
  total: number;
  results: ThreadSearchResult[];
}

export interface ThreadSearchResults {
  active: ThreadSearchResultGroup;
  archived: ThreadSearchResultGroup;
}

export interface ThreadSearchThreadMatches {
  threadId: string;
  matches: ThreadSearchMatch[];
}

export interface ThreadSearchMatchGroup {
  total: number;
  threads: ThreadSearchThreadMatches[];
}

export interface ThreadSearchMatches {
  active: ThreadSearchMatchGroup;
  archived: ThreadSearchMatchGroup;
}

export interface SearchThreadsWithPendingInteractionStateArgs {
  query: string;
  limitPerGroup: number;
}

export interface UpsertThreadTitleSearchSegmentsArgs {
  threadId: string;
  title: string | null;
  titleFallback: string | null;
  updatedAt?: number;
}

export interface UpsertThreadSearchSegmentInput {
  threadId: string;
  sourceKind: ThreadSearchSourceKind;
  sourceKey: string;
  sourceSeq: number | null;
  text: string;
}

export interface UpsertThreadSearchSegmentsArgs {
  segments: readonly UpsertThreadSearchSegmentInput[];
  updatedAt?: number;
}

interface UpsertThreadSearchSegmentArgs extends UpsertThreadSearchSegmentInput {
  id: string;
  updatedAt: number;
}

interface ListThreadSearchMatchRowsArgs {
  allTokensMatchQuery: string;
  anyTokenMatchQuery: string;
  limitPerGroup: number;
  tokenMatchQueries: readonly string[];
}

interface ThreadSearchMatchRow {
  archived: number;
  segmentOrder: number;
  sourceKind: string;
  sourceSeq: number | null;
  text: string;
  threadId: string;
  threadOrder: number;
  total: number;
}

interface CollectThreadSearchMatchGroupArgs {
  rows: readonly ThreadSearchMatchRow[];
  tokens: readonly string[];
}

interface ThreadSearchSnippet {
  highlightRanges: ThreadSearchHighlightRange[];
  text: string;
}

function buildThreadSearchSegmentId(args: {
  threadId: string;
  sourceKind: ThreadSearchSourceKind;
  sourceKey: string;
}): string {
  return `${args.threadId}:${args.sourceKind}:${args.sourceKey}`;
}

function deleteThreadSearchSegmentById(
  db: ThreadWriteConnection,
  id: string,
): void {
  db.delete(threadSearchSegments).where(eq(threadSearchSegments.id, id)).run();
}

function upsertThreadSearchSegment(
  db: ThreadWriteConnection,
  args: UpsertThreadSearchSegmentArgs,
): void {
  const searchableText = args.text.trim();

  if (searchableText.length === 0) {
    deleteThreadSearchSegmentById(db, args.id);

    return;
  }

  const updated = db
    .update(threadSearchSegments)
    .set({
      sourceKind: args.sourceKind,
      sourceKey: args.sourceKey,
      sourceSeq: args.sourceSeq,
      text: searchableText,
      updatedAt: args.updatedAt,
    })
    .where(eq(threadSearchSegments.id, args.id))
    .run();

  if (updated.changes > 0) {
    return;
  }

  db.run(sql`
    INSERT INTO thread_search_segments (
      rowid,
      id,
      thread_id,
      source_kind,
      source_key,
      source_seq,
      text,
      created_at,
      updated_at
    )
    VALUES (
      ${threadSearchSegmentKey(args)},
      ${args.id},
      ${args.threadId},
      ${args.sourceKind},
      ${args.sourceKey},
      ${args.sourceSeq},
      ${searchableText},
      ${args.updatedAt},
      ${args.updatedAt}
    )
  `);
}

function threadSearchSegmentKey(args: {
  threadId: string;
  sourceKind: ThreadSearchSourceKind;
}): SQL {
  const threadBase = sql`(
    (SELECT rowid FROM threads WHERE id = ${args.threadId})
      << ${THREAD_SEARCH_SEGMENT_ORDINAL_BITS}
  )`;

  if (args.sourceKind === "title") {
    return sql`(${threadBase} | ${THREAD_SEARCH_TITLE_ORDINAL})`;
  }

  if (args.sourceKind === "title_fallback") {
    return sql`(${threadBase} | ${THREAD_SEARCH_TITLE_FALLBACK_ORDINAL})`;
  }

  return sql`COALESCE(
    (
      SELECT segments.rowid + 1
      FROM thread_search_segments AS segments
      WHERE segments.rowid BETWEEN
        (${threadBase} | ${THREAD_SEARCH_FIRST_MESSAGE_ORDINAL})
        AND (${threadBase} | ${THREAD_SEARCH_SEGMENT_ORDINAL_MASK})
      ORDER BY segments.rowid DESC
      LIMIT 1
    ),
    ${threadBase} | ${THREAD_SEARCH_FIRST_MESSAGE_ORDINAL}
  )`;
}

export function upsertThreadSearchSegments(
  db: ThreadWriteConnection,
  args: UpsertThreadSearchSegmentsArgs,
): void {
  const updatedAt = args.updatedAt ?? Date.now();

  for (const segment of args.segments) {
    upsertThreadSearchSegment(db, {
      ...segment,
      id: buildThreadSearchSegmentId(segment),
      updatedAt,
    });
  }
}

function upsertThreadTitleSearchSegments(
  db: ThreadWriteConnection,
  args: UpsertThreadTitleSearchSegmentsArgs,
): void {
  upsertThreadSearchSegments(db, {
    updatedAt: args.updatedAt,
    segments: [
      {
        threadId: args.threadId,
        sourceKind: "title",
        sourceKey: "title",
        sourceSeq: null,
        text: args.title ?? "",
      },
      {
        threadId: args.threadId,
        sourceKind: "title_fallback",
        sourceKey: "title_fallback",
        sourceSeq: null,
        text: args.titleFallback ?? "",
      },
    ],
  });
}

export interface CreateThreadInput {
  projectId: string;
  environmentId?: string | null;
  providerId: string;
  claudeProfileBinding?: ClaudeProfileBinding | null;
  title?: string | null;
  titleFallback?: string | null;
  sectionId?: string | null;
  pinned?: boolean;
  status?: ThreadStatus;
  parentThreadId?: string | null;
  lifecycleOwnerThreadId?: string | null;
  launchedByThreadId?: string | null;
  sourceThreadId?: string | null;
  originKind?: ThreadOriginKind | null;
  originPluginId?: string | null;
  pluginMetadata?: { pluginId: string; metadata: JsonObject } | null;
  startupContext?: string;
  visibility?: ThreadVisibility;
  pluginHome?: boolean;
  quiet?: boolean;
  initialTimestamps?: { createdAt: number; attentionAt: number };
  nativeImport?: NewNativeThreadImport;
}

export class InvalidLifecycleOwnerError extends Error {
  constructor() {
    super("lifecycleOwnerThreadId must reference a live thread");
    this.name = "InvalidLifecycleOwnerError";
  }
}

export function createThread(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateThreadInput,
) {
  const visibility = input.visibility ?? "visible";
  const now = Date.now();
  const id = createThreadId();
  const originKind = input.originKind ?? null;
  const createdAt = input.initialTimestamps?.createdAt ?? now;
  const attentionAt = input.initialTimestamps?.attentionAt ?? now;

  const thread = db.transaction(
    (tx) => {
      if (input.lifecycleOwnerThreadId) {
        const owner = tx
          .select({ id: threads.id })
          .from(threads)
          .innerJoin(projects, eq(projects.id, threads.projectId))
          .where(
            and(
              eq(threads.id, input.lifecycleOwnerThreadId),
              isNull(threads.archivedAt),
              isNull(threads.deletedAt),
              isNull(projects.deletedAt),
            ),
          )
          .get();

        if (!owner) {
          throw new InvalidLifecycleOwnerError();
        }
      }

      const launchedByThreadId = input.launchedByThreadId
        ? (tx
            .select({ id: threads.id })
            .from(threads)
            .where(
              and(
                eq(threads.id, input.launchedByThreadId),
                isNull(threads.deletedAt),
              ),
            )
            .get()?.id ?? null)
        : null;

      const createdThread = tx
        .insert(threads)
        .values({
          id,
          projectId: input.projectId,
          environmentId: input.environmentId ?? null,
          providerId: input.providerId,
          claudeProfileBinding: input.claudeProfileBinding ?? null,
          title: input.title ?? null,
          titleFallback: input.titleFallback ?? null,
          sectionId: input.sectionId ?? null,
          pinnedAt: input.pinned ? now : null,
          pinSortKey: input.pinned
            ? createOrderKeyBetween({
                previousKey: null,
                nextKey: getFirstPinnedThread(tx)?.pinSortKey ?? null,
              })
            : null,
          status: input.status ?? "starting",
          statusChangedAt: now,
          startupContext: input.startupContext ?? null,
          parentThreadId:
            originKind === null ? (input.parentThreadId ?? null) : null,
          sourceThreadId:
            input.sourceThreadId ??
            (originKind === null ? null : (input.parentThreadId ?? null)),
          lifecycleOwnerThreadId: input.lifecycleOwnerThreadId ?? null,
          launchedByThreadId,
          originKind,
          originPluginId: input.originPluginId ?? null,
          visibility,
          pluginHome: input.pluginHome ?? false,
          quiet: input.quiet ?? false,
          lastReadAt: attentionAt,
          latestAttentionAt: attentionAt,
          createdAt,
          updatedAt: now,
        })
        .returning()
        .get();

      if (input.nativeImport !== undefined) {
        insertNativeThreadImportInTransaction(tx, {
          threadId: createdThread.id,
          source: input.nativeImport,
        });
      }

      if (
        createdThread.originKind === "fork" &&
        createdThread.sourceThreadId !== null
      ) {
        copyProjectAttachmentOwnership(
          tx,
          createdThread.sourceThreadId,
          createdThread.id,
        );
      }

      upsertThreadTitleSearchSegments(tx, {
        threadId: createdThread.id,
        title: createdThread.title,
        titleFallback: createdThread.titleFallback,
        updatedAt: now,
      });

      if (
        input.pluginMetadata !== undefined &&
        input.pluginMetadata !== null &&
        Object.keys(input.pluginMetadata.metadata).length > 0
      ) {
        insertThreadPluginMetadata(tx, {
          threadId: createdThread.id,
          pluginId: input.pluginMetadata.pluginId,
          metadata: input.pluginMetadata.metadata,
        });
      }

      return createdThread;
    },
    { behavior: "immediate" },
  );

  notifier.notifyThread(id, ["thread-created"], {
    projectId: input.projectId,
  });
  notifier.notifyProject(input.projectId, ["threads-changed"]);

  return thread;
}

const prepareGetThread = (db: DbQueryConnection) =>
  db
    .select()
    .from(threads)
    .where(eq(threads.id, placeholder("id")))
    .prepare();

export function getThread(db: ThreadWriteConnection, id: string) {
  return prepareCachedQuery(db, prepareGetThread).get({ id }) ?? null;
}

export interface ThreadMentionRow {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
}

export function listThreadMentionRowsByIds(
  db: DbQueryConnection,
  threadIds: readonly string[],
): ThreadMentionRow[] {
  if (threadIds.length === 0) {
    return [];
  }

  return db
    .select({
      id: threads.id,
      projectId: threads.projectId,
      title: threads.title,
      titleFallback: threads.titleFallback,
    })
    .from(threads)
    .innerJoin(projects, eq(projects.id, threads.projectId))
    .where(
      and(
        inArray(threads.id, [...threadIds]),
        isNull(threads.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .all();
}

export interface ListThreadsOptions {
  projectId?: string;
  environmentId?: string;
  hostId?: string;
  archived?: boolean;
  sectionId?: string;
  unsectioned?: boolean;
  groupId?: string;
  parentThreadId?: string;
  hasParent?: boolean;
  sourceThreadId?: string;
  originKind?: ThreadOriginKind;
  originPluginId?: string;
  shelved?: boolean;
  threadIds?: readonly string[];
  limit?: number;
  offset?: number;
  includeHidden?: boolean;
  includePluginHome?: boolean;
}

export function listErroredThreadsForContinuation(
  db: DbConnection,
): ThreadRow[] {
  return db
    .select()
    .from(threads)
    .where(
      activeThreads(
        eq(threads.status, "error"),
        eq(threads.visibility, "visible"),
      ),
    )
    .orderBy(asc(threads.updatedAt), asc(threads.id))
    .all();
}

type ThreadRow = typeof threads.$inferSelect;

export interface ListThreadsForProjectsOptions {
  projectIds: readonly string[];
  archived?: boolean;
  shelved?: boolean;
}

export interface PinThreadArgs {
  pinnedAt?: number;
  threadId: string;
}

export interface UnpinThreadArgs {
  threadId: string;
}

export interface ReorderPinnedThreadArgs {
  db: DbConnection;
  nextThreadId: string | null;
  notifier: DbNotifier;
  previousThreadId: string | null;
  threadId: string;
}

interface ResolveOrderedThreadNeighborArgs {
  movedThreadId: string;
  neighborThreadId: string | null;
  orderedThreads: readonly ThreadRow[];
}

interface PinThreadMutationResult {
  changed: boolean;
  thread: ThreadRow;
}

type PinnedThreadRootCandidate = Pick<ThreadRow, "id" | "parentThreadId">;

interface FilterVisiblePinnedThreadRootsArgs<
  TThread extends PinnedThreadRootCandidate,
> {
  pinnedThreads: readonly TThread[];
}

export interface ReorderPinnedThreadSuccess {
  kind: "reordered";
  threads: ThreadRow[];
}

export interface ReorderPinnedThreadUnchanged {
  kind: "unchanged";
  threads: ThreadRow[];
}

export interface ReorderPinnedThreadNotFound {
  kind: "not_found";
}

export interface ReorderPinnedThreadNotPinned {
  kind: "not_pinned";
}

export interface ReorderPinnedThreadStaleNeighbor {
  kind: "stale_neighbor";
}

export interface ReorderPinnedThreadInvalidNeighborOrder {
  kind: "invalid_neighbor_order";
}

export type ReorderPinnedThreadResult =
  | ReorderPinnedThreadSuccess
  | ReorderPinnedThreadUnchanged
  | ReorderPinnedThreadNotFound
  | ReorderPinnedThreadNotPinned
  | ReorderPinnedThreadStaleNeighbor
  | ReorderPinnedThreadInvalidNeighborOrder;

function listedThread() {
  return and(eq(threads.visibility, "visible"), eq(threads.pluginHome, false));
}

function pinnedThreadWhere() {
  return nonDeletedThreads(
    listedThread(),
    isNotNull(threads.pinnedAt),
    isNotNull(threads.pinSortKey),
  );
}

function getFirstPinnedThread(db: DbQueryConnection): ThreadRow | null {
  return (
    db
      .select()
      .from(threads)
      .where(pinnedThreadWhere())
      .orderBy(asc(threads.pinSortKey), asc(threads.id))
      .limit(1)
      .get() ?? null
  );
}

function filterVisiblePinnedThreadRoots<
  TThread extends PinnedThreadRootCandidate,
>({ pinnedThreads }: FilterVisiblePinnedThreadRootsArgs<TThread>): TThread[] {
  const pinnedThreadIds = new Set(pinnedThreads.map((thread) => thread.id));

  return pinnedThreads.filter(
    (thread) =>
      thread.parentThreadId === null ||
      !pinnedThreadIds.has(thread.parentThreadId),
  );
}

export function listActiveVisiblePinnedThreadRoots(
  db: DbQueryConnection,
): ThreadRow[] {
  const pinnedThreads = db
    .select()
    .from(threads)
    .where(activeThreads(pinnedThreadWhere()))
    .orderBy(asc(threads.pinSortKey), asc(threads.id))
    .all();

  return filterVisiblePinnedThreadRoots({ pinnedThreads });
}

function threadWithPendingInteractionBaseQuery(db: DbConnection) {
  return db
    .select({
      ...getTableColumns(threads),
      environmentBranchName: environments.branchName,
      environmentHostId: environments.hostId,
      environmentIsWorktree: environments.isWorktree,
      environmentName: environments.name,
      environmentPath: environments.path,
      environmentProviderId: environments.environmentProviderId,
      hasPendingInteraction: sql<number>`EXISTS (SELECT 1 FROM ${pendingInteractions} WHERE ${pendingInteractions.threadId} = ${threads.id} AND ${pendingInteractions.status} = 'pending')`,
    })
    .from(threads)
    .leftJoin(environments, eq(threads.environmentId, environments.id));
}

export function listActiveVisiblePinnedThreadRootsWithPendingInteractionState(
  db: DbConnection,
): ThreadWithPendingInteractionState[] {
  const pinnedThreads = threadWithPendingInteractionBaseQuery(db)
    .where(activeThreads(pinnedThreadWhere()))
    .orderBy(asc(threads.pinSortKey), asc(threads.id))
    .all()
    .map(toThreadWithPendingInteractionState);

  return filterVisiblePinnedThreadRoots({ pinnedThreads });
}

function resolveOrderedThreadNeighbor(
  args: ResolveOrderedThreadNeighborArgs,
): ThreadRow | null | false {
  if (args.neighborThreadId === null) {
    return null;
  }

  if (args.neighborThreadId === args.movedThreadId) {
    return false;
  }

  return (
    args.orderedThreads.find((thread) => thread.id === args.neighborThreadId) ??
    false
  );
}

export interface ThreadWithPendingInteractionState extends ThreadRow {
  environmentBranchName: string | null;
  environmentHostId: string | null;
  environmentIsWorktree: boolean | null;
  environmentName: string | null;
  environmentPath: string | null;
  environmentProviderId: string | null;
  hasPendingInteraction: boolean;
}

interface ThreadWithPendingInteractionStateRow extends ThreadRow {
  environmentBranchName: string | null;
  environmentHostId: string | null;
  environmentIsWorktree: boolean | null;
  environmentName: string | null;
  environmentPath: string | null;
  environmentProviderId: string | null;
  hasPendingInteraction: number;
}

export interface CountLiveThreadsInEnvironmentArgs {
  environmentId: string;
  excludeThreadId?: string;
}

export interface ListLiveThreadsInEnvironmentArgs {
  environmentId: string;
}

export interface CountNonDeletedAssignedChildThreadsArgs {
  parentThreadId: string;
}

export interface ListNonDeletedHiddenSourceThreadsArgs {
  sourceThreadId: string;
}

export interface ListUnarchivedAssignedChildThreadsArgs {
  parentThreadId: string;
}

export interface ListNonDeletedChildThreadsArgs {
  parentThreadId: string;
}

export interface MarkThreadDeletedArgs {
  deletedAt?: number;
  threadId: string;
}

export interface ListThreadEnvironmentAssignmentsOnHostArgs {
  hostId: string;
  threadIds: readonly string[];
}

export interface ListHostThreadIdsArgs {
  hostId: string;
}

export interface ListActiveHostThreadsArgs {
  hostId: string;
}

export interface ThreadEnvironmentAssignmentRow {
  environmentId: string;
  threadId: string;
}

function buildListThreadsFilters(options: ListThreadsOptions) {
  return [
    options.projectId ? eq(threads.projectId, options.projectId) : undefined,
    options.environmentId
      ? eq(threads.environmentId, options.environmentId)
      : undefined,
    options.hostId ? eq(environments.hostId, options.hostId) : undefined,
    options.threadIds === undefined
      ? undefined
      : inArray(threads.id, [...options.threadIds]),
    options.sectionId ? eq(threads.sectionId, options.sectionId) : undefined,
    options.unsectioned ? isNull(threads.sectionId) : undefined,
    options.groupId ? eq(threads.groupId, options.groupId) : undefined,
    nonDeletedThreads(),
    options.includeHidden
      ? undefined
      : options.includePluginHome
        ? eq(threads.visibility, "visible")
        : listedThread(),
    options.parentThreadId
      ? eq(threads.parentThreadId, options.parentThreadId)
      : undefined,
    options.sourceThreadId
      ? eq(threads.sourceThreadId, options.sourceThreadId)
      : undefined,
    options.originKind ? eq(threads.originKind, options.originKind) : undefined,
    options.originPluginId
      ? eq(threads.originPluginId, options.originPluginId)
      : undefined,
    options.archived === true
      ? isNotNull(threads.archivedAt)
      : options.archived === false
        ? isNull(threads.archivedAt)
        : undefined,
    shelvedThreadsFilter(options.shelved),
    options.hasParent === true
      ? isNotNull(threads.parentThreadId)
      : options.hasParent === false
        ? isNull(threads.parentThreadId)
        : undefined,
  ].filter((value) => value !== undefined);
}

function buildListThreadsForProjectsFilters(
  options: ListThreadsForProjectsOptions,
) {
  return [
    inArray(threads.projectId, [...options.projectIds]),
    listedThread(),
    nonDeletedThreads(),
    options.archived === true
      ? isNotNull(threads.archivedAt)
      : options.archived === false
        ? isNull(threads.archivedAt)
        : undefined,
    shelvedThreadsFilter(options.shelved),
  ].filter((value) => value !== undefined);
}

function buildActiveProjectThreadOrderBy() {
  return [
    asc(threads.projectId),
    ...buildPinnedThreadOrderBy(),
    desc(threads.createdAt),
    desc(threads.id),
  ];
}

function buildPinnedThreadOrderBy() {
  return [
    asc(sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN 0 ELSE 1 END`),
    asc(
      sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN ${threads.pinSortKey} END`,
    ),
    asc(sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN ${threads.id} END`),
  ];
}

function buildShelfOrderBy() {
  return [
    asc(sql`${threads.shelfSortKey} IS NOT NULL`),
    asc(threads.shelfSortKey),
    desc(threads.shelvedAt),
    asc(sql`${threads.parentThreadId} IS NOT NULL`),
    desc(threads.id),
  ];
}

function buildListThreadsOrderBy(options: ListThreadsOptions) {
  if (options.archived === true) {
    return [desc(threads.archivedAt), desc(threads.id)];
  }

  if (options.shelved === true) {
    return buildShelfOrderBy();
  }

  return buildActiveProjectThreadOrderBy();
}

function toThreadWithPendingInteractionState(
  row: ThreadWithPendingInteractionStateRow,
): ThreadWithPendingInteractionState {
  const {
    environmentBranchName,
    environmentHostId,
    environmentIsWorktree,
    environmentName,
    environmentPath,
    environmentProviderId,
    hasPendingInteraction,
    ...thread
  } = row;

  return {
    ...thread,
    environmentBranchName,
    environmentHostId,
    environmentIsWorktree,
    environmentName,
    environmentPath,
    environmentProviderId,
    hasPendingInteraction: hasPendingInteraction > 0,
  };
}

function listThreadSearchQueryTokens(query: string): string[] {
  const tokens: string[] = [];

  for (const match of query.matchAll(THREAD_SEARCH_QUERY_TOKEN_PATTERN)) {
    const token = match[0].trim();

    if (token.length > 0) {
      tokens.push(token);
    }
  }

  return tokens;
}

function buildThreadSearchTokenMatchQuery(token: string): string {
  return `"${token.replaceAll('"', '""')}"*`;
}

function listThreadSearchTokenMatchQueries(
  tokens: readonly string[],
): string[] {
  return [...new Set(tokens.map(buildThreadSearchTokenMatchQuery))];
}

function buildThreadSearchAnyTokenMatchQuery(
  tokenMatchQueries: readonly string[],
): string | null {
  if (tokenMatchQueries.length === 0) {
    return null;
  }

  return tokenMatchQueries.join(" OR ");
}

function mergeHighlightRanges(
  ranges: readonly ThreadSearchHighlightRange[],
): ThreadSearchHighlightRange[] {
  const merged: ThreadSearchHighlightRange[] = [];

  for (const range of ranges) {
    const previous = merged.at(-1);

    if (previous === undefined || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }

    previous.end = Math.max(previous.end, range.end);
  }

  return merged.slice(0, THREAD_SEARCH_HIGHLIGHT_RANGE_LIMIT);
}

function findHighlightRanges(args: {
  text: string;
  tokens: readonly string[];
}): ThreadSearchHighlightRange[] {
  const ranges: ThreadSearchHighlightRange[] = [];
  const normalizedText = normalizeThreadSearchHighlightText(args.text);

  const uniqueTokens = [
    ...new Set(
      args.tokens
        .map((token) => normalizeThreadSearchText(token))
        .filter((token) => token.length > 0),
    ),
  ];

  for (const token of uniqueTokens) {
    let offset = 0;

    while (offset < normalizedText.text.length) {
      const start = normalizedText.text.indexOf(token, offset);

      if (start === -1) {
        break;
      }

      const end = start + token.length;
      ranges.push({
        start: normalizedText.originalStarts[start] ?? 0,
        end: normalizedText.originalEnds[end - 1] ?? args.text.length,
      });
      offset = start + token.length;
    }
  }

  return mergeHighlightRanges(
    ranges.sort(
      (left, right) => left.start - right.start || left.end - right.end,
    ),
  );
}

function normalizeThreadSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase();
}

function normalizeThreadSearchHighlightText(text: string): {
  originalEnds: number[];
  originalStarts: number[];
  text: string;
} {
  let normalizedText = "";
  const originalStarts: number[] = [];
  const originalEnds: number[] = [];

  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);

    if (codePoint === undefined) {
      break;
    }

    const value = String.fromCodePoint(codePoint);
    const end = index + value.length;
    const normalizedValue = normalizeThreadSearchText(value);

    for (
      let normalizedIndex = 0;
      normalizedIndex < normalizedValue.length;
      normalizedIndex += 1
    ) {
      normalizedText += normalizedValue[normalizedIndex];
      originalStarts.push(index);
      originalEnds.push(end);
    }

    index = end;
  }

  return {
    originalEnds,
    originalStarts,
    text: normalizedText,
  };
}

function isThreadSearchTitleSourceKind(
  sourceKind: ThreadSearchSourceKind,
): boolean {
  return sourceKind === "title" || sourceKind === "title_fallback";
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);

  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);

  return code >= 0xd800 && code <= 0xdbff;
}

function buildThreadSearchSnippet(args: {
  text: string;
  tokens: readonly string[];
}): ThreadSearchSnippet {
  const highlightRanges = findHighlightRanges(args);
  const text = args.text;

  if (text.length <= THREAD_SEARCH_SNIPPET_MAX_CHARS) {
    return { highlightRanges, text };
  }

  const firstRange = highlightRanges[0];
  const anchorStart = firstRange?.start ?? 0;
  const anchorEnd = firstRange?.end ?? 0;

  let start = Math.min(
    Math.max(0, anchorStart - THREAD_SEARCH_SNIPPET_LEAD_CHARS),
    Math.max(0, text.length - THREAD_SEARCH_SNIPPET_MAX_CHARS),
  );

  let end = Math.min(text.length, start + THREAD_SEARCH_SNIPPET_MAX_CHARS);

  if (start > 0) {
    const boundary = text.slice(start, anchorStart).search(/\s/u);

    if (boundary !== -1) {
      start += boundary + 1;
    }
  }

  if (end < text.length) {
    const tailStart = Math.max(anchorEnd, start);
    const boundary = text.slice(tailStart, end).search(/\s\S*$/u);

    if (
      boundary > 0 &&
      end - (tailStart + boundary) <= THREAD_SEARCH_SNIPPET_LEAD_CHARS
    ) {
      end = tailStart + boundary;
    }
  }

  if (start > 0 && start < text.length && isLowSurrogate(text, start)) {
    start += 1;
  }

  if (end > start && end < text.length && isHighSurrogate(text, end - 1)) {
    end -= 1;
  }

  const prefix = start > 0 ? THREAD_SEARCH_SNIPPET_ELLIPSIS : "";
  const suffix = end < text.length ? THREAD_SEARCH_SNIPPET_ELLIPSIS : "";
  const rebasedRanges: ThreadSearchHighlightRange[] = [];

  for (const range of highlightRanges) {
    const rangeStart = Math.max(range.start, start) - start + prefix.length;
    const rangeEnd = Math.min(range.end, end) - start + prefix.length;

    if (rangeEnd > rangeStart) {
      rebasedRanges.push({ start: rangeStart, end: rangeEnd });
    }
  }

  return {
    highlightRanges: rebasedRanges,
    text: `${prefix}${text.slice(start, end)}${suffix}`,
  };
}

function listThreadSearchMatchRows(
  db: DbConnection,
  args: ListThreadSearchMatchRowsArgs,
): ThreadSearchMatchRow[] {
  const ordinalBits = sql.raw(String(THREAD_SEARCH_SEGMENT_ORDINAL_BITS));
  const ordinalMask = sql.raw(String(THREAD_SEARCH_SEGMENT_ORDINAL_MASK));
  const titleOrdinal = sql.raw(String(THREAD_SEARCH_TITLE_ORDINAL));

  const titleFallbackOrdinal = sql.raw(
    String(THREAD_SEARCH_TITLE_FALLBACK_ORDINAL),
  );

  const firstMessageOrdinal = sql.raw(
    String(THREAD_SEARCH_FIRST_MESSAGE_ORDINAL),
  );

  const singleToken = args.tokenMatchQueries.length === 1;

  const matchingSegmentKeys = (matchQuery: string) => sql`
    SELECT rowid AS segmentKey
    FROM thread_search_segments_fts
    WHERE thread_search_segments_fts MATCH ${matchQuery}
  `;

  const allTokenSegments = singleToken
    ? sql``
    : sql`all_token_segments AS MATERIALIZED (
        ${matchingSegmentKeys(args.allTokensMatchQuery)}
      ),`;

  const matchesAllTokens = singleToken
    ? sql`1`
    : sql`segmentKey IN (SELECT segmentKey FROM all_token_segments)`;

  const everyTokenThreadFilter = singleToken
    ? sql``
    : sql`AND threads.rowid IN (${sql.join(
        args.tokenMatchQueries.map(
          (matchQuery) => sql`
            SELECT rowid >> ${ordinalBits}
            FROM thread_search_segments_fts
            WHERE thread_search_segments_fts MATCH ${matchQuery}
          `,
        ),
        sql` INTERSECT `,
      )})`;

  return db.all<ThreadSearchMatchRow>(sql`
    WITH any_token_segments AS MATERIALIZED (
      ${matchingSegmentKeys(args.anyTokenMatchQuery)}
    ),
    ${allTokenSegments}
    thread_matches AS MATERIALIZED (
      SELECT
        segmentKey >> ${ordinalBits} AS threadKey,
        max(
          CASE WHEN (segmentKey & ${ordinalMask}) = ${titleOrdinal}
          THEN 1 + matchesAll END
        ) AS titleRank,
        max(
          CASE WHEN (segmentKey & ${ordinalMask}) = ${titleFallbackOrdinal}
          THEN 1 + matchesAll END
        ) AS titleFallbackRank,
        min(
          CASE WHEN (segmentKey & ${ordinalMask}) >= ${firstMessageOrdinal}
            AND matchesAll
          THEN segmentKey END
        ) AS firstAllTokenMessageKey,
        min(
          CASE WHEN (segmentKey & ${ordinalMask}) >= ${firstMessageOrdinal}
          THEN segmentKey END
        ) AS firstAnyTokenMessageKey
      FROM (
        SELECT segmentKey, ${matchesAllTokens} AS matchesAll
        FROM any_token_segments
      )
      GROUP BY segmentKey >> ${ordinalBits}
    ),
    ranked_threads AS (
      SELECT
        threads.rowid AS threadKey,
        threads.id AS threadId,
        threads.archived_at IS NOT NULL AS archived,
        (
          COALESCE(thread_matches.titleRank, 0) = 2
          OR (
            COALESCE(thread_matches.titleFallbackRank, 0) = 2
            AND COALESCE(threads.title, '') = ''
          )
        ) AS titleMatch,
        threads.updated_at AS threadUpdatedAt,
        thread_matches.titleRank AS titleRank,
        thread_matches.titleFallbackRank AS titleFallbackRank,
        COALESCE(
          thread_matches.firstAllTokenMessageKey,
          thread_matches.firstAnyTokenMessageKey
        ) AS messageKey
      FROM threads INDEXED BY threads_search_rank_idx
      JOIN thread_matches ON thread_matches.threadKey = threads.rowid
      WHERE threads.deleted_at IS NULL
        AND threads.visibility = 'visible'
        AND threads.plugin_home = 0
        ${everyTokenThreadFilter}
    ),
    ordered_threads AS (
      SELECT
        threadKey,
        threadId,
        archived,
        titleRank,
        titleFallbackRank,
        messageKey,
        ROW_NUMBER() OVER (
          PARTITION BY archived
          ORDER BY titleMatch DESC, threadUpdatedAt DESC, threadId DESC
        ) AS threadOrder,
        COUNT(*) OVER (PARTITION BY archived) AS total
      FROM ranked_threads
    ),
    limited_threads AS (
      SELECT *
      FROM ordered_threads
      WHERE threadOrder <= ${args.limitPerGroup}
    ),
    result_segments AS (
      SELECT
        archived,
        threadOrder,
        total,
        threadId,
        1 AS isTitle,
        titleRank AS matchRank,
        ${titleOrdinal} AS ordinal,
        (threadKey << ${ordinalBits}) | ${titleOrdinal} AS segmentKey
      FROM limited_threads
      WHERE titleRank IS NOT NULL
      UNION ALL
      SELECT
        archived,
        threadOrder,
        total,
        threadId,
        1 AS isTitle,
        titleFallbackRank AS matchRank,
        ${titleFallbackOrdinal} AS ordinal,
        (threadKey << ${ordinalBits}) | ${titleFallbackOrdinal} AS segmentKey
      FROM limited_threads
      WHERE titleFallbackRank IS NOT NULL
      UNION ALL
      SELECT
        archived,
        threadOrder,
        total,
        threadId,
        0 AS isTitle,
        NULL AS matchRank,
        ${firstMessageOrdinal} AS ordinal,
        messageKey AS segmentKey
      FROM limited_threads
      WHERE messageKey IS NOT NULL
    ),
    ranked_result_segments AS (
      SELECT
        archived,
        threadOrder,
        total,
        threadId,
        isTitle,
        segmentKey,
        ROW_NUMBER() OVER (
          PARTITION BY threadId, isTitle
          ORDER BY matchRank DESC, ordinal ASC
        ) AS segmentOrder
      FROM result_segments
    )
    SELECT
      ranked_result_segments.archived AS archived,
      ranked_result_segments.threadOrder AS threadOrder,
      ranked_result_segments.total AS total,
      ranked_result_segments.segmentOrder AS segmentOrder,
      segments.source_kind AS sourceKind,
      segments.source_seq AS sourceSeq,
      segments.text AS text,
      ranked_result_segments.threadId AS threadId
    FROM ranked_result_segments
    JOIN thread_search_segments AS segments
      ON segments.rowid = ranked_result_segments.segmentKey
    ORDER BY
      ranked_result_segments.archived ASC,
      ranked_result_segments.threadOrder ASC,
      ranked_result_segments.isTitle DESC,
      ranked_result_segments.segmentOrder ASC
  `);
}

function collectThreadSearchMatchGroup(
  args: CollectThreadSearchMatchGroupArgs,
): ThreadSearchMatchGroup {
  const firstRow = args.rows[0];

  if (firstRow === undefined) {
    return { total: 0, threads: [] };
  }

  const threadIds: string[] = [];
  const matchesByThreadId = new Map<string, ThreadSearchMatch[]>();

  for (const row of args.rows) {
    const matches = matchesByThreadId.get(row.threadId) ?? [];

    if (matches.length === 0) {
      threadIds.push(row.threadId);
    }

    const sourceKind = threadSearchSourceKindSchema.parse(row.sourceKind);

    const snippet = isThreadSearchTitleSourceKind(sourceKind)
      ? {
          text: row.text,
          highlightRanges: findHighlightRanges({
            text: row.text,
            tokens: args.tokens,
          }),
        }
      : buildThreadSearchSnippet({ text: row.text, tokens: args.tokens });

    matches.push({
      sourceKind,
      text: snippet.text,
      highlightRanges: snippet.highlightRanges,
      sourceSeq: row.sourceSeq,
    });
    matchesByThreadId.set(row.threadId, matches);
  }

  return {
    total: firstRow.total,
    threads: threadIds.map((threadId) => ({
      threadId,
      matches: matchesByThreadId.get(threadId) ?? [],
    })),
  };
}

function hydrateThreadSearchMatchGroup(
  db: DbConnection,
  group: ThreadSearchMatchGroup,
): ThreadSearchResultGroup {
  if (group.threads.length === 0) {
    return { total: group.total, results: [] };
  }

  const threadsById = new Map(
    threadWithPendingInteractionBaseQuery(db)
      .where(
        nonDeletedThreads(
          inArray(
            threads.id,
            group.threads.map((entry) => entry.threadId),
          ),
        ),
      )
      .all()
      .map(toThreadWithPendingInteractionState)
      .map((thread) => [thread.id, thread]),
  );

  const results: ThreadSearchResult[] = [];

  for (const entry of group.threads) {
    const thread = threadsById.get(entry.threadId);

    if (thread !== undefined) {
      results.push({ thread, matches: entry.matches });
    }
  }

  return { total: group.total, results };
}

export function findThreadSearchMatches(
  db: DbConnection,
  args: SearchThreadsWithPendingInteractionStateArgs,
): ThreadSearchMatches {
  const tokens = listThreadSearchQueryTokens(args.query);
  const tokenMatchQueries = listThreadSearchTokenMatchQueries(tokens);

  const anyTokenMatchQuery =
    buildThreadSearchAnyTokenMatchQuery(tokenMatchQueries);

  if (anyTokenMatchQuery === null) {
    return {
      active: { total: 0, threads: [] },
      archived: { total: 0, threads: [] },
    };
  }

  const limitPerGroup = Math.min(
    Math.max(args.limitPerGroup, 1),
    THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
  );

  const rows = listThreadSearchMatchRows(db, {
    allTokensMatchQuery: tokenMatchQueries.join(" AND "),
    anyTokenMatchQuery,
    limitPerGroup,
    tokenMatchQueries,
  });

  return {
    active: collectThreadSearchMatchGroup({
      tokens,
      rows: rows.filter((row) => row.archived === 0),
    }),
    archived: collectThreadSearchMatchGroup({
      tokens,
      rows: rows.filter((row) => row.archived === 1),
    }),
  };
}

export function hydrateThreadSearchMatches(
  db: DbConnection,
  matches: ThreadSearchMatches,
): ThreadSearchResults {
  return {
    active: hydrateThreadSearchMatchGroup(db, matches.active),
    archived: hydrateThreadSearchMatchGroup(db, matches.archived),
  };
}

export function searchThreadsWithPendingInteractionState(
  db: DbConnection,
  args: SearchThreadsWithPendingInteractionStateArgs,
): ThreadSearchResults {
  return hydrateThreadSearchMatches(db, findThreadSearchMatches(db, args));
}

export type CountThreadsGroupBy = "host" | "provider" | "project";

export interface CountThreadsOptions {
  status?: ThreadStatus;
  hostId?: string;
  providerId?: string;
  projectId?: string;

  parent?: { kind: "root" } | { kind: "id"; parentThreadId: string };
  groupBy?: CountThreadsGroupBy;

  includeArchived?: boolean;

  includeHidden?: boolean;
}

export interface ThreadCountGroupRow {
  key: string | null;
  count: number;
}

export interface CountThreadsResult {
  total: number;

  groups?: ThreadCountGroupRow[];
}

export function countThreads(
  db: DbQueryConnection,
  options: CountThreadsOptions,
): CountThreadsResult {
  const needsEnvironmentJoin =
    options.hostId !== undefined || options.groupBy === "host";

  const filters = [
    nonDeletedThreads(),
    options.includeArchived === true ? undefined : isNull(threads.archivedAt),
    options.includeHidden === true ? undefined : listedThread(),
    options.status !== undefined
      ? eq(threads.status, options.status)
      : undefined,
    options.providerId !== undefined
      ? eq(threads.providerId, options.providerId)
      : undefined,
    options.projectId !== undefined
      ? eq(threads.projectId, options.projectId)
      : undefined,
    options.parent === undefined
      ? undefined
      : options.parent.kind === "root"
        ? isNull(threads.parentThreadId)
        : eq(threads.parentThreadId, options.parent.parentThreadId),
    options.hostId !== undefined
      ? eq(environments.hostId, options.hostId)
      : undefined,
  ].filter((value) => value !== undefined);

  const groupColumn =
    options.groupBy === "host"
      ? environments.hostId
      : options.groupBy === "provider"
        ? threads.providerId
        : options.groupBy === "project"
          ? threads.projectId
          : null;

  if (groupColumn === null) {
    const base = db.select({ value: count() }).from(threads).$dynamic();

    const joined = needsEnvironmentJoin
      ? base.leftJoin(environments, eq(environments.id, threads.environmentId))
      : base;

    return { total: joined.where(and(...filters)).get()?.value ?? 0 };
  }

  const base = db
    .select({ key: groupColumn, value: count() })
    .from(threads)
    .$dynamic();

  const joined = needsEnvironmentJoin
    ? base.leftJoin(environments, eq(environments.id, threads.environmentId))
    : base;

  const rows = joined
    .where(and(...filters))
    .groupBy(groupColumn)
    .all();

  const groups = rows.map((row) => ({
    key: row.key ?? null,
    count: row.value,
  }));

  return {
    total: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
  };
}

const OCCUPYING_THREAD_STATUSES: readonly ThreadStatus[] = [
  "starting",
  "active",
];

export interface RunningThreadRow {
  id: string;

  hostId: string | null;
}

const prepareListRunningThreads = (db: DbQueryConnection) =>
  db
    .select({
      id: threads.id,
      hostId: environments.hostId,
    })
    .from(threads)
    .leftJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        liveThreads(),
        inArray(threads.status, [...OCCUPYING_THREAD_STATUSES]),
      ),
    )
    .orderBy(asc(threads.id))
    .prepare();

export function listRunningThreads(db: DbQueryConnection): RunningThreadRow[] {
  return prepareCachedQuery(db, prepareListRunningThreads)
    .all()
    .map((row) => ({ ...row, hostId: row.hostId ?? null }));
}

export function countThreadsWithUpdateActivity(db: DbQueryConnection): number {
  return listThreadsWithUpdateActivity(db).length;
}

export function primeThreadUpdateActivity(db: DbQueryConnection): void {
  listThreadsWithUpdateActivity(db);
}

const UPDATE_WORK_ITEM_EVENT_TYPES = sql.raw(
  "'item/started', 'item/completed', 'item/backgroundTask/progress', 'item/backgroundTask/completed', 'item/delegation/progress', 'item/delegation/completed'",
);

function threadUpdateItemWork(kind: "backgroundTask" | "delegation") {
  const background = kind === "backgroundTask";
  const itemKind = sql.raw(background ? "'backgroundTask'" : "'delegation'");

  const sourceIndex = sql.raw(
    background
      ? "events_background_task_thread_type_item_sequence_idx"
      : "events_thread_type_item_kind_sequence_idx",
  );

  const newerIndex = sql.raw(
    background
      ? "events_background_task_thread_type_item_sequence_idx"
      : "events_delegating_item_lookup_idx",
  );

  const newerKind = background
    ? sql`newer_work.item_kind = 'backgroundTask'`
    : sql`newer_work.item_kind IN ('toolCall', 'delegation') AND newer_work.item_kind = 'delegation'`;

  return {
    source: sql`events update_work INDEXED BY ${sourceIndex}`,
    predicate: sql`update_work.item_kind = ${itemKind}
      AND update_work.item_id IS NOT NULL
      AND update_work.type IN (${UPDATE_WORK_ITEM_EVENT_TYPES})
      AND NOT EXISTS (
        SELECT 1 FROM events newer_work INDEXED BY ${newerIndex}
        WHERE newer_work.thread_id = update_work.thread_id
          AND newer_work.item_id = update_work.item_id
          AND ${newerKind}
          AND newer_work.sequence > update_work.sequence
          AND newer_work.type IN (${UPDATE_WORK_ITEM_EVENT_TYPES})
      )
      AND json_extract(update_work.data, '$.item.status') = 'pending'`,
  };
}

function threadUpdateChildTurnWork() {
  return {
    source: sql`events update_work INDEXED BY events_thread_type_sequence_idx`,
    predicate: sql`update_work.type = 'turn/started'
      AND update_work.parent_tool_call_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM events completed_turn INDEXED BY events_thread_turn_type_item_sequence_idx
        WHERE completed_turn.thread_id = update_work.thread_id
          AND completed_turn.turn_id = update_work.turn_id
          AND completed_turn.type = 'turn/completed'
          AND completed_turn.sequence > update_work.sequence
      )`,
  };
}

function selectThreadUpdateWork(
  db: DbQueryConnection,
  threadId: string,
  { source, predicate }: ReturnType<typeof threadUpdateChildTurnWork>,
) {
  return db
    .select({
      data: sql<string>`update_work.data`,
      providerThreadId: sql<string | null>`update_work.provider_thread_id`,
      turnId: sql<string | null>`update_work.turn_id`,
      parentToolCallId: sql<string | null>`update_work.parent_tool_call_id`,
      itemKind: sql<string | null>`update_work.item_kind`,
      itemId: sql<string | null>`update_work.item_id`,
    })
    .from(source)
    .where(sql`update_work.thread_id = ${threadId} AND ${predicate}`);
}

export function listOpenThreadUpdateWorkRows(
  db: DbQueryConnection,
  threadId: string,
) {
  return selectThreadUpdateWork(
    db,
    threadId,
    threadUpdateItemWork("delegation"),
  )
    .unionAll(selectThreadUpdateWork(db, threadId, threadUpdateChildTurnWork()))
    .all();
}

export function hasThreadUpdateBackgroundWork(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  const stamp = db
    .select({
      rewriteEpoch: threadHistoryEpochs.rewriteEpoch,
      highWaterSequence: threadHistoryEpochs.highWaterSequence,
    })
    .from(threadHistoryEpochs)
    .where(eq(threadHistoryEpochs.threadId, threadId))
    .get();

  return (
    stamp !== undefined &&
    threadHasOpenUpdateWork(db, { id: threadId, ...stamp })
  );
}

const UPDATE_ACTIVE_THREAD_STATUSES: readonly ThreadStatus[] = [
  "starting",
  "active",
  "stopping",
];

interface ThreadUpdateWorkMemo {
  rewriteEpoch: string;
  highWaterSequence: number;
  openWork: Set<string>;
}

const threadUpdateWorkMemos = new WeakMap<
  DbQueryConnection,
  Map<string, ThreadUpdateWorkMemo>
>();

function readOpenUpdateItems(
  db: DbQueryConnection,
  threadId: string,
  kind: "backgroundTask" | "delegation",
): string[] {
  const itemKind = sql.raw(
    kind === "backgroundTask" ? "'backgroundTask'" : "'delegation'",
  );

  const sourceIndex = sql.raw(
    kind === "backgroundTask"
      ? "events_background_task_thread_type_item_sequence_idx"
      : "events_thread_type_item_kind_sequence_idx",
  );

  const latest = sql`(
    SELECT MAX(sequence) AS sequence
    FROM events INDEXED BY ${sourceIndex}
    WHERE thread_id = ${threadId}
      AND item_kind = ${itemKind}
      AND item_id IS NOT NULL
      AND type IN (${UPDATE_WORK_ITEM_EVENT_TYPES})
    GROUP BY item_id
  ) latest_update_work`;

  return db
    .select({ itemId: events.itemId })
    .from(latest)
    .innerJoin(
      events,
      and(
        eq(events.threadId, threadId),
        sql`${events.sequence} = latest_update_work.sequence`,
      ),
    )
    .where(sql`json_extract(${events.data}, '$.item.status') = 'pending'`)
    .all()
    .map(({ itemId }) => `${kind}:${itemId}`);
}

function readOpenUpdateWork(
  db: DbQueryConnection,
  threadId: string,
): Set<string> {
  return new Set([
    ...readOpenUpdateItems(db, threadId, "backgroundTask"),
    ...readOpenUpdateItems(db, threadId, "delegation"),
    ...selectThreadUpdateWork(db, threadId, threadUpdateChildTurnWork())
      .all()
      .map(({ turnId }) => `turn:${turnId}`),
  ]);
}

function applyUpdateWorkAppendedAfter(
  db: DbQueryConnection,
  threadId: string,
  afterSequence: number,
  openWork: Set<string>,
): void {
  const appended = db
    .select({
      type: events.type,
      itemKind: events.itemKind,
      itemId: events.itemId,
      turnId: events.turnId,
      parentToolCallId: events.parentToolCallId,
      itemStatus: sql<
        string | null
      >`CASE WHEN ${events.itemKind} IN ('backgroundTask', 'delegation') THEN json_extract(${events.data}, '$.item.status') END`,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        gt(events.sequence, afterSequence),
        sql`(${events.type} IN ('turn/started', 'turn/completed')
          OR (${events.itemKind} IN ('backgroundTask', 'delegation')
            AND ${events.itemId} IS NOT NULL
            AND ${events.type} IN (${UPDATE_WORK_ITEM_EVENT_TYPES})))`,
      ),
    )
    .orderBy(asc(events.sequence))
    .all();

  for (const event of appended) {
    if (event.type === "turn/started") {
      if (event.parentToolCallId !== null) openWork.add(`turn:${event.turnId}`);
    } else if (event.type === "turn/completed") {
      if (event.turnId !== null) openWork.delete(`turn:${event.turnId}`);
    } else if (event.itemStatus === "pending") {
      openWork.add(`${event.itemKind}:${event.itemId}`);
    } else {
      openWork.delete(`${event.itemKind}:${event.itemId}`);
    }
  }
}

function threadHasOpenUpdateWork(
  db: DbQueryConnection,
  thread: { id: string; rewriteEpoch: string; highWaterSequence: number },
): boolean {
  let memos = threadUpdateWorkMemos.get(db);

  if (memos === undefined) {
    memos = new Map();
    threadUpdateWorkMemos.set(db, memos);
  }

  const memo = memos.get(thread.id);

  if (memo === undefined || memo.rewriteEpoch !== thread.rewriteEpoch) {
    const openWork = readOpenUpdateWork(db, thread.id);

    memos.set(thread.id, {
      rewriteEpoch: thread.rewriteEpoch,
      highWaterSequence: thread.highWaterSequence,
      openWork,
    });

    return openWork.size > 0;
  }

  if (memo.highWaterSequence !== thread.highWaterSequence) {
    applyUpdateWorkAppendedAfter(
      db,
      thread.id,
      memo.highWaterSequence,
      memo.openWork,
    );
    memo.highWaterSequence = thread.highWaterSequence;
  }

  return memo.openWork.size > 0;
}

export function listThreadsWithUpdateActivity(
  db: DbQueryConnection,
  args: { hostId?: string; includeUnassigned?: boolean } = {},
): RunningThreadRow[] {
  return db
    .select({
      id: threads.id,
      hostId: environments.hostId,
      status: threads.status,
      rewriteEpoch: threadHistoryEpochs.rewriteEpoch,
      highWaterSequence: threadHistoryEpochs.highWaterSequence,
    })
    .from(threads)
    .leftJoin(environments, eq(environments.id, threads.environmentId))
    .innerJoin(
      threadHistoryEpochs,
      eq(threadHistoryEpochs.threadId, threads.id),
    )
    .where(
      and(
        or(
          inArray(threads.status, [...UPDATE_ACTIVE_THREAD_STATUSES]),
          and(liveThreads(), isNotNull(environments.id)),
        ),
        args.hostId === undefined
          ? undefined
          : or(
              eq(environments.hostId, args.hostId),
              args.includeUnassigned === true
                ? isNull(threads.environmentId)
                : undefined,
            ),
      ),
    )
    .orderBy(asc(threads.id))
    .all()
    .filter(
      (thread) =>
        UPDATE_ACTIVE_THREAD_STATUSES.includes(thread.status) ||
        threadHasOpenUpdateWork(db, thread),
    )
    .map(({ id, hostId }) => ({ id, hostId }));
}

const ARCHIVED_TEARDOWN_THREAD_STATUSES: readonly ThreadStatus[] = [
  "pending",
  "starting",
  "active",
  "stopping",
];

export interface ArchivedTeardownThreadRow {
  archivedAt: number | null;
  environmentId: string | null;
  id: string;
  status: ThreadStatus;
}

export function listArchivedThreadsPendingTeardown(
  db: DbQueryConnection,
): ArchivedTeardownThreadRow[] {
  const selection = {
    archivedAt: sql<number | null>`${threads.archivedAt}`,
    environmentId: sql<string | null>`${threads.environmentId}`,
    id: sql<string>`${threads.id}`,
    status: sql<ThreadStatus>`${threads.status}`,
  };

  const archived = and(
    isNotNull(threads.archivedAt),
    isNull(threads.deletedAt),
  );

  return db
    .select(selection)
    .from(sql`${threads} INDEXED BY threads_active_maintenance_idx`)
    .where(
      and(
        archived,
        inArray(threads.status, [...ARCHIVED_TEARDOWN_THREAD_STATUSES]),
      ),
    )
    .union(
      db
        .select(selection)
        .from(sql`${threads} INDEXED BY sqlite_autoindex_threads_1`)
        .where(
          and(
            archived,
            inArray(
              threads.id,
              db
                .select({ threadId: terminalSessions.threadId })
                .from(terminalSessions)
                .where(
                  inArray(
                    terminalSessions.status,
                    NON_TERMINAL_SESSION_STATUSES,
                  ),
                ),
            ),
          ),
        ),
    )
    .all();
}

export function listThreadsWithPendingInteractionState(
  db: DbConnection,
  options: ListThreadsOptions,
): ThreadWithPendingInteractionState[] {
  if (options.threadIds?.length === 0) return [];

  let query = threadWithPendingInteractionBaseQuery(db)
    .where(and(...buildListThreadsFilters(options)))
    .orderBy(...buildListThreadsOrderBy(options))
    .$dynamic();

  if (options.limit !== undefined) {
    query = query.limit(options.limit);
  }

  if (options.offset !== undefined) {
    query = query.offset(options.offset);
  }

  const rows = query.all();

  return rows.map(toThreadWithPendingInteractionState);
}

export function hasActiveThreadAttention(db: DbConnection): boolean {
  const unreadThread = or(
    isNull(threads.lastReadAt),
    lt(threads.lastReadAt, threads.latestAttentionAt),
  );

  const row = db
    .select({ id: threads.id })
    .from(threads)
    .leftJoin(
      pendingInteractions,
      and(
        eq(pendingInteractions.threadId, threads.id),
        eq(pendingInteractions.status, "pending"),
      ),
    )
    .where(
      activeThreads(
        listedThread(),
        or(unreadThread, isNotNull(pendingInteractions.id)),
      ),
    )
    .limit(1)
    .get();

  return row !== undefined;
}

export function listThreadsWithPendingInteractionStateForProjects(
  db: DbConnection,
  options: ListThreadsForProjectsOptions,
): ThreadWithPendingInteractionState[] {
  if (options.projectIds.length === 0) {
    return [];
  }

  const rows = threadWithPendingInteractionBaseQuery(db)
    .where(and(...buildListThreadsForProjectsFilters(options)))
    .orderBy(...buildListThreadsOrderBy(options))
    .all();

  return rows.map(toThreadWithPendingInteractionState);
}

export function countLiveThreadsInEnvironment(
  db: ThreadWriteConnection,
  args: CountLiveThreadsInEnvironmentArgs,
): number {
  return countThreadsWhere(
    db,
    liveThreads(
      eq(threads.environmentId, args.environmentId),
      args.excludeThreadId ? ne(threads.id, args.excludeThreadId) : undefined,
    ),
  );
}

export function listLiveThreadsInEnvironment(
  db: ThreadWriteConnection,
  args: ListLiveThreadsInEnvironmentArgs,
): ThreadRow[] {
  return db
    .select()
    .from(threads)
    .where(liveThreads(eq(threads.environmentId, args.environmentId)))
    .orderBy(desc(threads.createdAt))
    .all();
}

export function countNonDeletedAssignedChildThreads(
  db: DbConnection,
  args: CountNonDeletedAssignedChildThreadsArgs,
): number {
  return countThreadsWhere(
    db,
    nonDeletedThreads(eq(threads.parentThreadId, args.parentThreadId)),
  );
}

export function listUnarchivedAssignedChildThreads(
  db: ThreadWriteConnection,
  args: ListUnarchivedAssignedChildThreadsArgs,
): ThreadRow[] {
  return listThreadsWhere(
    db,
    liveThreads(eq(threads.parentThreadId, args.parentThreadId)),
  );
}

export function listNonDeletedHiddenSourceThreads(
  db: ThreadWriteConnection,
  args: ListNonDeletedHiddenSourceThreadsArgs,
): ThreadRow[] {
  return listThreadsWhere(
    db,
    nonDeletedThreads(
      eq(threads.sourceThreadId, args.sourceThreadId),
      eq(threads.visibility, "hidden"),
    ),
  );
}

export function listNonDeletedChildThreads(
  db: ThreadWriteConnection,
  args: ListNonDeletedChildThreadsArgs,
): ThreadRow[] {
  return listThreadsWhere(
    db,
    nonDeletedThreads(eq(threads.parentThreadId, args.parentThreadId)),
  );
}

export function listThreadEnvironmentAssignmentsOnHost(
  db: DbConnection,
  args: ListThreadEnvironmentAssignmentsOnHostArgs,
): ThreadEnvironmentAssignmentRow[] {
  if (args.threadIds.length === 0) {
    return [];
  }

  return db
    .select({
      threadId: threads.id,
      environmentId: environments.id,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        inArray(threads.id, [...args.threadIds]),
        eq(environments.hostId, args.hostId),
      ),
    )
    .all();
}

export function listExistingThreadIds(
  db: DbQueryConnection,
  threadIds: string[],
): string[] {
  if (threadIds.length === 0) {
    return [];
  }

  return db
    .select({ id: threads.id })
    .from(threads)
    .where(inArray(threads.id, threadIds))
    .all()
    .map((row) => row.id);
}

export function listHostThreadIds(
  db: DbConnection,
  args: ListHostThreadIdsArgs,
): string[] {
  return db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(eq(environments.hostId, args.hostId))
    .all()
    .map((row) => row.id);
}

export function listActiveHostThreads(
  db: DbConnection,
  args: ListActiveHostThreadsArgs,
): ThreadRow[] {
  return db
    .select(getTableColumns(threads))
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      nonDeletedThreads(
        eq(environments.hostId, args.hostId),
        eq(threads.status, "active"),
      ),
    )
    .all();
}

export function pinThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  args: PinThreadArgs,
) {
  const result = db.transaction(
    (tx): PinThreadMutationResult | null => {
      const existing =
        tx.select().from(threads).where(eq(threads.id, args.threadId)).get() ??
        null;

      if (!existing || existing.deletedAt !== null) {
        return null;
      }

      if (existing.pinnedAt !== null && existing.pinSortKey !== null) {
        return { changed: false, thread: existing };
      }

      const firstPinnedThread = getFirstPinnedThread(tx);

      const pinSortKey = createOrderKeyBetween({
        previousKey: null,
        nextKey: firstPinnedThread?.pinSortKey ?? null,
      });

      const now = Date.now();

      const updated = tx
        .update(threads)
        .set({
          pinnedAt: args.pinnedAt ?? now,
          pinSortKey,
          updatedAt: now,
        })
        .where(nonDeletedThreads(eq(threads.id, args.threadId)))
        .returning()
        .get();

      return updated ? { changed: true, thread: updated } : null;
    },
    { behavior: "immediate" },
  );

  if (result?.changed) {
    notifier.notifyThread(args.threadId, ["pin-state-changed"], {
      projectId: result.thread.projectId,
    });
  }

  return result?.thread ?? null;
}

export function unpinThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  args: UnpinThreadArgs,
) {
  const result = db.transaction(
    (tx): PinThreadMutationResult | null => {
      const existing =
        tx.select().from(threads).where(eq(threads.id, args.threadId)).get() ??
        null;

      if (!existing || existing.deletedAt !== null) {
        return null;
      }

      if (existing.pinnedAt === null && existing.pinSortKey === null) {
        return { changed: false, thread: existing };
      }

      const updated = tx
        .update(threads)
        .set({
          pinnedAt: null,
          pinSortKey: null,
          updatedAt: Date.now(),
        })
        .where(nonDeletedThreads(eq(threads.id, args.threadId)))
        .returning()
        .get();

      return updated ? { changed: true, thread: updated } : null;
    },
    { behavior: "immediate" },
  );

  if (result?.changed) {
    notifier.notifyThread(args.threadId, ["pin-state-changed"], {
      projectId: result.thread.projectId,
    });
  }

  return result?.thread ?? null;
}

export function reorderPinnedThread({
  db,
  nextThreadId,
  notifier,
  previousThreadId,
  threadId,
}: ReorderPinnedThreadArgs): ReorderPinnedThreadResult {
  const result = db.transaction(
    (tx): ReorderPinnedThreadResult => {
      const movedThread =
        tx.select().from(threads).where(eq(threads.id, threadId)).get() ?? null;

      if (!movedThread || movedThread.deletedAt !== null) {
        return { kind: "not_found" };
      }

      if (movedThread.pinnedAt === null || movedThread.pinSortKey === null) {
        return { kind: "not_pinned" };
      }

      const currentThreads = listActiveVisiblePinnedThreadRoots(tx);

      const currentIndex = currentThreads.findIndex(
        (thread) => thread.id === threadId,
      );

      if (currentIndex === -1) {
        return { kind: "stale_neighbor" };
      }

      const previousThread = resolveOrderedThreadNeighbor({
        movedThreadId: threadId,
        neighborThreadId: previousThreadId,
        orderedThreads: currentThreads,
      });

      const nextThread = resolveOrderedThreadNeighbor({
        movedThreadId: threadId,
        neighborThreadId: nextThreadId,
        orderedThreads: currentThreads,
      });

      if (previousThread === false || nextThread === false) {
        return { kind: "stale_neighbor" };
      }

      if (
        previousThread?.pinSortKey === null ||
        nextThread?.pinSortKey === null
      ) {
        return { kind: "stale_neighbor" };
      }

      if (
        previousThread !== null &&
        nextThread !== null &&
        previousThread.pinSortKey >= nextThread.pinSortKey
      ) {
        return { kind: "invalid_neighbor_order" };
      }

      const currentPreviousThreadId =
        currentThreads[currentIndex - 1]?.id ?? null;

      const currentNextThreadId = currentThreads[currentIndex + 1]?.id ?? null;

      if (
        currentPreviousThreadId === previousThreadId &&
        currentNextThreadId === nextThreadId
      ) {
        return {
          kind: "unchanged",
          threads: currentThreads,
        };
      }

      const pinSortKey = createOrderKeyBetween({
        previousKey: previousThread?.pinSortKey ?? null,
        nextKey: nextThread?.pinSortKey ?? null,
      });

      const updated = tx
        .update(threads)
        .set({ pinSortKey, updatedAt: Date.now() })
        .where(and(eq(threads.id, threadId), pinnedThreadWhere()))
        .returning({ id: threads.id })
        .get();

      if (!updated) {
        return { kind: "stale_neighbor" };
      }

      return {
        kind: "reordered",
        threads: listActiveVisiblePinnedThreadRoots(tx),
      };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "reordered") {
    const reorderedThread = result.threads.find(
      (thread) => thread.id === threadId,
    );

    if (reorderedThread) {
      notifier.notifyThread(threadId, ["pin-state-changed"], {
        projectId: reorderedThread.projectId,
      });
    }
  }

  return result;
}

export interface ThreadShelfArgs {
  threadId: string;
}

export type ShelveThreadFamilyResult =
  | { kind: "shelved"; thread: ThreadRow }
  | { kind: "not_found" }
  | { kind: "not_top_level" }
  | { kind: "archived" };

type ShelveThreadFamilyMutation =
  | Exclude<ShelveThreadFamilyResult, { kind: "shelved" }>
  | { kind: "shelved"; thread: ThreadRow; shelvedThreads: ThreadRow[] };

function threadFamilyIds(threadId: string): SQL {
  return sql`(WITH RECURSIVE ancestors(id, parent_id) AS (
    SELECT id, parent_thread_id FROM threads WHERE id = ${threadId}
    UNION SELECT t.id, t.parent_thread_id FROM threads t JOIN ancestors a ON t.id = a.parent_id
  ), family(id) AS (
    SELECT id FROM ancestors WHERE parent_id IS NULL
    UNION SELECT t.id FROM threads t JOIN family f ON t.parent_thread_id = f.id
  ) SELECT id FROM family)`;
}

export function shelveThreadFamily(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  args: ThreadShelfArgs,
): ShelveThreadFamilyResult {
  const mutation = db.transaction(
    (tx): ShelveThreadFamilyMutation => {
      const root = getThread(tx, args.threadId);

      if (!root || root.deletedAt !== null) return { kind: "not_found" };

      if (root.parentThreadId !== null) return { kind: "not_top_level" };

      if (root.archivedAt !== null) return { kind: "archived" };

      const now = Date.now();

      const shelvedThreads = tx
        .update(threads)
        .set({
          shelvedAt: root.shelvedAt ?? now,
          shelfSortKey:
            root.shelvedAt === null
              ? createOrderKeyBetween({
                  previousKey: null,
                  nextKey: getFirstShelfSortKey(tx),
                })
              : root.shelfSortKey,
          lastReadAt: sql`CASE WHEN ${threads.id} = ${root.id} THEN ${now} ELSE ${threads.lastReadAt} END`,
          updatedAt: now,
        })
        .where(
          and(
            inArray(threads.id, threadFamilyIds(root.id)),
            isNull(threads.archivedAt),
            isNull(threads.deletedAt),
            isNull(threads.shelvedAt),
          ),
        )
        .returning()
        .all();

      return {
        kind: "shelved",
        thread: shelvedThreads.find((thread) => thread.id === root.id) ?? root,
        shelvedThreads,
      };
    },
    { behavior: "immediate" },
  );

  if (mutation.kind !== "shelved") return mutation;

  for (const thread of mutation.shelvedThreads) {
    notifier.notifyThread(
      thread.id,
      thread.id === mutation.thread.id
        ? ["shelf-state-changed", "read-state-changed"]
        : ["shelf-state-changed"],
      { projectId: thread.projectId },
    );
  }

  return { kind: "shelved", thread: mutation.thread };
}

export function unshelveThreadFamily(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  args: ThreadShelfArgs,
): string[] {
  const returnedThreads = db
    .update(threads)
    .set({ shelvedAt: null, shelfSortKey: null, updatedAt: Date.now() })
    .where(
      and(
        inArray(threads.id, threadFamilyIds(args.threadId)),
        isNull(threads.deletedAt),
        isNotNull(threads.shelvedAt),
      ),
    )
    .returning({ id: threads.id, projectId: threads.projectId })
    .all();

  for (const thread of returnedThreads) {
    notifier.notifyThread(thread.id, ["shelf-state-changed"], {
      projectId: thread.projectId,
    });
  }

  return returnedThreads.map((thread) => thread.id);
}

export interface ReorderShelvedThreadArgs {
  db: DbConnection;
  nextThreadId: string | null;
  notifier: DbNotifier;
  previousThreadId: string | null;
  threadId: string;
}

export type ReorderShelvedThreadResult = {
  kind:
    | "reordered"
    | "unchanged"
    | "not_found"
    | "not_shelved"
    | "stale_neighbor"
    | "invalid_neighbor_order";
};

type ReorderShelvedThreadMutation =
  | { kind: Exclude<ReorderShelvedThreadResult["kind"], "reordered"> }
  | {
      kind: "reordered";
      changedThreads: Pick<ThreadRow, "id" | "projectId">[];
    };

function shelvedThreadRootWhere(): ThreadWhere {
  return liveThreads(
    listedThread(),
    isNull(threads.parentThreadId),
    isNotNull(threads.shelvedAt),
  );
}

function getFirstShelfSortKey(db: DbQueryConnection): string | null {
  return (
    db
      .select({ shelfSortKey: threads.shelfSortKey })
      .from(threads)
      .where(shelvedThreadRootWhere())
      .orderBy(...buildShelfOrderBy())
      .limit(1)
      .get()?.shelfSortKey ?? null
  );
}

function listShelvedThreadRoots(db: DbQueryConnection): ThreadRow[] {
  return db
    .select()
    .from(threads)
    .where(shelvedThreadRootWhere())
    .orderBy(...buildShelfOrderBy())
    .all();
}

function setShelvedFamilySortKey(
  tx: DbTransaction,
  rootId: string,
  shelfSortKey: string,
): Pick<ThreadRow, "id" | "projectId">[] {
  return tx
    .update(threads)
    .set({ shelfSortKey, updatedAt: Date.now() })
    .where(
      and(
        inArray(threads.id, threadFamilyIds(rootId)),
        isNull(threads.deletedAt),
        isNotNull(threads.shelvedAt),
      ),
    )
    .returning({ id: threads.id, projectId: threads.projectId })
    .all();
}

export function reorderShelvedThread({
  db,
  nextThreadId,
  notifier,
  previousThreadId,
  threadId,
}: ReorderShelvedThreadArgs): ReorderShelvedThreadResult {
  const mutation = db.transaction(
    (tx): ReorderShelvedThreadMutation => {
      const movedThread = getThread(tx, threadId);

      if (!movedThread || movedThread.deletedAt !== null) {
        return { kind: "not_found" };
      }

      if (
        movedThread.shelvedAt === null ||
        movedThread.archivedAt !== null ||
        movedThread.parentThreadId !== null
      ) {
        return { kind: "not_shelved" };
      }

      const currentThreads = listShelvedThreadRoots(tx);

      const currentIndex = currentThreads.findIndex(
        (thread) => thread.id === threadId,
      );

      if (currentIndex === -1) {
        return { kind: "stale_neighbor" };
      }

      const previousThread = resolveOrderedThreadNeighbor({
        movedThreadId: threadId,
        neighborThreadId: previousThreadId,
        orderedThreads: currentThreads,
      });

      const nextThread = resolveOrderedThreadNeighbor({
        movedThreadId: threadId,
        neighborThreadId: nextThreadId,
        orderedThreads: currentThreads,
      });

      if (
        previousThread === false ||
        nextThread === false ||
        previousThread?.shelfSortKey === null ||
        nextThread?.shelfSortKey === null
      ) {
        return { kind: "stale_neighbor" };
      }

      const previousKey = previousThread?.shelfSortKey ?? null;
      const nextKey = nextThread?.shelfSortKey ?? null;

      if (previousKey !== null && nextKey !== null && previousKey >= nextKey) {
        return { kind: "invalid_neighbor_order" };
      }

      if (
        (currentThreads[currentIndex - 1]?.id ?? null) === previousThreadId &&
        (currentThreads[currentIndex + 1]?.id ?? null) === nextThreadId
      ) {
        return { kind: "unchanged" };
      }

      return {
        kind: "reordered",
        changedThreads: setShelvedFamilySortKey(
          tx,
          threadId,
          createOrderKeyBetween({ previousKey, nextKey }),
        ),
      };
    },
    { behavior: "immediate" },
  );

  if (mutation.kind !== "reordered") return mutation;

  for (const thread of mutation.changedThreads) {
    notifier.notifyThread(thread.id, ["shelf-state-changed"], {
      projectId: thread.projectId,
    });
  }

  return { kind: "reordered" };
}

export function listShelvedThreadRootsWithPendingInteractionState(
  db: DbConnection,
  threadIds: readonly string[],
): ThreadWithPendingInteractionState[] {
  if (threadIds.length === 0) return [];

  return threadWithPendingInteractionBaseQuery(db)
    .where(and(shelvedThreadRootWhere(), inArray(threads.id, [...threadIds])))
    .orderBy(...buildShelfOrderBy())
    .all()
    .map(toThreadWithPendingInteractionState);
}

export interface UpdateThreadInput {
  environmentId?: string | null;
  sectionId?: string | null;
  groupId?: string | null;
  lastReadAt?: number | null;
  parentThreadId?: string | null;
  title?: string | null;
  visibility?: ThreadVisibility;
  pluginHome?: boolean;
}

export function clearPluginHomeThreads(
  db: ThreadWriteConnection,
  notifier: Pick<DbNotifier, "notifyThread">,
  pluginId: string,
): string[] {
  const cleared = db
    .update(threads)
    .set({ pluginHome: false, updatedAt: Date.now() })
    .where(
      and(eq(threads.originPluginId, pluginId), eq(threads.pluginHome, true)),
    )
    .returning({ id: threads.id, projectId: threads.projectId })
    .all();

  for (const thread of cleared) {
    notifier.notifyThread(thread.id, ["title-changed"], {
      projectId: thread.projectId,
    });
  }

  return cleared.map((thread) => thread.id);
}

export function updateThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateThreadInput,
) {
  const now = Date.now();
  const existing = db.select().from(threads).where(eq(threads.id, id)).get();

  if (!existing) {
    return null;
  }

  const changes: ThreadChangeKind[] = [];

  if ("title" in input || "sectionId" in input || "groupId" in input)
    changes.push("title-changed");

  if ("lastReadAt" in input) changes.push("read-state-changed");

  if ("visibility" in input && input.visibility !== existing.visibility) {
    changes.push("title-changed");
  }

  if ("pluginHome" in input && input.pluginHome !== existing.pluginHome) {
    changes.push("title-changed");
  }

  if (
    "parentThreadId" in input &&
    input.parentThreadId !== existing.parentThreadId
  ) {
    changes.push("parent-changed");
  }

  if (
    "environmentId" in input &&
    input.environmentId !== existing.environmentId
  ) {
    changes.push("environment-changed");
  }

  const set: Partial<typeof threads.$inferInsert> = { updatedAt: now };

  if ("title" in input) set.title = input.title;

  if ("sectionId" in input) {
    set.sectionId = input.sectionId;
  }

  if ("groupId" in input) set.groupId = input.groupId;

  if ("environmentId" in input) set.environmentId = input.environmentId;

  if ("lastReadAt" in input) {
    set.lastReadAt = input.lastReadAt;
  }

  if ("parentThreadId" in input) set.parentThreadId = input.parentThreadId;

  if ("visibility" in input) set.visibility = input.visibility;

  if ("pluginHome" in input) set.pluginHome = input.pluginHome;

  const updated = db
    .update(threads)
    .set(set)
    .where(eq(threads.id, id))
    .returning()
    .get();

  if (updated && "title" in input) {
    upsertThreadTitleSearchSegments(db, {
      threadId: updated.id,
      title: updated.title,
      titleFallback: updated.titleFallback,
      updatedAt: now,
    });
  }

  if (updated && changes.length > 0) {
    notifier.notifyThread(id, changes, {
      projectId: existing.projectId,
    });
  }

  return updated ?? null;
}

export interface ThreadExecutionOverride {
  modelOverride: string | null;
  reasoningLevelOverride: ReasoningLevel | null;
}

export function getThreadExecutionOverride(
  db: ThreadWriteConnection,
  id: string,
): ThreadExecutionOverride | null {
  const row = db
    .select({
      modelOverride: threads.modelOverride,
      reasoningLevelOverride: threads.reasoningLevelOverride,
    })
    .from(threads)
    .where(eq(threads.id, id))
    .get();

  return row ?? null;
}

export interface SetThreadExecutionOverrideInput {
  threadId: string;
  modelOverride?: string | null;
  reasoningLevelOverride?: ReasoningLevel | null;
}

export function setThreadExecutionOverride(
  db: ThreadWriteConnection,
  input: SetThreadExecutionOverrideInput,
) {
  const set: Partial<typeof threads.$inferInsert> = { updatedAt: Date.now() };

  if ("modelOverride" in input) {
    set.modelOverride = input.modelOverride;
  }

  if ("reasoningLevelOverride" in input) {
    set.reasoningLevelOverride = input.reasoningLevelOverride;
  }

  const updated = db
    .update(threads)
    .set(set)
    .where(eq(threads.id, input.threadId))
    .returning()
    .get();

  return updated ?? null;
}

export interface SetThreadStartupContextInput {
  threadId: string;
  startupContext: string | null;
}

export function setThreadStartupContext(
  db: ThreadWriteConnection,
  input: SetThreadStartupContextInput,
) {
  return (
    db
      .update(threads)
      .set({
        startupContext: input.startupContext,
        updatedAt: Date.now(),
      })
      .where(eq(threads.id, input.threadId))
      .returning()
      .get() ?? null
  );
}

export function getThreadStartupContext(
  db: DbQueryConnection,
  threadId: string,
): string | null {
  return (
    db
      .select({ startupContext: threads.startupContext })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get()?.startupContext ?? null
  );
}

export function purgeThreadHistoryChunk(
  db: ThreadWriteConnection,
  args: { threadId: string; limit: number },
): boolean {
  if (
    db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.lifecycleOwnerThreadId, args.threadId))
      .limit(1)
      .get()
  )
    return true;

  const deletedSegments = db.run(sql`
    DELETE FROM thread_search_segments
    WHERE rowid IN (
      SELECT rowid
      FROM thread_search_segments
        INDEXED BY thread_search_segments_thread_source_seq_idx
      WHERE thread_id = ${args.threadId}
      LIMIT ${args.limit}
    )
  `).changes;

  const deletedEvents = db.run(sql`
    DELETE FROM events
    WHERE rowid IN (
      SELECT rowid
      FROM events INDEXED BY events_thread_sequence_idx
      WHERE thread_id = ${args.threadId}
      ORDER BY sequence DESC
      LIMIT ${args.limit}
    )
  `).changes;

  return deletedSegments < args.limit && deletedEvents < args.limit;
}

export function deleteThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  id: string,
) {
  const existing = db.select().from(threads).where(eq(threads.id, id)).get();

  if (!existing) return false;

  if (
    db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.lifecycleOwnerThreadId, id))
      .limit(1)
      .get()
  )
    return false;
  db.delete(threads).where(eq(threads.id, id)).run();
  notifier.notifyThread(id, ["thread-deleted"], {
    projectId: existing.projectId,
  });
  notifier.notifyProject(existing.projectId, ["threads-changed"]);

  return true;
}

export function listThreadAncestors(
  db: DbQueryConnection,
  threadIds: readonly string[],
): Array<{ threadId: string; ancestorIds: string[] }> {
  if (threadIds.length === 0) return [];

  const rows = db.all<{ id: string; parentId: string | null }>(sql`
    WITH RECURSIVE chain(id, parent_id) AS (
      SELECT id, parent_thread_id FROM threads WHERE ${inArray(threads.id, [...threadIds])}
      UNION
      SELECT t.id, t.parent_thread_id FROM threads t JOIN chain c ON t.id = c.parent_id
    )
    SELECT id, parent_id AS parentId FROM chain
  `);

  const parentById = new Map(rows.map((row) => [row.id, row.parentId]));
  const result: Array<{ threadId: string; ancestorIds: string[] }> = [];

  for (const threadId of new Set(threadIds)) {
    if (!parentById.has(threadId)) continue;
    const ancestorIds: string[] = [];
    let parentId = parentById.get(threadId) ?? null;

    while (
      parentId !== null &&
      parentById.has(parentId) &&
      parentId !== threadId &&
      !ancestorIds.includes(parentId)
    ) {
      ancestorIds.push(parentId);
      parentId = parentById.get(parentId) ?? null;
    }

    result.push({ threadId, ancestorIds });
  }

  return result;
}

export interface ListThreadDescendantsOptions {
  includeArchived: boolean;
  includeHidden: boolean;
}

export function listThreadDescendants(
  db: DbQueryConnection,
  threadIds: readonly string[],
  options: ListThreadDescendantsOptions,
): Array<{ threadId: string; descendantIds: string[] }> {
  if (threadIds.length === 0) return [];

  const rows = db.all<{
    id: string;
    parentId: string | null;
    archived: number;
    hidden: number;
  }>(sql`
    WITH RECURSIVE tree(id, parent_id, archived, hidden) AS (
      SELECT id, parent_thread_id, archived_at IS NOT NULL, visibility = 'hidden' FROM threads
      WHERE ${inArray(threads.id, [...threadIds])} AND deleted_at IS NULL
      UNION
      SELECT t.id, t.parent_thread_id, t.archived_at IS NOT NULL, t.visibility = 'hidden'
      FROM threads t JOIN tree ON t.parent_thread_id = tree.id
      WHERE t.deleted_at IS NULL
    )
    SELECT id, parent_id AS parentId, archived, hidden FROM tree
  `);

  const omittedIds = new Set(
    rows
      .filter(
        (row) =>
          (!options.includeArchived && row.archived === 1) ||
          (!options.includeHidden && row.hidden === 1),
      )
      .map((row) => row.id),
  );

  const childIdsByParent = new Map<string, string[]>();

  for (const row of rows) {
    if (row.parentId === null) continue;
    const siblings = childIdsByParent.get(row.parentId);

    if (siblings === undefined) childIdsByParent.set(row.parentId, [row.id]);
    else if (!siblings.includes(row.id)) siblings.push(row.id);
  }

  const knownIds = new Set(rows.map((row) => row.id));
  const result: Array<{ threadId: string; descendantIds: string[] }> = [];

  for (const threadId of new Set(threadIds)) {
    if (!knownIds.has(threadId)) continue;
    const visited = new Set([threadId]);
    const descendantIds: string[] = [];

    for (let index = -1; index < descendantIds.length; index += 1) {
      const parentId = index < 0 ? threadId : descendantIds[index]!;

      for (const childId of childIdsByParent.get(parentId) ?? []) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        descendantIds.push(childId);
      }
    }

    result.push({
      threadId,
      descendantIds: descendantIds.filter((id) => !omittedIds.has(id)),
    });
  }

  return result;
}

function lifecycleThreadTreeIds(seed: SQL): SQL {
  return sql`(WITH RECURSIVE owned(id) AS (
    ${seed} UNION SELECT t.id FROM threads t JOIN owned ON t.lifecycle_owner_thread_id = owned.id
  ) SELECT id FROM owned)`;
}

function lifecycleThreadTreeIdsForThread(threadId: string): SQL {
  return lifecycleThreadTreeIds(sql`SELECT ${threadId}`);
}

export function lifecycleThreadTreeIdsForProject(projectId: string): SQL {
  return lifecycleThreadTreeIds(
    sql`SELECT id FROM threads WHERE project_id = ${projectId}`,
  );
}

export function listLifecycleThreadDependents(
  db: DbQueryConnection,
  id: string,
) {
  return db
    .select()
    .from(threads)
    .where(eq(threads.lifecycleOwnerThreadId, id))
    .all();
}

export function listLifecycleThreadTree(db: DbQueryConnection, id: string) {
  return db
    .select()
    .from(threads)
    .where(inArray(threads.id, lifecycleThreadTreeIdsForThread(id)))
    .all();
}

export function markThreadDeleted(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  args: MarkThreadDeletedArgs,
) {
  const updated = db
    .update(threads)
    .set({
      deletedAt: args.deletedAt ?? Date.now(),
      updatedAt: Date.now(),
    })
    .where(
      and(
        inArray(threads.id, lifecycleThreadTreeIdsForThread(args.threadId)),
        isNull(threads.deletedAt),
      ),
    )
    .returning()
    .all();

  for (const thread of updated) {
    notifier.notifyThread(thread.id, ["thread-deleted"], {
      projectId: thread.projectId,
    });
    notifier.notifyProject(thread.projectId, ["threads-changed"]);
  }

  return (
    updated.find((thread) => thread.id === args.threadId) ??
    getThread(db, args.threadId)
  );
}

export function markThreadStorageDeleted(
  db: ThreadWriteConnection,
  args: { threadId: string },
) {
  return (
    db
      .update(threads)
      .set({ storageDeletedAt: Date.now() })
      .where(eq(threads.id, args.threadId))
      .returning()
      .get() ?? null
  );
}

export function archiveThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  id: string,
) {
  const now = Date.now();

  const archivableThreads = (...where: ThreadWhere[]) =>
    and(
      inArray(threads.id, lifecycleThreadTreeIdsForThread(id)),
      isNull(threads.archivedAt),
      isNull(threads.deletedAt),
      ...where,
    );

  const { updated, cancelledCallbackThreadIds } = db.transaction((tx) => {
    const archived = tx
      .update(threads)
      .set({ archivedAt: now, updatedAt: now })
      .where(archivableThreads())
      .returning()
      .all();

    const archivedIds = archived.map((thread) => thread.id);

    const cancelledCallbackThreadIds = new Set(
      archivedIds.length === 0
        ? []
        : tx
            .delete(threadCallbacks)
            .where(inArray(threadCallbacks.threadId, archivedIds))
            .returning({ threadId: threadCallbacks.threadId })
            .all()
            .map((callback) => callback.threadId),
    );

    markThreadPruningPolicyWork(tx, archivedIds, "rate-limits");

    return {
      updated: archived,
      cancelledCallbackThreadIds,
    };
  });

  for (const thread of updated) {
    const changes: ThreadChangeKind[] = ["archived-changed"];

    if (cancelledCallbackThreadIds.has(thread.id))
      changes.push("interactions-changed");
    notifier.notifyThread(thread.id, changes, { projectId: thread.projectId });
  }

  const root = updated.find((thread) => thread.id === id) ?? getThread(db, id);

  return root?.deletedAt === null ? root : null;
}

export function unarchiveThread(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const updated = db.transaction(
    (tx) => {
      const current = getThread(tx, id);

      if (current?.deletedAt !== null) return null;

      if (current.lifecycleOwnerThreadId) {
        const owner = getThread(tx, current.lifecycleOwnerThreadId);

        if (!owner || owner.archivedAt !== null || owner.deletedAt !== null)
          return null;
      }

      const now = Date.now();

      const unarchived = tx
        .update(threads)
        .set({ archivedAt: null, updatedAt: now })
        .where(and(eq(threads.id, id), isNotNull(threads.archivedAt)))
        .returning()
        .get();

      if (unarchived)
        markThreadPruningPolicyWork(tx, [unarchived.id], "rate-limits");

      return unarchived;
    },
    { behavior: "immediate" },
  );

  if (updated) {
    notifier.notifyThread(id, ["archived-changed"], {
      projectId: updated.projectId,
    });
  }

  return updated ?? null;
}

export type ApplyThreadLifecycleEventNoopReason =
  | ThreadLifecycleNoopReason
  | "not-found"
  | "cas-conflict";

export type ApplyThreadLifecycleEventOutcome =
  | { applied: true; thread: ThreadRow }
  | {
      applied: false;
      detail: string;
      reason: ApplyThreadLifecycleEventNoopReason;
    };

export interface ApplyThreadLifecycleEventArgs {
  event: ThreadLifecycleEvent;
  threadId: string;
}

interface ThreadLifecycleEventNotAppliedErrorArgs {
  detail: string;
  reason: ApplyThreadLifecycleEventNoopReason;
}

export class ThreadLifecycleEventNotAppliedError extends Error {
  readonly detail: string;
  readonly reason: ApplyThreadLifecycleEventNoopReason;

  constructor(args: ThreadLifecycleEventNotAppliedErrorArgs) {
    super(
      `Thread lifecycle event not applied (${args.reason}): ${args.detail}`,
    );
    this.name = "ThreadLifecycleEventNotAppliedError";
    this.detail = args.detail;
    this.reason = args.reason;
  }
}

export function requireThreadLifecycleEventApplied(
  outcome: ApplyThreadLifecycleEventOutcome,
) {
  if (!outcome.applied) {
    throw new ThreadLifecycleEventNotAppliedError(outcome);
  }

  return outcome.thread;
}

export function applyThreadLifecycleEventInTransaction(
  db: DbTransaction,
  notifier: DbNotifier,
  args: ApplyThreadLifecycleEventArgs,
): ApplyThreadLifecycleEventOutcome {
  const thread = db
    .select()
    .from(threads)
    .where(eq(threads.id, args.threadId))
    .get();

  if (!thread) {
    return {
      applied: false,
      detail: `thread not found: ${args.threadId}`,
      reason: "not-found",
    };
  }

  const evaluation = evaluateThreadLifecycleEvent({
    event: args.event,
    thread,
  });

  if ("noop" in evaluation) {
    return {
      applied: false,
      detail: evaluation.detail,
      reason: evaluation.noop,
    };
  }

  const now = Date.now();

  const set: Partial<typeof threads.$inferInsert> = {
    status: evaluation.to,
    statusChangedAt: now,
    updatedAt: now,
  };

  if (
    evaluation.to === "active" ||
    (evaluation.to === "idle" && thread.environmentId !== null)
  ) {
    set.startupContext = null;
  }

  const updated = db
    .update(threads)
    .set(set)
    .where(
      and(eq(threads.id, args.threadId), eq(threads.status, thread.status)),
    )
    .returning()
    .get();

  if (!updated) {
    return {
      applied: false,
      detail: `status changed from ${thread.status} while applying ${args.event.type}`,
      reason: "cas-conflict",
    };
  }

  return { applied: true, thread: updated };
}

export function applyThreadLifecycleEvent(
  db: DbConnection,
  notifier: DbNotifier,
  args: ApplyThreadLifecycleEventArgs,
): ApplyThreadLifecycleEventOutcome {
  return db.transaction(
    (tx) => applyThreadLifecycleEventInTransaction(tx, notifier, args),
    { behavior: "immediate" },
  );
}
