import { type ReactNode, useCallback, useEffect, useState } from "react";

import { AttentionCard } from "../attention/AttentionCard.js";
import { errorFromCatch, newRequestId, type SmError, useSmClient } from "../data/client.js";
import type {
  AttentionItem,
  EventCatalogEntry,
  InstanceView,
  StateVisit,
} from "../data/contract.js";
import { useEventCatalog } from "../data/hooks.js";
import { formatDuration, phaseText, stepStatusText } from "../data/projection.js";
import { useQueryStore } from "../data/query.js";
import { Section } from "../inspector/fields.js";
import { StateInspector } from "../inspector/StateInspector.js";
import { TransitionInspector } from "../inspector/TransitionInspector.js";
import { InstanceLog } from "../log/InstanceLog.js";
import { Button, ErrorAlert, formatAbsolute, Pill } from "../primitives.js";
import type { Selection } from "../routes.js";
import type { ControlState } from "../run/useControl.js";

const NOOP = () => undefined;

export function LiveInspector({
  instance,
  selection,
  attention,
  control,
  now,
  frozen,
  onSelect,
  onViewLog,
  lowerCards,
}: {
  instance: InstanceView;
  selection: Selection;
  attention: readonly AttentionItem[];
  control: ControlState;
  now: number;
  frozen: boolean;
  onSelect(selection: Selection): void;
  onViewLog(): void;
  lowerCards: ReactNode;
}) {
  const definition = instance.definition;
  const stateTitles = new Map(definition.states.map((state) => [state.id, state.title]));

  if (selection?.kind === "state") {
    const index = definition.states.findIndex((state) => state.id === selection.id);
    const state = definition.states[index];

    if (state === undefined)
      return <InstancePanel instance={instance} onViewLog={onViewLog} lowerCards={lowerCards} />;

    const current = instance.stateId === state.id;
    const step = current ? instance.steps.find((item) => item.stateId === state.id) : undefined;
    const authority = instance.standingAuthority.find((item) => item.stateId === state.id) ?? null;

    return (
      <div className="stm-inspector-content">
        {attention
          .filter((item) => item.stateId === state.id)
          .map((item) => (
            <AttentionCard key={item.attentionId} item={item} />
          ))}
        {current ? (
          <Section title="Now">
            <p className="stm-text-sm">
              <Pill tone="warning">Current</Pill> {phaseText(instance.phase)}
            </p>
            {step === undefined ? null : (
              <>
                <p className="stm-text-sm">{stepStatusText(step, now, frozen)}</p>
                {step.deadlineAt === null ? null : (
                  <p className="stm-text-xs stm-text-muted">
                    Deadline {formatAbsolute(step.deadlineAt)}
                  </p>
                )}
                {step.status === "running" ||
                step.status === "pending" ||
                step.status === "dispatching" ? (
                  <Button
                    variant="ghost"
                    pending={control.pending === "cancel-step"}
                    onClick={() =>
                      void control.run({
                        kind: "cancel-step",
                        invocationId: step.invocationId,
                        entryId: step.entryId,
                      })
                    }
                  >
                    Cancel step
                  </Button>
                ) : null}
              </>
            )}
            <PersonActions instance={instance} stateId={state.id} />
          </Section>
        ) : null}
        <RecentVisits instanceId={instance.instanceId} stateId={state.id} />
        <StateInspector
          state={state}
          stateIndex={index}
          editable={false}
          published
          isInitial={definition.initialStateId === state.id}
          problems={[]}
          outgoing={definition.transitions.filter((edge) => edge.from === state.id)}
          incoming={definition.transitions.filter((edge) => edge.to === state.id)}
          edgeLabels={definition.layout.edgeLabels}
          stateTitles={stateTitles}
          contextSchema={definition.contextSchema}
          environments={[]}
          projectId={null}
          standingAuthority={authority}
          dispatch={NOOP}
          onSelectTransition={(id) => onSelect({ kind: "transition", id })}
          onAddTransition={NOOP}
          onReorder={NOOP}
        />
      </div>
    );
  }

  if (selection?.kind === "transition") {
    const index = definition.transitions.findIndex((edge) => edge.id === selection.id);
    const edge = definition.transitions[index];

    if (edge === undefined)
      return <InstancePanel instance={instance} onViewLog={onViewLog} lowerCards={lowerCards} />;

    return (
      <TransitionInspector
        edge={edge}
        index={index}
        states={definition.states}
        editable={false}
        problems={[]}
        edgeLabels={definition.layout.edgeLabels}
        hasCustomRoute={false}
        contextSchema={definition.contextSchema}
        dispatch={NOOP}
        onDelete={NOOP}
        onSelectState={(id) => onSelect({ kind: "state", id })}
        liveTaken={{
          lastAt:
            instance.lastTransition?.transitionId === edge.id ? instance.lastTransition.at : null,
        }}
      />
    );
  }

  return (
    <>
      {attention.map((item) => (
        <AttentionCard key={item.attentionId} item={item} />
      ))}
      <InstancePanel instance={instance} onViewLog={onViewLog} lowerCards={lowerCards} />
    </>
  );
}

