import type { TimelineTurnActivity } from "@omnyo/server-contract";
import { assertNever } from "./assert-never.js";
import type { EventProjectionMessage } from "./event-projection-types.js";
import { relativizeWorkspacePath } from "./workspace-path.js";

function hasFailedStatus(message: EventProjectionMessage): boolean {
  if (message.kind === "error") return true;

  return "status" in message && message.status === "error";
}

export function summarizeTurnActivity(
  messages: readonly EventProjectionMessage[],
  workspaceRoot: string | null,
): TimelineTurnActivity {
  const files = new Set<string>();

  const addFile = (path: string) => {
    files.add(
      relativizeWorkspacePath(path, workspaceRoot).replace(/^\.\//u, ""),
    );
  };

  const activity: TimelineTurnActivity = {
    commands: 0,
    files: 0,
    searches: 0,
    tools: 0,
    warnings: 0,
    failures: 0,
  };

  for (const message of messages) {
    if (hasFailedStatus(message)) activity.failures += 1;

    switch (message.kind) {
      case "command": {
        const exploration = message.parsedIntents.filter(
          (intent) => intent.type === "read" || intent.type === "search",
        );

        if (exploration.length === 0) activity.commands += 1;

        for (const intent of exploration) {
          if (intent.type === "read") {
            addFile(intent.path ?? intent.name);
          } else {
            activity.searches += 1;
          }
        }

        break;
      }

      case "file-read":
        addFile(message.path);
        break;
      case "file-edit":
        for (const change of message.changes) addFile(change.path);

        break;
      case "search":
      case "web-fetch":
        activity.searches += 1;
        break;
      case "web-search":
        activity.searches += Math.max(1, message.queries.length);
        break;
      case "tool-call":
      case "extension":
      case "delegation":
      case "workflow":
      case "image-generation":
      case "image-view":
        activity.tools += 1;
        break;
      case "operation":
        if (message.opType === "warning" || message.opType === "deprecation") {
          activity.warnings += 1;
        }

        break;
      case "user":
      case "assistant-text":
      case "plan-steps":
      case "permission-grant-lifecycle":
      case "user-question-lifecycle":
      case "plugin-form-lifecycle":
      case "error":
        break;
      default:
        assertNever(message);
    }
  }

  activity.files = files.size;

  return activity;
}
