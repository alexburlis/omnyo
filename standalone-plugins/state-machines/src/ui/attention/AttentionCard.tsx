import { experimental_useAppNavigate } from "@omnyo/plugin-sdk/app";

import { useInstance } from "../data/hooks.js";
import { formatRelativeDuration } from "../data/projection.js";
import { useId, useState } from "react";

import { errorFromCatch, newRequestId, useSmClient } from "../data/client.js";
import type { AttentionDecision, AttentionItem } from "../data/contract.js";
import { useQueryStore } from "../data/query.js";
import { Button, Pill, useNow } from "../primitives.js";
import { useAnnounce, useGo } from "../shell.js";
import { AttentionContext, HomeChatButton } from "./CauseSummary.js";
import { DecisionActions } from "./DecisionActions.js";

export function AttentionCard({
  item,
  compact = false,
  onResolved,
}: {
  item: AttentionItem;
  compact?: boolean;
  onResolved?: () => void;
}) {
  const client = useSmClient();
  const store = useQueryStore();
  const announce = useAnnounce();
  const go = useGo();
  const now = useNow(true, 30_000);
  const [requestId, setRequestId] = useState(newRequestId);
  const titleId = useId();

  async function decide(decision: AttentionDecision, evidence: string) {
    try {
      await client.call("sm_attention_resolve", {
        instanceId: item.instanceId,
        attentionId: item.attentionId,
        entryId: item.entryId,
        expectedRevision: item.revision,
        decision: decision.name,
        evidence,
        requestId,
      });
    } catch (caught) {
      const failure = errorFromCatch(caught instanceof Error ? caught : null);

      if (failure.code === "STALE_ENTRY" || failure.code === "REVISION_CONFLICT") {
        setRequestId(newRequestId());
        store.refetchAll();
      }

      throw new Error(failure.message);
    }

    announce(`${item.machineName}: ${decision.label} recorded.`);
    store.refetchAll();
    onResolved?.();
  }

  return (
    <article className="stm-attention" aria-labelledby={titleId}>
      <header className="stm-attention-head">
        {compact ? null : <Pill tone="attention">Needs you</Pill>}
        <button
          type="button"
          className="stm-attention-machine stm-text-sm"
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
          {item.stateTitle === item.title
            ? item.machineName
            : `${item.machineName} · ${item.stateTitle}`}
        </button>
        <span className="stm-text-muted stm-text-xs">
          waiting {formatRelativeDuration(now - item.createdAt)}
        </span>
      </header>
      <h3 id={titleId} className="stm-h3">
        {item.title}
      </h3>
      <AttentionContext item={item} />
      {item.evidenceSummary === null ? null : (
        <p className="stm-text-sm stm-text-muted">{item.evidenceSummary}</p>
      )}
      {item.kind === "agent-input" ? (
        <p className="stm-text-sm">
          The agent asked a question in its thread. Answer it there; nothing here resolves it.
        </p>
      ) : null}
      {item.decisions.length > 0 && !compact ? (
        <DecisionActions key={item.attentionId} decisions={item.decisions} onDecide={decide} />
      ) : null}
      <footer className="stm-row stm-attention-actions">
        {compact ? (
          <Button onClick={() => go({ screen: "attention" })}>Review and decide</Button>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={() =>
                go({
                  screen: "instance",
                  machineId: item.machineId,
                  instanceId: item.instanceId,
                  view: "graph",
                  selection: null,
                })
              }
            >
              Open instance
            </Button>
            {item.homeThreadId === null ? null : <HomeChatButton threadId={item.homeThreadId} />}
          </>
        )}
        {item.kind === "agent-input" && item.invocationId !== null ? (
          <AgentThreadLink instanceId={item.instanceId} invocationId={item.invocationId} />
        ) : null}
      </footer>
    </article>
  );
}

function AgentThreadLink({
  instanceId,
  invocationId,
}: {
  instanceId: string;
  invocationId: string;
}) {
  const instance = useInstance(instanceId);
  const navigate = experimental_useAppNavigate();

  const threadId =
    instance.data?.steps.find((step) => step.invocationId === invocationId)?.threadId ?? null;

  if (threadId === null) return null;

  return (
    <Button
      variant="secondary"
      icon="MessageSquare"
      onClick={() => navigate.toThread(threadId, { split: true })}
    >
      Open thread
    </Button>
  );
}
