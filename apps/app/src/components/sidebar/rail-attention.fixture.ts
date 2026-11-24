import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ThreadListEntry } from "@omnyo/domain";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import {
  makeThreadListEntry,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";

const countsSchema = z
  .object({
    failed: z.number().int().nonnegative(),
    needs: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    fresh: z.number().int().nonnegative(),
    unread: z.number().int().nonnegative(),
    hasRunningWork: z.boolean(),
  })
  .strict();

const fixtureThreadSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    parentThreadId: z.string().min(1).nullable(),
    status: z.enum([
      "pending",
      "idle",
      "starting",
      "active",
      "stopping",
      "error",
    ]),
    runtimeStatus: z.enum([
      "pending",
      "idle",
      "starting",
      "active",
      "stopping",
      "error",
      "provisioning",
      "waiting-for-host",
    ]),
    queuedWork: z.enum(["none", "waiting", "failed"]),
    hasPendingInteraction: z.boolean(),
    isUnread: z.boolean(),
    isHidden: z.boolean(),
    isArchived: z.boolean(),
    activity: z
      .object({
        workflows: z.number().int().nonnegative(),
        backgroundAgents: z.number().int().nonnegative(),
        backgroundCommands: z.number().int().nonnegative(),
        planMode: z.number().int().nonnegative(),
        goals: z.number().int().nonnegative(),
      })
      .strict(),
    workLabel: z.enum([
      "needs-you",
      "working",
      "blocked",
      "failed",
      "waiting",
      "open",
      "ready-to-archive",
    ]),
    indicator: z.string().min(1),
    note: z.string(),
  })
  .strict();

const railAttentionFixtureSchema = z
  .object({
    description: z.string(),
    projects: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          isPersonal: z.boolean(),
        })
        .strict(),
    ),
    threads: z.array(fixtureThreadSchema),
    expected: z
      .object({
        projects: z.record(z.string(), countsSchema),
        inbox: countsSchema,
      })
      .strict(),
  })
  .strict();

export type RailAttentionFixtureThread = z.infer<typeof fixtureThreadSchema>;

export const railAttentionFixture = railAttentionFixtureSchema.parse(
  JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "rail-attention.fixture.json",
      ),
      "utf8",
    ),
  ),
);

const READ_AT = 200;

export function toFixtureThreadListEntry(
  thread: RailAttentionFixtureThread,
): ThreadListEntry {
  return makeThreadListEntry({
    work: makeThreadWorkSummary({
      primary: {
        label: thread.workLabel,
        reason: { code: "fixture", text: thread.note },
      },
    }),
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    status: thread.status,
    runtime: { displayStatus: thread.runtimeStatus },
    queuedWork: thread.queuedWork,
    hasPendingInteraction: thread.hasPendingInteraction,
    visibility: thread.isHidden ? "hidden" : "visible",
    archivedAt: thread.isArchived ? READ_AT : null,
    lastReadAt: thread.isUnread ? READ_AT - 1 : READ_AT,
    latestAttentionAt: READ_AT,
    activity: {
      activeWorkflowCount: thread.activity.workflows,
      activeBackgroundAgentCount: thread.activity.backgroundAgents,
      activeBackgroundCommandCount: thread.activity.backgroundCommands,
      activePlanModeCount: thread.activity.planMode,
      activeGoalCount: thread.activity.goals,
      activeSubagentCount: 0,
    },
  });
}

export const railAttentionFixtureThreads: readonly ThreadListEntry[] =
  railAttentionFixture.threads.map(toFixtureThreadListEntry);

export function railAttentionFixtureCatalog(): SidebarBootstrapResponse {
  const toProject = (project: (typeof railAttentionFixture.projects)[number]) =>
    makeProjectWithThreadsResponse({
      id: project.id,
      name: project.name,
      kind: project.isPersonal ? "personal" : "standard",
      threads: railAttentionFixtureThreads.filter(
        (thread) => thread.projectId === project.id,
      ),
    });

  const personal = railAttentionFixture.projects.find(
    (project) => project.isPersonal,
  );

  if (personal === undefined) {
    throw new Error("The rail attention fixture needs a personal project.");
  }

  return makeSidebarBootstrapResponse({
    projects: railAttentionFixture.projects
      .filter((project) => !project.isPersonal)
      .map(toProject),
    personalProject: toProject(personal),
  });
}
