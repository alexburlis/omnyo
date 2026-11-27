import { useCallback, useEffect, useState } from "react";
import { experimental_useAppNavigate, useRpc } from "@omnyo/plugin-sdk/app";
import type { DelegatedView, rpcContract } from "../lib/contract.ts";
import { decidedState } from "./chief-logic.ts";
import { Button } from "./ui/button.tsx";
import { useChiefChanged } from "./use-chief-changed.ts";
import { errorText, useLoaded } from "./use-loaded.ts";

const TICK_MS = 15_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);

    return () => window.clearInterval(timer);
  }, []);

  return now;
}

function timeText(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function DecidedRow({
  item,
  now,
  onChanged,
}: {
  item: DelegatedView;
  now: number;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = experimental_useAppNavigate();
  const [state, setState] = useState(item.state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = decidedState(state, item.sendAt, now);

  const undo = () => {
    setBusy(true);
    setError(null);
    rpc
      .call("delegation.undo", { id: item.id })
      .then(
        (result) => {
          setState(result.state);
          onChanged();
        },
        (failure: Error) => setError(errorText(failure)),
      )
      .finally(() => setBusy(false));
  };

  const run = () => {
    if (shown.action === "open") nav.toThread(item.threadId);
    else undo();
  };

  return (
    <li className="flex flex-col gap-0.5 border-b border-border py-3">
      <span className="text-sm">
        <span className="font-medium">{item.answer.join(", ")}</span> in{" "}
        <button
          type="button"
          className="cursor-pointer bg-transparent p-0 underline-offset-2 hover:underline"
          onClick={() => nav.toThread(item.threadId)}
        >
          {item.title}
        </button>
      </span>
      <span className="text-xs text-muted-foreground">
        {item.prompt} · Rule: {item.cue} · {timeText(item.updatedAt)}
      </span>
      <span className="flex items-center gap-1 text-xs">
        <span>{shown.text}</span>
        {shown.actionLabel === null ? null : (
          <>
            <span aria-hidden>·</span>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs text-foreground underline"
              disabled={busy}
              aria-label={`${shown.actionLabel} in ${item.title}`}
              onClick={run}
            >
              {shown.actionLabel}
            </Button>
          </>
        )}
      </span>
      {error === null ? null : (
        <span role="alert" className="text-xs text-destructive-text">
          {error}
        </span>
      )}
    </li>
  );
}

export function DecidedTab() {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => rpc.call("delegation.list"), [rpc]);
  const { value, error, refresh } = useLoaded(load, null);
  const now = useNow();

  useChiefChanged(refresh);

  return (
    <div className="mx-auto flex w-full max-w-[600px] flex-col px-4 py-4">
      {error === null || value !== null ? null : (
        <div role="alert" className="flex items-center gap-3 py-8 text-sm">
          <span>Couldn&apos;t load what the Chief answered.</span>
          <Button variant="outline" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}
      {value === null ? null : value.items.length === 0 ? (
        <p className="m-0 py-14 text-center text-sm text-muted-foreground">
          Nothing decided for you yet. The Chief only answers after you make a rule.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {[...value.items]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((item) => (
              <DecidedRow key={`${item.id}:${item.state}`} item={item} now={now} onChanged={refresh} />
            ))}
        </ul>
      )}
    </div>
  );
}
