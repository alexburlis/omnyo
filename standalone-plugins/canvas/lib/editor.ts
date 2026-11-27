import {
  nodeFieldsSchema,
  type CanvasNode,
  type Composition,
  type FlowGroup,
  type FlowItem,
  type FlowLeaf,
  type NodeFields,
  type NodeViews,
} from "../contract";
import type { NodeBinding, SourceState } from "../source-contract";

export interface NodeDraft {
  title: string;
  body: string;
  tone: CanvasNode["tone"];
  width: string;
  href: string;
  html: string;
  overview: string;
  viewEvidence: string;
  sources: string;
  bindingSource: string;
  bindingView: NodeBinding["view"];
  bindingX: string;
  bindingY: string;
  bindingFormat: NonNullable<NodeBinding["format"]>;
  bindingSources: string[];
  evidenceSources: string[];
}

const draftKeys = [
  "title",
  "body",
  "tone",
  "width",
  "href",
  "html",
  "overview",
  "viewEvidence",
  "sources",
  "bindingSource",
  "bindingView",
  "bindingX",
  "bindingY",
  "bindingFormat",
  "bindingSources",
  "evidenceSources",
] as const;

export function draftFor(node: CanvasNode): NodeDraft {
  return {
    title: node.title ?? "",
    body: node.body ?? "",
    tone: node.tone,
    width: node.width == null ? "" : String(node.width),
    href: node.href ?? "",
    html: node.html ?? "",
    overview: node.views?.overview ?? "",
    viewEvidence: node.views?.evidence ?? "",
    sources: node.views?.sources ?? "",
    bindingSource: node.binding?.sourceId ?? "",
    bindingView: node.binding?.view ?? "metric",
    bindingX: node.binding?.x ?? "",
    bindingY: node.binding?.y ?? "",
    bindingFormat: node.binding?.format ?? "number",
    bindingSources: [...(node.binding?.sources ?? [])],
    evidenceSources: [...(node.evidence?.sourceIds ?? [])],
  };
}

