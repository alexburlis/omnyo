import { CHAPTERS, READOUTS, STORY_LINES } from "./content";
import type { Engine, EngineFrame, Vec3, Vec4 } from "./engine";
import { WINDOW_COUNT } from "./shaders";

export interface StoryCallbacks {
  onStep: (index: number) => void;
  onLive: () => void;
}

export interface StoryController {
  attach: (engine: Engine) => void;
  modelReady: () => void;
  modelProgress: (fraction: number) => void;
  fail: () => void;
  dispose: () => void;
}

type Anchor = { x: number; y: number; r: number };

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

const ramp = (value: number, start: number, length: number) =>
  clamp01((value - start) / length);

const smooth = (value: number) => value * value * (3 - 2 * value);

const smoothstep = (edge0: number, edge1: number, value: number) =>
  smooth(clamp01((value - edge0) / (edge1 - edge0)));

const mix = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

const mixAnchor = (a: Anchor, b: Anchor, t: number): Anchor => ({
  x: mix(a.x, b.x, t),
  y: mix(a.y, b.y, t),
  r: mix(a.r, b.r, t),
});

const MOON_RATIO = 1.03;

const START_DISTANCE = 2.5;

const HOLD_DISTANCE = 0.042;

const LEAVE_DISTANCE = 2.75;

const FADE_SHARE = 0.3;

const hexToRgb = (hex: string): Vec3 => {
  const value = Number.parseInt(hex.slice(1), 16);

  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
};

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const toGamma = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

const toOklab = ([r, g, b]: Vec3): Vec3 => {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );

  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );

  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const fromOklab = ([L, a, b]: Vec3): Vec3 => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    clamp01(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
};

const SKY_STOPS = [
  [0, "#f3efe6", "#f3efe6", "#f2ece2"],
  [0.18, "#f1e5d2", "#f4e7d4", "#f6dfc4"],
  [0.38, "#e2bf9e", "#eec9a3", "#f3b586"],
  [0.56, "#975c6b", "#d2826a", "#ec9761"],
  [0.72, "#3d2d50", "#7b435a", "#c06a4b"],
  [0.87, "#17131f", "#2b1b2c", "#4a2628"],
  [1, "#07070b", "#0b0a10", "#130d11"],
].map(([at, top, mid, bot]) => ({
  at: at as number,
  top: toOklab(hexToRgb(top as string)),
  mid: toOklab(hexToRgb(mid as string)),
  bot: toOklab(hexToRgb(bot as string)),
}));

const mixLab = (a: Vec3, b: Vec3, t: number): Vec3 => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];

function skyAt(night: number) {
  const n = clamp01(night);
  let index = 0;

  while (index < SKY_STOPS.length - 2 && n > (SKY_STOPS[index + 1]?.at ?? 1)) {
    index++;
  }

  const from = SKY_STOPS[index];
  const to = SKY_STOPS[index + 1];

  if (!from || !to) throw new Error("Sky stops are missing");
  const t = smooth(clamp01((n - from.at) / (to.at - from.at)));

  return {
    top: fromOklab(mixLab(from.top, to.top, t)),
    mid: fromOklab(mixLab(from.mid, to.mid, t)),
    bot: fromOklab(mixLab(from.bot, to.bot, t)),
  };
}

const mixLab3 = (a: Vec3, b: Vec3): Vec3 => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2,
];

const css = (color: Vec3) =>
  `rgb(${Math.round(color[0] * 255)} ${Math.round(color[1] * 255)} ${Math.round(color[2] * 255)})`;

const luminance = ([r, g, b]: Vec3) =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

function circleOverlap(d: number, r1: number, r2: number) {
  if (d >= r1 + r2) return 0;

  if (d <= Math.abs(r2 - r1)) return Math.PI * Math.min(r1, r2) ** 2;
  const a = Math.acos(clamp(-1, 1, (d * d + r1 * r1 - r2 * r2) / (2 * d * r1)));
  const b = Math.acos(clamp(-1, 1, (d * d + r2 * r2 - r1 * r1) / (2 * d * r2)));

  const k = Math.sqrt(
    Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)),
  );

  return r1 * r1 * a + r2 * r2 * b - 0.5 * k;
}

