import {
  getThreadListIndicatorLabel,
  type ThreadListIndicatorKind,
} from "@omnyo/client-core";

export function threadIndicatorLabel(
  kind: ThreadListIndicatorKind,
): string | null {
  return kind === "open" ? "Done" : getThreadListIndicatorLabel(kind);
}
