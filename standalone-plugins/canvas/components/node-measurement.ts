import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasNode } from "../contract";
import { frameCount } from "../lib/node-rendering";

type FrameCycle = {
  key: string | null;
  loaded: boolean;
  started: boolean;
  reports: number;
  settled: boolean;
};

interface MeasurementProps {
  node: CanvasNode;
  threadId?: string;
  eager: boolean;
  measureKey: string | null;
  remembered: boolean;
  measuring: boolean;
  onMeasure?(id: string, height: number, key: string): void;
  onRealization?(id: string, realized: boolean): void;
}

export function useNodeMeasurement({
  node,
  threadId,
  eager,
  measureKey,
  remembered,
  measuring,
  onMeasure,
  onRealization,
}: MeasurementProps) {
  const element = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const heavy = node.kind === "html" || node.kind === "image" || node.kind === "video";

  const [realized, setRealized] = useState(
    () => eager || !heavy || typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (eager) setRealized(true);
  }, [eager]);

  const realization = useRef(onRealization);
  realization.current = onRealization;

  useEffect(() => {
    if (realized) realization.current?.(node.id, true);
  }, [realized, node.id]);

  useEffect(() => {
    const target = element.current;

    if (realized || target === null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRealized(true);
          observer.disconnect();
        } else realization.current?.(node.id, false);
      },
      { root: target.closest(".cnv-board"), rootMargin: "200px" },
    );

    observer.observe(target);

    return () => observer.disconnect();
  }, [realized, node.id]);

  const [frame, setFrame] = useState<FrameCycle>(() => ({
    key: measureKey,
    loaded: false,
    started: false,
    reports: 0,
    settled: false,
  }));

  const cycle =
    frame.key === measureKey
      ? frame
      : { key: measureKey, loaded: false, started: frame.started, reports: 0, settled: false };

  if (cycle !== frame) setFrame(cycle);

  const frameDocument = useCallback(
    () =>
      setFrame((current) =>
        current.loaded || current.started || current.reports > 0 || current.settled
          ? { key: current.key, loaded: false, started: false, reports: 0, settled: false }
          : current,
      ),
    [],
  );

  const frameHeight = useCallback(
    () =>
      setFrame((current) =>
        current.settled ? current : { ...current, reports: current.reports + 1 },
      ),
    [],
  );

  useEffect(() => {
    if (cycle.settled || (cycle.reports === 0 && !cycle.loaded)) return;
    const key = cycle.key;

    const timer = window.setTimeout(
      () => setFrame((current) => (current.key === key ? { ...current, settled: true } : current)),
      cycle.reports === 0 ? 250 : 120,
    );

    return () => window.clearTimeout(timer);
  }, [cycle.key, cycle.settled, cycle.loaded, cycle.reports]);

  useEffect(() => {
    if (cycle.settled || !cycle.started) return;
    const key = cycle.key;

    const timer = window.setTimeout(
      () => setFrame((current) => (current.key === key ? { ...current, settled: true } : current)),
      1000,
    );

    return () => window.clearTimeout(timer);
  }, [cycle.key, cycle.settled, cycle.started]);

  const media =
    !node.binding && (node.kind === "image" || node.kind === "video") && node.assetId !== null;

  const [readyAsset, setReadyAsset] = useState<string | null>(null);
  const mediaReady = useCallback((assetId: string) => setReadyAsset(assetId), []);
  const [mediaWaitOver, setMediaWaitOver] = useState<string | null>(null);

  useEffect(() => {
    const assetId = node.assetId;

    if (!realized || !media || assetId === null) return;

    if (readyAsset === assetId || mediaWaitOver === assetId) return;
    const timer = window.setTimeout(() => setMediaWaitOver(assetId), 1000);

    return () => window.clearTimeout(timer);
  }, [realized, media, node.assetId, readyAsset, mediaWaitOver]);

  const [dataWaitOver, setDataWaitOver] = useState(false);

  useEffect(() => {
    if (!realized || measureKey !== null || dataWaitOver || remembered) return;
    const timer = window.setTimeout(() => setDataWaitOver(true), 1000);

    return () => window.clearTimeout(timer);
  }, [realized, measureKey, dataWaitOver, remembered]);
  const reportedKey = measureKey ?? (dataWaitOver ? "" : null);

  const settled =
    realized &&
    reportedKey !== null &&
    (frameCount(node, threadId) === 0 || cycle.settled) &&
    (!media || readyAsset === node.assetId || mediaWaitOver === node.assetId);

  useEffect(() => {
    const target = element.current;

    if (target === null || onMeasure === undefined || !settled || reportedKey === null) return;

    const body = content.current;

    const observer = new ResizeObserver((entries) => {
      if (!target.isConnected) return;

      for (const entry of entries) {
        if (entry.target === target) {
          const size = entry.borderBoxSize[0];

          if (size !== undefined && size.blockSize > 0)
            onMeasure(node.id, Math.ceil(size.blockSize), reportedKey);
        } else if (body !== null && entry.target === body) {
          const size = entry.contentBoxSize[0];

          if (size === undefined) continue;
          body.style.containIntrinsicBlockSize = `auto ${size.blockSize}px`;
          body.style.contentVisibility = "auto";
          observer.unobserve(body);
        }
      }
    });

    observer.observe(target);

    if (body && !measuring && target.closest(".cnv-world") && !body.style.contentVisibility)
      observer.observe(body);

    return () => observer.disconnect();
  }, [node.id, onMeasure, settled, reportedKey, measuring]);

  const frameLoaded = () =>
    setFrame((current) =>
      current.loaded && current.started ? current : { ...current, loaded: true, started: true },
    );

  return {
    element,
    content,
    realized,
    settled,
    frameDocument,
    frameHeight,
    mediaReady,
    frameLoaded,
  };
}