function clamp(min: number, max: number, value: number) {
  return Math.min(Math.max(value, min), max);
}

const INK: Vec3 = [0.05, 0.05, 0.055];

const GLOW: Vec3 = [1, 0.9, 0.78];

export function startStory(
  root: HTMLElement,
  callbacks: StoryCallbacks,
): StoryController {
  const cache = new WeakMap<HTMLElement, Map<string, string>>();

  const setVar = (element: HTMLElement | null, name: string, value: string) => {
    if (!element) return;
    let entries = cache.get(element);

    if (!entries) {
      entries = new Map();
      cache.set(element, entries);
    }

    if (entries.get(name) === value) return;
    entries.set(name, value);
    element.style.setProperty(name, value);
  };

  const setNumber = (
    element: HTMLElement | null,
    name: string,
    value: number,
    digits = 4,
  ) => setVar(element, name, value.toFixed(digits));

  const setFlag = (element: Element | null, on: boolean) => {
    if (!element) return;

    if (element.classList.contains("is-on") !== on) {
      element.classList.toggle("is-on", on);
    }
  };

  const one = <T extends Element = HTMLElement>(selector: string) =>
    root.querySelector<T & HTMLElement>(selector);

  const all = (selector: string) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ];

  const sections = {
    hero: one("[data-scene=hero]"),
    gather: one("[data-scene=gather]"),
    chapters: one("[data-scene=chapters]"),
    night: one("[data-scene=night]"),
    machines: one("[data-scene=machines]"),
    more: one("[data-scene=more]"),
    switch: one("[data-scene=switch]"),
    dawn: one("[data-scene=dawn]"),
    footer: one("[data-scene=footer]"),
  };

  const anchors = {
    hero: one("[data-anchor=hero-sun]"),
    gather: one("[data-anchor=gather-sun]"),
    chapters: one("[data-anchor=chap-sun]"),
    dawn: one("[data-anchor=dawn-sun]"),
  };

  const sky = one("[data-sky]");
  const poster = one("[data-poster]");
  const navLabel = one("[data-nav-label]");
  const windows = all("[data-win]");
  const lines = all("[data-line]");
  const totality = one("[data-totality]");
  const readout = one("[data-readout]");
  const dawnCopy = one("[data-dawn-copy]");
  const dawnReadout = one("[data-dawn-readout]");
  const heroDecor = one("[data-hero-decor]");
  const band = one("[data-band]");
  const rig = one("[data-rig]");

  let engine: Engine | null = null;
  let live = false;
  let failed = false;
  let modelReady = false;
  let modelProgress = 0;
  let disposed = false;
  let step = -1;
  let raf = 0;
  let lastInput = performance.now();
  let lastRender = 0;
  const startedAt = performance.now();
  const pointerTarget = { x: 0, y: 0 };
  const pointer = { x: 0, y: 0 };

  const handlePointer = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointerTarget.y = (event.clientY / window.innerHeight) * 2 - 1;
    lastInput = performance.now();
  };

  const handleScroll = () => {
    lastInput = performance.now();
  };

  window.addEventListener("pointermove", handlePointer);
  window.addEventListener("scroll", handleScroll, { passive: true });

  const measure = (element: HTMLElement | null, vh: number) => {
    if (!element) return { top: 0, bottom: 0, p: 0, e: 0, present: false };
    const rect = element.getBoundingClientRect();

    return {
      top: rect.top,
      bottom: rect.bottom,
      p: clamp01(-rect.top / Math.max(1, rect.height - vh)),
      e: clamp01((vh - rect.top) / vh),
      present: true,
    };
  };

  const anchorOf = (element: HTMLElement | null): Anchor => {
    if (!element) return { x: 0, y: 0, r: 1 };
    const rect = element.getBoundingClientRect();

    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      r: rect.width / 2,
    };
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);

    if (disposed) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const time = (now - startedAt) / 1000;
    const compact = vw < 760;

    const hero = measure(sections.hero, vh);
    const gather = measure(sections.gather, vh);
    const chapters = measure(sections.chapters, vh);
    const night = measure(sections.night, vh);
    const machines = measure(sections.machines, vh);
    const more = measure(sections.more, vh);
    const switching = measure(sections.switch, vh);
    const dawn = measure(sections.dawn, vh);
    const footer = measure(sections.footer, vh);

    const inDawn = dawn.top < vh;
    const inChapters = !inDawn && chapters.top < vh;
    const g = gather.p;

    let sun = mixAnchor(
      anchorOf(anchors.hero),
      anchorOf(anchors.gather),
      smooth(gather.e),
    );

    if (inChapters) {
      sun = mixAnchor(sun, anchorOf(anchors.chapters), smooth(chapters.e));
    }

    if (inDawn) sun = anchorOf(anchors.dawn);

    const unit = (x: number, y: number) => ({
      x: x / Math.hypot(x, y),
      y: y / Math.hypot(x, y),
    });

    const dir = compact ? unit(-0.22, -1) : unit(-1, -0.2);
    const leaveDir = compact ? unit(1, -0.12) : unit(1, 0.2);
    const startDistance = compact ? 2.3 : START_DISTANCE;

    const lead = gather.e < 1 ? (gather.e - 1) * 0.3 : g;
    const s1 = ramp(lead, -0.07, 0.27);
    const s2 = ramp(g, 0.29, 0.14);
    const form = ramp(g, 0.4, 0.08);
    const transit = smooth(ramp(g, 0.47, 0.39));
    let distance = mix(startDistance, HOLD_DISTANCE, transit);
    let moonOn = smooth(ramp(g, 0.38, 0.1));
    let oForm = form;
    let leave = 0;
    let holdBead = transit >= 1 ? 1 : 0;

    if (inChapters) {
      distance = HOLD_DISTANCE;
      moonOn = 1;
      oForm = 1;
      holdBead = 1;
    }

    if (inDawn) {
      leave = ramp(dawn.p, 0.05, 0.55) ** 1.8;
      distance = mix(HOLD_DISTANCE, LEAVE_DISTANCE, leave);
      moonOn = 1;
      oForm = 1;
      holdBead = leave > 0.02 ? 0 : 1;
    }

    const R = Math.max(1, sun.r);
    const Rm = R * MOON_RATIO;
    const path = inDawn ? leaveDir : dir;

    const moon = {
      x: sun.x + path.x * distance * R,
      y: sun.y + path.y * distance * R,
      r: Rm,
    };

    const coverage = clamp01(
      circleOverlap(distance * R, R, Rm) / (Math.PI * R * R),
    );

    const visible = 1 - coverage;
    const n = coverage ** 1.2;
    const gap = distance - (MOON_RATIO - 1);
    const corona = smoothstep(0.17, -0.004, gap);

    const beadShape =
      gap > 0
        ? smoothstep(0, 0.006, gap) * (1 - smoothstep(0.035, 0.18, gap))
        : 0;

    const bead = beadShape * (holdBead ? 0.55 : 1);
    const beadDir = { x: sun.x - moon.x, y: sun.y - moon.y };
    const beadLen = Math.hypot(beadDir.x, beadDir.y);
    const ux = beadLen > 1e-3 ? beadDir.x / beadLen : 0.7071;
    const uy = beadLen > 1e-3 ? beadDir.y / beadLen : 0.7071;
    const colors = skyAt(n);

    setVar(sky, "--cb-sky-top", css(colors.top));
    setVar(sky, "--cb-sky-mid", css(colors.mid));
    setVar(sky, "--cb-sky-bot", css(colors.bot));
    setNumber(root, "--cb-night", n, 3);
    setNumber(root, "--cb-lt", smoothstep(0.3, 0.17, luminance(colors.bot)), 3);

    const scrollable = document.documentElement.scrollHeight - vh;
    setNumber(
      root,
      "--cb-progress",
      clamp01(window.scrollY / Math.max(1, scrollable)),
    );
    setNumber(heroDecor, "--cb-fade", 1 - ramp(gather.e, 0.05, 0.4), 3);

    const navY = 34;

    const overNight =
      night.present &&
      night.top + vh * FADE_SHARE * 0.5 <= navY &&
      night.bottom - vh * FADE_SHARE * 0.5 >= navY;

    const overFooter =
      (footer.present && footer.top <= navY) ||
      (switching.present && switching.top <= navY);

    const topLum = luminance(colors.top);

    const navLight = overFooter
      ? 0
      : overNight
        ? 1
        : smoothstep(0.42, 0.24, topLum);

    setNumber(root, "--cb-nav-lt", navLight, 3);
    setNumber(
      root,
      "--cb-nav-veil",
      overFooter ||
        overNight ||
        (hero.top < -24 && gather.top > 0) ||
        (chapters.top < 0 &&
          chapters.bottom > 0 &&
          chapters.bottom < vh * 1.05) ||
        (dawn.top < 0 && dawn.bottom > 0 && dawn.bottom < vh * 1.05)
        ? 1
        : 0,
      0,
    );

    windows.forEach((element, index) => {
      setFlag(element, s1 > 0.06 + index * 0.115 && s2 < 0.18);
    });

    lines.forEach((element, index) => {
      const on = s1 > 0.08 + index * 0.24 && s2 < 0.1;

      const next =
        s1 > 0.08 + (index + 1) * 0.24 && index < STORY_LINES.length - 1;

      setFlag(element, on);
      element.classList.toggle("is-past", on && next);
    });

    setFlag(totality, g > 0.55 && chapters.e < 0.2);

    if (totality) {
      const dark = luminance(mixLab3(colors.mid, colors.bot));
      const lit = totality.classList.contains("is-lt");

      if (lit ? dark > 0.24 : dark < 0.2) {
        totality.classList.toggle("is-lt", !lit);
      }
    }

    if (readout) {
      const text =
        g < 0.27
          ? ""
          : g < 0.44
            ? modelReady || failed
              ? "Gathering"
              : `Loading the 3D O · ${Math.round(modelProgress * 100)}%`
            : coverage <= 0.001
              ? "Before first contact"
              : gap > 0
                ? `Partial eclipse · ${Math.round(coverage * 100)}%`
                : "Totality";

      if (readout.textContent !== text) readout.textContent = text;
      setFlag(readout, text !== "" && g <= 0.55);
    }

    if (dawnReadout) {
      const text =
        leave < 0.003
          ? "Totality"
          : gap < 0.22
            ? "Third contact"
            : `Light returns · ${Math.round(visible * 100)}%`;

      if (dawnReadout.textContent !== text) dawnReadout.textContent = text;
    }

    setFlag(dawnCopy, dawn.e > 0.2);

    let nextStep = 0;

    if (chapters.top <= 0) {
      nextStep = Math.min(
        CHAPTERS.length - 1,
        Math.floor(chapters.p * CHAPTERS.length * 0.999),
      );
    }

    if (nextStep !== step) {
      step = nextStep;
      callbacks.onStep(step);
    }

    setFlag(band, chapters.e > 0.36);
    setNumber(sections.chapters, "--cb-rise", smooth(chapters.e), 3);

    const frameEl = rig?.querySelector<HTMLElement>("[data-win-frame]") ?? null;

    if (frameEl && inChapters) {
      const rect = frameEl.getBoundingClientRect();
      setVar(
        frameEl,
        "--cb-lx",
        `${(((sun.x - rect.left) / Math.max(1, rect.width)) * 100).toFixed(2)}%`,
      );
      setVar(
        frameEl,
        "--cb-ly",
        `${(((sun.y - rect.top) / Math.max(1, rect.height)) * 100).toFixed(2)}%`,
      );
      setNumber(frameEl, "--cb-glow", corona, 3);
    }

    let label: string = READOUTS.hero;

    if (gather.top <= vh * 0.5) {
      label =
        g < 0.27
          ? READOUTS.scattered
          : coverage <= 0.001
            ? READOUTS.gathering
            : gap > 0
              ? `${READOUTS.partial} · ${Math.round(coverage * 100)}%`
              : READOUTS.totality;
    }

    if (chapters.top <= vh * 0.5) {
      const chapter = CHAPTERS[Math.max(0, step)];
      label = chapter ? `${chapter.number} ${chapter.name}` : label;
    }

    if (machines.top <= vh * 0.5) label = READOUTS.machines;

    if (more.top <= vh * 0.5) label = READOUTS.more;

    if (dawn.top <= vh * 0.5) label = READOUTS.dawn;

    if (switching.top <= vh * 0.5) label = READOUTS.switch;

    if (footer.top <= vh * 0.5) label = "Omnyo";

    if (navLabel && navLabel.textContent !== label)
      navLabel.textContent = label;

    if (poster && failed) {
      setNumber(poster, "--sx", sun.x, 1);
      setNumber(poster, "--sy", sun.y, 1);
      setNumber(poster, "--sr", R, 1);
      setNumber(poster, "--mx", moon.x - sun.x, 1);
      setNumber(poster, "--my", moon.y - sun.y, 1);
      setNumber(poster, "--mon", moonOn, 3);
      setNumber(poster, "--corona", corona, 3);
      setNumber(poster, "--vis", visible, 3);
    }

    const covered =
      (night.present &&
        night.top + vh * FADE_SHARE <= 0 &&
        night.bottom - vh * FADE_SHARE >= vh) ||
      (switching.present && switching.top <= 0) ||
      (footer.present && footer.top <= 0);

    if (!engine || failed || covered) return;
    const calm = now - lastInput > 2600;

    if (calm && now - lastRender < 1000 / 30 - 2) return;
    lastRender = now;

    pointer.x += (pointerTarget.x - pointer.x) * 0.08;
    pointer.y += (pointerTarget.y - pointer.y) * 0.08;

    const windowRects: Vec4[] = windows.map((element) => {
      const rect = element.getBoundingClientRect();

      return [rect.left, rect.top, rect.width, rect.height];
    });

    while (windowRects.length < WINDOW_COUNT) windowRects.push([0, 0, 0, 0]);

    const oOpacity = modelReady ? smooth(oForm) : 0;
    const particleAlpha = modelReady ? 1 - oOpacity : 1;
    const turn = inChapters || inDawn ? 0 : 1 - transit;
    const sway = Math.sin(time * 0.31) * 0.05;
    const leaveTurn = leave * -0.32;

    const frameData: EngineFrame = {
      width: vw,
      height: vh,
      time,
      sky: colors,
      sun,
      moon: { ...moon, on: moonOn },
      night: n,
      visible,
      corona,
      stars: smoothstep(0.8, 1, n),
      grain: Math.max(0.007, 0.03 * n),
      bead: {
        x: sun.x + ux * R,
        y: sun.y + uy * R,
        intensity: bead,
        streak: bead * 0.9,
      },
      o: {
        opacity: oOpacity,
        rx: -0.16 * turn + pointer.y * 0.08 + Math.sin(time * 0.27) * 0.03,
        ry: 0.42 * turn + leaveTurn + pointer.x * 0.1 + sway,
        rz: 0.22 * turn + Math.sin(time * 0.11) * 0.05,
        env: mix(0.3, 0.12, n),
        rim: mix(1.5, 2.3, smoothstep(0.2, 0.9, n)),
        key: mix(1.5, 0, smoothstep(0, 0.8, n)),
        back: mix(0.55, 1, n),
        rimDir: [ux, -uy],
      },
      particles: {
        stage: inChapters || inDawn ? 2 : s1 + s2,
        alpha: particleAlpha,
        intro: clamp01((now - startedAt - 120) / 1700),
        color: [
          mix(INK[0], GLOW[0], smoothstep(0.35, 0.65, n)),
          mix(INK[1], GLOW[1], smoothstep(0.35, 0.65, n)),
          mix(INK[2], GLOW[2], smoothstep(0.35, 0.65, n)),
        ],
        ringTurn: 0.42 * turn + leaveTurn + sway,
        orbitScale: compact ? 0.9 : 1,
        windows: windowRects,
      },
    };

    engine.render(frameData);

    if (!live) {
      live = true;
      callbacks.onLive();
    }
  };

  raf = requestAnimationFrame(frame);

  return {
    attach: (next) => {
      engine = next;
    },
    modelReady: () => {
      modelReady = true;
    },
    modelProgress: (fraction) => {
      modelProgress = fraction;
    },
    fail: () => {
      failed = true;
      engine = null;
    },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", handlePointer);
      window.removeEventListener("scroll", handleScroll);
    },
  };
}
