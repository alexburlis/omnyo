import { asc, eq, inArray } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { createThreadGroupId } from "../ids.js";
import type { DbNotifier } from "../notifier.js";
import { threadGroups, threads } from "../schema.js";

export type ThreadGroupRow = typeof threadGroups.$inferSelect;

export interface ListThreadGroupsOptions {
  projectId?: string;
}

export interface CreateThreadGroupInput {
  name: string;
  threadIds: readonly string[];
}

export interface RenameThreadGroupInput {
  id: string;
  name: string;
}

export interface DeleteThreadGroupInput {
  id: string;
}

export interface ThreadGroupMutationResult {
  id: string;
  projectId: string;
  name: string;
  updatedThreadCount: number;
}

export type CreateThreadGroupResult =
  | { status: "created"; group: ThreadGroupRow; threadIds: string[] }
  | { status: "thread_not_found"; threadId: string }
  | { status: "project_mismatch" };

export function normalizeThreadGroupName(
  name: string | null | undefined,
): string | null {
  const normalized = (name ?? "").trim();

  return normalized.length > 0 ? normalized : null;
}

export function getThreadGroupById(
  db: DbQueryConnection,
  id: string,
): ThreadGroupRow | null {
  return (
    db.select().from(threadGroups).where(eq(threadGroups.id, id)).get() ?? null
  );
}

export function listThreadGroups(
  db: DbQueryConnection,
  options: ListThreadGroupsOptions = {},
): ThreadGroupRow[] {
  const query = db.select().from(threadGroups);

  return (
    options.projectId
      ? query.where(eq(threadGroups.projectId, options.projectId))
      : query
  )
    .orderBy(asc(threadGroups.createdAt), asc(threadGroups.id))
    .all();
}

function notifyGroupMembers(
  notifier: DbNotifier,
  projectId: string,
  threadIds: readonly string[],
): void {
  for (const threadId of threadIds) {
    notifier.notifyThread(threadId, ["title-changed"], { projectId });
  }

  notifier.notifyProject(projectId, ["threads-changed"]);
}

export function createThreadGroup(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateThreadGroupInput,
): CreateThreadGroupResult {
  const name = normalizeThreadGroupName(input.name);

  if (!name) {
    throw new Error("Thread group name cannot be empty");
  }

  const threadIds = [...new Set(input.threadIds)];

  if (threadIds.length === 0) {
    throw new Error("A thread group needs at least one thread");
  }

  return db.transaction(
    (tx) => {
      const members = tx
        .select({
          id: threads.id,
          projectId: threads.projectId,
          deletedAt: threads.deletedAt,
        })
        .from(threads)
        .where(inArray(threads.id, threadIds))
        .all();

      const byId = new Map(members.map((member) => [member.id, member]));

      const missing = threadIds.find((threadId) => {
        const member = byId.get(threadId);

        return member === undefined || member.deletedAt !== null;
      });

      if (missing !== undefined) {
        return { status: "thread_not_found", threadId: missing };
      }

      const projectIds = new Set(members.map((member) => member.projectId));
      const [projectId] = projectIds;

      if (projectIds.size !== 1 || projectId === undefined) {
        return { status: "project_mismatch" };
      }

      const now = Date.now();

      const group = tx
        .insert(threadGroups)
        .values({
          id: createThreadGroupId(),
          projectId,
          name,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      tx.update(threads)
        .set({ groupId: group.id, updatedAt: now })
        .where(inArray(threads.id, threadIds))
        .run();

      notifyGroupMembers(notifier, projectId, threadIds);

      return { status: "created", group, threadIds };
    },
    { behavior: "immediate" },
  );
}

export function renameThreadGroup(
  db: DbConnection,
  notifier: DbNotifier,
  input: RenameThreadGroupInput,
): ThreadGroupMutationResult | null {
  const name = normalizeThreadGroupName(input.name);

  if (!name) {
    throw new Error("Thread group name cannot be empty");
  }

  return db.transaction(
    (tx) => {
      const group = getThreadGroupById(tx, input.id);

      if (!group) {
        return null;
      }

      if (group.name !== name) {
        tx.update(threadGroups)
          .set({ name, updatedAt: Date.now() })
          .where(eq(threadGroups.id, group.id))
          .run();
        notifier.notifyProject(group.projectId, ["threads-changed"]);
      }

      return {
        id: group.id,
        projectId: group.projectId,
        name,
        updatedThreadCount: 0,
      };
    },
    { behavior: "immediate" },
  );
}

export function deleteThreadGroup(
  db: DbConnection,
  notifier: DbNotifier,
  input: DeleteThreadGroupInput,
): ThreadGroupMutationResult | null {
  return db.transaction(
    (tx) => {
      const group = getThreadGroupById(tx, input.id);

      if (!group) {
        return null;
      }

      const memberIds = tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.groupId, group.id))
        .all()
        .map((member) => member.id);

      if (memberIds.length > 0) {
        tx.update(threads)
          .set({ groupId: null, updatedAt: Date.now() })
          .where(eq(threads.groupId, group.id))
          .run();
      }

      tx.delete(threadGroups).where(eq(threadGroups.id, group.id)).run();
      notifyGroupMembers(notifier, group.projectId, memberIds);

      return {
        id: group.id,
        projectId: group.projectId,
        name: group.name,
        updatedThreadCount: memberIds.length,
      };
    },
    { behavior: "immediate" },
  );
}
