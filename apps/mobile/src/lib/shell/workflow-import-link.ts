export function workflowShareId(url: string): string | null {
  if (url.length > 256) return null;

  const match = /^omnyo:\/\/workflows\/import\/([a-f0-9]{32})$/.exec(url);

  return match?.[1] ?? null;
}

export function isWorkflowImportLink(url: string): boolean {
  return (
    url.startsWith("omnyo://workflows/import/") ||
    url === "omnyo://workflows/import"
  );
}
