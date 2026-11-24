import type { ThreadStatus } from "@omnyo/domain";

type PreStartThreadStatus = Extract<ThreadStatus, "starting">;

export function isPreStartThreadStatus(
  status: ThreadStatus,
): status is PreStartThreadStatus {
  return status === "starting";
}
