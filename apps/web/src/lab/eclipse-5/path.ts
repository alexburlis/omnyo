export const SUN_TO_MOON = 0.955;

export const APPROACH = { x: -0.6, y: 0.8 };

const CONTACT_SPAN = 1 + 1 / SUN_TO_MOON;

export const SECOND_CONTACT = 1 - (1 / SUN_TO_MOON - 1) / CONTACT_SPAN;

const PARTIAL_MINUTES = 78;

export type FrameKey = "hero" | "side" | "center";

export type Frame = { cx: number; cy: number; r: number };

export type Eclipse = Frame & {
  c: number;
  ox: number;
  oy: number;
  or: number;
  obscuration: number;
  filter: number;
  dark: number;
  corona: number;
  stars: number;
  horizon: number;
  diamond: number;
  totality: number;
  flareX: number;
  flareY: number;
  streak: number;
  glow: number;
};

export type PathState = Eclipse & {
  w: number;
  h: number;
  version: number;
  moving: boolean;
};

export const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

export const smoothstep = (from: number, to: number, value: number) => {
  const t = clamp01((value - from) / (to - from));

  return t * t * (3 - 2 * t);
};

export const mix = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

export function frameFor(key: FrameKey, w: number, h: number): Frame {
  if (w >= 900) {
    if (key === "hero")
      return { cx: w * 0.685, cy: h * 0.41, r: Math.min(h * 0.2, w * 0.14) };

    if (key === "side")
      return w > 1180
        ? { cx: w * 0.75, cy: h * 0.47, r: Math.min(h * 0.18, w * 0.12) }
        : { cx: w * 0.73, cy: h * 0.46, r: Math.min(h * 0.19, w * 0.13) };

    return { cx: w * 0.5, cy: h * 0.29, r: Math.min(h * 0.15, w * 0.12) };
  }

  if (key === "hero")
    return { cx: w * 0.62, cy: h * 0.215, r: Math.min(w * 0.235, h * 0.12) };

  if (key === "side")
    return { cx: w * 0.6, cy: h * 0.22, r: Math.min(w * 0.2, h * 0.1) };

  return { cx: w * 0.5, cy: h * 0.22, r: Math.min(w * 0.2, h * 0.1) };
}

function overlapArea(d: number, a: number, b: number) {
  if (d >= a + b) return 0;

  if (d <= Math.abs(b - a)) return Math.PI * Math.min(a, b) ** 2;
  const partA = a * a * Math.acos((d * d + a * a - b * b) / (2 * d * a));
  const partB = b * b * Math.acos((d * d + b * b - a * a) / (2 * d * b));

  const lens =
    0.5 * Math.sqrt((-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b));

  return partA + partB - lens;
}

export function describe(c: number, frame: Frame): Eclipse {
  const or = frame.r / SUN_TO_MOON;
  const d = (1 - c) * (frame.r + or);

  const obscuration = clamp01(
    overlapArea(d, frame.r, or) / (Math.PI * frame.r * frame.r),
  );

  const filter = 1 - smoothstep(0.905, 0.95, c);
  const totality = smoothstep(SECOND_CONTACT - 0.004, 1, c);

  const diamond =
    smoothstep(0.948, 0.968, c) * (1 - smoothstep(0.972, 0.99, c));

  const reach = mix(0.25, 1, smoothstep(0.35, 0.95, c));

  return {
    ...frame,
    c,
    ox: frame.cx + APPROACH.x * d,
    oy: frame.cy + APPROACH.y * d,
    or,
    obscuration,
    filter,
    dark: smoothstep(0.12, 0.985, c) ** 1.15,
    corona: smoothstep(0.935, 0.99, c),
    stars: smoothstep(0.78, 0.99, c),
    horizon: smoothstep(0.55, 1, c),
    diamond,
    totality,
    flareX: frame.cx - APPROACH.x * frame.r * reach,
    flareY: frame.cy - APPROACH.y * frame.r * reach,
    streak: 0.2 * filter + diamond * 1.25 + totality * 0.55,
    glow: 0.06 * filter + diamond * 1.5 + totality * 0.1,
  };
}

