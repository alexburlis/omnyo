const IDLE_MS = 140;

const SLACK = 0.15;

const KEYS: Record<string, number> = {
  ArrowDown: 1,
  PageDown: 1,
  End: 1,
  ArrowUp: -1,
  PageUp: -1,
  Home: -1,
};

const ease = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

export function pinnedStops(
  section: HTMLElement,
  count: number,
  at: (index: number) => number,
) {
  const top = section.getBoundingClientRect().top + window.scrollY;
  const travel = Math.max(0, section.offsetHeight - window.innerHeight);

  return Array.from({ length: count }, (_, index) => top + travel * at(index));
}

export function startGlide(stops: () => readonly number[]) {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let timer = 0;
  let raf = 0;
  let touching = false;
  let gliding = false;
  let lastY = window.scrollY;
  let origin = lastY;
  let intent = 0;

  const halt = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    gliding = false;
    lastY = window.scrollY;
    origin = lastY;
  };

  const glide = (from: number, to: number) => {
    const distance = to - from;

    const duration = Math.min(
      900,
      Math.max(420, 300 + Math.abs(distance) * 0.4),
    );

    const startedAt = performance.now();
    gliding = true;

    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / duration);
      window.scrollTo(0, from + distance * ease(t));

      if (t < 1) {
        raf = requestAnimationFrame(step);

        return;
      }

      raf = 0;
      gliding = false;
      lastY = window.scrollY;
      origin = lastY;
    };

    raf = requestAnimationFrame(step);
  };

  const settle = () => {
    timer = 0;

    if (touching || gliding || motion.matches) return;
    const list = stops();
    const first = list[0];
    const last = list.at(-1);

    if (first === undefined || last === undefined) return;
    const y = window.scrollY;
    const gap = list.length > 1 ? (last - first) / (list.length - 1) : 0;

    if (y < first - gap / 2 || y > last + gap / 2) return;
    const slack = gap * SLACK;
    const heading = intent || Math.sign(Math.round(y - origin));
    let target: number | undefined;

    if (heading > 0) {
      target = list.find((stop) => stop > origin + 1 && stop >= y - slack);
    } else if (heading < 0) {
      target = [...list]
        .reverse()
        .find((stop) => stop < origin - 1 && stop <= y + slack);
    } else {
      target = list.reduce((best, stop) =>
        Math.abs(stop - y) < Math.abs(best - y) ? stop : best,
      );
    }

    origin = y;
    intent = 0;

    if (target === undefined || Math.abs(target - y) < 2) return;
    glide(y, target);
  };

  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(settle, IDLE_MS);
  };

  const handleScroll = () => {
    if (gliding) return;

    if (!timer) origin = lastY;
    lastY = window.scrollY;
    schedule();
  };

  const takeOver = () => {
    if (gliding) halt();
  };

  const handleWheel = (event: WheelEvent) => {
    takeOver();

    if (event.deltaY) intent = Math.sign(event.deltaY);
  };

  const handleKey = (event: KeyboardEvent) => {
    takeOver();

    const heading =
      event.key === " " ? (event.shiftKey ? -1 : 1) : KEYS[event.key];

    if (heading) intent = heading;
  };

  const handleTouchStart = () => {
    touching = true;
    intent = 0;
    takeOver();
  };

  const handleTouchEnd = () => {
    touching = false;
    schedule();
  };

  const handleScrollEnd = () => {
    if (gliding) return;
    touching = false;
    schedule();
  };

  window.addEventListener("scroll", handleScroll, { passive: true });
  window.addEventListener("scrollend", handleScrollEnd, { passive: true });
  window.addEventListener("wheel", handleWheel, { passive: true });
  window.addEventListener("keydown", handleKey);
  window.addEventListener("pointerdown", takeOver);
  window.addEventListener("touchstart", handleTouchStart, { passive: true });
  window.addEventListener("touchend", handleTouchEnd, { passive: true });
  window.addEventListener("touchcancel", handleTouchEnd, { passive: true });

  return () => {
    window.clearTimeout(timer);
    cancelAnimationFrame(raf);
    window.removeEventListener("scroll", handleScroll);
    window.removeEventListener("scrollend", handleScrollEnd);
    window.removeEventListener("wheel", handleWheel);
    window.removeEventListener("keydown", handleKey);
    window.removeEventListener("pointerdown", takeOver);
    window.removeEventListener("touchstart", handleTouchStart);
    window.removeEventListener("touchend", handleTouchEnd);
    window.removeEventListener("touchcancel", handleTouchEnd);
  };
}
