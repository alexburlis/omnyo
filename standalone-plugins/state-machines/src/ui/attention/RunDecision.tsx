import { type PluginPendingInteractionProps } from "@omnyo/plugin-sdk/app";
import { useId, useMemo } from "react";

import { runDecisionPayloadSchema } from "../../contracts/run-decision.js";
import { formatRelativeDuration } from "../data/projection.js";
import { Button, useNow } from "../primitives.js";
import { useGo } from "../shell.js";
import { AttentionContext } from "./CauseSummary.js";
import { DecisionActions } from "./DecisionActions.js";

export function RunDecision({ interaction, submit }: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () => runDecisionPayloadSchema.safeParse(interaction.payload),
    [interaction.payload],
  );

  const go = useGo();
  const titleId = useId();
  const now = useNow(true, 30_000);

  if (!parsed.success)
    return (
      <p className="stm-text-sm stm-text-muted">
        This decision can't be shown here. Open State Machines to answer it.
      </p>
    );

  const item = parsed.data;

  return (
    <article className="stm-attention stm-attention--inline" aria-labelledby={titleId}>
      <h3 id={titleId} className="stm-sr-only">
        {item.machineName}: {item.title}
      </h3>
      <AttentionContext item={item} />
      {item.lastError === null ? null : (
        <p className="stm-attention-error" role="alert">
          {item.lastError}
        </p>
      )}
      <DecisionActions
        key={interaction.id}
        decisions={item.decisions}
        onDecide={(decision, evidence) => submit({ decision: decision.name, evidence })}
      />
      <footer className="stm-attention-footer">
        <span className="stm-attention-since">
          <span className="stm-attention-since-dot" aria-hidden="true" />
          Paused {formatRelativeDuration(now - item.createdAt)} ago
        </span>
        <Button
          variant="ghost"
          icon="ArrowUpRight"
          onClick={() =>
            go({
              screen: "instance",
              machineId: item.machineId,
              instanceId: item.instanceId,
              view: "graph",
              selection: { kind: "state", id: item.stateId },
            })
          }
        >
          Open run
        </Button>
      </footer>
    </article>
  );
}
