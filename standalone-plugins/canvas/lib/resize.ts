import { bentoColumns, type Composition, type FlowItem } from "../contract";
import { defaultGap } from "./composition";

export function resizeFlow(
  composition: Composition,
  id: string,
  currentWidth: number,
  width: number,
  trackUnit?: number,
): Composition | null {
  let changed = false;

  function visit(item: FlowItem): FlowItem {
    if ("node" in item) return item;
    const children = item.children.map(visit);

    if (changed) return { ...item, children };

    function contains(entry: FlowItem): boolean {
      return "node" in entry ? entry.node === id : entry.children.some(contains);
    }

    const index = children.findIndex(contains);
    const bentoChild = children[index];

    if (item.flow === "bento" && bentoChild !== undefined && "node" in bentoChild && trackUnit) {
      const span = Math.max(
        1,
        Math.min(
          item.columns ?? bentoColumns,
          Math.round((width + (item.gap ?? defaultGap(item))) / trackUnit),
        ),
      );

      if (span === (bentoChild.span ?? 1)) return { ...item, children };
      changed = true;

      return {
        ...item,
        children: children.map((entry, at) => (at === index ? { ...entry, span } : entry)),
      };
    }

    if (item.flow === "row" && index >= 0 && children.length > 1) {
      const child = children[index];

      if (!child) return item;
      const previous = child.weight ?? 1;
      const total = children.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
      const available = (currentWidth * total) / previous;
      const desired = Math.min(available - 1, Math.max(1, width));

      const weight = Math.min(
        8,
        Math.max(0.25, (desired * (total - previous)) / (available - desired)),
      );

      changed = true;

      return {
        ...item,
        children: children.map((entry, at) => (at === index ? { ...entry, weight } : entry)),
      };
    }

    return { ...item, children };
  }

  const root = visit(composition.root);

  return changed && "flow" in root ? { ...composition, root } : null;
}
