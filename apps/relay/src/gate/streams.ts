import type { VerifiedDesktopGrant } from "./desktop-session.js";

export type StreamBinding =
  | {
      kind: "gate";
      label: string;
      userId: string;
      sessionId: string;
      exp: number;
    }
  | {
      kind: "desktop";
      label: string;
      userId: string;
      grant: VerifiedDesktopGrant;
      exp: number;
    }
  | {
      kind: "machine-credential";
      label: string;
      userId: string;
      machineId: string;
      credentialHash: string;
    }
  | { kind: "anonymous"; label: string; userId: string };

export interface TrackedStream {
  readonly binding: StreamBinding;
  close(reason: string): void;
  settle(): void;
}

export class StreamTracker {
  private readonly streams = new Set<TrackedStream>();

  add(stream: TrackedStream): () => void {
    this.streams.add(stream);

    return () => {
      this.streams.delete(stream);
    };
  }

  all(): readonly TrackedStream[] {
    return [...this.streams];
  }

  get size(): number {
    return this.streams.size;
  }
}

export interface MeteredBody {
  stream: ReadableStream<Uint8Array>;
  abort(reason: string): void;
}

export function meteredBody(
  body: ReadableStream<Uint8Array>,
  onBytes: (bytes: number) => void,
  onEnd: (outcome: "complete" | "aborted") => void,
): MeteredBody {
  const reader = body.getReader();
  let control: ReadableStreamDefaultController<Uint8Array> | null = null;
  let ended = false;

  const finish = (outcome: "complete" | "aborted") => {
    if (ended) return false;
    ended = true;
    onEnd(outcome);

    return true;
  };

  reader.closed.catch((error: unknown) => {
    if (finish("aborted")) control?.error(error);
  });

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        control = controller;
      },
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;

        try {
          chunk = await reader.read();
        } catch (error) {
          if (finish("aborted")) controller.error(error);

          return;
        }

        if (ended) return;

        if (chunk.done) {
          finish("complete");
          controller.close();

          return;
        }

        onBytes(chunk.value.byteLength);

        if (ended) return;
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        finish("aborted");

        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );

  return {
    stream,
    abort(reason) {
      if (!finish("aborted")) return;
      const error = new Error(reason);
      control?.error(error);
      reader.cancel(error).catch(() => undefined);
    },
  };
}

const DAY_MS = 86_400_000;

export interface DailyByteBudget {
  exhausted(key: string): boolean;
  add(key: string, bytes: number): void;
  used(key: string): number;
  prune(): void;
  readonly size: number;
}

export function createDailyByteBudget(
  limitBytes: number,
  now: () => number,
): DailyByteBudget {
  const usage = new Map<string, { day: number; bytes: number }>();
  const today = () => Math.floor(now() / DAY_MS);

  const used = (key: string) => {
    const entry = usage.get(key);

    return entry !== undefined && entry.day === today() ? entry.bytes : 0;
  };

  return {
    exhausted: (key) => used(key) >= limitBytes,
    add(key, bytes) {
      const day = today();
      const entry = usage.get(key);

      if (entry === undefined || entry.day !== day) {
        usage.set(key, { day, bytes });

        return;
      }

      entry.bytes += bytes;
    },
    used,
    prune() {
      const day = today();

      for (const [key, entry] of usage) {
        if (entry.day !== day) usage.delete(key);
      }
    },
    get size() {
      return usage.size;
    },
  };
}
