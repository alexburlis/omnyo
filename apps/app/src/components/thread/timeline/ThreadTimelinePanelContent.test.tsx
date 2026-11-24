// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import type { TimelineRow } from "@omnyo/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRuntimeDisplayStatus } from "@omnyo/domain";
import type { TimelineWorkflowWorkRow } from "@omnyo/server-contract";
import { ThreadTimelinePanelContent } from "./ThreadTimelinePanelContent.js";
import type { UseThreadTimelineControllerResult } from "./useThreadTimelineController.js";

const mocks = vi.hoisted(() => ({
  activeBackgroundAgentCount: 0,
  displayStatus: "idle" as ThreadRuntimeDisplayStatus,
  threadStatus: "idle",
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({
    data: {
      activeBackgroundAgentCount: mocks.activeBackgroundAgentCount,
      runtime: { displayStatus: mocks.displayStatus },
      status: mocks.threadStatus,
    },
    error: null,
  }),
}));

vi.mock("./ThreadTimelineSurface.js", () => ({
  ThreadTimelineSurface: ({
    ongoingIndicatorLabel,
    showOngoingIndicator,
    leadingContent,
    timelineRows,
  }: {
    ongoingIndicatorLabel?: string;
    showOngoingIndicator: boolean;
    leadingContent?: ReactNode;
    timelineRows: TimelineRow[];
  }) => (
    <div>
      {leadingContent}
      {timelineRows.map((row) =>
        row.kind === "conversation" ? <div key={row.id}>{row.text}</div> : null,
      )}
      {showOngoingIndicator ? (
        <div>{ongoingIndicatorLabel ?? "Working..."}</div>
      ) : null}
    </div>
  ),
}));

vi.mock("./useThreadTimelineController.js", () => ({
  useThreadTimelineController: () => ({
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    contextBoundarySeq: null,
    contextWindowUsage: undefined,
    goal: null,
    providerCommands: null,
    sessionOptions: null,
    modelFallback: null,
    hasOlderTimelineRows: false,
    isCatchingUpTimeline: false,
    isLoadingOlderTimelineRows: false,
    loadOlderTimelineRows: vi.fn(),
    pendingTodos: null,
    timelineError: null,
    timelineLoading: false,
    isReadOnlyDisplay: false,
    timelineRows: [],
    threadNotFound: false,
  }),
}));

