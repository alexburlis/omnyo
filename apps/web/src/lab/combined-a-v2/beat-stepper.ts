export const EDGE = 0.06;

const TOLERANCE = 8;

const GAP_MS = 200;

const MIN_RISE = 24;

const ENERGY_MS = 64;

const WHEEL_MIN = 8;

const TOUCH_SLOP = 6;

const TOUCH_MIN = 14;

const REACH_BEFORE = 0.5;

const REACH_AFTER = 0.45;

const ARROW_PX = 40;

const GEOMETRY_MS = 250;

const GRACE_MS = 160;

const CARRY_MS = 1000;

const NOTCH_GAP_MS = 90;

const NOTCH_MIN = 40;

const TOUCH_STEP_MS = 340;

const COAST_MS = 2500;

const SETTLE_MS = 120;

export interface Track {
  stops: readonly number[];
  enterBelow: number;
  enterAbove: number;
  pinStart: number;
  pinEnd: number;
}

export type Move =
  | { kind: "step"; beat: number }
  | { kind: "enter"; beat: number }
  | { kind: "release" }
  | { kind: "pass" };

export function stopsFor(
  top: number,
  travel: number,
  count: number,
  edge = EDGE,
) {
  const lead = travel * edge;
  const span = count > 1 ? (travel - lead * 2) / (count - 1) : 0;

  return Array.from({ length: count }, (_, index) => top + lead + span * index);
}

export function nearestBeat(y: number, stops: readonly number[]) {
  let best = 0;

  stops.forEach((stop, index) => {
    if (Math.abs(stop - y) < Math.abs((stops[best] ?? stop) - y)) best = index;
  });

  return best;
}

export function insideTrack(y: number, stops: readonly number[]) {
  const first = stops[0];
  const last = stops.at(-1);

  return (
    first !== undefined &&
    last !== undefined &&
    y >= first - TOLERANCE &&
    y <= last + TOLERANCE
  );
}

export function onPin(y: number, track: Track) {
  const { stops, pinStart, pinEnd } = track;

  return (
    stops.length > 0 && y >= pinStart - TOLERANCE && y <= pinEnd + TOLERANCE
  );
}

export function plan(y: number, delta: number, track: Track): Move {
  const { stops, enterBelow, enterAbove } = track;
  const first = stops[0];
  const last = stops.at(-1);

  if (first === undefined || last === undefined || delta === 0) {
    return { kind: "pass" };
  }

  if (insideTrack(y, stops)) {
    if (delta > 0) {
      const beat = stops.findIndex((stop) => stop > y + TOLERANCE);

      return beat < 0 ? { kind: "release" } : { kind: "step", beat };
    }

    const beat = stops.reduce(
      (found, stop, index) => (stop < y - TOLERANCE ? index : found),
      -1,
    );

    return beat < 0 ? { kind: "release" } : { kind: "step", beat };
  }

  if (y < first) {
    return delta > 0 && y + delta >= enterBelow
      ? { kind: "enter", beat: 0 }
      : { kind: "pass" };
  }

  return delta < 0 && y + delta <= enterAbove
    ? { kind: "enter", beat: stops.length - 1 }
    : { kind: "pass" };
}

export function touchPlan(y: number, delta: number, track: Track): Move {
  const move = plan(y, delta, track);
  const last = track.stops.length - 1;

  if (move.kind !== "enter" || last < 1 || !onPin(y, track)) return move;

  return { kind: "step", beat: move.beat === 0 ? 1 : last - 1 };
}

export interface Flick {
  origin: number;
  release: number;
  heading: number;
}