function InstancePanel({
  instance,
  onViewLog,
  lowerCards,
}: {
  instance: InstanceView;
  onViewLog(): void;
  lowerCards: ReactNode;
}) {
  const stateTitle =
    instance.definition.states.find((state) => state.id === instance.stateId)?.title ??
    instance.stateId;

  const phase = phaseText(instance.phase);

  return (
    <div className="stm-inspector-content">
      <header className="stm-inspector-header">
        <p className="stm-text-xs stm-text-muted">This instance</p>
        <h2 className="stm-h2">{stateTitle}</h2>
        {phase.length > 0 ? <p className="stm-text-sm">{phase}</p> : null}
        <p className="stm-text-xs stm-text-muted">
          Select a state or transition to see its details.
        </p>
      </header>
      {lowerCards === null ? null : <div className="stm-stack">{lowerCards}</div>}
      {instance.standingAuthority.length > 0 ? (
        <Section title="Standing authority (read only)">
          <ul className="stm-list">
            {instance.standingAuthority.map((item) => (
              <li key={`${item.stateId}:${item.reference}`} className="stm-text-sm">
                {item.stateId}: <code className="stm-mono">{item.reference}</code> · {item.scope}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Recent events">
        <InstanceLog instanceId={instance.instanceId} limit={5} compact />
        <button type="button" className="stm-link stm-text-sm" onClick={onViewLog}>
          Open full activity log
        </button>
      </Section>
      <Section title="Details" defaultOpen={false}>
        <dl className="stm-kv">
          <div className="stm-kv-row">
            <dt className="stm-text-muted">Version</dt>
            <dd>v{instance.versionNumber}</dd>
          </div>
          <div className="stm-kv-row">
            <dt className="stm-text-muted">Cycles completed</dt>
            <dd>{instance.cyclesCompleted}</dd>
          </div>
          <div className="stm-kv-row">
            <dt className="stm-text-muted">Instance id</dt>
            <dd className="stm-mono stm-break">{instance.instanceId}</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}

function RecentVisits({ instanceId, stateId }: { instanceId: string; stateId: string }) {
  const client = useSmClient();
  const [visits, setVisits] = useState<StateVisit[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [retainedSince, setRetainedSince] = useState<number | null>(null);
  const [error, setError] = useState<SmError | null>(null);

  const load = useCallback(
    async (before: number | null) => {
      try {
        const page = await client.call("sm_state_history", {
          instanceId,
          stateId,
          before,
          limit: 10,
        });

        setVisits((previous) =>
          before === null ? page.visits : [...(previous ?? []), ...page.visits],
        );
        setCursor(page.nextCursor);
        setRetainedSince(page.retainedSince);
        setError(null);
      } catch (caught) {
        setError(errorFromCatch(caught instanceof Error ? caught : null));
      }
    },
    [client, instanceId, stateId],
  );

  useEffect(() => {
    setVisits(null);
    void load(null);
  }, [load]);

  return (
    <Section title="Recent visits" defaultOpen={false}>
      {error === null ? null : <ErrorAlert error={error} onRetry={() => void load(null)} />}
      {visits !== null && visits.length === 0 ? (
        <p className="stm-text-sm stm-text-muted">No visits in retained history.</p>
      ) : null}
      <ul className="stm-list">
        {(visits ?? []).map((visit) => (
          <li key={visit.entryId} className="stm-text-sm">
            <time dateTime={formatAbsolute(visit.enteredAt)}>
              {new Date(visit.enteredAt).toLocaleString()}
            </time>
            {visit.exitedAt === null
              ? " · current"
              : ` · ${formatDuration(visit.exitedAt - visit.enteredAt)}`}
            {visit.exitTrigger === null ? "" : ` · left on ${visit.exitTrigger}`}
            {visit.attempts > 0
              ? ` · ${visit.attempts} attempt${visit.attempts === 1 ? "" : "s"}`
              : ""}
          </li>
        ))}
      </ul>
      {retainedSince === null ? null : (
        <p className="stm-text-xs stm-text-muted">
          Showing visits since {new Date(retainedSince).toLocaleDateString()}; older detail
          compacted.
        </p>
      )}
      {cursor === null ? null : <Button onClick={() => void load(cursor)}>Load older</Button>}
    </Section>
  );
}

function PersonActions({ instance, stateId }: { instance: InstanceView; stateId: string }) {
  const catalog = useEventCatalog(instance.instanceId);

  const actions = (catalog.data ?? []).filter(
    (entry) =>
      entry.personOnly &&
      entry.stateIds.includes(stateId) &&
      entry.subscriptionId !== null &&
      entry.epoch !== null,
  );

  if (actions.length === 0) return null;

  return (
    <div className="stm-person-actions">
      {actions.map((entry) => (
        <PersonActionButton
          key={`${entry.eventType}:${entry.epoch ?? 0}`}
          instance={instance}
          entry={entry}
          onExpired={catalog.refetch}
        />
      ))}
      <p className="stm-field-hint">
        This records a request from this Omnyo client. It enters a manual gate and authorizes
        nothing.
      </p>
    </div>
  );
}

function PersonActionButton({
  instance,
  entry,
  onExpired,
}: {
  instance: InstanceView;
  entry: EventCatalogEntry;
  onExpired(): void;
}) {
  const client = useSmClient();
  const store = useQueryStore();
  const [requestId, setRequestId] = useState(newRequestId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<SmError | null>(null);
  const [sent, setSent] = useState(false);

  const send = async () => {
    if (entry.subscriptionId === null || entry.epoch === null) return;

    setPending(true);
    setError(null);

    try {
      await client.call("sm_instance_signal", {
        instanceId: instance.instanceId,
        entryId: instance.entryId,
        subscriptionId: entry.subscriptionId,
        epoch: entry.epoch,
        eventType: entry.eventType,
        payload: null,
        requestId,
      });
      setSent(true);
      setRequestId(newRequestId());
      void store.fetch(`instance:${instance.instanceId}`);
    } catch (caught) {
      const failure = errorFromCatch(caught instanceof Error ? caught : null);

      setError(failure);

      if (failure.code === "STALE_SUBSCRIPTION" || failure.code === "EXPIRED_RECEIPT") {
        setRequestId(newRequestId());
        onExpired();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="stm-field">
      <Button pending={pending} onClick={() => void send()}>
        Request {entry.label.toLowerCase()}
      </Button>
      {sent ? <p className="stm-text-sm stm-text-muted">Request sent.</p> : null}
      {error === null ? null : <ErrorAlert error={error} />}
    </div>
  );
}
