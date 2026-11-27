import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { experimental_Icon as Icon, useSdk } from "@omnyo/plugin-sdk/app";
import { Button } from "./ui/button";
import { FIELD_FOCUS_RING_CLASS } from "./ui/focus-ring";

const loopSchema = z.object({
  prompt: z.string(),
  intervalMs: z.number(),
  nextAtMs: z.number().nullable(),
  iterations: z.number(),
  maxIterations: z.number().nullable(),
});

const stateSchema = z.object({ loop: loopSchema.nullable() });

export type ChatLoop = z.infer<typeof loopSchema>;

const pollMs = 30_000;

export function formatDuration(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;

  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;

  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;

  return `${Math.max(0, Math.round(ms / 1_000))}s`;
}

export function loopCountdown(loop: ChatLoop, now: number): string {
  return loop.nextAtMs === null ? "checking" : formatDuration(loop.nextAtMs - now);
}

export interface LoopSource {
  loop: ChatLoop | null;
  now: number;
  refresh: () => Promise<void>;
  stop: () => Promise<void>;
  edit: (prompt: string) => Promise<void>;
}

export function useChatLoop(threadId: string): LoopSource {
  const sdk = useSdk();
  const [loop, setLoop] = useState<ChatLoop | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const call = useCallback(
    async (method: string, extra: { prompt?: string } = {}) => {
      const state = await sdk.plugins.callRpc({
        pluginId: "pursue",
        method,
        input: { threadId, ...extra },
        outputSchema: stateSchema,
      });

      setLoop(state.loop);
    },
    [sdk, threadId],
  );

  const refresh = useCallback(() => call("pursue_state").catch(() => setLoop(null)), [call]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);

    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (loop === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);

    return () => clearInterval(timer);
  }, [loop]);

  return {
    loop,
    now,
    refresh,
    stop: () => call("pursue_clear_loop"),
    edit: (prompt) => call("pursue_edit_loop", { prompt }),
  };
}

export function intervalLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));

  if (minutes % 1440 === 0) return minutes === 1440 ? "every day" : `every ${minutes / 1440} days`;

  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;

  return minutes === 1 ? "every minute" : `every ${minutes} min`;
}

export function LoopBadge({ loop, now }: { loop: ChatLoop; now: number }) {
  const countdown = loopCountdown(loop, now);

  return (
    <span
      data-glance-loop=""
      title={
        loop.nextAtMs === null
          ? "Loop: checking now"
          : `Loop: wakes this chat again in ${countdown}`
      }
      className="inline-flex shrink-0 items-center gap-1 border-l border-border pl-2 font-medium text-foreground tabular-nums"
    >
      <Icon name="Repeat" className="size-3.5" aria-hidden="true" />
      <span>{countdown}</span>
    </span>
  );
}

export function LoopSection({ source }: { source: LoopSource }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const { loop, now } = source;

  if (loop === null) return null;

  const run = async (action: () => Promise<void>, failure: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      await action();
      setDraft(null);
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const checks = `${loop.iterations} check${loop.iterations === 1 ? "" : "s"}${loop.maxIterations === null ? "" : ` of ${loop.maxIterations}`}`;

  const next =
    loop.nextAtMs === null ? "Checking now" : `Next check in ${loopCountdown(loop, now)}`;

  const trimmed = draft?.trim() ?? "";

  return (
    <section
      aria-label="Loop"
      className="mt-3 rounded-xl border border-border bg-surface-recessed p-3"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-full bg-timeline-accent/10 text-timeline-accent"
        >
          <Icon name="Repeat" className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-5">Loop</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {`Wakes this chat with the prompt below ${intervalLabel(loop.intervalMs)}, and less often while nothing changes.`}
          </p>
          <p className="text-xs leading-5 text-muted-foreground tabular-nums">{`${next} · ${checks}`}</p>
        </div>
      </div>
      {draft === null ? (
        <p
          className="mt-2.5 line-clamp-3 break-words border-l-2 border-border pl-2.5 text-xs leading-5 text-foreground"
          title={loop.prompt}
        >
          {loop.prompt}
        </p>
      ) : (
        <textarea
          aria-label="Loop prompt"
          value={draft}
          disabled={busy}
          rows={4}
          onChange={(event) => setDraft(event.target.value)}
          className={`mt-2.5 w-full resize-y rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs leading-5 ${FIELD_FOCUS_RING_CLASS}`}
        />
      )}
      <div className="mt-2.5 flex justify-end gap-1.5">
        {draft === null ? (
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => run(source.stop, "Could not stop the loop. Try again.")}
            >
              Stop loop
            </Button>
            <Button disabled={busy} onClick={() => setDraft(loop.prompt)}>
              <Icon name="Edit" className="size-3.5" aria-hidden="true" />
              Edit
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              variant="default"
              disabled={busy || trimmed === "" || trimmed === loop.prompt}
              onClick={() => run(() => source.edit(trimmed), "Could not save the loop. Try again.")}
            >
              Save
            </Button>
          </>
        )}
      </div>
      {error === null ? null : (
        <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive-text">
          <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </section>
  );
}
