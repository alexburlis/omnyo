import { subscribeTheme } from "../../lib/theme";
import { ACTS } from "./content";
import {
  type DiscTrack,
  clamp01,
  DISC_RANGE,
  createScrollTimeline,
  discFrames,
  discScale,
  ramp,
  rangeFrames,
  reach,
  smooth,
  wipeRadius,
} from "./disc-frames";
import {
  RAIN_SPAN,
  WINDOW_COUNT,
  createParticles,
  type ParticleFrame,
  type Vec4,
} from "./particles";
import {
  FIXED_TONES,
  type Tones,
  readTones,
  toneBg,
  toneFg,
  toneFgUnit,
} from "./tones";

const MAX_DPR = 2;

const MAX_PHONE_DPR = 1.5;

const PHONE_PARTICLES = 6000;

const DESKTOP_PARTICLES = 12000;

const STREAM_MARGIN = 64;

const TEXT_STEPS = 4;

const SETTLE_MS = 800;

const REFRESH_FRAMES = 30;

const INTRO_MS = 2400;

const NAV_HEIGHT = 68;

const PHONE_MAX_WIDTH = 820;

const HERO_WIPE = [0.3, 0.62] as const;

const PHONE_APP_WIPE = [0.1, 0.4] as const;

const DISC_RING = 2;

const DISC_TAIL = 3;

const DISC_HIDE = 1;

const STORY_MARK_RISE = 0.03;

const STORY_VH = {
  rain: 90,
  lines: [-10, 14, 40, 76],
  waiting: 76,
  gather: [86, 20],
  flow: [84, 56],
  light: [98, 38],
  act: 104,
  orbit: [100, 48],
  title: 112,
  sub: 128,
  with: [120, 12],
  rise: [96, 64],
  leave: [172, 14],
} as const;

const progressVar = (element: HTMLElement) =>
  element.dataset.progress === "local" ? "--sp" : "--p";

const windowStart = (index: number) =>
  ((index / WINDOW_COUNT) * 0.85 + 0.075) * (1 - RAIN_SPAN);

interface Wipe {
  t: number;
  x: number;
  y: number;
  stage: number;
  disc?: HTMLElement | null;
}

const centerOf = (rect: DOMRect | undefined, vw: number, vh: number) =>
  rect
    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    : { x: vw / 2, y: vh / 2 };

const FOLLOWS = 4;

const wipeOrder = (elements: readonly (HTMLElement | null)[]) =>
  elements
    .map((_, index) => index)
    .sort((a, b) => {
      const first = elements[a];
      const second = elements[b];

      if (!first || !second || first === second) return a - b;

      return first.compareDocumentPosition(second) & FOLLOWS ? -1 : 1;
    });

