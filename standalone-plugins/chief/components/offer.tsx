import { useState } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import type { AgentView, rpcContract } from "../lib/contract.ts";
import { NO_AGENT_TEXT, OFFER_TITLE, PROVIDERS_HREF, offerText } from "./chief-logic.ts";
import { Button } from "./ui/button.tsx";
import { cn } from "./ui/utils.ts";
import { errorText } from "./use-loaded.ts";

const ACTION = "pointer-coarse:h-10";

export function SuggestionsOffer({
  agent,
  onChanged,
  className,
}: {
  agent: Pick<AgentView, "label" | "ready">;
  onChanged: () => void;
  className?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (value: "on" | "off") => {
    setBusy(true);
    setError(null);
    rpc
      .call("suggestions.set", { value })
      .then(onChanged, (failure: Error) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };

  if (!agent.ready)
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <p className="m-0 text-sm">{NO_AGENT_TEXT}</p>
        <div>
          <Button asChild variant="outline" size="sm" className={ACTION}>
            <a href={PROVIDERS_HREF}>Connect an agent</a>
          </Button>
        </div>
      </div>
    );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-col gap-0.5">
        <p className="m-0 text-sm font-medium">{OFFER_TITLE}</p>
        <p className="m-0 text-xs text-muted-foreground">{offerText(agent.label)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className={ACTION}
          disabled={busy}
          onClick={() => choose("on")}
        >
          Turn on suggestions
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={ACTION}
          disabled={busy}
          onClick={() => choose("off")}
        >
          Keep suggestions off
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-destructive-text">
          {error}
        </p>
      )}
    </div>
  );
}
