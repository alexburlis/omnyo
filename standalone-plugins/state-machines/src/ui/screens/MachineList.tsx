import { experimental_useAppContext } from "@omnyo/plugin-sdk/app";

import { AttentionCard } from "../attention/AttentionCard.js";
import type { MachineSummary } from "../data/contract.js";
import { useAttention, useMachines } from "../data/hooks.js";
import {
  LIFECYCLE_URGENCY,
  lifecyclePresentation,
  phaseText,
  phaseUrgency,
} from "../data/projection.js";
import {
  Button,
  Chip,
  EmptyState,
  ErrorAlert,
  Pill,
  Skeleton,
  TimeAgo,
  useNow,
} from "../primitives.js";
import { Page, useGo } from "../shell.js";

function mostUrgent(machine: MachineSummary) {
  return [...machine.instances].sort(
    (a, b) =>
      phaseUrgency(a.phase) - phaseUrgency(b.phase) ||
      LIFECYCLE_URGENCY[a.lifecycle] - LIFECYCLE_URGENCY[b.lifecycle],
  )[0];
}

export function MachineList() {
  const { projectId } = experimental_useAppContext();
  const machines = useMachines(projectId);
  const attention = useAttention(null, null);
  const go = useGo();
  const now = useNow(true, 30_000);
  const openAttention = attention.data ?? [];

  const sorted = [...(machines.data ?? [])].sort(
    (a, b) =>
      Number(b.openAttentionCount > 0) - Number(a.openAttentionCount > 0) ||
      b.updatedAt - a.updatedAt,
  );

  return (
    <Page
      crumbs={[{ label: "State machines", route: null }]}
      title="State machines"
      actions={
        <Button variant="primary" icon="Plus" onClick={() => go({ screen: "new" })}>
          New machine
        </Button>
      }
    >
      <p className="stm-text-sm stm-text-muted stm-lede">
        Repeatable workflows of steps, checks and approvals that keep running in the background.
      </p>
      {openAttention.length > 0 ? (
        <section className="stm-section" aria-labelledby="stm-needs-you">
          <div className="stm-section-head">
            <h2 id="stm-needs-you" className="stm-h2">
              Needs you
            </h2>
            <Button variant="ghost" onClick={() => go({ screen: "attention" })}>
              {openAttention.length > 3 ? `See all ${openAttention.length}` : "See all"}
            </Button>
          </div>
          <div className="stm-stack">
            {openAttention.slice(0, 3).map((item) => (
              <AttentionCard key={item.attentionId} item={item} compact />
            ))}
          </div>
        </section>
      ) : null}
      {machines.error !== null ? (
        <ErrorAlert error={machines.error} onRetry={machines.refetch} subject="list" />
      ) : null}
      {machines.data === undefined && machines.error === null ? (
        <Skeleton rows={4} height={44} />
      ) : null}
      {machines.data !== undefined && machines.data.length === 0 ? (
        <EmptyState
          title="No state machines yet"
          body="Build a loop of steps, checks and approvals that keeps running."
          actions={
            <>
              <Button variant="primary" onClick={() => go({ screen: "new" })}>
                New machine
              </Button>
              <Button onClick={() => go({ screen: "new" })}>
                Start from Release loop template
              </Button>
            </>
          }
        />
      ) : null}
      {sorted.length > 0 ? (
        <table className="stm-table">
          <thead>
            <tr>
              <th scope="col">Machine</th>
              <th scope="col">Status</th>
              <th scope="col" className="stm-hide-compact">
                Current state
              </th>
              <th scope="col" className="stm-hide-compact">
                Version
              </th>
              <th scope="col" className="stm-hide-compact">
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((machine) => {
              const urgent = mostUrgent(machine);

              const presentation =
                urgent === undefined ? null : lifecyclePresentation(urgent.lifecycle, false);

              return (
                <tr key={machine.machineId} className="stm-table-row">
                  <td>
                    <button
                      type="button"
                      className="stm-row-link"
                      onClick={() => go({ screen: "machine", machineId: machine.machineId })}
                    >
                      <span className="stm-text-strong">{machine.name}</span>
                      {machine.description.length > 0 ? (
                        <span className="stm-text-muted stm-truncate">{machine.description}</span>
                      ) : null}
                    </button>
                  </td>
                  <td>
                    {machine.openAttentionCount > 0 ? (
                      <Pill tone="attention">Needs you</Pill>
                    ) : presentation === null ? (
                      <span className="stm-text-muted">No instances</span>
                    ) : (
                      <Pill tone={presentation.tone}>{presentation.label}</Pill>
                    )}
                    {machine.instances.length > 1 ? (
                      <span className="stm-text-muted stm-text-xs">
                        {" "}
                        {`+${machine.instances.length - 1} more ${machine.instances.length === 2 ? "instance" : "instances"}`}
                      </span>
                    ) : null}
                  </td>
                  <td className="stm-hide-compact">
                    {urgent === undefined ? (
                      <span className="stm-text-muted">—</span>
                    ) : (
                      <>
                        <span>{urgent.stateTitle}</span>
                        {urgent.phase === null ? null : (
                          <span className="stm-text-muted"> · {phaseText(urgent.phase)}</span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="stm-hide-compact">
                    <span className="stm-row stm-row--tight">
                      {machine.latestVersionNumber === null ? (
                        <Chip>Not published</Chip>
                      ) : (
                        <Chip>Published v{machine.latestVersionNumber}</Chip>
                      )}
                      {machine.draftChangeCount > 0 ? (
                        <Chip tone="selected">
                          {machine.draftChangeCount} unpublished change
                          {machine.draftChangeCount === 1 ? "" : "s"}
                        </Chip>
                      ) : null}
                    </span>
                  </td>
                  <td className="stm-hide-compact stm-text-muted">
                    <TimeAgo at={machine.updatedAt} now={now} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </Page>
  );
}
