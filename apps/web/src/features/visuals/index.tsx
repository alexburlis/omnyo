import "../../lab/app-mock/app-mock.css";
import "./styles.css";

import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  type ComponentType,
} from "react";

export interface VisualModule {
  label: string;
  Visual: ComponentType;
  Demo?: ComponentType;
}

const MODULES = import.meta.glob<VisualModule>("./*.visual.tsx");

const VISUALS = new Map(
  Object.entries(MODULES).map(([path, load]) => [
    path.slice(2, -".visual.tsx".length),
    lazy(async () => {
      const entry = await load();

      return { default: () => <VisualArtwork entry={entry} /> };
    }),
  ]),
);

export const visualIds = () => [...VISUALS.keys()];

const DEMOS = new Map([
  [
    "terminal",
    lazy(async () => ({ default: (await import("./terminal.visual")).Demo })),
  ],
]);

export const getFeatureDemo = (id: string) => DEMOS.get(id);

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

function VisualArtwork({ entry }: { entry: VisualModule }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = box.current;

    if (!element) return;

    return observeLive(element);
  }, []);

  return (
    <div ref={box} className="fv-box" role="img" aria-label={entry.label}>
      <entry.Visual />
    </div>
  );
}

export const FeatureVisual = memo(function FeatureVisual({
  id,
}: {
  id: string;
}) {
  const Artwork = VISUALS.get(id);

  if (!Artwork) throw new Error(`Feature visual ${id} is not registered`);

  return (
    <Suspense fallback={null}>
      <Artwork />
    </Suspense>
  );
});