export function catchTarget(
  y: number,
  flick: Flick,
  track: Track,
): number | null {
  const { stops, pinStart, pinEnd } = track;
  const { origin, release, heading } = flick;
  const last = stops.length - 1;

  if (last < 0 || heading === 0) return null;

  if (heading > 0 && origin < pinStart - TOLERANCE) {
    return y < pinStart - TOLERANCE || release > pinEnd + TOLERANCE ? null : 0;
  }

  if (heading < 0 && origin > pinEnd + TOLERANCE) {
    return y > pinEnd + TOLERANCE || release < pinStart - TOLERANCE
      ? null
      : last;
  }

  if (!onPin(y, track) || !onPin(release, track)) return null;
  const move = plan(release, heading, track);

  return move.kind === "step" || move.kind === "enter" ? move.beat : null;
}

export function rebaseFlick(
  flick: Flick,
  from: Track,
  to: Track,
): Flick | null {
  const { origin, release, heading } = flick;
  const above = from.pinStart - TOLERANCE;
  const below = from.pinEnd + TOLERANCE;

  if (heading > 0 && origin < above && release < above) {
    const edge = to.pinStart - TOLERANCE - 1;

    return { origin: edge, release: edge, heading };
  }

  if (heading < 0 && origin > below && release > below) {
    const edge = to.pinEnd + TOLERANCE + 1;

    return { origin: edge, release: edge, heading };
  }

  return null;
}

export function wheelDelta(delta: number, mode: number, page: number): number {
  if (mode === 1) return delta * 16;

  if (mode === 2) return delta * page;

  return delta;
}

export function carriesOver(sum: number, delta: number, gap: number) {
  return (
    sum !== 0 &&
    Math.sign(sum) === Math.sign(delta) &&
    Math.abs(sum) < WHEEL_MIN &&
    gap < CARRY_MS
  );
}

export function isNotch(delta: number, gap: number) {
  return Math.abs(delta) >= NOTCH_MIN && gap > NOTCH_GAP_MS;
}

export type Opening = "gap" | "turn" | "rise";

export function createGestureClock(gap = GAP_MS, minRise = MIN_RISE) {
  const recent: [number, number][] = [];
  let last = Number.NEGATIVE_INFINITY;
  let sign = 0;
  let peak = 0;
  let low = 0;
  let previous = 0;

  return (delta: number, time: number): Opening | null => {
    const size = Math.abs(delta);
    const heading = Math.sign(delta);
    recent.push([time, size]);

    while ((recent[0]?.[0] ?? time) <= time - ENERGY_MS) recent.shift();
    const energy = recent.reduce((sum, [, value]) => sum + value, 0);

    const opening: Opening | null =
      time - last > gap
        ? "gap"
        : heading !== 0 && sign !== 0 && heading !== sign && size >= 4
          ? "turn"
          : low <= peak * 0.5 &&
              energy > previous &&
              energy >= low * 2.5 + minRise
            ? "rise"
            : null;

    last = time;

    if (opening) {
      recent.splice(0, recent.length - 1);
      sign = heading;
      peak = size;
      low = size;
      previous = size;

      return opening;
    }

    if (!sign) sign = heading;

    if (energy > peak) {
      peak = energy;
      low = energy;
    } else {
      low = Math.min(low, energy);
    }

    previous = energy;

    return null;
  };
}

const ease = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

const KEYS: Record<string, number> = {
  ArrowDown: 1,
  PageDown: 1,
  ArrowUp: -1,
  PageUp: -1,
};

const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="listbox"], [role="menu"], [role="tablist"], [role="radiogroup"]';

const PRESSABLE =
  'button, summary, [role="button"], [role="checkbox"], [role="switch"]';

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const COARSE_POINTER = "(pointer: coarse)";

type Gesture = "open" | "done" | "released";

interface Coast {
  until: number;
  flick: Flick;
  track: Track;
  beat: number | null;
  lock: number | null;
}

interface Touch {
  x: number;
  y: number;
  origin: number;
  last: number;
  state: "undecided" | "mine" | "done" | "native";
}

export interface BeatStepper {
  goTo: (beat: number) => void;
  stop: () => void;
}

