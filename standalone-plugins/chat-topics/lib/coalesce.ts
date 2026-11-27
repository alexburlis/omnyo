export interface Coalesced {
  schedule(delay?: number): void;
  cancel(): void;
}

export function coalesce(run: () => void, delay: number): Coalesced {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return {
    schedule(wait = delay) {
      if (timer !== undefined && wait > 0) return;

      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, wait);
    },
    cancel,
  };
}
