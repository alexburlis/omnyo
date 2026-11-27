import { useEffect, useMemo, useRef, useState } from "react";

import { useIsCompactViewport } from "../../../components/omnyo/components/ui/hooks/use-compact-viewport.js";
import type { InstanceView, StepView } from "../data/contract.js";
import { useAttention, useInstance, useMachines } from "../data/hooks.js";
import { lifecyclePresentation, phaseText, statusSummary } from "../data/projection.js";
import { Canvas } from "../graph/Canvas.js";
import { InstanceLog, OutputDialog } from "../log/InstanceLog.js";
import { Outline } from "../outline/Outline.js";
import {
  Alert,
  Button,
  Chip,
  EmptyState,
  ErrorAlert,
  Pill,
  Sheet,
  Skeleton,
  useNow,
} from "../primitives.js";
import type { InstanceTab, Selection } from "../routes.js";
import { HomeChatButton } from "../attention/CauseSummary.js";
import { ActiveWork, ContextCard } from "../run/ActiveWork.js";
import { ControlError, PauseAfterStepNotice, RunControls } from "../run/RunControls.js";
import { useControl } from "../run/useControl.js";
import { FloatingPanel, Page, shortId, useAnnounce, useConnectionFrozen, useGo } from "../shell.js";
import { LiveInspector } from "./LiveInspector.js";
import { StartInstanceDialog } from "./StartInstanceDialog.js";

export function InstanceScreen({
  machineId,
  instanceId,
  view,
  selection,
}: {
  machineId: string;
  instanceId: string;
  view: InstanceTab;
  selection: Selection;
}) {
  const instance = useInstance(instanceId);

  const crumbs = [
    { label: "State machines", route: { screen: "list" as const } },
    {
      label: instance.data?.machineName ?? "Machine",
      route: { screen: "machine" as const, machineId },
    },
    { label: `Instance #${shortId(instanceId)}`, route: null },
  ];

  if (instance.data === undefined && instance.error !== null)
    return (
      <Page crumbs={crumbs} title="Instance">
        {instance.error.code === "NOT_FOUND" ? (
          <EmptyState title="This instance doesn't exist." />
        ) : (
          <ErrorAlert error={instance.error} onRetry={instance.refetch} subject="instance" />
        )}
      </Page>
    );

  if (instance.data === undefined)
    return (
      <Page crumbs={crumbs} title="Instance">
        <Skeleton rows={1} height={24} />
        <Skeleton rows={1} height={360} />
      </Page>
    );

  return (
    <InstanceLoaded
      instance={instance.data}
      view={view}
      selection={selection}
      refreshError={instance.error}
      onRetry={instance.refetch}
    />
  );
}

