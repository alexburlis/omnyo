import { useEffect, useState, type ReactNode } from "react";
import { PERMISSION_MODE_OPTIONS } from "@omnyo/client-core";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import {
  useContinueThread,
  useThreadContinuation,
} from "@/hooks/queries/thread-continuation-queries";

function retryCountdown(at: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((at - now) / 1_000));

  if (seconds === 0) return "Scheduled retry is due";
  const minutes = Math.ceil(seconds / 60);

  if (minutes < 60)
    return `Next attempt in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);

  return `Next attempt in ${hours}h ${minutes % 60}m`;
}

export function ThreadContinueControl({
  threadId,
  errored,
  model,
  modelControl,
}: {
  threadId: string;
  errored: boolean;
  model?: string;
  modelControl?: ReactNode;
}) {
  const state = useThreadContinuation(threadId, errored);
  const continuation = useContinueThread();
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const retryAt = state.data?.retryAt;

  useEffect(() => {
    if (!errored || retryAt == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);

    return () => clearInterval(timer);
  }, [errored, retryAt]);

  if (!errored) return null;

  if (state.isError)
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground" role="alert">
        Recovery status is unavailable.{" "}
        <Button size="sm" variant="ghost" onClick={() => void state.refetch()}>
          Check again
        </Button>
      </div>
    );

  const pending = state.data?.pending === true;

  const canContinue =
    (state.data?.available === true || state.data?.canRetryNow === true) &&
    state.data?.action !== "unavailable";

  const canAttempt =
    canContinue && (!pending || state.data?.canRetryNow === true);

  const changeModel = model !== undefined && model !== state.data?.model;

  const submit = (differentModel: boolean) => {
    setMessage(null);
    continuation.mutate(
      {
        threadId,
        now: true,
        ...(differentModel && model !== undefined ? { model } : {}),
      },
      {
        onSuccess: (result) => setMessage(result.message),
        onError: () => setMessage("Could not continue this chat. Try again."),
      },
    );
  };

  return (
    <PromptStackCard ariaLabel="Thread recovery" className="px-3 py-2">
      <div
        className="flex items-start gap-2"
        data-testid="thread-continue-control"
        role={pending ? "status" : "alert"}
      >
        <Icon
          name={pending ? "Clock" : "Pause"}
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1 text-xs">
          <p className="font-medium">
            {state.data?.failureLabel ??
              (pending ? "Automatic recovery" : "Paused")}
          </p>
          <p className="mt-1 whitespace-pre-line break-words text-muted-foreground">
            {state.data?.message ?? "Checking recovery…"}
          </p>
          {retryAt != null ? (
            <p className="mt-1 text-muted-foreground" aria-live="off">
              {retryCountdown(retryAt, now)}
            </p>
          ) : null}
          {state.data?.cause ? (
            <details className="mt-1 text-muted-foreground">
              <summary className="cursor-pointer">Failure details</summary>
              <p className="mt-1 whitespace-pre-wrap break-words">
                {state.data.cause}
              </p>
            </details>
          ) : null}
          {message !== null && (
            <p role="status" className="mt-1 text-muted-foreground">
              {message}
            </p>
          )}
          {canAttempt && modelControl ? (
            <details className="mt-2">
              <summary className="cursor-pointer">
                Continue with a different model
              </summary>
              {state.data?.permissionMode ? (
                <p className="mt-1 text-muted-foreground">
                  Approvals:{" "}
                  {
                    PERMISSION_MODE_OPTIONS.find(
                      (option) => option.value === state.data?.permissionMode,
                    )?.label
                  }
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {modelControl}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!changeModel || continuation.isPending}
                  onClick={() => submit(true)}
                >
                  Continue with selected model
                </Button>
              </div>
            </details>
          ) : null}
        </div>
        {canAttempt && (
          <Button
            size="sm"
            variant="secondary"
            disabled={continuation.isPending}
            onClick={() => submit(false)}
          >
            Continue now
          </Button>
        )}
      </div>
    </PromptStackCard>
  );
}
