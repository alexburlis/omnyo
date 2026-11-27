import { useMemo, useState } from "react";

import { errorFromCatch, newRequestId, type SmError, useSmClient } from "../data/client.js";
import type { MachineDefinition } from "../data/contract.js";
import { useMachines, useVersion, useVersions } from "../data/hooks.js";
import { useQueryStore } from "../data/query.js";
import { Canvas, type DiffMark } from "../graph/Canvas.js";
import { StateInspector } from "../inspector/StateInspector.js";
import { TransitionInspector } from "../inspector/TransitionInspector.js";
import {
  Button,
  Chip,
  Dialog,
  EmptyState,
  ErrorAlert,
  Skeleton,
  TimeAgo,
  useNow,
} from "../primitives.js";
import type { Selection } from "../routes.js";
import { FloatingPanel, MachineTabs, Page, useGo } from "../shell.js";

const NOOP = () => undefined;

export function VersionList({ machineId }: { machineId: string }) {
  const versions = useVersions(machineId);
  const machines = useMachines(null);
  const machine = machines.data?.find((item) => item.machineId === machineId);
  const go = useGo();
  const now = useNow(true, 60_000);
  const sorted = [...(versions.data ?? [])].sort((a, b) => b.number - a.number);

  return (
    <Page
      crumbs={[
        { label: "State machines", route: { screen: "list" } },
        { label: machine?.name ?? "Machine", route: { screen: "machine", machineId } },
        { label: "Versions", route: null },
      ]}
      title={machine?.name ?? "Versions"}
      tabs={<MachineTabs machineId={machineId} active="versions" />}
    >
      <p className="stm-text-sm stm-text-muted stm-lede">
        Each publish saves an unchangeable version. Instances keep the version they started with.
      </p>
      {versions.error === null ? null : (
        <ErrorAlert error={versions.error} onRetry={versions.refetch} />
      )}
      {versions.data === undefined && versions.error === null ? (
        <Skeleton rows={3} height={36} />
      ) : null}
      {versions.data !== undefined && versions.data.length === 0 ? (
        <EmptyState title="Not published yet" body="Publish the draft to create v1." />
      ) : null}
      {sorted.length > 0 ? (
        <table className="stm-table">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Published</th>
              <th scope="col" className="stm-hide-compact">
                Note
              </th>
              <th scope="col">Instances</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((version, index) => (
              <tr key={version.versionId} className="stm-table-row">
                <td>
                  <button
                    type="button"
                    className="stm-row-link"
                    onClick={() =>
                      go({
                        screen: "version",
                        machineId,
                        versionId: version.versionId,
                        compareWith: null,
                        selection: null,
                      })
                    }
                  >
                    v{version.number} {index === 0 ? <Chip tone="success">Latest</Chip> : null}
                  </button>
                </td>
                <td className="stm-text-muted">
                  <TimeAgo at={version.publishedAt} now={now} />
                </td>
                <td className="stm-hide-compact">{version.note}</td>
                <td>{version.instanceCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Page>
  );
}

export function diffDefinitions(
  newer: MachineDefinition,
  older: MachineDefinition,
): Map<string, DiffMark> {
  const marks = new Map<string, DiffMark>();
  const oldStates = new Map(older.states.map((state) => [state.id, JSON.stringify(state)]));
  const oldEdges = new Map(older.transitions.map((edge) => [edge.id, JSON.stringify(edge)]));

  for (const state of newer.states) {
    const before = oldStates.get(state.id);

    if (before === undefined) marks.set(`state:${state.id}`, "added");
    else if (before !== JSON.stringify(state)) marks.set(`state:${state.id}`, "changed");
  }

  for (const edge of newer.transitions) {
    const before = oldEdges.get(edge.id);

    if (before === undefined) marks.set(`tr:${edge.id}`, "added");
    else if (before !== JSON.stringify(edge)) marks.set(`tr:${edge.id}`, "changed");
  }

  return marks;
}

export function VersionScreen({
  machineId,
  versionId,
  compareWith,
  selection,
}: {
  machineId: string;
  versionId: string;
  compareWith: string | null;
  selection: Selection;
}) {
  const version = useVersion(machineId, versionId);
  const other = useVersion(machineId, compareWith);
  const versions = useVersions(machineId);
  const machines = useMachines(null);
  const machine = machines.data?.find((item) => item.machineId === machineId);
  const go = useGo();
  const client = useSmClient();
  const store = useQueryStore();
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyError, setCopyError] = useState<SmError | null>(null);
  const [copying, setCopying] = useState(false);
  const [requestId] = useState(newRequestId);

  const diff = useMemo(
    () =>
      version.data !== undefined && other.data !== undefined
        ? diffDefinitions(version.data.definition, other.data.definition)
        : undefined,
    [other.data, version.data],
  );

  const removed = useMemo(() => {
    if (version.data === undefined || other.data === undefined) return [];

    const current = new Set(version.data.definition.states.map((state) => state.id));

    return other.data.definition.states
      .filter((state) => !current.has(state.id))
      .map((state) => state.title);
  }, [other.data, version.data]);

  const select = (next: Selection) =>
    go(
      { screen: "version", machineId, versionId, compareWith, selection: next },
      { replace: true },
    );

  const copyToDraft = async () => {
    if (version.data === undefined) return;

    setCopying(true);
    setCopyError(null);

    try {
      const draft = await client.call("sm_machine_draft_get", { machineId });

      await client.call("sm_machine_draft_save", {
        machineId,
        expectedRevision: draft.draftRevision,
        document: version.data.definition,
        requestId,
      });
      store.refetchMatching(`draft:${machineId}`);
      setCopyOpen(false);
      go({ screen: "draft", machineId, selection: null });
    } catch (caught) {
      setCopyError(errorFromCatch(caught instanceof Error ? caught : null));
    } finally {
      setCopying(false);
    }
  };

  const crumbs = [
    { label: "State machines", route: { screen: "list" as const } },
    { label: machine?.name ?? "Machine", route: { screen: "machine" as const, machineId } },
    { label: "Versions", route: { screen: "versions" as const, machineId } },
    { label: version.data === undefined ? "Version" : `v${version.data.number}`, route: null },
  ];

  if (version.data === undefined)
    return (
      <Page crumbs={crumbs} title="Version">
        {version.error === null ? (
          <Skeleton rows={4} height={48} />
        ) : (
          <ErrorAlert error={version.error} onRetry={version.refetch} subject="version" />
        )}
      </Page>
    );

  const definition = version.data.definition;
  const stateTitles = new Map(definition.states.map((state) => [state.id, state.title]));

  const stateIndex =
    selection?.kind === "state"
      ? definition.states.findIndex((state) => state.id === selection.id)
      : -1;

  const edgeIndex =
    selection?.kind === "transition"
      ? definition.transitions.findIndex((edge) => edge.id === selection.id)
      : -1;

  const state = definition.states[stateIndex];
  const edge = definition.transitions[edgeIndex];

  return (
    <Page
      flush
      crumbs={crumbs}
      title={`v${version.data.number}`}
      tabs={<MachineTabs machineId={machineId} active="versions" />}
      titleExtra={
        <span className="stm-text-sm stm-text-muted">
          published {new Date(version.data.publishedAt).toLocaleDateString()}
        </span>
      }
      actions={
        <>
          <label className="stm-sr-only" htmlFor="stm-compare">
            Compare with
          </label>
          <select
            id="stm-compare"
            className="stm-input stm-input--short"
            value={compareWith ?? ""}
            onChange={(event) =>
              go({
                screen: "version",
                machineId,
                versionId,
                compareWith: event.target.value.length > 0 ? event.target.value : null,
                selection,
              })
            }
          >
            <option value="">Compare with…</option>
            {(versions.data ?? [])
              .filter((item) => item.versionId !== versionId)
              .sort((a, b) => b.number - a.number)
              .map((item) => (
                <option key={item.versionId} value={item.versionId}>
                  v{item.number}
                </option>
              ))}
          </select>
          <Button onClick={() => setCopyOpen(true)}>Copy to draft</Button>
        </>
      }
      banner={
        removed.length > 0 ? (
          <p className="stm-text-sm stm-diff-removed-list">
            Removed since the compared version: {removed.join(", ")}
          </p>
        ) : undefined
      }
    >
      {version.data.note.length > 0 ? (
        <p className="stm-text-sm stm-text-muted stm-lede">{version.data.note}</p>
      ) : null}
      <div className="stm-workspace">
        <div className="stm-workspace-main">
          <Canvas
            definition={definition}
            mode="readonly"
            label={`v${version.data.number}`}
            selection={selection}
            onSelect={select}
            diff={diff}
            occludeRight={selection !== null}
          />
        </div>
        {state === undefined && edge === undefined ? null : (
          <FloatingPanel label="Inspector" flushTop onClose={() => select(null)}>
            {state !== undefined ? (
              <StateInspector
                state={state}
                stateIndex={stateIndex}
                editable={false}
                published
                isInitial={definition.initialStateId === state.id}
                problems={[]}
                outgoing={definition.transitions.filter((item) => item.from === state.id)}
                incoming={definition.transitions.filter((item) => item.to === state.id)}
                edgeLabels={definition.layout.edgeLabels}
                stateTitles={stateTitles}
                contextSchema={definition.contextSchema}
                environments={[]}
                projectId={null}
                standingAuthority={null}
                dispatch={NOOP}
                onSelectTransition={(id) => select({ kind: "transition", id })}
                onAddTransition={NOOP}
                onReorder={NOOP}
              />
            ) : null}
            {edge !== undefined ? (
              <TransitionInspector
                edge={edge}
                index={edgeIndex}
                states={definition.states}
                editable={false}
                problems={[]}
                edgeLabels={definition.layout.edgeLabels}
                hasCustomRoute={false}
                contextSchema={definition.contextSchema}
                dispatch={NOOP}
                onDelete={NOOP}
                onSelectState={(id) => select({ kind: "state", id })}
              />
            ) : null}
          </FloatingPanel>
        )}
      </div>
      <Dialog
        open={copyOpen}
        onOpenChange={setCopyOpen}
        title={`Replace the draft with v${version.data.number}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCopyOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" pending={copying} onClick={() => void copyToDraft()}>
              Replace draft
            </Button>
          </>
        }
      >
        <p className="stm-text-sm">Current draft changes are lost.</p>
        {copyError === null ? null : <ErrorAlert error={copyError} />}
      </Dialog>
    </Page>
  );
}