export function countdown(c: number) {
  if (c >= SECOND_CONTACT) return "Totality";

  const seconds = Math.max(
    0,
    Math.round(((SECOND_CONTACT - c) / SECOND_CONTACT) * PARTIAL_MINUTES * 60),
  );

  const pad = (value: number) => String(value).padStart(2, "0");

  return `T−${pad(Math.floor(seconds / 3600))}:${pad(
    Math.floor(seconds / 60) % 60,
  )}:${pad(seconds % 60)}`;
}

type Key = { top: number; c: number; frame: FrameKey };

const INTRO_MS = 2600;

const INTRO_OFFSET = 0.13;

export function createPathDriver({
  root,
  sky,
  reducedMotion,
  onUpdate,
}: {
  root: HTMLElement;
  sky: HTMLElement;
  reducedMotion: boolean;
  onUpdate: (state: PathState) => void;
}) {
  let keys: Key[] = [];
  let w = 1;
  let h = 1;
  let raf = 0;
  let last = 0;
  let initialized = false;
  const introStart = performance.now();
  const current = { c: 0, cx: 0, cy: 0, r: 0 };

  const state: PathState = {
    ...describe(0, { cx: 0, cy: 0, r: 1 }),
    w,
    h,
    version: 0,
    moving: true,
  };

  const measure = () => {
    w = sky.clientWidth || window.innerWidth;
    h = sky.clientHeight || window.innerHeight;
    const scroll = window.scrollY;
    keys = Array.from(root.querySelectorAll<HTMLElement>("[data-c]"))
      .map((element) => ({
        top: element.getBoundingClientRect().top + scroll,
        c: Number(element.dataset.c),
        frame: (element.dataset.frame ?? "side") as FrameKey,
      }))
      .sort((a, b) => a.top - b.top);
  };

  const target = () => {
    const first = keys[0];

    if (!first) return { c: 0.15, ...frameFor("hero", w, h) };
    const scroll = window.scrollY;
    let c = first.c;
    let frame = frameFor(first.frame, w, h);

    for (let index = 1; index < keys.length; index++) {
      const key = keys[index];

      if (!key) continue;
      const start = key.top - h;
      const end = key.top - h * 0.32;
      const t = smoothstep(start, end, scroll);

      if (t <= 0) break;
      const next = frameFor(key.frame, w, h);
      c = mix(c, key.c, t);
      frame = {
        cx: mix(frame.cx, next.cx, t),
        cy: mix(frame.cy, next.cy, t),
        r: mix(frame.r, next.r, t),
      };
    }

    return { c, ...frame };
  };

  const tick = (now: number) => {
    raf = 0;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const goal = target();

    if (!initialized || reducedMotion) {
      Object.assign(current, goal);
      initialized = true;
    } else {
      const follow = 1 - Math.exp(-dt * 5.5);
      current.c += (goal.c - current.c) * follow;
      current.cx += (goal.cx - current.cx) * follow;
      current.cy += (goal.cy - current.cy) * follow;
      current.r += (goal.r - current.r) * follow;
    }

    const intro = reducedMotion ? 1 : clamp01((now - introStart) / INTRO_MS);
    const introEase = 1 - (1 - intro) ** 3;
    const shown = Math.max(0, current.c - INTRO_OFFSET * (1 - introEase));

    const anchor = keys[keys.length - 1];

    const lift =
      anchor && anchor.frame === "center"
        ? Math.min(0, anchor.top - window.scrollY)
        : 0;

    Object.assign(
      state,
      describe(shown, { ...current, cy: current.cy + lift }),
      {
        w,
        h,
        version: state.version + 1,
      },
    );

    const settled =
      intro >= 1 &&
      Math.abs(goal.c - current.c) < 1e-4 &&
      Math.abs(goal.cx - current.cx) < 0.05 &&
      Math.abs(goal.cy - current.cy) < 0.05 &&
      Math.abs(goal.r - current.r) < 0.05;

    state.moving = !settled;
    onUpdate(state);

    if (!settled) raf = requestAnimationFrame(tick);
  };

  const wake = () => {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  const remeasure = () => {
    measure();
    wake();
  };

  measure();
  last = performance.now();
  tick(last);

  window.addEventListener("scroll", wake, { passive: true });
  window.addEventListener("resize", remeasure);
  const observer = new ResizeObserver(remeasure);
  observer.observe(root);
  observer.observe(sky);

  return {
    state,
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", wake);
      window.removeEventListener("resize", remeasure);
      observer.disconnect();
    },
  };
}

export type PathDriver = ReturnType<typeof createPathDriver>;
