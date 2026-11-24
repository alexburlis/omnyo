import type {
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@omnyo/domain";
import { AnimatedDisclosureBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  PromptStackDisclosureChevron,
  useOwnerRevealedIds,
} from "@/components/promptbox/banner/prompt-stack-header";
import {
  activityIconClass,
  activityRowClass,
  activityTextClass,
} from "@omnyo/shared-ui/activity-row-styles";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { getStaggerItemProps } from "@omnyo/shared-ui/motion";
import { Progress } from "@omnyo/shared-ui/progress";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  useDisclosureFocusHandoff,
} from "@omnyo/shared-ui/prompt-stack-disclosure";
import { StatusBadge } from "@omnyo/shared-ui/status-row";

const STATUS_SORT_RANK: Record<ThreadTimelinePendingTodoItemStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

interface ThreadTodoCardProps {
  pendingTodos: ThreadTimelinePendingTodos | null;
  isExpanded: boolean;
  onToggle: () => void;
}

const BODY_ID = "thread-todo-card-body";

const TOGGLE_ID = "thread-todo-card-toggle";

const TODO_HEADER_BUTTON_CLASS = activityRowClass(
  "active",
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
);

const STATUS_TEXT_CLASS: Record<ThreadTimelinePendingTodoItemStatus, string> = {
  in_progress: "font-medium text-foreground",
  pending: "text-muted-foreground",
  completed: "text-subtle-foreground line-through decoration-border",
};

function getTodoSummary(items: readonly ThreadTimelinePendingTodoItem[]): {
  completed: number;
  total: number;
  visible: string;
  aria: string;
} {
  let completedCount = 0;

  for (const item of items) {
    if (item.status === "completed") completedCount += 1;
  }

  return {
    completed: completedCount,
    total: items.length,
    visible: `${completedCount} of ${items.length} done`,
    aria: `${completedCount} of ${items.length} ${
      items.length === 1 ? "item" : "items"
    } complete`,
  };
}

function TodoStatusIcon({
  status,
}: {
  status: ThreadTimelinePendingTodoItemStatus;
}) {
  switch (status) {
    case "in_progress":
      return (
        <span
          aria-hidden="true"
          className="flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-foreground"
        >
          <span className="size-1.5 rounded-full bg-foreground" />
        </span>
      );
    case "completed":
      return (
        <Icon
          name="CircleCheck"
          className="size-3.5 shrink-0 text-subtle-foreground"
          aria-hidden="true"
        />
      );
    case "pending":
      return (
        <Icon
          name="Circle"
          className="size-3.5 shrink-0 text-subtle-foreground"
          aria-hidden="true"
        />
      );
  }
}

function TodoBody({
  items,
  revealedIds,
}: {
  items: readonly ThreadTimelinePendingTodoItem[];
  revealedIds: ReadonlySet<string> | null;
}) {
  const ordered = [...items].sort(
    (a, b) => STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status],
  );

  return (
    <ul className="max-h-40 space-y-0.5 overflow-y-auto px-3 pb-2 pt-1.5">
      {ordered.map((item, index) => {
        const stagger = getStaggerItemProps(
          index,
          ordered.length,
          revealedIds?.has(item.id) ?? false,
        );

        return (
          <li
            key={item.id}
            className={cn(
              "flex min-h-6 min-w-0 items-center gap-2 text-xs",
              stagger.className,
            )}
            style={stagger.style}
          >
            <TodoStatusIcon status={item.status} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                STATUS_TEXT_CLASS[item.status],
              )}
              title={item.text}
            >
              {item.text}
            </span>
            {item.status === "in_progress" ? (
              <StatusBadge tone="active" className="h-4 px-1.5 text-2xs">
                In progress
              </StatusBadge>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ThreadTodoCard({
  pendingTodos,
  isExpanded,
  onToggle,
}: ThreadTodoCardProps) {
  const focus = useDisclosureFocusHandoff(isExpanded, onToggle);
  const items = pendingTodos?.items ?? [];

  const revealedIds = useOwnerRevealedIds(
    isExpanded,
    items.map((item) => item.id),
  );

  if (items.length === 0) {
    return null;
  }

  const summary = getTodoSummary(items);

  return (
    <PromptStackCard
      ariaLabel="To-do list"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={TOGGLE_ID}
          aria-expanded={isExpanded}
          aria-controls={BODY_ID}
          aria-label={`To-do list: ${summary.aria}`}
          ref={focus.triggerRef}
          onClick={focus.onTriggerClick}
          className={cn(
            TODO_HEADER_BUTTON_CLASS,
            PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
          )}
        >
          <Icon
            name="ListTodo"
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden="true"
          />
          <span
            className={activityTextClass(
              "active",
              "shrink-0 text-left font-medium",
            )}
          >
            To-dos
          </span>
          <span className="min-w-0 truncate text-left tabular-nums text-muted-foreground">
            {summary.visible}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2">
            <Progress
              aria-hidden="true"
              className="h-1 w-14"
              value={
                summary.total === 0
                  ? 0
                  : Math.round((summary.completed / summary.total) * 100)
              }
            />
            <PromptStackDisclosureChevron isExpanded={isExpanded} />
          </span>
        </button>
      </div>
      <AnimatedDisclosureBody
        id={BODY_ID}
        labelledBy={TOGGLE_ID}
        isExpanded={isExpanded}
        collapsedBorder="none"
        collapseLabel="Collapse to-do list"
        collapseRef={focus.collapseRef}
        onCollapse={focus.onCollapseClick}
      >
        <TodoBody items={items} revealedIds={revealedIds} />
      </AnimatedDisclosureBody>
    </PromptStackCard>
  );
}
