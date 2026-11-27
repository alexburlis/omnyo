import type { CSSProperties } from "react";
import type { Viewport } from "./layout";

const gridSteps = [5.5, 11, 22, 44, 88, 176, 352];

export function gridBackground(viewport: Viewport): CSSProperties {
  const layers = gridSteps.map((step) => {
    const pitch = step * viewport.zoom;
    const weight = Math.max(0, 1 - Math.abs(Math.log2(pitch / 24)));
    const opacity = Math.round(14 * weight * weight * (3 - 2 * weight) * 1e6) / 1e6;

    return {
      image: `radial-gradient(color-mix(in oklab, var(--foreground) ${opacity}%, transparent) 1px, transparent 1px)`,
      size: `${pitch}px ${pitch}px`,
      position: `${viewport.x - pitch / 2}px ${viewport.y - pitch / 2}px`,
    };
  });

  return {
    backgroundImage: layers.map((layer) => layer.image).join(", "),
    backgroundSize: layers.map((layer) => layer.size).join(", "),
    backgroundPosition: layers.map((layer) => layer.position).join(", "),
  };
}