export function startStory(
  root: HTMLElement,
  reduced: boolean,
  {
    labels = ACTS,
    onProductProgress,
    productStage = false,
    themed = false,
  }: {
    labels?: readonly string[];
    onProductProgress?: (progress: number) => void;
    productStage?: boolean;
    themed?: boolean;
  } = {},
) {
  let tones: Tones = themed ? readTones(getComputedStyle(root)) : FIXED_TONES;

  const bgAt = (stage: number) => toneBg(tones, stage);

  const fgAt = (stage: number) => toneFg(tones, stage);

  const cache = new WeakMap<HTMLElement, Map<string, string>>();

  const setVar = (element: HTMLElement, name: string, value: string) => {
    let entries = cache.get(element);

    if (!entries) {
      entries = new Map();
      cache.set(element, entries);
    }

    if (entries.get(name) === value) return;
    entries.set(name, value);
    element.style.setProperty(name, value);
  };

  const numbers = new WeakMap<HTMLElement, Map<string, number>>();

  const setNumber = (element: HTMLElement, name: string, value: number) => {
    let entries = numbers.get(element);

    if (!entries) {
      entries = new Map();
      numbers.set(element, entries);
    }

    const step = Math.round(value * 10000);

    if (entries.get(name) === step) return;
    entries.set(name, step);
    element.style.setProperty(name, String(step / 10000));
  };

  const scene = (name: string) =>
    root.querySelector<HTMLElement>(`[data-scene="${name}"]`);

  const anchor = (name: string) =>
    root.querySelector<HTMLElement>(`[data-anchor="${name}"]`);

  const scenes = {
    hero: scene("hero"),
    story: scene("story"),
    app: scene("app"),
    review: scene("review"),
    more: scene("more"),
    yours: scene("yours"),
    cta: scene("cta"),
    footer: scene("footer"),
  };

  const flows = [...root.querySelectorAll<HTMLElement>("[data-flow]")];

  const heroMark = anchor("hero-mark");
  const storyMark = anchor("story-mark");
  const ctaMark = anchor("cta-mark");
  const stream = anchor("stream");
  const winLayer = root.querySelector<HTMLElement>("[data-win-layer]");
  const windows = [...root.querySelectorAll<HTMLElement>("[data-win]")];
  const lines = [...root.querySelectorAll<HTMLElement>("[data-line]")];
  const navLabel = root.querySelector<HTMLElement>("[data-act-label]");
  const progressBar = root.querySelector<HTMLElement>("[data-progress]");
  const nav = root.querySelector<HTMLElement>(".nav");
  const navShade = root.querySelector<HTMLElement>("[data-nav-shade]");
  const storyPin = scenes.story?.querySelector<HTMLElement>(".story-pin");

  const storyTitle =
    storyPin?.querySelector<HTMLElement>(".story-title") ?? null;

  const veil = root.querySelector<HTMLElement>("[data-veil]");

  const disc = (name: string) =>
    root.querySelector<HTMLElement>(`[data-disc="${name}"]`);

  const discs = { hero: disc("hero"), story: disc("story"), app: disc("app") };

  const navDisc = (name: string) =>
    navShade?.querySelector<HTMLElement>(`[data-nav-disc="${name}"]`) ?? null;

  const navDiscs = {
    hero: navDisc("hero"),
    story: navDisc("story"),
    app: navDisc("app"),
  };

  let discRadius = 1;
  let discHalf = 1;
  let storyMarkBase = { x: 0, y: 0 };
  let storyDiscBase = { x: 0, y: 0 };
  let shadeOrigin = { x: 0, y: 0 };
  const discTimeline = createScrollTimeline();

  const discRuns = new Map<
    HTMLElement,
    { key: string; animation: Animation; effect: KeyframeEffect }
  >();

  const stopDisc = (element: HTMLElement) => {
    discRuns.get(element)?.animation.cancel();
    discRuns.delete(element);
  };

  const stopDiscs = () => {
    for (const element of [...discRuns.keys()]) stopDisc(element);
  };

  const runDisc = (
    element: HTMLElement,
    track: DiscTrack,
    place: (scroll: number) => { x: number; y: number },
    vw: number,
    vh: number,
  ) => {
    if (!discTimeline) return;
    const tail = vh * DISC_TAIL;
    const coverHeight = Math.max(vh, window.screen.height);
    const center = track.center(track.start);
    const from = place(track.start);
    const to = place(track.start + track.length);

    const key = [
      vw,
      vh,
      coverHeight,
      track.start,
      track.length,
      center.x,
      center.y,
      from.x,
      from.y,
      to.x,
      to.y,
      discHalf,
    ]
      .map(Math.round)
      .join("|");

    const run = discRuns.get(element);

    if (run?.key === key) return;

    const frames = rangeFrames(
      discFrames(track, tail, vw, vh, discRadius, coverHeight),
    ).map(({ offset, scroll, scale }) => {
      const { x, y } = place(scroll);

      return {
        offset,
        transform: `translate(${(x - discHalf).toFixed(2)}px, ${(y - discHalf).toFixed(2)}px) scale(${scale.toFixed(4)})`,
      };
    });

    if (run) {
      run.effect.setKeyframes(frames);
      run.key = key;

      return;
    }

    const animation = element.animate(frames, {
      timeline: discTimeline,
      rangeStart: "0px",
      rangeEnd: `${DISC_RANGE}px`,
      fill: "both",
      easing: "linear",
    });

    if (animation.effect instanceof KeyframeEffect) {
      discRuns.set(element, { key, animation, effect: animation.effect });
    }
  };

  const canvas = root.querySelector<HTMLCanvasElement>("[data-particles]");
  const pins: HTMLElement[] = [];

  for (const element of [winLayer, storyMark, stream, ctaMark]) {
    const pin = element?.closest<HTMLElement>(".pin");

    if (pin && !pins.includes(pin)) pins.push(pin);
  }

  const toned = [...flows, scenes.yours, productStage ? scenes.app : null];

  const flag = (
    element: HTMLElement | null | undefined,
    name: string,
    value: string | null,
  ) => {
    if (!element) return;

    if (value === null) {
      if (element.dataset[name] !== undefined) delete element.dataset[name];

      return;
    }

    if (element.dataset[name] !== value) element.dataset[name] = value;
  };

  const clearMarks = () => {
    delete root.dataset.reveal;

    for (const element of toned) {
      if (element) delete element.dataset.tone;
    }
  };

  if (reduced) {
    clearMarks();

    for (const [name, element] of Object.entries(scenes)) {
      if (element) {
        setNumber(element, progressVar(element), name === "story" ? 0.42 : 1);
      }
    }

    for (const element of flows) {
      setNumber(element, progressVar(element), 1);
    }

    for (const element of windows) {
      setNumber(element, "--w", 1);
      element.classList.add("is-live");
    }

    for (const element of lines) flag(element, "state", "on");

    if (storyPin) {
      setNumber(storyPin, "--gather", 0);
      setNumber(storyPin, "--orbit", 1);
      setNumber(storyPin, "--rise", 0.5);
      setNumber(storyPin, "--leave", 0);
      flag(storyPin, "title", "");
      flag(storyPin, "sub", "");
    }

    const paintBase = () => {
      setVar(root, "--bg", bgAt(0));
      setVar(root, "--fg", fgAt(0));
    };

    paintBase();
    onProductProgress?.(0);

    return themed
      ? subscribeTheme(() => {
          tones = readTones(getComputedStyle(root));
          paintBase();
        })
      : () => {};
  }

  let tone = 0;

  for (const element of flows) {
    if (element.dataset.wipe) tone = element.dataset.wipe === "stage" ? 1 : 0;
    element.dataset.tone = tone ? "stage" : "base";
  }

  if (scenes.yours) scenes.yours.dataset.tone = "stage";

  if (productStage && scenes.app) scenes.app.dataset.tone = "stage";

  root.dataset.reveal = "on";

  const revealer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting && entry.boundingClientRect.top > 0) {
          continue;
        }

        if (entry.target instanceof HTMLElement) entry.target.dataset.in = "";
        revealer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px" },
  );

  for (const element of flows) {
    if (element.dataset.in === undefined) revealer.observe(element);
  }

  let particles: ReturnType<typeof createParticles> | null = null;
  const width = window.innerWidth;

  try {
    if (canvas)
      particles = createParticles(
        canvas,
        width < 720 ? PHONE_PARTICLES : DESKTOP_PARTICLES,
      );
  } catch (error) {
    console.error("Particle field failed to start", error);
  }

  let layoutKey = "";
  let drawn = true;
  const view = { w: window.innerWidth, h: window.innerHeight };
  const pointerTarget = { x: -9999, y: -9999, inside: false };
  const pointer = { x: -9999, y: -9999, on: 0, tilt: 0 };

  const handlePointer = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    pointerTarget.x = event.clientX - view.w / 2;
    pointerTarget.y = view.h / 2 - event.clientY;
    pointerTarget.inside = true;

    if (pointer.x < -9000) {
      pointer.x = pointerTarget.x;
      pointer.y = pointerTarget.y;
    }
  };

  const handleLeave = () => {
    pointerTarget.inside = false;
  };

  const viewport = { w: window.innerWidth, h: window.innerHeight };
  let navHeight = NAV_HEIGHT;

  const handleResize = () => {
    viewport.w = window.innerWidth;
    viewport.h = window.innerHeight;
    view.w = canvas?.clientWidth || viewport.w;
    view.h = canvas?.clientHeight || viewport.h;
    navHeight = nav?.offsetHeight || NAV_HEIGHT;
    const discSize = discs.story?.offsetWidth ?? 0;
    discHalf = Math.max(1, discSize / 2);
    discRadius = Math.max(1, discSize / 2 - DISC_RING);

    storyMarkBase = {
      x: storyMark?.offsetLeft ?? 0,
      y: storyMark?.offsetTop ?? 0,
    };

    storyDiscBase = {
      x: discs.story?.offsetLeft ?? 0,
      y: discs.story?.offsetTop ?? 0,
    };

    const shade = navShade?.getBoundingClientRect();
    shadeOrigin = { x: shade?.left ?? 0, y: shade?.top ?? 0 };
  };

  handleResize();

  window.addEventListener("resize", handleResize);
  window.visualViewport?.addEventListener("resize", handleResize);
  window.addEventListener("pointermove", handlePointer);
  document.documentElement.addEventListener("pointerleave", handleLeave);

  const startedAt = performance.now();
  let raf = 0;
  let last = startedAt;

  const measure = (element: HTMLElement | null, vh: number) => {
    if (!element) return { p: 0, e: 0, rect: null };
    const rect = element.getBoundingClientRect();

    return {
      p: clamp01(-rect.top / Math.max(1, rect.height - vh)),
      e: clamp01((vh - rect.top) / vh),
      rect,
    };
  };

  const rectOf = (element: HTMLElement | null) =>
    element?.getBoundingClientRect();

  const markFrom = (rect: DOMRect | undefined, rotation: number): Vec4 => {
    if (!rect) return [0, 0, 0, rotation];

    return [
      rect.left + rect.width / 2 - view.w / 2,
      view.h / 2 - (rect.top + rect.height / 2),
      Math.min(rect.width, rect.height),
      rotation,
    ];
  };

  const liveWindows = windows.map(() => false);

  const windowRects: Vec4[] = Array.from(
    { length: WINDOW_COUNT },
    () => [0, 0, 0, 0] as Vec4,
  );

  let order: number[] | null = null;

  const isPinned = (pin: HTMLElement) => {
    const track = pin.parentElement?.getBoundingClientRect();

    return Boolean(track && track.top < 0 && track.bottom > pin.offsetHeight);
  };

  const canvasPlace = () => {
    const page = root.getBoundingClientRect();

    return {
      rides: page.bottom >= view.h && !pins.some(isPinned),
      x: -page.left,
      y: -page.top,
    };
  };

  const placeCanvas = ({ rides, x, y }: ReturnType<typeof canvasPlace>) => {
    if (!canvas) return;
    canvas.classList.toggle("is-riding", rides);
    setVar(
      canvas,
      "transform",
      rides ? `translate3d(${x}px, ${y}px, 0)` : "none",
    );
  };

  const updateDom = (vw: number, vh: number) => {
    const phone = vw <= PHONE_MAX_WIDTH;
    const place = canvasPlace();
    const hero = measure(scenes.hero, vh);
    const story = measure(scenes.story, vh);
    const app = measure(scenes.app, vh);
    const review = measure(scenes.review, vh);
    const more = measure(scenes.more, vh);
    const yours = measure(scenes.yours, vh);
    const cta = measure(scenes.cta, vh);
    const footer = measure(scenes.footer, vh);

    const heroRect = rectOf(heroMark);
    const storyRect = rectOf(storyMark);
    const ctaRect = rectOf(ctaMark);
    const streamRect = rectOf(stream);
    const titleRect = rectOf(storyTitle);
    const layerRect = winLayer?.getBoundingClientRect();
    const scrollable = document.documentElement.scrollHeight - vh;

    windows.forEach((element, index) => {
      const rect = windowRects[index];

      if (!rect) return;
      rect[0] = (layerRect?.left ?? 0) + element.offsetLeft;
      rect[1] = (layerRect?.top ?? 0) + element.offsetTop;
      rect[2] = element.offsetWidth;
      rect[3] = element.offsetHeight;
    });

    const storyY = story.rect ? (-story.rect.top / vh) * 100 : -100;

    const during = ([start, length]: readonly [number, number]) =>
      ramp(storyY, start, length);

    const s1 =
      ramp(story.e, 0.4, 0.6) * 0.3 + ramp(storyY, 0, STORY_VH.rain) * 0.7;

    const s2 = during(STORY_VH.flow);
    const s3 = ramp(app.e, 0.12, 0.78);
    const s4 = ramp(yours.e, 0.25, 0.6);
    const s5 = ramp(cta.e, 0.2, 0.7);
    const stage = s1 + s2 + s3 + s4 + s5;

    const heroCenter = centerOf(heroRect, vw, vh);
    const storyCenter = centerOf(storyRect, vw, vh);
    const ctaCenter = centerOf(ctaRect, vw, vh);

    const flowed = flows.map((element) => measure(element, vh));

    const sourced: [HTMLElement | null, Wipe][] = [
      [
        scenes.story,
        {
          t: ramp(story.e, ...HERO_WIPE),
          ...heroCenter,
          stage: 1,
          disc: discs.hero,
        },
      ],
      [
        scenes.story,
        {
          t: during(STORY_VH.light),
          ...storyCenter,
          stage: 0,
          disc: discs.story,
        },
      ],
      [
        scenes.app,
        productStage
          ? phone
            ? {
                t: ramp(app.e, ...PHONE_APP_WIPE),
                x: vw / 2,
                y: app.rect ? app.rect.top : vh,
                stage: 1,
                disc: discs.app,
              }
            : { t: ramp(app.e, 0.04, 0.5), ...storyCenter, stage: 1 }
          : { t: 0, x: 0, y: 0, stage: 0 },
      ],
      [
        scenes.yours,
        {
          t: ramp(yours.e, 0.05, 0.62),
          x: streamRect ? streamRect.left : 0,
          y: streamRect ? streamRect.top + streamRect.height / 2 : vh,
          stage: 1,
        },
      ],
      [scenes.cta, { t: ramp(cta.e, 0.22, 0.5), ...ctaCenter, stage: 0 }],
    ];

    flows.forEach((element, index) => {
      const tone = element.dataset.wipe;

      if (!tone) return;
      sourced.push([
        element,
        {
          t: ramp(flowed[index]?.e ?? 0, 0.08, 0.5),
          x: vw / 2,
          y: vh,
          stage: tone === "stage" ? 1 : 0,
        },
      ]);
    });

    const wipes: Wipe[] = [];

    order ??= wipeOrder(sourced.map(([element]) => element));

    for (const index of order) {
      const wipe = sourced[index]?.[1];

      if (!wipe || wipe.stage === (wipes.at(-1)?.stage ?? 0)) continue;
      wipes.push(wipe);
    }

    let active = -1;
    wipes.forEach((wipe, index) => {
      if (wipe.t > 0) active = index;
    });
    const current = wipes[active];
    const fromStage = active > 0 ? (wipes[active - 1]?.stage ?? 0) : 0;
    const toStage = current?.stage ?? 0;
    const wipeT = current ? smooth(current.t) : 0;
    const vx = current?.x ?? vw / 2;
    const vy = current?.y ?? vh / 2;

    const vr = current ? wipeRadius(wipeT, vx, vy, vw, vh) : 0;

    const textMix = current
      ? Math.round(smooth(ramp(current.t, 0.36, 0.2)) * TEXT_STEPS) / TEXT_STEPS
      : 0;

    const toneMix = fromStage + (toStage - fromStage) * textMix;
    const bgColor = bgAt(toneMix);
    const fgColor = fgAt(toneMix);

    const footTop = footer.rect ? footer.rect.top : vh;

    const sceneProgress: [HTMLElement | null, ReturnType<typeof measure>][] = [
      [scenes.hero, hero],
      [scenes.story, story],
      [scenes.app, app],
      [scenes.review, review],
      [scenes.more, more],
      [scenes.yours, yours],
      [scenes.cta, cta],
    ];

    flows.forEach((element, index) => {
      const entry = flowed[index];

      if (entry) sceneProgress.push([element, entry]);
    });

    const navTone = phone
      ? sceneProgress.find(
          ([element, entry]) =>
            element?.dataset.tone !== undefined &&
            entry.rect !== null &&
            entry.rect.top <= navHeight &&
            navHeight < entry.rect.bottom,
        )?.[0]?.dataset.tone
      : undefined;

    const navStage = navTone === undefined ? null : navTone === "stage" ? 1 : 0;

    if (nav) {
      setVar(nav, "--nav-bg", navStage === null ? bgColor : bgAt(navStage));
      setVar(nav, "--nav-fg", navStage === null ? fgColor : fgAt(navStage));
    }

    const moving = wipeT > 0 && wipeT < 1;

    const heroOffset =
      heroRect && story.rect
        ? {
            x: Math.round(heroCenter.x - story.rect.left),
            y: Math.round(heroCenter.y - story.rect.top),
          }
        : null;

    if (discs.hero && heroOffset) {
      setVar(discs.hero, "--dx", `${heroOffset.x}px`);
      setVar(discs.hero, "--dy", `${heroOffset.y}px`);
    }

    let held = false;

    if (phone && discTimeline) {
      const scrolled = window.scrollY;
      const storyTop = story.rect ? story.rect.top + scrolled : null;
      const appTop = app.rect ? app.rect.top + scrolled : null;
      const heroY = heroCenter.y + scrolled;

      const heroPlace = heroOffset ?? { x: 0, y: 0 };
      const still = { x: 0, y: 0 };

      const plans: {
        disc: HTMLElement | null;
        nav: HTMLElement | null;
        track: DiscTrack | null;
        place: { x: number; y: number };
        seen: (scroll: number) => { x: number; y: number };
        tone: number;
      }[] = [
        {
          disc: discs.hero,
          nav: navDiscs.hero,
          track:
            storyTop === null || !heroOffset
              ? null
              : {
                  start: storyTop - vh * (1 - HERO_WIPE[0]),
                  length: vh * HERO_WIPE[1],
                  center: (scroll) => ({ x: heroCenter.x, y: heroY - scroll }),
                },
          place: heroPlace,
          seen: (scroll) => ({ x: heroCenter.x, y: heroY - scroll }),
          tone: 1,
        },
        {
          disc: discs.story,
          nav: navDiscs.story,
          track:
            storyTop === null
              ? null
              : {
                  start: storyTop + (vh * STORY_VH.light[0]) / 100,
                  length: (vh * STORY_VH.light[1]) / 100,
                  center: (scroll) => {
                    const rise = ramp(
                      ((scroll - storyTop) / vh) * 100,
                      ...STORY_VH.rise,
                    );

                    return {
                      x: storyMarkBase.x,
                      y: storyMarkBase.y + (0.5 - rise) * vh * STORY_MARK_RISE,
                    };
                  },
                },
          place: still,
          seen: () => storyDiscBase,
          tone: 0,
        },
        {
          disc: discs.app,
          nav: navDiscs.app,
          track:
            appTop === null || !productStage
              ? null
              : {
                  start: appTop - vh * (1 - PHONE_APP_WIPE[0]),
                  length: vh * PHONE_APP_WIPE[1],
                  center: (scroll) => ({ x: vw / 2, y: appTop - scroll }),
                },
          place: still,
          seen: (scroll) => ({ x: vw / 2, y: (appTop ?? 0) - scroll }),
          tone: 1,
        },
      ];

      for (const { disc: main, nav: copy, track, place, seen, tone } of plans) {
        const done =
          track !== null &&
          scrolled >= track.start + track.length + vh * DISC_HIDE;

        if (main && track && main === current?.disc && !done) held = true;

        const drives: [
          HTMLElement | null,
          (scroll: number) => { x: number; y: number },
        ][] = [
          [main, () => place],
          [
            main ? copy : null,
            (scroll) => {
              const { x, y } = seen(scroll);

              return { x: x - shadeOrigin.x, y: y - shadeOrigin.y };
            },
          ],
        ];

        for (const [element, at] of drives) {
          if (!element) continue;
          setNumber(element, "--ds", 0);

          if (!track) {
            stopDisc(element);
            flag(element, "done", null);
            continue;
          }

          setVar(element, "--disc-in", bgAt(tone));
          runDisc(element, track, at, vw, vh);

          flag(element, "done", done ? "" : null);
        }
      }
    } else {
      stopDiscs();
      const growing = phone && moving ? (current?.disc ?? null) : null;

      for (const element of [discs.hero, discs.story, discs.app]) {
        if (!element) continue;
        const on = element === growing;
        setNumber(element, "--ds", on ? discScale(vr, discRadius) : 0);
        flag(element, "done", null);

        if (on) setVar(element, "--disc-in", bgAt(toStage));
      }
    }

    for (const layer of [veil, navShade]) {
      if (!layer) continue;

      if (layer === veil && phone) {
        setVar(layer, "--vr", current && !moving && !held ? "99999px" : "0px");
        setVar(layer, "--v-in", bgAt(toStage));
        setVar(layer, "--v-out", bgAt(current ? fromStage : 0));
        setNumber(layer, "--v-edge", 0);
        continue;
      }

      if (layer === navShade && navStage !== null) {
        setVar(layer, "--vr", "99999px");
        setVar(layer, "--v-in", bgAt(navStage));
        setVar(layer, "--v-out", bgAt(navStage));
        setNumber(layer, "--v-edge", 0);
        continue;
      }

      if (
        layer === navShade &&
        phone &&
        current?.disc &&
        discRuns.has(current.disc)
      ) {
        setVar(layer, "--vr", moving || held ? "0px" : "99999px");
        setVar(layer, "--v-in", bgAt(toStage));
        setVar(layer, "--v-out", bgAt(fromStage));
        setNumber(layer, "--v-edge", 0);
        continue;
      }

      if (moving) {
        setVar(layer, "--vx", `${vx.toFixed(1)}px`);
        setVar(layer, "--vy", `${vy.toFixed(1)}px`);
        setVar(layer, "--vr", `${vr.toFixed(1)}px`);
      } else {
        setVar(layer, "--vr", current ? "99999px" : "0px");
      }

      setVar(layer, "--v-in", bgAt(toStage));
      setVar(layer, "--v-out", bgAt(current ? fromStage : 0));
      setNumber(layer, "--v-edge", moving ? 1 : 0);
    }

    if (navShade) {
      setVar(
        navShade,
        "--foot-top",
        `${Math.min(Math.max(Math.round(footTop), -1), NAV_HEIGHT + 1)}px`,
      );
    }

    if (progressBar) {
      setVar(
        progressBar,
        "transform",
        `scaleX(${clamp01(window.scrollY / Math.max(1, scrollable)).toFixed(4)})`,
      );
    }

    for (const [element, entry] of sceneProgress) {
      if (!element || !entry.rect) continue;

      if (element.dataset.flow === undefined) {
        setNumber(
          element,
          progressVar(element),
          entry.rect.top > 0 ? entry.e - 1 : entry.p,
        );
      }

      if (entry.rect.top < vh && entry.rect.bottom > 0) {
        setVar(element, "--bg", bgColor);
        setVar(element, "--fg", fgColor);
        setNumber(element, "--stage-mix", toneMix);
      }
    }

    const localS1 = Math.min(s1, 1);
    windows.forEach((element, index) => {
      const formed = ramp(localS1, windowStart(index) + RAIN_SPAN * 0.7, 0.1);
      setNumber(element, "--w", formed);
      const live = liveWindows[index] ?? false;

      if (!live && formed >= 0.6) {
        liveWindows[index] = true;
        element.classList.add("is-live");
      } else if (live && formed <= 0.05) {
        liveWindows[index] = false;
        element.classList.remove("is-live");
      }
    });

    const shown = (at: number | undefined) => at !== undefined && storyY >= at;

    lines.forEach((element, index) => {
      flag(
        element,
        "state",
        shown(STORY_VH.lines[index + 1])
          ? "past"
          : shown(STORY_VH.lines[index])
            ? "on"
            : null,
      );
    });

    if (
      storyPin &&
      story.rect &&
      story.rect.top < vh &&
      story.rect.bottom > 0
    ) {
      setNumber(storyPin, "--gather", during(STORY_VH.gather));
      setNumber(storyPin, "--orbit", smooth(during(STORY_VH.orbit)));
      setNumber(storyPin, "--rise", during(STORY_VH.rise));
      setNumber(storyPin, "--with", during(STORY_VH.with));
      setNumber(storyPin, "--leave", during(STORY_VH.leave));

      const lit = titleRect
        ? smooth(during(STORY_VH.light)) *
            (reach(storyCenter.x, storyCenter.y, vw, vh) + 4) >=
          Math.hypot(titleRect.width * 0.4, titleRect.bottom - storyCenter.y)
        : true;

      const titled = shown(STORY_VH.title) && lit;

      flag(storyPin, "waiting", shown(STORY_VH.waiting) ? "" : null);
      flag(storyPin, "title", titled ? "" : null);
      flag(storyPin, "sub", titled && shown(STORY_VH.sub) ? "" : null);
    }

    const center = vh / 2;
    let act = 0;
    let flowLabel: string | undefined;

    const ordered: [number, { rect: DOMRect | null }, HTMLElement | null][] = [
      [0, hero, scenes.hero],
      [1, story, scenes.story],
      [3, app, scenes.app],
      [4, review, scenes.review],
      [5, more, scenes.more],
      [6, yours, scenes.yours],
      [7, cta, scenes.cta],
      [7, footer, scenes.footer],
    ];

    flows.forEach((element, index) => {
      const entry = flowed[index];

      if (entry) ordered.push([-1, entry, element]);
    });

    let top = Number.NEGATIVE_INFINITY;

    for (const [index, entry, element] of ordered) {
      if (!entry.rect || entry.rect.top > center || entry.rect.top < top) {
        continue;
      }

      top = entry.rect.top;
      act = index;
      flowLabel = index < 0 ? (element?.dataset.act ?? "") : undefined;
    }

    if (act === 1 && storyY > STORY_VH.act) act = 2;

    if (scenes.review) {
      setNumber(
        scenes.review,
        "--s",
        review.p >= 0.62 ? 2 : review.p >= 0.3 ? 1 : 0,
      );
    }

    if (navLabel) {
      const label = flowLabel ?? labels[act] ?? "";

      if (navLabel.textContent !== label) navLabel.textContent = label;
    }

    onProductProgress?.(app.rect && app.rect.top <= 0 ? app.p : 0);
    placeCanvas(place);

    return {
      stage,
      s2,
      s5,
      ctaHold: cta.p,
      footerE: footer.e,
      streamFade: streamRect
        ? clamp01((streamRect.top - NAV_HEIGHT - 24) / (vh * 0.25))
        : 0,
      toStage,
      fromStage,
      wiping: Boolean(current),
      vx,
      vy,
      vr,
      heroRect,
      storyRect,
      ctaRect,
      streamRect,
    };
  };

  let state: ReturnType<typeof updateDom> | null = null;
  let lastScroll = -1;
  let lastWidth = 0;
  let lastHeight = 0;
  let still = 0;

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const vw = viewport.w;
    const vh = viewport.h;
    const dt = Math.min(now - last, 64);
    last = now;
    const time = (now - startedAt) / 1000;
    const scrollY = window.scrollY;
    const settled = now - startedAt > INTRO_MS + SETTLE_MS;

    still =
      scrollY === lastScroll && vw === lastWidth && vh === lastHeight
        ? still + 1
        : 0;

    if (!state || !settled || still < 3 || still % REFRESH_FRAMES === 0) {
      state = updateDom(vw, vh);
      lastScroll = scrollY;
      lastWidth = vw;
      lastHeight = vh;
    }

    const {
      stage,
      s2,
      s5,
      ctaHold,
      footerE,
      streamFade,
      toStage,
      fromStage,
      wiping,
      vx,
      vy,
      vr,
      heroRect,
      storyRect,
      ctaRect,
      streamRect,
    } = state;

    if (!particles || !canvas) return;

    const dpr = Math.min(
      window.devicePixelRatio || 1,
      view.w < 720 ? MAX_PHONE_DPR : MAX_DPR,
    );

    const key = `${view.w}x${view.h}@${dpr}`;

    if (key !== layoutKey) {
      layoutKey = key;
      drawn = true;
      particles.resize(view.w, view.h, dpr);
    }

    const follow = 1 - 0.9 ** (dt / 16.7);
    const pointerWanted = pointerTarget.inside && stage < 0.35 ? 1 : 0;
    pointer.on += (pointerWanted - pointer.on) * follow * 0.5;

    if (pointerTarget.inside) {
      pointer.x += (pointerTarget.x - pointer.x) * follow;
      pointer.y += (pointerTarget.y - pointer.y) * follow;
    }

    pointer.tilt +=
      ((pointerTarget.inside ? pointerTarget.x / vw : 0) - pointer.tilt) *
      follow *
      0.4;

    let alpha = 1;

    if (stage > 2 && stage <= 3) alpha = 1 - Math.min(1, (stage - 2) * 1.15);
    else if (stage > 3 && stage <= 4) alpha = Math.max(0, (stage - 3.1) / 0.9);
    else if (stage > 4 && stage < 5) alpha = Math.max(streamFade, stage - 4);
    alpha *= 1 - ramp(footerE, 0, 0.7);

    if (
      stage === 4 &&
      streamRect &&
      (streamRect.bottom < -STREAM_MARGIN ||
        streamRect.top > view.h + STREAM_MARGIN)
    ) {
      alpha = 0;
    }

    if (alpha <= 0 && !drawn) return;
    drawn = alpha > 0;

    const particleFrame: ParticleFrame = {
      stage,
      time,
      intro: clamp01((now - startedAt - 200) / INTRO_MS),
      alpha,
      colIn: toneFgUnit(tones, toStage),
      colOut: toneFgUnit(tones, wiping ? fromStage : 0),
      veil: [vx - view.w / 2, view.h / 2 - vy, vr],
      markA: markFrom(
        heroRect,
        Math.sin(time * 0.35) * 0.2 + pointer.tilt * 0.5,
      ),
      markB: markFrom(storyRect, (1 - s2) * 1.5 + Math.sin(time * 0.3) * 0.1),
      markC: markFrom(
        ctaRect,
        (1 - s5) * -1.4 + ctaHold * 0.55 + Math.sin(time * 0.32) * 0.14,
      ),
      windows: windowRects,
      stream: streamRect
        ? [
            streamRect.left - view.w / 2,
            streamRect.right - view.w / 2,
            view.h / 2 - (streamRect.top + streamRect.height / 2),
            streamRect.height / 2,
          ]
        : [0, 0, 0, 0],
      pointer: [pointer.x, pointer.y],
      pointerOn: pointer.on,
    };

    particles.render(particleFrame);
  };

  const stopTheme = themed
    ? subscribeTheme(() => {
        tones = readTones(getComputedStyle(root));
        state = updateDom(viewport.w, viewport.h);
      })
    : () => {};

  raf = requestAnimationFrame(frame);

  return () => {
    stopTheme();
    cancelAnimationFrame(raf);
    revealer.disconnect();
    stopDiscs();
    clearMarks();
    window.removeEventListener("resize", handleResize);
    window.visualViewport?.removeEventListener("resize", handleResize);
    window.removeEventListener("pointermove", handlePointer);
    document.documentElement.removeEventListener("pointerleave", handleLeave);
    particles?.dispose();
  };
}
