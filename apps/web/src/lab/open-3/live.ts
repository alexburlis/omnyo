import {
  type RefObject,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

const listeners = new Set<() => void>();

let tick = Date.now();

let timer: number | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);

  if (timer === undefined) {
    timer = window.setInterval(() => {
      tick = Date.now();

      for (const notify of listeners) notify();
    }, 1000);
  }

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

const snapshot = () => tick;

export function useNow() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const pad = (value: number) => String(value).padStart(2, "0");

export function clock(date: Date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function duration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}`;
}

export function nextWeekdayRun(now: number, hour: number, minute: number) {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);

  if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);

  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate;
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

export function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;

    if (!element) return;

    const targets = element.querySelectorAll<HTMLElement>("[data-reveal]");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );

    for (const target of targets) observer.observe(target);
    element.classList.add("is-armed");

    return () => observer.disconnect();
  }, [root]);
}
