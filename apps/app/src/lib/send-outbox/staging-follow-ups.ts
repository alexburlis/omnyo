import type { PromptInput } from "@omnyo/domain";

export interface StagingFollowUp {
  submissionId: string;
  threadId: string;
  input: PromptInput[];
  createdAt: number;
}

const NO_STAGING_FOLLOW_UPS: readonly StagingFollowUp[] = [];

let stagingFollowUps: readonly StagingFollowUp[] = NO_STAGING_FOLLOW_UPS;

const listeners = new Set<() => void>();

function publish(next: readonly StagingFollowUp[]): void {
  stagingFollowUps = next.length === 0 ? NO_STAGING_FOLLOW_UPS : next;

  for (const listener of listeners) listener();
}

export function addStagingFollowUp(followUp: StagingFollowUp): void {
  publish([...stagingFollowUps, followUp]);
}

export function removeStagingFollowUp(submissionId: string): void {
  if (!stagingFollowUps.some((item) => item.submissionId === submissionId))
    return;
  publish(
    stagingFollowUps.filter((item) => item.submissionId !== submissionId),
  );
}

export function readStagingFollowUps(): readonly StagingFollowUp[] {
  return stagingFollowUps;
}

export function subscribeStagingFollowUps(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}
