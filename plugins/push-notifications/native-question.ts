interface NativeQuestionRecord {
  readonly id: string;
  readonly revision: number;
  readonly state: string;
  readonly createdAt: number;
  readonly question: { readonly mode: "optional" | "required" };
}

function outranks(
  candidate: NativeQuestionRecord,
  found: NativeQuestionRecord,
): boolean {
  if (candidate.id === found.id) return candidate.revision > found.revision;

  if (candidate.question.mode !== found.question.mode)
    return candidate.question.mode === "required";

  return candidate.createdAt > found.createdAt;
}

export function openNativeQuestion<Question extends NativeQuestionRecord>(
  questions: readonly Question[],
): Question | null {
  let found: Question | null = null;

  for (const question of questions) {
    if (question.state !== "open") continue;

    if (found === null || outranks(question, found)) found = question;
  }

  return found;
}
