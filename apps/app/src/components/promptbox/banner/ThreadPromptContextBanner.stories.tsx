import { useState, type ReactNode } from "react";
import {
  ThreadPromptContextBanner,
  type ThreadPromptArchivedSection,
  type ThreadPromptContextBannerExpandedSection,
  type ThreadPromptEnvironmentGoneSection,
  type ThreadPromptParentThreadSection,
  type ThreadPromptChildThreadsSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "promptbox/banner/Context Banner",
};

const noop = () => {};

type PromptStageSize = "desktop" | "mobile";

function PromptStage({
  children,
  size,
}: {
  children: ReactNode;
  size: PromptStageSize;
}) {
  return (
    <div
      data-promptbox-shell=""
      className={size === "desktop" ? "min-w-0 flex-1" : "w-[20rem] shrink-0"}
    >
      {children}
    </div>
  );
}

const parentThreadFixture: ThreadPromptParentThreadSection = {
  parentThreadTitle: "Parent thread",
  href: "/projects/proj-1/threads/thr_parent_demo",
  relationship: "parent",
};

const forkedFromFixture: ThreadPromptParentThreadSection = {
  parentThreadTitle: "Investigate flaky test",
  href: "/projects/proj-1/threads/thr_source_demo",
  relationship: "fork",
};

const childThreadsFixture: ThreadPromptChildThreadsSection = {
  items: [
    {
      id: "thr_a",
      title: "Investigate Safari auth flake on staging",
      href: "/projects/proj-1/threads/thr_a",
      hasPendingInteraction: false,
    },
    {
      id: "thr_b",
      title: "Review PR #4521 reviewer comments",
      href: "/projects/proj-1/threads/thr_b",
      hasPendingInteraction: false,
    },
    {
      id: "thr_c",
      title: "Refactor email pipeline retry logic",
      href: "/projects/proj-1/threads/thr_c",
      hasPendingInteraction: false,
    },
    {
      id: "thr_d",
      title: "Backfill workspace-status invalidation cache",
      href: "/projects/proj-1/threads/thr_d",
      hasPendingInteraction: false,
    },
  ],
};

const childThreadsPendingFixture: ThreadPromptChildThreadsSection = {
  items: [
    {
      id: "thr_blocked",
      title: "Install workspace tools",
      href: "/projects/proj-1/threads/thr_blocked",
      hasPendingInteraction: true,
    },
  ],
};

const childThreadsMixedFixture: ThreadPromptChildThreadsSection = {
  items: childThreadsFixture.items.map((item, index) =>
    index === 1 ? { ...item, hasPendingInteraction: true } : item,
  ),
};

const childThreadsLargeFixture: ThreadPromptChildThreadsSection = {
  items: Array.from({ length: 12 }, (_, i) => ({
    id: `thr_large_${i}`,
    title: `Child work item ${i + 1} that is busy doing thing-${i}`,
    href: `/projects/proj-1/threads/thr_large_${i}`,
    hasPendingInteraction: i === 1,
  })),
};

interface RowConfig {
  archived?: ThreadPromptArchivedSection | null;
  environmentGone?: ThreadPromptEnvironmentGoneSection | null;
  parentThread?: ThreadPromptParentThreadSection | null;
  childThreads?: ThreadPromptChildThreadsSection | null;
  initiallyExpandedSection?: ThreadPromptContextBannerExpandedSection | null;
}

function ContextBannerPreview({
  archived = null,
  environmentGone = null,
  parentThread = null,
  childThreads = null,
  initiallyExpandedSection = null,
  size,
}: RowConfig & { size: PromptStageSize }) {
  const [expandedSection, setExpandedSection] =
    useState<ThreadPromptContextBannerExpandedSection | null>(
      initiallyExpandedSection,
    );

  return (
    <PromptStage size={size}>
      <ThreadPromptContextBanner
        archivedSection={archived}
        environmentGoneSection={environmentGone}
        parentThreadSection={parentThread}
        continuedInSection={null}
        childThreadsSection={childThreads}
        expandedSection={expandedSection}
        onToggleSection={(next) =>
          setExpandedSection((previous) => (previous === next ? null : next))
        }
      />
    </PromptStage>
  );
}

