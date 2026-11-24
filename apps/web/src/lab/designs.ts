import type { ComponentType } from "react";

export interface LabDesign {
  slug: string;
  group: "open" | "cinematic-o" | "eclipse" | "combined" | "tools";
  title: string;
  territory: string;
  load: () => Promise<{ default: ComponentType }>;
}

export const LAB_DESIGNS: readonly LabDesign[] = [
  {
    slug: "open-1",
    group: "open",
    title: "Open 1",
    territory: "Editorial typography",
    load: () => import("./open-1/page"),
  },
  {
    slug: "open-2",
    group: "open",
    title: "Open 2",
    territory: "Product as the hero",
    load: () => import("./open-2/page"),
  },
  {
    slug: "open-3",
    group: "open",
    title: "Open 3",
    territory: "Mission control",
    load: () => import("./open-3/page"),
  },
  {
    slug: "open-4",
    group: "open",
    title: "Open 4",
    territory: "Light and warm",
    load: () => import("./open-4/page"),
  },
  {
    slug: "open-5",
    group: "open",
    title: "Open 5",
    territory: "Kinetic scroll story",
    load: () => import("./open-5/page"),
  },
  {
    slug: "o-1",
    group: "cinematic-o",
    title: "Cinematic O 1",
    territory: "Eclipse",
    load: () => import("./o-1/page"),
  },
  {
    slug: "o-2",
    group: "cinematic-o",
    title: "Cinematic O 2",
    territory: "Liquid chrome and glass",
    load: () => import("./o-2/page"),
  },
  {
    slug: "o-3",
    group: "cinematic-o",
    title: "Cinematic O 3",
    territory: "Through the O",
    load: () => import("./o-3/page"),
  },
  {
    slug: "eclipse-1",
    group: "eclipse",
    title: "Eclipse 1",
    territory: "Purist totality",
    load: () => import("./eclipse-1/page"),
  },
  {
    slug: "eclipse-2",
    group: "eclipse",
    title: "Eclipse 2",
    territory: "Trailer cut",
    load: () => import("./eclipse-2/page"),
  },
  {
    slug: "eclipse-3",
    group: "eclipse",
    title: "Eclipse 3",
    territory: "Cold corona",
    load: () => import("./eclipse-3/page"),
  },
  {
    slug: "eclipse-4",
    group: "eclipse",
    title: "Eclipse 4",
    territory: "Eclipse over the product",
    load: () => import("./eclipse-4/page"),
  },
  {
    slug: "eclipse-5",
    group: "eclipse",
    title: "Eclipse 5",
    territory: "Path of totality",
    load: () => import("./eclipse-5/page"),
  },
  {
    slug: "combined-a",
    group: "combined",
    title: "Combined A · Kinetic workspace",
    territory: "Open 5 motion, Eclipse 4 window, one Monday told in scenes",
    load: () => import("./combined-a/page"),
  },
  {
    slug: "combined-a-v2",
    group: "combined",
    title: "Combined A v2 · Problem first",
    territory: "Combined A told as the problems Omnyo fixes",
    load: () => import("./combined-a-v2/page"),
  },
  {
    slug: "combined-b",
    group: "combined",
    title: "Combined B",
    territory: "Open 5 + Eclipse 4, told like Open 2",
    load: () => import("./combined-b/page"),
  },
  {
    slug: "visuals",
    group: "tools",
    title: "Feature visuals",
    territory: "Every mock-up at four sizes",
    load: () => import("./visuals/page"),
  },
];
