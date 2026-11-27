const ATTRIBUTE = {
  nodeId: "data-node-id",
  edgeId: "data-edge-id",
  rowKey: "data-row-key",
} as const;

export function findByData(
  root: HTMLElement | null,
  key: keyof typeof ATTRIBUTE,
  value: string,
): HTMLElement | null {
  if (root === null) return null;

  return (
    Array.from(root.querySelectorAll<HTMLElement>(`[${ATTRIBUTE[key]}]`)).find(
      (element) => element.dataset[key] === value,
    ) ?? null
  );
}
