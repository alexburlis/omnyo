type AfterCommitAction = () => void;

interface CollectedAfterCommit<TResult> {
  actions: AfterCommitAction[];
  result: TResult;
}

let collecting: AfterCommitAction[] | null = null;

export function afterCommit(action: AfterCommitAction): void {
  if (collecting === null) {
    action();

    return;
  }

  collecting.push(action);
}

export function collectAfterCommit<TResult>(
  work: () => TResult,
): CollectedAfterCommit<TResult> {
  if (collecting !== null) {
    throw new Error("After-commit actions are already being collected");
  }

  const actions: AfterCommitAction[] = [];
  collecting = actions;

  try {
    return { actions, result: work() };
  } finally {
    collecting = null;
  }
}
