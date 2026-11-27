import { frameReportSchema } from "../lib/frame-document";
import type { Board } from "../contract";
import type { RenderReport } from "../workspace-contract";

export const unevenBlank = 160;

export const unevenShare = 0.4;

export function readRenderReports(
  root: HTMLElement,
  board: Board,
  compact: boolean,
  sectionId?: string,
): RenderReport[] {
  const elements = Array.from(
    root.querySelectorAll<HTMLElement>(".cnv-node:not([data-measuring])"),
  ).filter(
    (element) =>
      sectionId === undefined ||
      element.closest<HTMLElement>("[data-project-section-id]")?.dataset.projectSectionId ===
        sectionId,
  );

  const matrixText = root.querySelector<HTMLElement>(".cnv-world")?.style.transform ?? "";
  const zoomText = /scale\(([\d.]+)\)/u.exec(matrixText)?.[1];
  const zoom = zoomText ? Number(zoomText) : 1;

  const nodes = new Map(board.nodes.map((node) => [node.id, node]));
  const measured = elements.map((element) => ({ element, rect: element.getBoundingClientRect() }));

  return measured.flatMap(({ element, rect }) => {
    const node = nodes.get(element.dataset.nodeId ?? "");

    if (!node) return [];

    const frames = Array.from(element.querySelectorAll<HTMLIFrameElement>(".cnv-frame")).filter(
      (frame) => getComputedStyle(frame).visibility !== "hidden",
    );

    const reports = frames.map((frame) => {
      try {
        return frameReportSchema.safeParse(JSON.parse(frame.dataset.frameReport ?? "null"));
      } catch {
        return frameReportSchema.safeParse(null);
      }
    });

    const issues: string[] = [];

    const semantic =
      node.views?.overview === undefined
        ? null
        : element.querySelector<HTMLElement>('.cnv-semantic[data-detail="overview"]');

    const overviewFrame = semantic?.querySelector<HTMLIFrameElement>(
      '[data-view="overview"][data-active="true"] > .cnv-frame',
    );

    if (semantic && overviewFrame && getComputedStyle(overviewFrame).visibility !== "hidden") {
      const shown = overviewFrame.offsetHeight;
      const reserved = semantic.offsetHeight;

      if (shown > 0 && shown * 2 < reserved && reserved - shown > 120)
        issues.push(
          `Sparse overview ${node.id}: ${shown}px of ${reserved}px reserved. Keep charts or a summary of similar height, or omit overview.`,
        );
    }

    const blank = Number(element.dataset.slackBlank ?? 0);
    const row = Number(element.dataset.slackRow ?? 0);

    if (!compact && blank >= unevenBlank && blank >= row * unevenShare)
      issues.push(
        `Uneven row ${node.id}: ${blank}px blank below it. Stack a related module there, change spans or widths, or move it.`,
      );

    if (reports.some((report) => report.success && report.data.overflowX))
      issues.push("HTML content has horizontal overflow");

    if (reports.some((report) => report.success && report.data.overflowY))
      issues.push("HTML content has vertical overflow");

    if (!compact)
      for (const { element: other, rect: candidate } of measured) {
        if (other === element) continue;

        if (
          Math.min(rect.right, candidate.right) - Math.max(rect.left, candidate.left) > zoom &&
          Math.min(rect.bottom, candidate.bottom) - Math.max(rect.top, candidate.top) > zoom
        )
          issues.push(`Overlaps ${other.dataset.nodeId ?? "another module"}`);
      }

    const text = reports.length
      ? reports.flatMap((report) => (report.success ? [report.data.text] : [])).join("\n")
      : (element.innerText ?? element.textContent ?? "");

    const deferred = element.dataset.contentDeferred === "true";

    const visible = (target: HTMLElement) =>
      target.closest('[aria-hidden="true"]') === null &&
      getComputedStyle(target).visibility !== "hidden";

    const mediaPending = Array.from(
      element.querySelectorAll<HTMLElement>('[aria-busy="true"], [role="alert"]'),
    ).some(visible);

    const imagesReady = Array.from(element.querySelectorAll<HTMLImageElement>("img"))
      .filter(visible)
      .every((image) => image.complete && image.naturalWidth > 0);

    const ready =
      !deferred &&
      !mediaPending &&
      imagesReady &&
      rect.width > 0 &&
      rect.height > 0 &&
      reports.every((report) => report.success);

    const report: RenderReport = {
      nodeId: node.id,
      nodeRevision: node.updatedRevision,
      boardRevision: board.revision,
      sourceRevision: element.dataset.sourceRevision
        ? Number(element.dataset.sourceRevision)
        : null,
      capturedAt: Date.now(),
      mode: compact ? "outline" : "board",
      zoom,
      view: element.querySelector<HTMLElement>("[data-detail]")?.dataset.detail ?? "evidence",
      bounds: {
        x: compact ? element.offsetLeft : parseFloat(element.style.left) || 0,
        y: compact ? element.offsetTop : parseFloat(element.style.top) || 0,
        width: element.offsetWidth,
        height: element.offsetHeight,
      },
      text: deferred ? "" : text.slice(0, 4000),
      issues: issues.slice(0, 30),
      ready,
    };

    if (board.threadId.startsWith("sec_")) report.sectionId = board.threadId;

    return [report];
  });
}
