const continuationsInFlight = new Set<string>();

export function isThreadContinuationInFlight(threadId: string): boolean {
  return continuationsInFlight.has(threadId);
}

export function acquireThreadContinuationAdmission(
  threadId: string,
): (() => void) | null {
  if (continuationsInFlight.has(threadId)) return null;
  continuationsInFlight.add(threadId);

  return () => continuationsInFlight.delete(threadId);
}
