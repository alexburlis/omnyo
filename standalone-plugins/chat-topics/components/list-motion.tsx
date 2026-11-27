import { Component, createRef, type ComponentPropsWithoutRef } from "react";

interface ListMotionProps extends ComponentPropsWithoutRef<"div"> {
  scopeKey: string | null;
}

interface Captured {
  top: number;
  height: number;
}

interface Placed {
  key: string | undefined;
  rect: DOMRect;
  top: number;
  previous: number | undefined;
}

export class ListMotion extends Component<ListMotionProps> {
  private root = createRef<HTMLDivElement>();
  private scroll: HTMLElement | null = null;
  private held = new Set<number>();
  private dragging = false;
  private painted: ReadonlyMap<string, Captured> | null = null;
  private ordered: string | null = null;
  private frame: number | null = null;
  private resize: ResizeObserver | null = null;

  componentDidMount() {
    this.scroll = this.root.current?.closest<HTMLElement>(".ct-list") ?? null;
    this.root.current?.addEventListener("pointerdown", this.press, true);
    this.root.current?.addEventListener("dragstart", this.startDrag, true);
    document.addEventListener("dragend", this.endDrag, true);
    document.addEventListener("pointerup", this.release, true);
    document.addEventListener("pointercancel", this.release, true);
    this.ordered = this.order();
    this.resize = new ResizeObserver(this.paint);

    if (this.root.current !== null) this.resize.observe(this.root.current);
    this.paint();
  }

  componentWillUnmount() {
    this.resize?.disconnect();

    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.root.current?.removeEventListener("pointerdown", this.press, true);
    this.root.current?.removeEventListener("dragstart", this.startDrag, true);
    document.removeEventListener("dragend", this.endDrag, true);
    document.removeEventListener("pointerup", this.release, true);
    document.removeEventListener("pointercancel", this.release, true);
  }

  private press = (event: PointerEvent) => {
    this.held.add(event.pointerId);
  };

  private release = (event: PointerEvent) => {
    this.held.delete(event.pointerId);

    if (event.type === "pointerup") this.dragging = false;
  };

  private startDrag = (event: DragEvent) => {
    this.dragging = true;
    setTimeout(() => {
      if (event.defaultPrevented) this.dragging = false;
    }, 0);
  };

  private endDrag = () => {
    this.dragging = false;
  };

  private direct() {
    return this.held.size > 0 || this.dragging || document.body.dataset.sidebarDragging === "true";
  }

  private rows() {
    return Array.from(
      this.root.current?.querySelectorAll<HTMLElement>("[data-chat-motion-key]") ?? [],
    );
  }

  private order() {
    return this.rows()
      .map((element) => element.dataset.chatMotionKey ?? "")
      .join("\n");
  }

  private paint = () => {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.painted = this.measure();
    });
  };

  private measure() {
    const viewport = this.scroll?.getBoundingClientRect();
    const origin = this.root.current?.getBoundingClientRect();
    const captured = new Map<string, Captured>();

    for (const element of this.rows()) {
      const key = element.dataset.chatMotionKey;

      if (key === undefined) continue;
      const rect = element.getBoundingClientRect();

      if (
        origin === undefined ||
        rect.height === 0 ||
        (viewport !== undefined &&
          (rect.bottom < viewport.top - 32 || rect.top > viewport.bottom + 32))
      )
        continue;
      captured.set(key, { top: rect.top - origin.top, height: rect.height });
    }

    return captured;
  }

  componentDidUpdate(previousProps: ListMotionProps) {
    const order = this.order();
    const before = this.painted;
    const rescoped = previousProps.scopeKey !== this.props.scopeKey;

    if (order === this.ordered && !rescoped && !this.shifted(before)) {
      this.paint();

      return;
    }

    this.ordered = order;
    const viewport = this.scroll?.getBoundingClientRect();

    if (before !== null && !rescoped && !this.direct() && viewport !== undefined) {
      const originTop = this.root.current?.getBoundingClientRect().top ?? 0;

      const placed: Placed[] = this.rows().map((element) => {
        const key = element.dataset.chatMotionKey;
        const rect = element.getBoundingClientRect();

        return {
          key,
          rect,
          top: rect.top - originTop,
          previous: key === undefined ? undefined : before.get(key)?.top,
        };
      });

      this.anchor(placed, before, viewport.top - originTop, viewport.bottom - originTop);
      this.painted = this.measure();
    }

    this.paint();
  }

  private shifted(before: ReadonlyMap<string, Captured> | null) {
    if (before === null) return false;
    const originTop = this.root.current?.getBoundingClientRect().top ?? 0;

    return this.rows().some((element) => {
      const key = element.dataset.chatMotionKey;
      const expected = key === undefined ? undefined : before.get(key)?.top;

      if (expected === undefined) return false;

      return Math.abs(element.getBoundingClientRect().top - originTop - expected) > 0.5;
    });
  }

  private anchor(
    placed: readonly Placed[],
    captured: ReadonlyMap<string, Captured>,
    viewTop: number,
    viewBottom: number,
  ) {
    const scroll = this.scroll;

    if (scroll === null || scroll.scrollTop <= 0) return;

    const arrivedInView = placed.some(
      (row) =>
        row.previous === undefined &&
        row.rect.height > 0 &&
        row.top >= viewTop - 0.5 &&
        row.top < viewBottom,
    );

    if (arrivedInView) return;

    const visible = placed
      .flatMap((row) =>
        row.previous !== undefined &&
        row.rect.height > 0 &&
        row.previous >= viewTop - 0.5 &&
        row.previous + row.rect.height <= viewBottom + 0.5
          ? [{ previous: row.previous, delta: row.top - row.previous }]
          : [],
      )
      .sort((a, b) => a.previous - b.previous);

    const pair = visible.findIndex(
      (row, index) =>
        index + 1 < visible.length && Math.abs(row.delta - visible[index + 1].delta) < 0.5,
    );

    if (pair < 0 || Math.abs(visible[pair].delta) <= 0.5) return;
    const anchor = visible[pair];
    const present = new Set(placed.map((row) => row.key));

    for (const [key, capture] of captured)
      if (
        !present.has(key) &&
        capture.top + capture.height > viewTop &&
        capture.top < anchor.previous
      )
        return;
    const limit = scroll.scrollHeight - scroll.clientHeight;
    const target = Math.min(limit, Math.max(0, scroll.scrollTop + anchor.delta));

    if (Math.abs(target - scroll.scrollTop) <= 0.5) return;
    scroll.scrollTop = target;
  }

  render() {
    const { scopeKey: _scopeKey, ...props } = this.props;

    return <div {...props} ref={this.root} style={{ overflowAnchor: "none", ...props.style }} />;
  }
}
