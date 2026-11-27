import type { Run } from "../contract";

const activeRunStates = {
  queued: true,
  preparing: true,
  investigating: true,
  verifying: true,
  publishing: true,
  "local-ready": false,
  "pr-open": false,
  "no-fix": false,
  "needs-evidence": false,
  failed: false,
  cancelled: false,
} satisfies Record<Run["state"], boolean>;

export function isActiveRun(state: Run["state"]): boolean {
  return activeRunStates[state];
}