function InstanceLoaded({
  instance,
  view,
  selection,
  refreshError,
  onRetry,
}: {
  instance: InstanceView;
  view: InstanceTab;
  selection: Selection;
  refreshError: ReturnType<typeof useInstance>["error"];
  onRetry(): void;
}) {
  const go = useGo();
  const announce = useAnnounce();
  const compact = useIsCompactViewport();
  const frozen = useConnectionFrozen();

  const live =
    instance.lifecycle === "running" ||
    instance.lifecycle === "paused" ||
    instance.lifecycle === "stopping";

  const now = useNow(live && !frozen);
  const control = useControl(instance);
  const attention = useAttention(null, instance.instanceId);
  const machines = useMachines(null);

  const projectId =
    machines.data?.find((item) => item.machineId === instance.machineId)?.projectId ?? null;

  const [startOpen, setStartOpen] = useState(false);
  const [outputFor, setOutputFor] = useState<StepView | null>(null);
  const [follow, setFollow] = useState(true);
  const [graphChosen, setGraphChosen] = useState(false);
  const [detailsChoice, setDetailsChoice] = useState<boolean | null>(null);
  const detailsOpen = detailsChoice ?? (attention.data?.length ?? 0) > 0;
  const panelOpen = selection !== null || detailsOpen;

  const effectiveView: InstanceTab =
    compact && view === "graph" && selection === null && !graphChosen ? "outline" : view;

  const stateTitle =
    instance.definition.states.find((state) => state.id === instance.stateId)?.title ??
    instance.stateId;

  const presentation = lifecyclePresentation(
    instance.lifecycle,
    instance.unknownOutcomes.length > 0,
  );

  const previous = useRef({
    stateId: instance.stateId,
    lifecycle: instance.lifecycle,
    attention: 0,
  });

  useEffect(() => {
    const before = previous.current;
    const attentionCount = attention.data?.length ?? 0;

    if (before.stateId !== instance.stateId) announce(`Moved to ${stateTitle}.`);
    else if (before.lifecycle !== instance.lifecycle)
      announce(`${instance.machineName} is ${presentation.label.toLowerCase()}.`);

    if (attentionCount > before.attention) announce(`${instance.machineName} needs you.`);

    previous.current = {
      stateId: instance.stateId,
      lifecycle: instance.lifecycle,
      attention: attentionCount,
    };
  }, [
    announce,
    attention.data,
    instance.lifecycle,
    instance.machineName,
    instance.stateId,
    presentation.label,
    stateTitle,
  ]);

  const setView = (next: InstanceTab) => {
    setGraphChosen(next === "graph");
    go(
      {
        screen: "instance",
        machineId: instance.machineId,
        instanceId: instance.instanceId,
        view: next,
        selection,
      },
      { replace: true },
    );
  };

  const select = (next: Selection) =>
    go(
      {
        screen: "instance",
        machineId: instance.machineId,
        instanceId: instance.instanceId,
        view: effectiveView,
        selection: next,
      },
      { replace: true },
    );

  const closePanel = () => {
    setDetailsChoice(false);

    if (selection !== null) select(null);
  };

  const liveOverlay = useMemo(() => ({ instance, now, frozen }), [frozen, instance, now]);

  const statusLine = (
    <p className="stm-text-sm">
      <span className="stm-text-muted">{live ? "Now in " : "Ended in "}</span>
      <span className="stm-text-strong">{stateTitle}</span>
      {statusSummary(stateTitle, instance.summary) === null ? null : (
        <span> · {statusSummary(stateTitle, instance.summary)}</span>
      )}
      {instance.phase === null ? null : (
        <span className="stm-text-muted"> · {phaseText(instance.phase)}</span>
      )}
      {instance.pauseAfterStep && instance.lifecycle === "running" ? (
        <span className="stm-text-muted"> · pausing after this step</span>
      ) : null}
    </p>
  );

  const lowerCards = (
    <>
      <ActiveWork
        instance={instance}
        control={control}
        now={now}
        frozen={frozen}
        onOpenOutput={setOutputFor}
      />
      <ContextCard instance={instance} />
    </>
  );

  const inspector = (
    <LiveInspector
      instance={instance}
      selection={selection}
      attention={attention.data ?? []}
      control={control}
      now={now}
      frozen={frozen}
      onSelect={select}
      onViewLog={() => setView("log")}
      lowerCards={compact ? null : lowerCards}
    />
  );

  return (
    <Page
      flush
      crumbs={[
        { label: "State machines", route: { screen: "list" } },
        {
          label: instance.machineName,
          route: { screen: "machine", machineId: instance.machineId },
        },
        { label: `Instance #${shortId(instance.instanceId)}`, route: null },
      ]}
      title={instance.machineName}
      titleExtra={
        <span className="stm-row stm-row--tight">
          <Pill tone={presentation.tone}>
            {instance.lifecycle === "running" && instance.pauseAfterStep
              ? "Running · pausing after this step"
              : presentation.label}
          </Pill>
          <Chip>v{instance.versionNumber}</Chip>
        </span>
      }
      statusLine={statusLine}
      actions={
        <span className="stm-row stm-row--tight">
          {instance.homeThreadId === null ? null : (
            <HomeChatButton threadId={instance.homeThreadId} />
          )}
          <RunControls
            instance={instance}
            control={control}
            onStartNew={() => setStartOpen(true)}
          />
        </span>
      }
      banner={
        <>
          {refreshError === null ? null : <ErrorAlert error={refreshError} onRetry={onRetry} />}
          <ControlError control={control} />
          <PauseAfterStepNotice instance={instance} />
          {instance.versionNumber < instance.latestVersionNumber ? (
            <Alert
              tone="info"
              actions={
                <Button
                  onClick={() =>
                    go({
                      screen: "version",
                      machineId: instance.machineId,
                      versionId: instance.versionId,
                      compareWith: null,
                      selection: null,
                    })
                  }
                >
                  Compare
                </Button>
              }
            >
              Runs v{instance.versionNumber}. v{instance.latestVersionNumber} is published.
            </Alert>
          ) : null}
          {instance.quarantined === null ? null : (
            <Alert
              tone="danger"
              title="This instance is held because its stored data didn't validate."
            >
              <p className="stm-text-sm">
                Code {instance.quarantined.code} · reference{" "}
                <code className="stm-mono">{instance.quarantined.reference}</code>
              </p>
            </Alert>
          )}
          {instance.unknownOutcomes.length > 0 && instance.lifecycle === "stopped" ? (
            <Alert tone="warning" title="Stopped with an unknown outcome.">
              <p className="stm-text-sm">Check the attention card before starting again.</p>
            </Alert>
          ) : null}
        </>
      }
    >
      <div className="stm-workspace">
        <div className="stm-workspace-main">
          <div className="stm-row stm-view-switch-row">
            <div className="stm-toggle-group stm-view-switch" role="group" aria-label="View">
              {(["graph", "outline", "log"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className="stm-toggle"
                  aria-pressed={effectiveView === tab}
                  onClick={() => setView(tab)}
                >
                  {tab === "graph" ? "Graph" : tab === "outline" ? "Outline" : "Activity log"}
                </button>
              ))}
            </div>
            {effectiveView === "graph" ? (
              <label className="stm-check stm-text-sm">
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(event) => setFollow(event.target.checked)}
                />
                <span>Keep current state in view</span>
              </label>
            ) : null}
            <button
              type="button"
              className="stm-toggle stm-details-toggle"
              aria-pressed={panelOpen}
              onClick={() => {
                if (panelOpen) closePanel();
                else setDetailsChoice(true);
              }}
            >
              Details
            </button>
          </div>
          {effectiveView === "graph" ? (
            <Canvas
              definition={instance.definition}
              mode="inspect"
              label={instance.machineName}
              selection={selection}
              onSelect={select}
              live={liveOverlay}
              followCurrent={follow}
              occludeRight={panelOpen && !compact}
            />
          ) : null}
          {effectiveView === "outline" ? (
            <Outline
              definition={instance.definition}
              label={instance.machineName}
              selection={selection}
              onSelect={select}
              live={liveOverlay}
            />
          ) : null}
          {effectiveView === "log" ? <InstanceLog instanceId={instance.instanceId} /> : null}
          {effectiveView !== "log" && compact ? (
            <div className="stm-lower-cards">{lowerCards}</div>
          ) : null}
        </div>
        {compact ? (
          <Sheet open={panelOpen} onOpenChange={(open) => !open && closePanel()} label="Inspector">
            {inspector}
          </Sheet>
        ) : panelOpen ? (
          <FloatingPanel label="Inspector" onClose={closePanel}>
            {inspector}
          </FloatingPanel>
        ) : null}
      </div>
      {startOpen ? (
        <StartInstanceDialog
          machineId={instance.machineId}
          projectId={projectId}
          initialVersionId={instance.versionId}
          onClose={() => setStartOpen(false)}
        />
      ) : null}
      {outputFor === null ? null : (
        <OutputDialog invocationId={outputFor.invocationId} onClose={() => setOutputFor(null)} />
      )}
    </Page>
  );
}