function Row(props: RowConfig) {
  return (
    <div className="flex w-full min-w-0 items-start gap-3 overflow-x-auto">
      <ContextBannerPreview {...props} size="desktop" />
      <ContextBannerPreview {...props} size="mobile" />
    </div>
  );
}

const archivedFixture: ThreadPromptArchivedSection = {
  archivedAt: 1_731_456_000_000,
  onUnarchive: noop,
};

const destroyedEnvironmentFixture: ThreadPromptEnvironmentGoneSection = {
  status: "destroyed",
};

const restorableEnvironmentFixture: ThreadPromptEnvironmentGoneSection = {
  status: "destroyed",
  onRestore: noop,
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="archived thread"
        hint="archive icon + 'Thread is archived' with a filled unarchive action pinned to the far right"
      >
        <Row archived={archivedFixture} />
      </StoryRow>
      <StoryRow
        label="archived + child thread"
        hint="archived row plus parent context; action is hidden because archived is not the only segment"
      >
        <Row archived={archivedFixture} parentThread={parentThreadFixture} />
      </StoryRow>
      <StoryRow
        label="environment archived"
        hint="archived-environment row suppresses child threads"
      >
        <Row environmentGone={destroyedEnvironmentFixture} />
      </StoryRow>
      <StoryRow
        label="environment archived (restorable)"
        hint="the workspace can be rebuilt on its branch, so a filled restore action is pinned to the far right"
      >
        <Row environmentGone={restorableEnvironmentFixture} />
      </StoryRow>
      <StoryRow
        label="environment archived + child thread"
        hint="archived-environment row plus parent context"
      >
        <Row
          environmentGone={destroyedEnvironmentFixture}
          parentThread={parentThreadFixture}
        />
      </StoryRow>
      <StoryRow label="child thread (alone)" hint="inline parent link">
        <Row parentThread={parentThreadFixture} />
      </StoryRow>
      <StoryRow
        label="forked thread (alone)"
        hint={'renders "Forked from …" instead of "Child of …"'}
      >
        <Row parentThread={forkedFromFixture} />
      </StoryRow>
      <StoryRow
        label="parent thread with a child waiting for approval"
        hint="the parent banner names the blocked child and drops the active shimmer"
      >
        <Row childThreads={childThreadsPendingFixture} />
      </StoryRow>
      <StoryRow
        label="parent thread with active children (collapsed)"
        hint="the primary child mirrors other background-work banners without an animated flash; click to expand the child list"
      >
        <Row childThreads={childThreadsFixture} />
      </StoryRow>
      <StoryRow
        label="parent thread with active children (expanded)"
        hint="list of children with status + pending-approval marker on item 2"
      >
        <Row
          childThreads={childThreadsMixedFixture}
          initiallyExpandedSection="childThreads"
        />
      </StoryRow>
      <StoryRow
        label="parent thread with many children (scrollable)"
        hint="max-h-40 caps the list; rest scrolls"
      >
        <Row
          childThreads={childThreadsLargeFixture}
          initiallyExpandedSection="childThreads"
        />
      </StoryRow>
    </StoryCard>
  );
}

export const MachineRemovalHistory = () => (
  <StoryCard>
    <StoryRow label="Machine removed">
      <Row environmentGone={{ status: "removed" }} />
    </StoryRow>
    <StoryRow label="Removal in progress">
      <Row environmentGone={{ status: "removing" }} />
    </StoryRow>
    <StoryRow label="Cleanup failed">
      <Row environmentGone={{ status: "cleanup-failed" }} />
    </StoryRow>
  </StoryCard>
);