export function startBeatStepper({
  section,
  pin,
  count,
  onBeat,
}: {
  section: HTMLElement;
  pin: HTMLElement;
  count: number;
  onBeat: (beat: number) => void;
}): BeatStepper {
  const motion = window.matchMedia(REDUCED_MOTION);
  const coarse = window.matchMedia(COARSE_POINTER);
  const root = document.documentElement;
  const clock = createGestureClock();
  let beat = -1;
  let track: Track | null = null;
  let measuredAt = Number.NEGATIVE_INFINITY;
  let raf = 0;
  let animating = false;
  let expected = 0;
  let pending = 0;
  let gesture: Gesture = "released";
  let gestureSum = 0;
  let touch: Touch | null = null;
  let coast: Coast | null = null;
  let settleTimer = 0;
  const seen = new WeakSet<Event>();
  const bound = new Set<GlobalEventHandlers>();
  let frozen: string | null = null;
  let gutter = "";
  let releaseTimer = 0;
  let inputAt = Number.NEGATIVE_INFINITY;
  let wheelStamp = Number.NEGATIVE_INFINITY;
  let openedBy: Opening | "notch" = "gap";
  let entering = false;
  let attached = false;

  const geometry = () => {
    const now = performance.now();

    if (track && now - measuredAt < GEOMETRY_MS) return track;
    const top = section.getBoundingClientRect().top + window.scrollY;
    const travel = Math.max(0, section.offsetHeight - pin.offsetHeight);
    const vh = window.innerHeight;

    track =
      travel < count * 4
        ? { stops: [], enterBelow: 0, enterAbove: 0, pinStart: 0, pinEnd: 0 }
        : {
            stops: stopsFor(top, travel, count),
            enterBelow: top - vh * REACH_BEFORE,
            enterAbove: top + travel + vh * REACH_AFTER,
            pinStart: top,
            pinEnd: top + travel,
          };
    measuredAt = now;

    return track;
  };

  const announce = (next: number) => {
    if (next === beat) return;
    beat = next;
    onBeat(next);
  };

  const sync = () => {
    const { stops } = geometry();

    if (stops.length) announce(nearestBeat(window.scrollY, stops));
  };

  const hold = () => {
    window.clearTimeout(releaseTimer);

    if (frozen === null) {
      frozen = root.style.overflow;
      gutter = root.style.scrollbarGutter;
      root.style.scrollbarGutter = "stable";
      root.style.overflow = "hidden";
    }

    releaseTimer = window.setTimeout(release, GAP_MS + 20);
  };

  const unhold = () => {
    window.clearTimeout(releaseTimer);

    if (frozen === null) return;
    root.style.overflow = frozen;
    root.style.scrollbarGutter = gutter;
    frozen = null;
  };

  const release = () => {
    window.clearTimeout(releaseTimer);

    if (frozen === null || animating) return;
    const quiet = performance.now() - inputAt;

    if (quiet < GAP_MS) {
      releaseTimer = window.setTimeout(release, GAP_MS - quiet + 20);

      return;
    }

    unhold();
  };

  const own = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    else hold();
  };

  const overlayScrollbars = () => window.innerWidth === root.clientWidth;

  const finish = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    animating = false;
    release();
  };

  const go = (target: number, quick = false) => {
    const { stops } = geometry();
    const to = stops[target];
    coast = null;

    if (to === undefined) return;
    finish();
    announce(target);
    const from = window.scrollY;
    const distance = to - from;

    if (Math.abs(distance) < 1) return;

    const duration = quick
      ? TOUCH_STEP_MS
      : Math.min(700, Math.max(560, 560 + Math.abs(distance) * 0.08));

    const curve = quick ? easeOut : ease;

    const startedAt = performance.now();
    animating = true;
    entering = !insideTrack(from, stops);
    expected = from;

    const frame = (now: number) => {
      if (
        frozen === null &&
        now - startedAt > GRACE_MS &&
        Math.abs(window.scrollY - expected) > 3
      ) {
        pending = 0;
        finish();
        sync();

        return;
      }

      const t = Math.min(1, Math.max(0, (now - startedAt) / duration));
      expected = from + distance * curve(t);
      window.scrollTo({ top: expected, behavior: "instant" });
      expected = window.scrollY;

      if (t < 1) {
        raf = requestAnimationFrame(frame);

        return;
      }

      finish();
      const queued = pending;
      pending = 0;

      if (!queued) return;
      const move = plan(window.scrollY, queued, geometry());

      if (move.kind === "step" || move.kind === "enter") go(move.beat, quick);
    };

    raf = requestAnimationFrame(frame);
  };

  const nearby = (y: number) => {
    const { enterBelow, enterAbove } = geometry();

    return y >= enterBelow && y <= enterAbove;
  };

  const handleWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey) return;
    coast = null;
    const page = window.innerHeight;
    const dy = wheelDelta(event.deltaY, event.deltaMode, page);
    const dx = wheelDelta(event.deltaX, event.deltaMode, page);

    if (!dy || Math.abs(dx) > Math.abs(dy)) return;
    inputAt = performance.now();
    const since = event.timeStamp - wheelStamp;
    wheelStamp = event.timeStamp;
    const opening = clock(dy, event.timeStamp);

    if (opening) {
      const carry =
        opening === "gap" &&
        gesture === "open" &&
        carriesOver(gestureSum, dy, since);

      if (!carry) gestureSum = 0;
      gesture = "open";
      openedBy = opening;
    } else if (
      gesture === "done" &&
      !animating &&
      event.cancelable &&
      isNotch(dy, since)
    ) {
      gesture = "open";
      gestureSum = 0;
      openedBy = "notch";
    }

    if (gesture === "released") return;
    gestureSum += dy;
    const y = window.scrollY;

    if (animating) {
      own(event);

      if (gesture === "open" && Math.abs(gestureSum) >= WHEEL_MIN) {
        const coasting = openedBy === "gap" || !event.cancelable;

        if (!entering || !coasting) pending = Math.sign(gestureSum);
        gesture = "done";
      }

      return;
    }

    if (gesture === "done") {
      if (nearby(y)) own(event);

      return;
    }

    const move = plan(y, dy, geometry());

    if (move.kind === "pass" || move.kind === "release") {
      if (move.kind === "release") gesture = "released";
      unhold();

      return;
    }

    own(event);

    if (move.kind === "step" && Math.abs(gestureSum) < WHEEL_MIN) return;
    gesture = "done";
    go(move.beat);
  };

  const handleKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;

    if (event.altKey) return;
    const space = event.key === " ";
    const heading = space ? (event.shiftKey ? -1 : 1) : KEYS[event.key];

    if (!heading) return;
    coast = null;
    const target = event.target instanceof Element ? event.target : null;

    if (target?.closest(EDITABLE)) return;

    if (space && target?.closest(PRESSABLE)) return;
    const y = window.scrollY;

    if (animating) {
      event.preventDefault();
      pending = heading;

      return;
    }

    const amount =
      space || event.key.startsWith("Page")
        ? window.innerHeight * 0.85
        : ARROW_PX;

    const move = plan(y, heading * amount, geometry());

    if (move.kind !== "step" && move.kind !== "enter") return;
    event.preventDefault();
    go(move.beat);
  };

  const bind = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement || target instanceof SVGElement)) {
      return;
    }

    const node: GlobalEventHandlers = target;

    if (bound.has(node)) return;
    bound.add(node);
    node.addEventListener("touchmove", handleTouchMove, { passive: false });
    node.addEventListener("touchend", handleTouchEnd, { passive: true });
    node.addEventListener("touchcancel", handleTouchEnd, { passive: true });
  };

  const unbind = () => {
    for (const target of bound) {
      target.removeEventListener("touchmove", handleTouchMove);
      target.removeEventListener("touchend", handleTouchEnd);
      target.removeEventListener("touchcancel", handleTouchEnd);
    }

    bound.clear();
  };

  const handleTouchStart = (event: TouchEvent) => {
    if (motion.matches) return;
    coast = null;
    bind(event.target);

    if (!animating) unhold();
    const point = event.touches[0];

    if (event.touches.length !== 1 || !point) {
      if (touch) touch.state = "native";

      return;
    }

    window.clearTimeout(settleTimer);
    const inside = attached && (animating || onPin(window.scrollY, geometry()));

    touch = {
      x: point.clientX,
      y: point.clientY,
      origin: window.scrollY,
      last: point.clientY,
      state: inside ? "undecided" : "native",
    };
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (seen.has(event)) return;
    seen.add(event);
    const point = event.touches[0];

    if (!touch || !point || touch.state === "native") return;
    inputAt = performance.now();
    const dy = touch.y - point.clientY;
    const dx = touch.x - point.clientX;
    const moved = touch.last - point.clientY;
    touch.last = point.clientY;

    if (animating || touch.state === "done") {
      own(event);

      if (animating && touch.state !== "done" && Math.abs(dy) >= TOUCH_MIN) {
        pending = Math.sign(dy);
        touch.state = "done";
      }

      return;
    }

    if (touch.state === "undecided") {
      if (Math.abs(dy) < TOUCH_SLOP && Math.abs(dx) < TOUCH_SLOP) return;

      if (Math.abs(dx) > Math.abs(dy)) {
        touch.state = "native";

        return;
      }

      const move = touchPlan(window.scrollY, moved || dy, geometry());

      if (move.kind === "release") {
        touch.state = "native";
        unhold();
      }

      if (move.kind === "pass" || move.kind === "release") return;
      touch.state = "mine";

      if (overlayScrollbars()) hold();
    }

    own(event);

    if (Math.abs(dy) < TOUCH_MIN) return;
    const move = touchPlan(window.scrollY, dy, geometry());
    touch.state = "done";

    if (move.kind === "step" || move.kind === "enter") go(move.beat, true);
  };

  const handleTouchEnd = (event: TouchEvent) => {
    if (seen.has(event)) return;
    seen.add(event);

    if (event.touches.length) return;
    unbind();
    const ended = touch;
    touch = null;
    release();

    if (!ended || ended.state === "mine" || ended.state === "done") return;
    const lifted = event.changedTouches[0]?.clientY ?? ended.last;
    const dragged = ended.y - lifted;

    if (Math.abs(dragged) < TOUCH_SLOP) return;
    coast = {
      until: performance.now() + COAST_MS,
      flick: {
        origin: ended.origin,
        release: ended.origin + dragged,
        heading: Math.sign(dragged),
      },
      track: geometry(),
      beat: null,
      lock: null,
    };
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      if (!animating && !touch && coast?.lock === null) steer();
    }, SETTLE_MS);
  };

  const steer = () => {
    if (coast && performance.now() > coast.until) coast = null;

    if (!coast || touch) return false;
    const y = window.scrollY;

    if (coast.lock !== null) {
      if (Math.abs(y - coast.lock) > 1) {
        hold();
        window.scrollTo({ top: coast.lock, behavior: "instant" });
      }

      return true;
    }

    const target = catchTarget(y, coast.flick, coast.track);
    const now = geometry();
    const to = target === null ? undefined : now.stops[target];

    if (target === null || to === undefined) return false;
    const { flick } = coast;
    go(target, true);
    coast = {
      until: performance.now() + COAST_MS,
      flick,
      track: now,
      beat: target,
      lock: to,
    };

    if (animating) hold();

    return true;
  };

  const handleScroll = () => {
    if (animating || steer()) return;
    sync();
  };

  const attach = () => {
    if (attached || motion.matches) return;
    attached = true;
    track = null;
    const { stops } = geometry();
    const y = window.scrollY;
    const to = stops[nearestBeat(y, stops)];

    if (
      !coarse.matches &&
      to !== undefined &&
      insideTrack(y, stops) &&
      Math.abs(to - y) >= 1
    ) {
      window.scrollTo({ top: to, behavior: "instant" });
    }

    sync();
    window.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", handleKey);
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("scroll", handleScroll, { passive: true });
  };

  const detach = () => {
    if (!attached) return;
    attached = false;
    unhold();
    window.removeEventListener("wheel", handleWheel);
    window.removeEventListener("keydown", handleKey);
    window.removeEventListener("touchmove", handleTouchMove);
    window.removeEventListener("scroll", handleScroll);
  };

  let near = false;

  window.addEventListener("touchstart", handleTouchStart, { passive: true });
  window.addEventListener("touchend", handleTouchEnd, { passive: true });
  window.addEventListener("touchcancel", handleTouchEnd, { passive: true });

  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries.at(-1);

      if (!entry) return;
      near = entry.isIntersecting;

      if (near) attach();
      else detach();
    },
    { rootMargin: "100% 0px 100% 0px" },
  );

  observer.observe(section);

  const refit = () => {
    const before = track;
    const prior = touch ? null : coast;

    const target = prior
      ? (prior.beat ??
        catchTarget(prior.flick.release, prior.flick, prior.track))
      : null;

    window.clearTimeout(settleTimer);
    track = null;
    coast = null;

    if (!attached) return;
    const landing = target === null ? undefined : geometry().stops[target];

    if (prior && target !== null && landing !== undefined) {
      pending = 0;
      finish();
      announce(target);
      window.scrollTo({ top: landing, behavior: "instant" });
      coast = {
        until: performance.now() + COAST_MS,
        flick: prior.flick,
        track: geometry(),
        beat: target,
        lock: landing,
      };

      return;
    }

    const now = geometry();
    const flick = prior ? rebaseFlick(prior.flick, prior.track, now) : null;

    if (prior && flick) {
      coast = { until: prior.until, flick, track: now, beat: null, lock: null };

      if (!animating && steer()) return;
    }

    const y = window.scrollY;
    const was = before?.stops[beat];

    const inside =
      beat >= 0 &&
      before !== null &&
      (animating || insideTrack(y, before.stops));

    const to = geometry().stops[beat];

    if (!inside || to === undefined) {
      if (!animating) sync();

      return;
    }

    if (was !== undefined && Math.abs(to - was) < 1) return;
    pending = 0;
    finish();
    window.scrollTo({ top: to, behavior: "instant" });
  };

  const interrupt = () => {
    pending = 0;
    coast = null;
    finish();
  };

  const handleClick = (event: MouseEvent) => {
    const link =
      event.target instanceof Element ? event.target.closest("a[href]") : null;

    if (
      link instanceof HTMLAnchorElement &&
      link.hash &&
      link.origin === location.origin &&
      link.pathname === location.pathname
    ) {
      interrupt();
    }
  };

  const resize = new ResizeObserver(refit);

  resize.observe(section);
  window.addEventListener("resize", refit);
  window.addEventListener("click", handleClick, true);
  window.addEventListener("hashchange", interrupt);

  const handleMotion = () => {
    if (motion.matches) {
      finish();
      detach();
      announce(0);

      return;
    }

    if (near) attach();
  };

  motion.addEventListener("change", handleMotion);

  if (motion.matches) announce(0);

  return {
    goTo: (target) => {
      if (motion.matches) {
        announce(target);

        return;
      }

      pending = 0;
      go(target);
    },
    stop: () => {
      finish();
      detach();
      unhold();
      window.clearTimeout(settleTimer);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
      unbind();
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", refit);
      window.removeEventListener("click", handleClick, true);
      window.removeEventListener("hashchange", interrupt);
      motion.removeEventListener("change", handleMotion);
    },
  };
}
