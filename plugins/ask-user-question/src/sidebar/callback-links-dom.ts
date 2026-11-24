import {
  traceLinks,
  type LinkEdge,
  type LinkGraph,
  type LinkTrace,
} from "./callback-links";

export type LinkNodeInfo = {
  title: string;
  projectName: string | null;
};

export type LinkData = {
  graph: LinkGraph;
  info: ReadonlyMap<string, LinkNodeInfo>;
};

const STYLE_ID = "needs-you-callback-links";

const ROW = ".omnyo-sidebar-hover-actions-row";

const ANCHOR = "a[data-sidebar-thread-id]";

const SCROLL_ROOT = '[data-sidebar="content"]';

const PROJECT = "[data-sidebar-project-id]";

const PLACEHOLDER = "[data-sidebar-windowed-nav]";

const STICKY =
  '[data-sidebar-sticky-tier="label"], [data-sidebar-sticky-tier="project"]';

const ATTR_GROUP = "data-needs-you-link";

const ATTR_ROLE = "data-needs-you-link-role";

const ATTR_RELATED = "data-needs-you-link-related";

const ATTR_FOCUS = "data-needs-you-link-focus";

const SVG_NS = "http://www.w3.org/2000/svg";

const LANE_X = 4;

const LANE_GAP = -3;

const MAX_LANES = 2;

const CARD_WIDTH = 288;

const OBSERVER_INIT: MutationObserverInit = { childList: true, subtree: true };

const STATE_LABEL: Record<LinkEdge["sourceState"], string> = {
  working: "working",
  waiting: "queued",
  idle: "idle without callback",
  "needs-input": "needs your input",
  error: "failed",
  archived: "archived",
  unavailable: "unavailable",
  unverified: "unverified",
};

const color = (index: number) => `var(--needs-you-link-${index})`;

export const LINKS_CSS = `
:root {
  --needs-you-link-0: var(--timeline-accent);
  --needs-you-link-1: var(--pr-merged);
  --needs-you-link-2: var(--diff-added);
  --needs-you-link-3: var(--warning);
  --needs-you-link-4: color-mix(in oklch, var(--pr-merged) 55%, var(--destructive-text));
  --needs-you-link-5: color-mix(in oklch, var(--timeline-accent) 50%, var(--diff-added));
}
${[0, 1, 2, 3, 4, 5]
  .map(
    (index) =>
      `${ROW}:has(${ANCHOR}[${ATTR_GROUP}="${index}"]) { --needs-you-link-color: ${color(index)}; }`,
  )
  .join("\n")}

${ROW} {
  transition: opacity var(--motion-duration-fast, 150ms) var(--motion-ease-standard, cubic-bezier(0.25, 0.1, 0.25, 1));
}
html[${ATTR_FOCUS}] ${ROW}:not(:has(${ANCHOR}[${ATTR_RELATED}])) {
  opacity: 0.6;
}
html[${ATTR_FOCUS}] ${ROW}:has(${ANCHOR}[${ATTR_RELATED}]) {
  background-image: linear-gradient(
    color-mix(in oklab, var(--needs-you-link-color) 12%, transparent),
    color-mix(in oklab, var(--needs-you-link-color) 12%, transparent)
  );
}
html[${ATTR_FOCUS}] ${ROW}:has(${ANCHOR}[${ATTR_RELATED}="self"]) {
  background-image: linear-gradient(
    color-mix(in oklab, var(--needs-you-link-color) 20%, transparent),
    color-mix(in oklab, var(--needs-you-link-color) 20%, transparent)
  );
}

.needs-you-links-layer {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 40;
  overflow: visible;
}
.needs-you-links-layer .lane { stroke-width: 1.5; opacity: 0.7; fill: none; }
.needs-you-links-layer .dot { stroke-width: 1.5; }
.needs-you-links-layer .dot.waiting { fill: var(--sidebar); }
.needs-you-links-layer[data-focus] .muted { opacity: 0.15; }
.needs-you-links-layer .arc { fill: none; stroke-width: 1.75; stroke-linecap: round; }
.needs-you-links-layer .arc.live { stroke-dasharray: 4 3; animation: needs-you-link-flow 0.8s linear infinite; }
.needs-you-links-layer .arc.blocked { stroke-dasharray: 1.5 3; opacity: 0.75; }
@keyframes needs-you-link-flow { to { stroke-dashoffset: -7; } }
@media (prefers-reduced-motion: reduce) {
  ${ROW} { transition: none; }
  .needs-you-links-layer .arc.live { animation: none; stroke-dasharray: none; }
}

.needs-you-link-card {
  position: fixed;
  z-index: 41;
  width: ${CARD_WIDTH}px;
  pointer-events: none;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) + 2px);
  background: var(--popover);
  color: var(--popover-foreground);
  box-shadow: var(--shadow-md);
  font-size: 12px;
  line-height: 1.35;
}
.needs-you-link-card .head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.needs-you-link-card .swatch {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: none;
  background: var(--needs-you-link-color);
}
.needs-you-link-card .section {
  margin-top: 8px;
  color: var(--muted-foreground);
  font-size: 11px;
}
.needs-you-link-card .item {
  position: relative;
  margin-top: 4px;
  padding-left: 14px;
}
.needs-you-link-card .item::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 4px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  border: 1.5px solid var(--needs-you-link-color);
  box-sizing: border-box;
}
.needs-you-link-card .item.owes::before { background: var(--needs-you-link-color); }
.needs-you-link-card .title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.needs-you-link-card .meta {
  display: block;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.needs-you-link-card .state.blocked { color: var(--destructive-text); }
`;

