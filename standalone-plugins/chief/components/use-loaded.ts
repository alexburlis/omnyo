import { useCallback, useEffect, useRef, useState } from "react";

export interface Loaded<T> {
  value: T | null;
  error: string | null;
  refresh: () => void;
}

export function errorText(error: Error | string | null | undefined): string {
  if (error instanceof Error) return error.message;

  return error ?? "Something went wrong.";
}

export function useLoaded<T>(load: () => Promise<T>, everyMs: number | null): Loaded<T> {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const latest = useRef(load);

  latest.current = load;

  const refresh = useCallback(() => {
    if (inFlight.current) {
      again.current = true;

      return;
    }

    inFlight.current = true;
    again.current = false;

    latest
      .current()
      .then(
        (next) => {
          setValue(next);
          setError(null);
        },
        (failure: Error) => setError(errorText(failure)),
      )
      .finally(() => {
        inFlight.current = false;

        if (again.current) refresh();
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [load, refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);

    const timer =
      everyMs === null
        ? null
        : window.setInterval(() => {
            if (document.visibilityState === "visible") refresh();
          }, everyMs);

    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);

      if (timer !== null) window.clearInterval(timer);
    };
  }, [refresh, everyMs]);

  return { value, error, refresh };
}
