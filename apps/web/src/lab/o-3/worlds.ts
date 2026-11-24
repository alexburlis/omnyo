export interface World {
  top: string;
  mid: string;
  horizon: string;
  glow: string;
  ground: string;
  horizonY: number;
  sunX: number;
  sunY: number;
  sun: number;
  streak: number;
  haze: number;
}

export type WorldName =
  | "dusk"
  | "dawn"
  | "mist"
  | "noon"
  | "morning"
  | "lilac"
  | "blue"
  | "night";

export const WORLDS: Record<WorldName, World> = {
  dusk: {
    top: "#101a3c",
    mid: "#5b3566",
    horizon: "#ff9a52",
    glow: "#ffd7a1",
    ground: "#1a1020",
    horizonY: 0.5,
    sunX: 0.5,
    sunY: 0.5,
    sun: 1,
    streak: 1,
    haze: 0.6,
  },
  dawn: {
    top: "#6b93d2",
    mid: "#d6d0e6",
    horizon: "#ffd6ae",
    glow: "#fff0da",
    ground: "#8a88a8",
    horizonY: 0.34,
    sunX: 0.74,
    sunY: 0.4,
    sun: 0.42,
    streak: 0.4,
    haze: 0.85,
  },
  mist: {
    top: "#5f9993",
    mid: "#c7dfd3",
    horizon: "#f1eedb",
    glow: "#fffbe6",
    ground: "#557f7b",
    horizonY: 0.34,
    sunX: 0.26,
    sunY: 0.42,
    sun: 0.4,
    streak: 0.3,
    haze: 0.85,
  },
  noon: {
    top: "#3f78c4",
    mid: "#9fc1e8",
    horizon: "#eaf1f4",
    glow: "#ffffff",
    ground: "#4f74a6",
    horizonY: 0.34,
    sunX: 0.76,
    sunY: 0.66,
    sun: 0.38,
    streak: 0.22,
    haze: 0.9,
  },
  morning: {
    top: "#8a9dcc",
    mid: "#efc9a0",
    horizon: "#ffc684",
    glow: "#fff0d2",
    ground: "#94724f",
    horizonY: 0.34,
    sunX: 0.26,
    sunY: 0.38,
    sun: 0.5,
    streak: 0.5,
    haze: 0.85,
  },
  lilac: {
    top: "#7f77c6",
    mid: "#d2c3ec",
    horizon: "#f8dfe8",
    glow: "#fff3f2",
    ground: "#6f66a0",
    horizonY: 0.34,
    sunX: 0.74,
    sunY: 0.42,
    sun: 0.42,
    streak: 0.38,
    haze: 0.85,
  },
  blue: {
    top: "#0c1430",
    mid: "#22366c",
    horizon: "#5a6cb0",
    glow: "#b9c8ff",
    ground: "#080c1c",
    horizonY: 0.16,
    sunX: 0.5,
    sunY: 0.16,
    sun: 0.45,
    streak: 0.3,
    haze: 0.5,
  },
  night: {
    top: "#080c1e",
    mid: "#151f44",
    horizon: "#3d4f8f",
    glow: "#9fb4ff",
    ground: "#05070f",
    horizonY: 0.16,
    sunX: 0.5,
    sunY: 0.16,
    sun: 0.45,
    streak: 0.3,
    haze: 0.4,
  },
};

export interface Journey {
  hero: number;
  finale: number;
  from: WorldName;
  to: WorldName;
  blend: number;
}

export const PORTAL_WORLD: WorldName = "dawn";
