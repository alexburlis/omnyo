export interface TypedAheadKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function nextTypedAhead(
  buffer: string,
  event: TypedAheadKey,
): string | null {
  if (event.key === "Backspace") return buffer.slice(0, -1);

  if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey)
    return null;

  return buffer + event.key;
}

const TYPE_AHEAD_CAPTURE_MS = 10_000;

let captured = "";

let stopCapture: (() => void) | null = null;

export function startTypeAheadCapture(): void {
  stopTypeAheadCapture();
  captured = "";

  const handleKeyDown = (event: KeyboardEvent) => {
    const focused = document.activeElement;

    if (focused !== null && focused !== document.body) return;

    const next = nextTypedAhead(captured, event);

    if (next === null) return;
    captured = next;
    event.preventDefault();
  };

  document.addEventListener("keydown", handleKeyDown, true);

  const timeout = window.setTimeout(
    stopTypeAheadCapture,
    TYPE_AHEAD_CAPTURE_MS,
  );

  stopCapture = () => {
    document.removeEventListener("keydown", handleKeyDown, true);
    window.clearTimeout(timeout);
  };
}

export function takeTypeAhead(): string {
  const text = captured;
  captured = "";

  return text;
}

export function stopTypeAheadCapture(): void {
  stopCapture?.();
  stopCapture = null;
}

export function finishTypeAhead(): string {
  stopTypeAheadCapture();

  return takeTypeAhead();
}
