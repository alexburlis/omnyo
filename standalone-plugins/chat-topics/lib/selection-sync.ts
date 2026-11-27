export function orderedSelection(
  selected: ReadonlySet<string> | null,
  order: readonly string[],
): string[] {
  if (selected === null) return [];
  const shown = order.filter((id) => selected.has(id));
  const listed = new Set(shown);

  return [...shown, ...[...selected].filter((id) => !listed.has(id))];
}

export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function adoptsHostClear(
  before: readonly string[],
  after: readonly string[],
  published: readonly string[],
): boolean {
  if (after.length > 0 || before.length === 0 || before.length !== published.length) return false;
  const mine = new Set(published);

  return before.every((id) => mine.has(id));
}