vi.mock("@/components/ui/conversation.js", () => ({
  ConversationTimeline: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

function workflowRow(): TimelineWorkflowWorkRow {
  return {
    id: "thr-test:workflow:task:wf-open",
    threadId: "thr-test",
    turnId: null,
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
    kind: "work",
    status: "pending",
    workKind: "workflow",
    itemId: "task:wf-open",
    taskType: "local_workflow",
    workflowName: "fixture-mini",
    description: "fixture workflow",
    model: null,
    taskStatus: "running",
    workflow: null,
    usage: null,
    summary: null,
    error: null,
    completedAt: null,
  };
}

function baseTimeline(
  overrides: Partial<UseThreadTimelineControllerResult> = {},
): UseThreadTimelineControllerResult {
  return {
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    contextWindowUsage: undefined,
    goal: null,
    providerCommands: null,
    sessionOptions: null,
    hasPagedHistory: false,
    hasOlderTimelineRows: false,
    isCatchingUpTimeline: false,
    isLoadingOlderTimelineRows: false,
    loadOlderTimelineRows: vi.fn(),
    pendingTodos: null,
    timelineError: null,
    timelineLoading: false,
    isReadOnlyDisplay: false,
    timelineRows: [],
    ...overrides,
    threadNotFound: overrides.threadNotFound ?? false,
    contextBoundarySeq: overrides.contextBoundarySeq ?? null,
    modelFallback: overrides.modelFallback ?? null,
  };
}

afterEach(() => {
  cleanup();
  mocks.activeBackgroundAgentCount = 0;
  mocks.displayStatus = "idle";
  mocks.threadStatus = "idle";
});

describe("ThreadTimelinePanelContent", () => {
  it("restores a conversation outside the latest page through bounded native history loading", async () => {
    const conversation = { pluginId: "canvas", itemId: "conversation:a" };

    const prompt = conversationRow({
      id: "old-prompt",
      role: "user",
      text: "Old region prompt",
      turnId: "turn-old",
    });

    if (prompt.role !== "user") throw new Error("User fixture expected");
    prompt.mentions = [
      {
        start: 0,
        end: 3,
        resource: { kind: "plugin", ...conversation, label: "Old" },
      },
    ];

    const answer = conversationRow({
      id: "old-answer",
      role: "assistant",
      text: "Old region answer",
      turnId: "turn-old",
    });

    const latest = conversationRow({
      id: "latest-prompt",
      role: "user",
      text: "Unrelated prompt",
      turnId: "turn-new",
    });

    const timeline = baseTimeline({
      timelineRows: [latest],
      hasOlderTimelineRows: true,
    });

    const load = vi.fn(async () => {
      timeline.timelineRows = [prompt, answer, latest];
      timeline.hasOlderTimelineRows = false;
    });

    timeline.loadOlderTimelineRows = load;
    render(
      <ThreadTimelinePanelContent
        threadId="thr-test"
        conversation={conversation}
        timeline={timeline}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Old region answer")).not.toBeNull(),
    );
    expect(screen.queryByText("Unrelated prompt")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stops missing-conversation discovery after twenty pages and exposes continuation", async () => {
    const load = vi.fn(async () => {});
    render(
      <ThreadTimelinePanelContent
        threadId="thr-test"
        conversation={{ pluginId: "canvas", itemId: "conversation:missing" }}
        timeline={baseTimeline({
          hasOlderTimelineRows: true,
          loadOlderTimelineRows: load,
        })}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Continue loading this conversation",
        }),
      ).not.toBeNull(),
    );
    expect(load).toHaveBeenCalledTimes(20);
  });

  it("reports failed history discovery without replaying reads", async () => {
    const load = vi.fn(async () => {
      throw new Error("unavailable");
    });

    render(
      <ThreadTimelinePanelContent
        threadId="thr-test"
        conversation={{ pluginId: "canvas", itemId: "conversation:missing" }}
        timeline={baseTimeline({
          hasOlderTimelineRows: true,
          loadOlderTimelineRows: load,
        })}
      />,
    );
    await waitFor(() => expect(screen.getByRole("alert")).not.toBeNull());
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("shows a background-only working indicator while runtime is idle", () => {
    render(
      <ThreadTimelinePanelContent
        threadId="thr-test"
        timeline={baseTimeline({ activeWorkflows: [workflowRow()] })}
      />,
    );

    expect(screen.getByText("Background work running")).not.toBeNull();
  });

  it("keeps the normal working label while runtime is active", () => {
    mocks.displayStatus = "active";

    render(
      <ThreadTimelinePanelContent
        threadId="thr-test"
        timeline={baseTimeline({ activeWorkflows: [workflowRow()] })}
      />,
    );

    expect(screen.queryByText("Background work running")).toBeNull();
    expect(screen.getByText("Working...")).not.toBeNull();
  });

  it("shows a background indicator for an idle Claude thread with only a nested agent active", () => {
    mocks.activeBackgroundAgentCount = 1;

    render(
      <ThreadTimelinePanelContent
        threadId="thr-claude-nested-agent"
        timeline={baseTimeline()}
      />,
    );

    expect(screen.getByText("Background work running")).not.toBeNull();
    expect(screen.queryByText("Working...")).toBeNull();
  });

  it("hides the background indicator when the nested agent count returns to zero", () => {
    mocks.activeBackgroundAgentCount = 1;

    const { rerender } = render(
      <ThreadTimelinePanelContent
        threadId="thr-claude-nested-agent"
        timeline={baseTimeline()}
      />,
    );

    expect(screen.getByText("Background work running")).not.toBeNull();

    mocks.activeBackgroundAgentCount = 0;
    rerender(
      <ThreadTimelinePanelContent
        threadId="thr-claude-nested-agent"
        timeline={baseTimeline()}
      />,
    );

    expect(screen.queryByText("Background work running")).toBeNull();
    expect(screen.queryByText("Working...")).toBeNull();
  });
});
