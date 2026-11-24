import "./kit.css";

import { useEffect, useRef, type ComponentType } from "react";

export interface VisualModule {
  label: string;
  Visual: ComponentType;
  Demo?: ComponentType;
}

const MODULES = import.meta.glob<VisualModule>("./*.visual.tsx", {
  eager: true,
});

const VISUALS = new Map(
  Object.entries(MODULES).map(([path, module]) => [
    path.slice(2, -".visual.tsx".length),
    module,
  ]),
);

export const visualIds = () => [...VISUALS.keys()];

export const getFeatureDemo = (id: string) => VISUALS.get(id)?.Demo;

let liveObserver: IntersectionObserver | null = null;

const observeLive = (element: HTMLElement) => {
  liveObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue;

        if (entry.isIntersecting) entry.target.dataset.live = "";
        else delete entry.target.dataset.live;
      }
    },
    { rootMargin: "-6% 0px" },
  );

  const observer = liveObserver;
  observer.observe(element);

  return () => {
    observer.unobserve(element);
    delete element.dataset.live;
  };
};

export function FeatureVisual({ id }: { id: string }) {
  const entry = VISUALS.get(id);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = box.current;

    if (!element) return;

    return observeLive(element);
  }, []);

  if (!entry) throw new Error(`Feature visual ${id} is not registered`);

  return (
    <div ref={box} className="fv-box" role="img" aria-label={entry.label}>
      <entry.Visual />
    </div>
  );
}
