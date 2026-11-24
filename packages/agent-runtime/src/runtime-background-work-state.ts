import type {
  ThreadEvent,
  ThreadEventBackgroundTaskItem,
  ThreadEventDelegationItem,
} from "@omnyo/domain";
import {
  backgroundTaskItemStatus,
  requireThreadEventScopeTurnId,
  threadScope,
} from "@omnyo/domain";

export interface RuntimeOpenBackgroundWork {
  itemIds: string[];
  threadId: string;
}

export type RuntimeStoppedBackgroundTaskEvent = Extract<
  ThreadEvent,
  { type: "item/backgroundTask/completed" }
>;

type OpenTask =
  | {
      kind: "backgroundTask";
      item: ThreadEventBackgroundTaskItem;
      providerThreadId: string;
    }
  | { kind: "turnOrDelegation" };

const OPEN_TURN_OR_DELEGATION: OpenTask = { kind: "turnOrDelegation" };

export class RuntimeBackgroundWorkState {
  private readonly openTasksByThreadId = new Map<
    string,
    Map<string, OpenTask>
  >();

  clear(): void {
    this.openTasksByThreadId.clear();
  }

  clearThread(threadId: string): RuntimeStoppedBackgroundTaskEvent[] {
    const openTasks = this.openTasksByThreadId.get(threadId);
    this.openTasksByThreadId.delete(threadId);

    return [...(openTasks?.values() ?? [])].flatMap((task) =>
      task.kind === "backgroundTask"
        ? [
            {
              type: "item/backgroundTask/completed" as const,
              threadId,
              providerThreadId: task.providerThreadId,
              scope: threadScope(),
              item: {
                ...task.item,
                status: backgroundTaskItemStatus("stopped"),
                taskStatus: "stopped" as const,
              },
            },
          ]
        : [],
    );
  }

  hasOpenWork(): boolean {
    return this.openTasksByThreadId.size > 0;
  }

  listOpenWork(): RuntimeOpenBackgroundWork[] {
    return [...this.openTasksByThreadId].map(([threadId, openTasks]) => ({
      threadId,
      itemIds: [...openTasks.keys()],
    }));
  }

  hasOpenThreadWork(threadId: string): boolean {
    return (this.openTasksByThreadId.get(threadId)?.size ?? 0) > 0;
  }

  observe(event: ThreadEvent): void {
    if (event.type === "turn/started" || event.type === "turn/completed") {
      if (event.type === "turn/started" && !event.parentToolCallId) {
        return;
      }

      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });

      this.setTask({
        openTask:
          event.type === "turn/started" ? OPEN_TURN_OR_DELEGATION : null,
        taskId: `turn:${turnId}`,
        threadId: event.threadId,
      });

      return;
    }

    if (event.type === "item/started" || event.type === "item/completed") {
      if (event.item.type === "backgroundTask") {
        this.observeBackgroundTask({
          item: event.item,
          providerThreadId: event.providerThreadId,
          threadId: event.threadId,
        });
      }

      if (event.item.type === "delegation") {
        this.observeDelegation(event, event.item);
      }

      return;
    }

    if (
      event.type === "item/backgroundTask/progress" ||
      event.type === "item/backgroundTask/completed"
    ) {
      this.observeBackgroundTask({
        item: event.item,
        providerThreadId: event.providerThreadId,
        threadId: event.threadId,
      });

      return;
    }

    if (
      event.type === "item/delegation/progress" ||
      event.type === "item/delegation/completed"
    ) {
      this.observeDelegation(event, event.item);
    }
  }

  private observeBackgroundTask(args: {
    item: ThreadEventBackgroundTaskItem;
    providerThreadId: string;
    threadId: string;
  }): void {
    this.setTask({
      openTask:
        args.item.status === "pending"
          ? {
              kind: "backgroundTask",
              item: args.item,
              providerThreadId: args.providerThreadId,
            }
          : null,
      taskId: `task:${args.item.id}`,
      threadId: args.threadId,
    });
  }

  private observeDelegation(
    event: Pick<ThreadEvent, "threadId">,
    item: ThreadEventDelegationItem,
  ): void {
    this.setTask({
      openTask: item.status === "pending" ? OPEN_TURN_OR_DELEGATION : null,
      taskId: `task:${item.id}`,
      threadId: event.threadId,
    });
  }

  private setTask(args: {
    openTask: OpenTask | null;
    taskId: string;
    threadId: string;
  }): void {
    const openTasks = this.openTasksByThreadId.get(args.threadId);

    if (args.openTask === null) {
      if (!openTasks) {
        return;
      }

      openTasks.delete(args.taskId);

      if (openTasks.size === 0) {
        this.openTasksByThreadId.delete(args.threadId);
      }

      return;
    }

    if (openTasks) {
      openTasks.set(args.taskId, args.openTask);

      return;
    }

    this.openTasksByThreadId.set(
      args.threadId,
      new Map([[args.taskId, args.openTask]]),
    );
  }
}