function equal(left: NodeDraft[keyof NodeDraft], right: NodeDraft[keyof NodeDraft]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function draftChanged(base: CanvasNode, draft: NodeDraft): boolean {
  const original = draftFor(base);

  return draftKeys.some((key) => !equal(original[key], draft[key]));
}

export function mergeDraft(base: CanvasNode, draft: NodeDraft, latest: CanvasNode): NodeDraft {
  const original = draftFor(base);
  const next = draftFor(latest);

  function retain<Key extends keyof NodeDraft>(key: Key) {
    next[key] = draft[key];
  }

  for (const key of draftKeys) if (!equal(original[key], draft[key])) retain(key);

  return next;
}

export function evidenceFor(
  ids: readonly string[],
  sources: readonly SourceState[],
  requireData = false,
) {
  const revisions: Record<string, number> = {};

  for (const id of ids) {
    const dataset = sources.find((entry) => entry.source.definition.id === id)?.dataset;

    if (!dataset && requireData)
      throw new Error(`Refresh ${id} before marking this evidence reviewed.`);

    if (dataset) revisions[id] = dataset.revision;
  }

  return { sourceIds: [...ids], revisions };
}

export function draftFields(
  base: CanvasNode,
  draft: NodeDraft,
  sources: readonly SourceState[],
): NodeFields {
  const initial = draftFor(base);
  const fields: NodeFields = {};

  if (draft.title !== initial.title) fields.title = draft.title;

  if (draft.body !== initial.body) fields.body = draft.body;

  if (draft.tone !== initial.tone) fields.tone = draft.tone;

  if (draft.width !== initial.width)
    fields.width = draft.width.trim() === "" ? null : Number(draft.width);

  if (draft.href !== initial.href) fields.href = draft.href;

  if (base.kind === "html") {
    if (draft.html !== initial.html) fields.html = draft.html;

    if (
      ["overview", "viewEvidence", "sources"].some((key) =>
        key === "overview"
          ? draft.overview !== initial.overview
          : key === "viewEvidence"
            ? draft.viewEvidence !== initial.viewEvidence
            : draft.sources !== initial.sources,
      )
    ) {
      const views: NodeViews = {};

      if (draft.overview) views.overview = draft.overview;

      if (draft.viewEvidence) views.evidence = draft.viewEvidence;

      if (draft.sources) views.sources = draft.sources;
      fields.views = Object.keys(views).length ? views : null;
    }
  }

  if (
    draft.bindingSource !== initial.bindingSource ||
    draft.bindingView !== initial.bindingView ||
    draft.bindingX !== initial.bindingX ||
    draft.bindingY !== initial.bindingY ||
    draft.bindingFormat !== initial.bindingFormat
  ) {
    if (draft.bindingSource) {
      const binding: NodeBinding = {
        sourceId: draft.bindingSource,
        view: draft.bindingView,
        format: draft.bindingFormat,
      };

      if (draft.bindingX) binding.x = draft.bindingX;

      if (draft.bindingY) binding.y = draft.bindingY;

      if (draft.bindingSources.length) binding.sources = draft.bindingSources;
      fields.binding = binding;
    } else fields.binding = null;
  }

  if (!equal(draft.evidenceSources, initial.evidenceSources))
    fields.evidence = draft.evidenceSources.length
      ? evidenceFor(draft.evidenceSources, sources)
      : null;

  return nodeFieldsSchema.parse(fields);
}

export interface FlowSelection {
  parent: FlowGroup;
  leaf: FlowLeaf;
  index: number;
  path: number[];
}

export function selectedFlow(
  item: FlowItem,
  id: string,
  path: number[] = [],
): FlowSelection | null {
  if ("node" in item) return null;

  for (let index = 0; index < item.children.length; index += 1) {
    const child = item.children[index];

    if (!child) continue;

    if ("node" in child && child.node === id) return { parent: item, leaf: child, index, path };
    const found = selectedFlow(child, id, [...path, index]);

    if (found) return found;
  }

  return null;
}

function withoutKey<Item extends FlowItem>(item: Item, key: "weight" | "span"): Item {
  const copy = { ...item };

  delete copy[key];

  return copy;
}

export function changeFlow(
  composition: Composition,
  id: string,
  fields: {
    flow: FlowGroup["flow"];
    gap: number;
    weight: number;
    span?: number;
    columns?: number;
  },
  direction = 0,
): Composition {
  const selection = selectedFlow(composition.root, id);

  if (!selection) throw new Error("This module is not in the flow composition.");
  const selectedIndex = selection.index;
  const selectedPath = selection.path;

  function update(item: FlowItem, path: readonly number[]): FlowItem {
    if ("node" in item) throw new Error("The flow changed. Review the latest layout.");

    if (path.length)
      return {
        ...item,
        children: item.children.map((child, index) =>
          index === path[0] ? update(child, path.slice(1)) : child,
        ),
      };

    const bento = fields.flow === "bento";

    const children = item.children.map((child) => {
      const base = withoutKey(child, bento ? "weight" : "span");

      if (!("node" in base) || base.node !== id) return base;

      return bento
        ? { ...base, span: fields.span ?? base.span ?? 1 }
        : { ...base, weight: fields.weight };
    });

    const nextIndex = selectedIndex + direction;

    const current = children[selectedIndex],
      neighbor = children[nextIndex];

    if (direction !== 0 && current && neighbor) {
      children[selectedIndex] = neighbor;
      children[nextIndex] = current;
    }

    const parent = { ...item, flow: fields.flow, gap: fields.gap, children };

    if (bento) parent.columns = fields.columns ?? item.columns ?? 3;
    else delete parent.columns;

    return parent;
  }

  const root = update(composition.root, selectedPath);

  if ("node" in root) throw new Error("The composition must retain a root group.");

  return { ...composition, root };
}
