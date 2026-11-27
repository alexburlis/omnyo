import { useState } from "react";

import { AttentionCard } from "../attention/AttentionCard.js";
import type { InstanceSummary } from "../data/contract.js";
import { useAttention, useInstances, useMachines, useVersion } from "../data/hooks.js";
import { lifecyclePresentation, phaseText } from "../data/projection.js";
import { Canvas } from "../graph/Canvas.js";
import { StartInstanceDialog } from "../instance/StartInstanceDialog.js";
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
import { MachineTabs, Page, shortId, useGo } from "../shell.js";

function isActive(item: InstanceSummary): boolean {
  return (
    item.lifecycle === "running" || item.lifecycle === "paused" || item.lifecycle === "stopping"
  );
}

export function MachinePage({ machineId }: { machineId: string }) {
  const machines = useMachines(null);
  const instances = useInstances(machineId);
  const attention = useAttention(machineId, null);
  const go = useGo();
  const now = useNow(true, 30_000);
  const [startOpen, setStartOpen] = useState(false);
  const machine = machines.data?.find((item) => item.machineId === machineId);
  const version = useVersion(machineId, machine?.latestVersionId ?? null);

  const crumbs = [
    { label: "State machines", route: { screen: "list" as const } },
    { label: machine?.name ?? "Machine", route: null },
  ];

  if (machines.data !== undefined && machine === undefined)
    return (
      <Page crumbs={crumbs} title="Machine">
        <EmptyState
          title="This machine doesn't exist or was removed."
          actions={<Button onClick={() => go({ screen: "list" })}>Back to State machines</Button>}
        />
      </Page>
    );

  if (machine === undefined)
    return (
      <Page crumbs={crumbs} title="Machine">
        {machines.error === null ? (
          <Skeleton rows={3} height={44} />
        ) : (
          <ErrorAlert error={machines.error} onRetry={machines.refetch} />
        )}
      </Page>
    );

  const published = machine.latestVersionId !== null;
  const all = [...(instances.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const active = all.filter(isActive);
  const finished = all.filter((item) => !isActive(item));
  const openDraft = () => go({ screen: "draft", machineId, selection: null });

  const openInstance = (instanceId: string) =>
    go({ screen: "instance", machineId, instanceId, view: "graph", selection: null });

  return (
    <Page
      flush
      crumbs={crumbs}
      title={machine.name}
      titleExtra={
        <span className="stm-row stm-row--tight">
          {machine.latestVersionNumber === null ? (
            <Chip>Not published</Chip>
          ) : (
            <Chip tone="success">Published v{machine.latestVersionNumber}</Chip>
          )}
          {machine.draftChangeCount > 0 && published ? (
            <button type="button" className="stm-link stm-text-sm" onClick={openDraft}>
              {machine.draftChangeCount} unpublished change
              {machine.draftChangeCount === 1 ? "" : "s"}
            </button>
          ) : null}
        </span>
      }
      actions={
        published ? (
          <Button variant="primary" icon="Play" onClick={() => setStartOpen(true)}>
            Start instance
          </Button>
        ) : (
          <Button variant="primary" icon="Edit" onClick={openDraft}>
            Edit draft
          </Button>
        )
      }
      tabs={<MachineTabs machineId={machineId} active="overview" />}
    >
      {machine.description.length > 0 ? (
        <p className="stm-text-sm stm-text-muted stm-lede">{machine.description}</p>
      ) : null}
      {(attention.data ?? []).length > 0 ? (
        <section className="stm-stack" aria-label="Needs you">
          {(attention.data ?? []).map((item) => (
            <AttentionCard key={item.attentionId} item={item} />
          ))}
        </section>
      ) : null}
      <section className="stm-overview-runs" aria-labelledby="stm-overview-runs">
        <h2 id="stm-overview-runs" className="stm-h3 stm-text-muted">
          Instances
        </h2>
        {instances.error === null ? null : (
          <ErrorAlert error={instances.error} onRetry={instances.refetch} />
        )}
        {instances.data === undefined && instances.error === null ? (
          <Skeleton rows={1} height={40} />
        ) : null}
        {instances.data !== undefined && all.length === 0 ? (
          <p className="stm-text-sm stm-text-muted">
            {published
              ? `None yet. Start one to run v${machine.latestVersionNumber ?? ""}.`
              : "Publish the draft before starting an instance."}
          </p>
        ) : null}
        {active.length > 0 ? (
          <InstanceGroup
            title="Active"
            items={active}
            latest={machine.latestVersionNumber}
            now={now}
            onOpen={openInstance}
          />
        ) : null}
        {finished.length > 0 ? (
          <InstanceGroup
            title="Ended"
            items={finished}
            latest={machine.latestVersionNumber}
            now={now}
            onOpen={openInstance}
          />
        ) : null}
      </section>
      <section className="stm-overview-map" aria-label={published ? "Graph" : "Get started"}>
        {!published ? (
          <div className="stm-card">
            <h2 className="stm-h2">Get started</h2>
            <ol className="stm-steps">
              <li>
                <span className="stm-text-strong">Build the steps.</span> Add states and connect
                them in the draft editor.
              </li>
              <li>
                <span className="stm-text-strong">Publish.</span> Publishing saves an unchangeable
                version, v1.
              </li>
              <li>
                <span className="stm-text-strong">Start an instance.</span> An instance runs one
                version until you stop it or it ends.
              </li>
            </ol>
          </div>
        ) : version.data === undefined ? (
          version.error === null ? (
            <Skeleton rows={1} height={320} />
          ) : (
            <ErrorAlert error={version.error} onRetry={version.refetch} />
          )
        ) : (
          <Canvas
            definition={version.data.definition}
            mode="readonly"
            label={`${machine.name} v${version.data.number}`}
            selection={null}
            onSelect={() => undefined}
          />
        )}
      </section>
      {startOpen ? (
        <StartInstanceDialog
          machineId={machineId}
          projectId={machine.projectId}
          initialVersionId={machine.latestVersionId}
          onClose={() => setStartOpen(false)}
        />
      ) : null}
    </Page>
  );
}

function InstanceGroup({
  title,
  items,
  latest,
  now,
  onOpen,
}: {
  title: string;
  items: readonly InstanceSummary[];
  latest: number | null;
  now: number;
  onOpen(instanceId: string): void;
}) {
  return (
    <div className="stm-instance-group">
      <h3 className="stm-text-xs stm-text-muted">{title}</h3>
      <ul className="stm-instance-list">
        {items.map((item) => {
          const presentation = lifecyclePresentation(item.lifecycle, false);
          const phaseLabel = item.phase === null ? "" : phaseText(item.phase);
          const phase = phaseLabel === presentation.label ? "" : phaseLabel;

          return (
            <li key={item.instanceId}>
              <button
                type="button"
                className="stm-instance-card"
                aria-label={`Open instance ${shortId(item.instanceId)}, ${presentation.label}, in ${item.stateTitle}`}
                onClick={() => onOpen(item.instanceId)}
              >
                <span className="stm-row stm-row--tight stm-instance-card-head">
                  <Pill tone={presentation.tone}>{presentation.label}</Pill>
                  <span className="stm-text-strong stm-truncate">{item.stateTitle}</span>
                </span>
                {phase.length > 0 ? <span className="stm-text-sm">{phase}</span> : null}
                <span className="stm-text-xs stm-text-muted">
                  v{item.versionNumber}
                  {latest !== null && item.versionNumber < latest ? " (older version)" : ""} ·
                  started <TimeAgo at={item.startedAt} now={now} /> ·{" "}
                  <span className="stm-mono" title={item.instanceId}>
                    #{shortId(item.instanceId)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
