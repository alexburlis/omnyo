import type {
  TimelineConversationTurnRequest,
  TimelineRow,
  TimelineRowStatus,
  TimelineUserConversationRow,
} from "@omnyo/server-contract";

export type MaintenanceRunState = "running" | "done" | "failed" | "stopped";

export interface MaintenanceRunOutcome {
  state: MaintenanceRunState;
  reason: string | null;
}

interface MaintenanceRunSignals {
  rowId: string;
  requestStatus: TimelineConversationTurnRequest["status"];
  compactionStatus: TimelineRowStatus | null;
  compactionDetail: string | null;
  errorReason: string | null;
  turnStatus: TimelineRowStatus | null;
  interrupted: boolean;
}

interface MaintenanceRunWalk {
  open: MaintenanceRunSignals | null;
  runs: MaintenanceRunSignals[];
  runsByTurnId: Map<string, MaintenanceRunSignals>;
}

export const NO_MAINTENANCE_RUN_OUTCOMES: ReadonlyMap<
  string,
  MaintenanceRunOutcome
> = new Map();

export function isMaintenanceRequestRow(
  row: TimelineRow,
): row is TimelineUserConversationRow {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.maintenance === "auto-compaction"
  );
}

function visitMaintenanceRunRows(
  walk: MaintenanceRunWalk,
  rows: readonly TimelineRow[],
): void {
  for (const row of rows) {
    if (row.kind === "conversation") {
      if (row.role !== "user") continue;

      if (row.maintenance !== "auto-compaction") {
        walk.open = null;
        continue;
      }

      const run: MaintenanceRunSignals = {
        rowId: row.id,
        requestStatus: row.turnRequest.status,
        compactionStatus: null,
        compactionDetail: null,
        errorReason: null,
        turnStatus: null,
        interrupted: false,
      };

      walk.runs.push(run);
      walk.open = run;

      if (row.turnId !== null) walk.runsByTurnId.set(row.turnId, run);

      continue;
    }

    const run =
      row.turnId === null ? null : (walk.runsByTurnId.get(row.turnId) ?? null);

    if (row.kind === "turn") {
      if (run !== null) run.turnStatus = row.status;

      if (row.children !== null) visitMaintenanceRunRows(walk, row.children);

      continue;
    }

    if (row.kind !== "system") continue;

    if (
      row.systemKind === "operation" &&
      row.operationKind === "thread-interrupted"
    ) {
      const interruptedRun = run ?? walk.open;

      if (interruptedRun !== null) interruptedRun.interrupted = true;

      continue;
    }

    if (run === null) continue;

    if (row.systemKind === "error") {
      run.errorReason = row.title;
      continue;
    }

    if (row.systemKind === "operation" && row.operationKind === "compaction") {
      run.compactionStatus = row.status;
      run.compactionDetail = row.detail;
    }
  }
}

function normalizeFailureReason(reason: string | null): string | null {
  if (reason === null) return null;

  const normalized = reason
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.\s]+$/u, "");

  return normalized.length === 0 ? null : normalized;
}

function resolveMaintenanceRunOutcome(
  run: MaintenanceRunSignals,
  isLatestActiveRun: boolean,
): MaintenanceRunOutcome {
  if (run.requestStatus === "rejected") {
    return { state: "failed", reason: null };
  }

  if (run.compactionStatus === "completed") {
    return { state: "done", reason: null };
  }

  if (
    run.interrupted ||
    run.compactionStatus === "interrupted" ||
    run.turnStatus === "interrupted"
  ) {
    return { state: "stopped", reason: null };
  }

  if (
    run.errorReason !== null ||
    run.compactionStatus === "error" ||
    run.turnStatus === "error"
  ) {
    return {
      state: "failed",
      reason:
        normalizeFailureReason(
          run.compactionStatus === "error" ? run.compactionDetail : null,
        ) ?? normalizeFailureReason(run.errorReason),
    };
  }

  if (
    run.compactionStatus === "pending" ||
    run.turnStatus === "pending" ||
    run.requestStatus === "pending" ||
    isLatestActiveRun
  ) {
    return { state: "running", reason: null };
  }

  return { state: "done", reason: null };
}

export function collectMaintenanceRunOutcomes(
  rows: readonly TimelineRow[],
  scopeActive: boolean,
): ReadonlyMap<string, MaintenanceRunOutcome> {
  if (!rows.some(isMaintenanceRequestRow)) return NO_MAINTENANCE_RUN_OUTCOMES;

  const walk: MaintenanceRunWalk = {
    open: null,
    runs: [],
    runsByTurnId: new Map(),
  };

  visitMaintenanceRunRows(walk, rows);

  const latestActiveRun = scopeActive ? walk.open : null;

  return new Map(
    walk.runs.map((run) => [
      run.rowId,
      resolveMaintenanceRunOutcome(run, run === latestActiveRun),
    ]),
  );
}

export function maintenanceRunOutcomeFallback(
  row: TimelineUserConversationRow,
): MaintenanceRunOutcome {
  return {
    state: row.turnRequest.status === "pending" ? "running" : "done",
    reason: null,
  };
}

export function maintenanceRunTitleText(
  outcome: MaintenanceRunOutcome,
): string {
  switch (outcome.state) {
    case "running":
      return "Compacting before the prompt cache expires";
    case "done":
      return "Compacted before the prompt cache expired";
    case "failed":
      return outcome.reason === null
        ? "Automatic compaction failed. Full history kept."
        : `Automatic compaction failed: ${outcome.reason}. Full history kept.`;
    case "stopped":
      return "Automatic compaction stopped. Full history kept.";
  }
}