type Placement = "visible" | "above" | "below" | "hidden";

type NodePoint = {
  x: number;
  y: number;
  placement: Placement;
};

type Viewport = {
  root: Element;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

let warned = false;

function warn(cause: unknown): void {
  if (warned) return;
  warned = true;
  console.warn("[needs-you] callback links stopped after an error:", cause);
}

function svg<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);

  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));

  return element;
}

function setAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);

    return;
  }

  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function idOf(anchor: Element): string | null {
  return anchor.getAttribute("data-sidebar-thread-id");
}

function rowOf(anchor: Element): Element {
  return anchor.closest(ROW) ?? anchor;
}

export class CallbackLinksDecorator {
  private data: LinkData | null = null;
  private hovered: string | null = null;
  private roots: Element[] = [];
  private rowObserver: MutationObserver | null = null;
  private shellObserver: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private layer: SVGSVGElement | null = null;
  private card: HTMLDivElement | null = null;
  private frame = 0;
  private pointer: {
    x: number;
    y: number;
  } | null = null;
  private full = false;
  private stopped = false;
  private failed = false;
  private readonly onScroll = () => {
    if (this.pointer !== null)
      this.hover(
        this.memberAt(
          document.elementFromPoint(this.pointer.x, this.pointer.y),
        ),
      );
    this.schedule(false);
  };
  private readonly onPointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    this.pointer = { x: event.clientX, y: event.clientY };
    this.hover(this.memberAt(event.target));
  };
  private readonly onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget !== null) return;
    this.pointer = null;
    this.hover(null);
  };
  private readonly onFocusIn = (event: FocusEvent) => {
    this.pointer = null;
    this.hover(this.memberAt(event.target));
  };
  start(): void {
    try {
      this.injectStyle();
      this.rowObserver = new MutationObserver(() => this.schedule(true));
      this.shellObserver = new MutationObserver(() => {
        if (
          this.roots.length > 0 &&
          this.roots.every((root) => root.isConnected)
        )
          return;
        this.schedule(true);
      });
      this.shellObserver.observe(document.body, OBSERVER_INIT);
      this.resizeObserver = new ResizeObserver(() => this.schedule(false));
      document.addEventListener("pointerover", this.onPointerOver, true);
      document.addEventListener("pointerout", this.onPointerOut, true);
      document.addEventListener("focusin", this.onFocusIn, true);
      window.addEventListener("resize", this.onScroll);
      this.schedule(true);
    } catch (cause) {
      this.fail(cause);
    }
  }
  setData(data: LinkData | null): void {
    this.data = data;
    this.schedule(true);
  }
  stop(): void {
    this.stopped = true;

    try {
      this.teardown();
    } catch (cause) {
      warn(cause);
    }
  }
  private teardown(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.rowObserver?.disconnect();
    this.shellObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.rowObserver = null;
    this.shellObserver = null;
    this.resizeObserver = null;

    for (const root of this.roots)
      root.removeEventListener("scroll", this.onScroll);
    this.roots = [];
    document.removeEventListener("pointerover", this.onPointerOver, true);
    document.removeEventListener("pointerout", this.onPointerOut, true);
    document.removeEventListener("focusin", this.onFocusIn, true);
    window.removeEventListener("resize", this.onScroll);
    this.clearMarks();
    this.layer?.remove();
    this.card?.remove();
    this.layer = null;
    this.card = null;
    document.getElementById(STYLE_ID)?.remove();
  }
  private fail(cause: unknown): void {
    this.failed = true;
    warn(cause);

    try {
      this.teardown();
    } catch {}
  }
  private hover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.schedule(true);
  }
  private memberAt(target: EventTarget | null): string | null {
    if (!(target instanceof Element) || this.data === null) return null;
    const row = target.closest(ROW);

    if (row === null || !this.roots.some((root) => root.contains(row)))
      return null;
    const anchor = row.querySelector(ANCHOR);
    const id = anchor === null ? null : idOf(anchor);

    return id !== null && this.data.graph.groupOf.has(id) ? id : null;
  }
  private schedule(full: boolean): void {
    if (this.stopped || this.failed) return;
    this.full ||= full;

    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const repaint = this.full;
      this.full = false;

      if (this.stopped || this.failed) return;

      try {
        this.sync(repaint);
      } catch (cause) {
        this.fail(cause);
      }
    });
  }
  private injectStyle(): void {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = LINKS_CSS;
    document.head.appendChild(style);
  }
  private reobserve(): void {
    const roots = Array.from(document.querySelectorAll(SCROLL_ROOT));

    if (
      roots.length === this.roots.length &&
      roots.every((root, i) => root === this.roots[i])
    )
      return;

    for (const root of this.roots)
      root.removeEventListener("scroll", this.onScroll);
    this.rowObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.roots = roots;

    for (const root of roots) {
      this.rowObserver?.observe(root, OBSERVER_INIT);
      this.resizeObserver?.observe(root);
      root.addEventListener("scroll", this.onScroll, { passive: true });
    }
  }
  private clearMarks(): void {
    for (const element of Array.from(
      document.querySelectorAll(`[${ATTR_GROUP}], [${ATTR_RELATED}]`),
    )) {
      element.removeAttribute(ATTR_GROUP);
      element.removeAttribute(ATTR_ROLE);
      element.removeAttribute(ATTR_RELATED);
    }

    setAttribute(document.documentElement, ATTR_FOCUS, null);
  }
  private sync(repaint: boolean): void {
    this.reobserve();
    const data = this.data;

    if (
      data === null ||
      data.graph.groups.length === 0 ||
      this.roots.length === 0
    ) {
      this.clearMarks();
      this.hideLayer();
      this.hideCard();

      return;
    }

    let trace: LinkTrace | null = null;
    let hoveredAnchor: Element | null = null;

    if (this.hovered !== null) {
      hoveredAnchor = this.findAnchor(this.hovered);
      trace =
        hoveredAnchor === null ? null : traceLinks(data.graph, this.hovered);
    }

    if (repaint) this.paintMarks(data.graph, trace);
    this.draw(data, trace, hoveredAnchor);
  }
  private findAnchor(id: string): Element | null {
    for (const root of this.roots) {
      const anchor = root.querySelector(
        `${ANCHOR}[data-sidebar-thread-id="${CSS.escape(id)}"]`,
      );

      if (anchor !== null) return anchor;
    }

    return null;
  }
  private paintMarks(graph: LinkGraph, trace: LinkTrace | null): void {
    for (const root of this.roots) {
      for (const anchor of Array.from(root.querySelectorAll(ANCHOR))) {
        const id = idOf(anchor);
        const group = id === null ? undefined : graph.groupOf.get(id);
        setAttribute(
          anchor,
          ATTR_GROUP,
          group === undefined ? null : String(group.color),
        );
        setAttribute(
          anchor,
          ATTR_ROLE,
          group === undefined || id === null
            ? null
            : (group.members.get(id) ?? null),
        );

        const related =
          id === null || trace === null ? undefined : trace.nodes.get(id);

        setAttribute(
          anchor,
          ATTR_RELATED,
          related === undefined ? null : related.relation,
        );
      }
    }

    setAttribute(
      document.documentElement,
      ATTR_FOCUS,
      trace === null ? null : "",
    );
  }
  private viewport(root: Element): Viewport {
    const bounds = root.getBoundingClientRect();
    let top = Math.max(0, bounds.top + root.clientTop);

    const bottom = Math.min(
      window.innerHeight,
      bounds.top + root.clientTop + root.clientHeight,
    );

    for (const header of Array.from(root.querySelectorAll(STICKY))) {
      const rect = header.getBoundingClientRect();

      if (rect.height === 0 || getComputedStyle(header).position !== "sticky")
        continue;

      if (rect.top <= top + 1 && rect.bottom > top)
        top = Math.max(top, rect.bottom);
    }

    return { root, left: bounds.left, right: bounds.right, top, bottom };
  }
  private ensureLayer(): SVGSVGElement {
    if (this.layer?.isConnected) return this.layer;

    const layer = svg("svg", {
      class: "needs-you-links-layer",
      "aria-hidden": "true",
    });

    document.body.appendChild(layer);
    this.layer = layer;

    return layer;
  }
  private hideLayer(): void {
    if (this.layer !== null) this.layer.replaceChildren();
  }
  private hideCard(): void {
    if (this.card !== null) this.card.hidden = true;
  }
  private draw(
    data: LinkData,
    trace: LinkTrace | null,
    hoveredAnchor: Element | null,
  ): void {
    const layer = this.ensureLayer();
    const content: SVGElement[] = [];
    const defs = svg("defs", {});
    content.push(defs);
    const points = new Map<string, NodePoint>();
    let focusViewport: Viewport | null = null;

    for (const [rootIndex, root] of this.roots.entries()) {
      const view = this.viewport(root);

      if (view.bottom <= view.top || view.right <= view.left) continue;

      if (hoveredAnchor !== null && root.contains(hoveredAnchor))
        focusViewport = view;
      const clipId = `needs-you-links-clip-${rootIndex}`;
      const clip = svg("clipPath", { id: clipId });
      clip.appendChild(
        svg("rect", {
          x: view.left,
          y: view.top,
          width: view.right - view.left,
          height: view.bottom - view.top,
        }),
      );
      defs.appendChild(clip);
      const scene = svg("g", { "clip-path": `url(#${clipId})` });
      this.drawLanes(data.graph, view, trace, scene, points);
      content.push(scene);
    }

    if (trace !== null && focusViewport !== null) {
      this.locateHidden(trace, focusViewport, points);
      content.push(this.drawTrace(data.graph, trace, focusViewport, points));
    }

    setAttribute(layer, "data-focus", trace === null ? null : "");
    layer.replaceChildren(...content);

    if (trace !== null && hoveredAnchor !== null && focusViewport !== null)
      this.showCard(data, trace, rowOf(hoveredAnchor), focusViewport, points);
    else this.hideCard();
  }
  private drawLanes(
    graph: LinkGraph,
    view: Viewport,
    trace: LinkTrace | null,
    scene: SVGGElement,
    points: Map<string, NodePoint>,
  ): void {
    type Member = {
      id: string;
      y: number;
      role: string;
    };

    const containers = new Map<Element, Map<number, Member[]>>();

    for (const anchor of Array.from(
      view.root.querySelectorAll(`${ANCHOR}[${ATTR_GROUP}]`),
    )) {
      const id = idOf(anchor);
      const group = id === null ? undefined : graph.groupOf.get(id);

      if (id === null || group === undefined) continue;
      const rect = rowOf(anchor).getBoundingClientRect();

      if (rect.height === 0) continue;
      const container = anchor.closest(PROJECT) ?? view.root;
      const groups = containers.get(container) ?? new Map<number, Member[]>();
      const members = groups.get(group.color) ?? [];
      members.push({
        id,
        y: rect.top + rect.height / 2,
        role: group.members.get(id) ?? "source",
      });
      groups.set(group.color, members);
      containers.set(container, groups);
    }

    const focusColor =
      trace === null || this.hovered === null
        ? null
        : (graph.groupOf.get(this.hovered)?.color ?? null);

    for (const groups of containers.values()) {
      const spans = [...groups.entries()]
        .map(([colorIndex, members]) => ({
          colorIndex,
          members,
          top: Math.min(...members.map((member) => member.y)),
          bottom: Math.max(...members.map((member) => member.y)),
        }))
        .sort((a, b) => a.top - b.top);

      const laneEnds: number[] = [];

      for (const span of spans) {
        let lane = laneEnds.findIndex((end) => end < span.top - 4);

        if (lane === -1)
          lane = laneEnds.length < MAX_LANES ? laneEnds.length : MAX_LANES - 1;
        laneEnds[lane] = Math.max(laneEnds[lane] ?? -Infinity, span.bottom);
        const x = view.left + LANE_X + lane * LANE_GAP;
        const stroke = color(span.colorIndex);

        const muted =
          focusColor !== null && focusColor !== span.colorIndex ? " muted" : "";

        if (span.members.length > 1)
          scene.appendChild(
            svg("line", {
              class: `lane${muted}`,
              x1: x,
              x2: x,
              y1: span.top,
              y2: span.bottom,
              style: `stroke: ${stroke}`,
            }),
          );

        for (const member of span.members) {
          const related = trace?.nodes.has(member.id) ?? false;
          const visible = member.y >= view.top && member.y <= view.bottom;
          points.set(member.id, {
            x,
            y: member.y,
            placement: visible
              ? "visible"
              : member.y < view.top
                ? "above"
                : "below",
          });
          scene.appendChild(
            svg("circle", {
              class: `dot ${member.role === "waiting" ? "waiting" : "owes"}${related ? "" : muted}`,
              cx: x,
              cy: member.y,
              r: related ? 3.5 : 3,
              style: `stroke: ${stroke}; ${member.role === "waiting" ? "" : `fill: ${stroke}`}`,
            }),
          );
        }
      }
    }
  }
  private locateHidden(
    trace: LinkTrace,
    view: Viewport,
    points: Map<string, NodePoint>,
  ): void {
    for (const id of trace.nodes.keys()) {
      if (points.has(id)) continue;
      let placement: Placement = "hidden";
      let y = 0;

      for (const placeholder of Array.from(
        view.root.querySelectorAll(PLACEHOLDER),
      )) {
        const entries = (
          placeholder.getAttribute("data-sidebar-windowed-nav") ?? ""
        )
          .split(/\s+/u)
          .map((pair) => pair.split(":")[0]);

        if (!entries.includes(id)) continue;
        const rect = placeholder.getBoundingClientRect();
        y = rect.top + rect.height / 2;
        placement =
          rect.bottom < view.top
            ? "above"
            : rect.top > view.bottom
              ? "below"
              : "visible";
        break;
      }

      points.set(id, { x: view.left + LANE_X, y, placement });
    }
  }
  private drawTrace(
    graph: LinkGraph,
    trace: LinkTrace,
    view: Viewport,
    points: Map<string, NodePoint>,
  ): SVGGElement {
    const scene = svg("g", {});

    const group =
      this.hovered === null ? undefined : graph.groupOf.get(this.hovered);

    const stroke = color(group?.color ?? 0);

    const clamp = (point: NodePoint) =>
      point.placement === "above"
        ? view.top + 6
        : point.placement === "below"
          ? view.bottom - 6
          : point.y;

    for (const [index, edge] of trace.edges.entries()) {
      const from = points.get(edge.source);
      const to = points.get(edge.consumer);

      if (from === undefined || to === undefined) continue;

      if (from.placement === "hidden" || to.placement === "hidden") continue;

      if (from.placement !== "visible" && from.placement === to.placement)
        continue;
      const y1 = clamp(from);
      const y2 = clamp(to);

      const bend = Math.max(
        view.left - 12,
        Math.min(from.x, to.x) -
          5 -
          Math.min(10, Math.abs(y2 - y1) / 30) -
          (index % 2) * 2,
      );

      const tip = to.x - 3.5;
      scene.appendChild(
        svg("path", {
          class: `arc ${edge.blocked ? "blocked" : "live"}`,
          d: `M ${from.x - 3.5} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${tip} ${y2}`,
          style: `stroke: ${stroke}`,
        }),
      );

      if (to.placement === "visible")
        scene.appendChild(
          svg("path", {
            d: `M ${tip} ${y2} l -4 -3 l 0 6 z`,
            style: `fill: ${stroke}`,
          }),
        );

      for (const point of [from, to]) {
        if (point.placement === "visible") continue;
        const y = clamp(point);
        const direction = point.placement === "above" ? -1 : 1;
        scene.appendChild(
          svg("path", {
            d: `M ${point.x - 4} ${y - 2 * direction} l 4 ${4 * direction} l 4 ${-4 * direction}`,
            style: `stroke: ${stroke}; fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round`,
          }),
        );
      }
    }

    return scene;
  }
  private ensureCard(): HTMLDivElement {
    if (this.card?.isConnected) return this.card;
    const card = document.createElement("div");
    card.className = "needs-you-link-card";
    card.setAttribute("aria-hidden", "true");
    card.hidden = true;
    document.body.appendChild(card);
    this.card = card;

    return card;
  }
  private showCard(
    data: LinkData,
    trace: LinkTrace,
    row: Element,
    view: Viewport,
    points: Map<string, NodePoint>,
  ): void {
    const card = this.ensureCard();

    if (view.right + 8 + CARD_WIDTH > window.innerWidth) {
      card.hidden = true;

      return;
    }

    const hovered = this.hovered ?? "";
    const group = data.graph.groupOf.get(hovered);
    card.style.setProperty("--needs-you-link-color", color(group?.color ?? 0));
    const own = data.info.get(hovered);
    const children: HTMLElement[] = [];

    const element = (className: string, text: string) => {
      const node = document.createElement("span");
      node.className = className;
      node.textContent = text;

      return node;
    };

    const head = document.createElement("div");
    head.className = "head";
    head.append(element("swatch", ""), element("", "Callback chain"));
    children.push(head);

    const where = (id: string) => {
      const point = points.get(id);

      const place =
        point?.placement === "above"
          ? "↑ scrolled above"
          : point?.placement === "below"
            ? "↓ scrolled below"
            : point?.placement === "hidden"
              ? "in a collapsed list"
              : null;

      const project = data.info.get(id)?.projectName ?? null;

      const otherProject =
        project !== null && project !== (own?.projectName ?? null)
          ? project
          : null;

      return [otherProject, place].filter((part) => part !== null).join(" · ");
    };

    const item = (
      id: string,
      depth: number,
      owes: boolean,
      state: string | null,
      edge: LinkEdge,
    ) => {
      const node = document.createElement("div");
      node.className = `item${owes ? " owes" : ""}`;
      node.style.marginLeft = `${(depth - 1) * 10}px`;
      const title = element("title", data.info.get(id)?.title ?? id);
      node.appendChild(title);
      const meta = document.createElement("span");
      meta.className = "meta";

      if (state !== null)
        meta.appendChild(
          element(`state${edge.blocked ? " blocked" : ""}`, state),
        );
      const location = where(id);

      const tail = [location, edge.reason]
        .filter((part) => part !== "")
        .join(" · ");

      if (tail !== "") meta.append(`${state === null ? "" : " · "}${tail}`);
      node.appendChild(meta);

      return node;
    };

    const upstream = trace.edges.filter(
      (edge) => trace.nodes.get(edge.source)?.relation === "upstream",
    );

    const downstream = trace.edges.filter(
      (edge) => trace.nodes.get(edge.consumer)?.relation === "downstream",
    );

    if (upstream.length > 0) {
      children.push(element("section", "Waiting for"));

      for (const edge of upstream)
        children.push(
          item(
            edge.source,
            trace.nodes.get(edge.source)?.depth ?? 1,
            true,
            STATE_LABEL[edge.sourceState],
            edge,
          ),
        );
    }

    if (downstream.length > 0) {
      children.push(element("section", "Calls back to"));

      for (const edge of downstream)
        children.push(
          item(
            edge.consumer,
            trace.nodes.get(edge.consumer)?.depth ?? 1,
            false,
            null,
            edge,
          ),
        );
    }

    card.replaceChildren(...children);
    card.hidden = false;
    const rect = row.getBoundingClientRect();
    const height = card.offsetHeight;

    const top = Math.min(
      Math.max(8, rect.top - 8),
      Math.max(8, window.innerHeight - height - 8),
    );

    card.style.left = `${view.right + 8}px`;
    card.style.top = `${top}px`;
  }
}
