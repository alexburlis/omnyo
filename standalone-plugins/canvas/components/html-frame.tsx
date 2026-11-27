import { useEffect, useRef, useState } from "react";
import type { IslandAccent } from "../contract";
import {
  frameDocument,
  frameHeightMessage,
  frameNavigationMessage,
  framePanMessage,
  frameRenderMessage,
  frameWheelMessage,
  themeVariables,
} from "../lib/frame-document";

export function HtmlFrame({
  html,
  title,
  accent,
  canvasNavigation,
  active = true,
  data = null,
  onHeight,
  onDocument,
}: {
  html: string;
  title: string;
  accent?: IslandAccent;
  canvasNavigation: boolean;
  active?: boolean;
  data?: string | null;
  onHeight?(): void;
  onDocument?(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const heightListener = useRef(onHeight);
  heightListener.current = onHeight;
  const documentListener = useRef(onDocument);
  documentListener.current = onDocument;

  const wheelAnchor = useRef<{
    geometry: readonly number[];
    pointerRevision: number;
    clientX: number;
    clientY: number;
  } | null>(null);

  const [height, setHeight] = useState(160);
  const [loaded, setLoaded] = useState<{ source: string; generation: number } | null>(null);
  const source = loaded?.source ?? null;

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);

    const variables = new Map(
      themeVariables.map((name) => [name, styles.getPropertyValue(name).trim()] as const),
    );

    const accentValue =
      accent === undefined || accent === "neutral"
        ? ""
        : styles.getPropertyValue(`--cnv-accent-${accent}`).trim();

    if (accentValue !== "") variables.set("--canvas-accent", accentValue);
    const next = frameDocument(html, variables, styles.colorScheme, canvasNavigation, data);

    setLoaded((current) =>
      current?.source === next
        ? current
        : { source: next, generation: (current?.generation ?? 0) + 1 },
    );
  }, [html, accent, canvasNavigation, data]);

  useEffect(() => {
    if (loaded !== null) documentListener.current?.();
  }, [loaded]);

  useEffect(() => {
    wheelAnchor.current = null;
    let stopPan = () => {};

    function receive(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;

      const navigation = frameNavigationMessage.safeParse(event.data);

      if (navigation.success) {
        frame.current?.dispatchEvent(
          new CustomEvent("canvas-navigate", {
            bubbles: true,
            detail: navigation.data.canvasFrameNavigate,
          }),
        );

        return;
      }

      const render = frameRenderMessage.safeParse(event.data);

      if (render.success && frame.current) {
        frame.current.dataset.frameReport = JSON.stringify(render.data.canvasFrameReport);
        frame.current.dispatchEvent(new CustomEvent("canvas-frame-report", { bubbles: true }));
      }

      const result = frameHeightMessage.safeParse(event.data);

      if (result.success) {
        setHeight(Math.max(40, Math.ceil(result.data.canvasFrameHeight)));
        heightListener.current?.();

        return;
      }

      if (!canvasNavigation) return;
      const pan = framePanMessage.safeParse(event.data);

      if (pan.success && frame.current) {
        stopPan();
        const target = frame.current;
        const rect = target.getBoundingClientRect();

        if (target.clientWidth === 0 || target.clientHeight === 0) return;
        let x = rect.left + (pan.data.canvasFramePan.clientX * rect.width) / target.clientWidth;
        let y = rect.top + (pan.data.canvasFramePan.clientY * rect.height) / target.clientHeight;
        const overlay = document.createElement("div");
        overlay.style.cssText =
          "position:fixed;inset:0;z-index:2147483647;cursor:grabbing;touch-action:none";

        function move(event: PointerEvent) {
          if ((event.buttons & 4) === 0) {
            stopPan();

            return;
          }

          event.preventDefault();
          target.dispatchEvent(
            new CustomEvent("canvas-frame-pan", {
              bubbles: true,
              detail: { deltaX: event.clientX - x, deltaY: event.clientY - y },
            }),
          );
          x = event.clientX;
          y = event.clientY;
        }

        stopPan = () => {
          overlay.remove();
          window.removeEventListener("blur", stopPan);
        };

        overlay.addEventListener("pointermove", move);
        overlay.addEventListener("pointerup", () => stopPan());
        overlay.addEventListener("pointercancel", () => stopPan());
        overlay.addEventListener("auxclick", (event) => event.preventDefault());
        window.addEventListener("blur", stopPan);
        document.body.append(overlay);

        return;
      }

      const wheel = frameWheelMessage.safeParse(event.data);
      const target = frame.current;

      if (
        !wheel.success ||
        target === null ||
        target.clientWidth === 0 ||
        target.clientHeight === 0
      )
        return;

      const rect = target.getBoundingClientRect();
      const input = wheel.data.canvasFrameWheel;
      const board = target.closest(".cnv-board")?.getBoundingClientRect();

      const geometry = [
        window.screenX,
        window.screenY,
        window.innerWidth,
        window.innerHeight,
        window.outerWidth,
        window.outerHeight,
        window.devicePixelRatio,
        board?.left ?? 0,
        board?.top ?? 0,
      ];

      let anchor = wheelAnchor.current;

      if (
        anchor === null ||
        anchor.pointerRevision !== input.pointerRevision ||
        geometry.some((value, index) => value !== anchor?.geometry[index])
      ) {
        anchor = {
          geometry,
          pointerRevision: input.pointerRevision,
          clientX: rect.left + (input.clientX * rect.width) / target.clientWidth,
          clientY: rect.top + (input.clientY * rect.height) / target.clientHeight,
        };
        wheelAnchor.current = anchor;
      }

      target.dispatchEvent(
        new WheelEvent("wheel", {
          ...input,
          bubbles: true,
          cancelable: true,
          clientX: anchor.clientX,
          clientY: anchor.clientY,
        }),
      );
    }

    window.addEventListener("message", receive);

    return () => {
      stopPan();
      window.removeEventListener("message", receive);
    };
  }, [canvasNavigation, source]);

  if (source === null)
    return (
      <div className="cnv-frame-placeholder" aria-busy={active || undefined} style={{ height }} />
    );

  return (
    <iframe
      key={loaded?.generation}
      ref={frame}
      className="cnv-frame"
      title={title}
      sandbox="allow-scripts"
      srcDoc={source}
      style={{ height }}
    />
  );
}
