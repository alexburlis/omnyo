export function getErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const seen = new Set<Error>();
  const messages: string[] = [];
  const pending: Error[] = [err];

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    if (current.message.length > 0) {
      messages.push(current.message);
    }

    const children: Error[] = [];

    if (current.cause instanceof Error) {
      children.push(current.cause);
    }

    if (current instanceof AggregateError) {
      children.push(
        ...current.errors.filter(
          (nested): nested is Error => nested instanceof Error,
        ),
      );
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }

  return messages.join(": ");
}
