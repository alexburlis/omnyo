import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import { useId, useState } from "react";

import type { InstanceView, StepView } from "../data/contract.js";
import { ACTIVE_STEP_STATUSES, displayStepStatus, stepStatusText } from "../data/projection.js";
import { Alert, Button, Dialog, ErrorAlert } from "../primitives.js";
import type { ControlState } from "./useControl.js";

const PENDING_LABEL = {
  pause: "Pausing…",
  "pause-after-step": "Pausing after this step…",
  resume: "Resuming…",
  stop: "Stopping…",
  "cancel-step": "Cancelling…",
  "mark-unknown": "Recording…",
} as const;

export function activeSteps(instance: InstanceView): StepView[] {
  return instance.steps.filter((step) => ACTIVE_STEP_STATUSES.includes(displayStepStatus(step)));
}

function stateTitle(instance: InstanceView, stateId: string): string {
  return instance.definition.states.find((state) => state.id === stateId)?.title ?? stateId;
}

export function RunControls({
  instance,
  control,
  onStartNew,
}: {
  instance: InstanceView;
  control: ControlState;
  onStartNew(): void;
}) {
  const [stopOpen, setStopOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const pendingLabel = control.pending === null ? null : PENDING_LABEL[control.pending];
  const busy = control.pending !== null;
  const running = activeSteps(instance);

  const resume = async () => {
    if (await control.run({ kind: "resume" })) setResumeOpen(false);
  };

  return (
    <>
      {instance.lifecycle === "running" ? (
        <>
          <Button
            variant="primary"
            icon="Pause"
            pending={control.pending === "pause"}
            disabled={busy}
            onClick={() => void control.run({ kind: "pause" })}
          >
            {control.pending === "pause" ? pendingLabel : "Pause"}
          </Button>
          <div className="stm-menu-anchor">
            <Button
              icon="MoreHorizontal"
              ariaLabel="More run controls"
              disabled={busy}
              onClick={() => setMenuOpen((value) => !value)}
            />
            {menuOpen ? (
              <div
                id={menuId}
                className="stm-menu stm-menu--end"
                role="menu"
                aria-label="Run controls"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="stm-menu-item"
                  disabled={instance.pauseAfterStep}
                  onClick={() => {
                    setMenuOpen(false);
                    void control.run({ kind: "pause-after-step" });
                  }}
                >
                  <Icon name="Pause" aria-hidden />
                  <span>
                    {instance.pauseAfterStep
                      ? "Pausing after this step"
                      : "Pause after current step"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="stm-menu-item stm-menu-item--danger"
                  onClick={() => {
                    setMenuOpen(false);
                    setStopOpen(true);
                  }}
                >
                  <Icon name="Square" aria-hidden />
                  <span>Stop…</span>
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      {instance.lifecycle === "paused" ? (
        <>
          <Button
            variant="primary"
            icon="Play"
            pending={control.pending === "resume"}
            disabled={busy}
            onClick={() =>
              instance.expiredWhilePaused.length > 0
                ? setResumeOpen(true)
                : void control.run({ kind: "resume" })
            }
          >
            {control.pending === "resume" ? pendingLabel : "Resume"}
          </Button>
          <Button icon="Square" disabled={busy} onClick={() => setStopOpen(true)}>
            Stop…
          </Button>
        </>
      ) : null}
      {instance.lifecycle === "stopping" ? (
        <span className="stm-text-sm stm-text-muted" role="status">
          Stopping… {running.length} step{running.length === 1 ? "" : "s"} ending
        </span>
      ) : null}
      {instance.lifecycle === "stopped" ||
      instance.lifecycle === "completed" ||
      instance.lifecycle === "failed" ? (
        <Button
          variant="primary"
          icon="Play"
          onClick={onStartNew}
          disabled={instance.unknownOutcomes.some((outcome) => outcome.blocksRestartIn !== null)}
          disabledReason={blockedReason(instance)}
        >
          Start new instance
        </Button>
      ) : null}
      <Dialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title={`Stop this ${instance.machineName} instance?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setStopOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              pending={control.pending === "stop"}
              onClick={() =>
                void control.run({ kind: "stop" }).then((ok) => ok && setStopOpen(false))
              }
            >
              Stop instance
            </Button>
          </>
        }
      >
        <p className="stm-text-sm">
          Running steps are cancelled. The instance can't be resumed; start a new one to run again.
        </p>
        {running.length > 0 ? (
          <ul className="stm-list">
            {running.map((step) => (
              <li key={step.invocationId}>
                {stateTitle(instance, step.stateId)} · {stepStatusText(step, Date.now(), false)}
              </li>
            ))}
          </ul>
        ) : null}
        {control.error !== null && control.pending === null && stopOpen ? (
          <ErrorAlert error={control.error} />
        ) : null}
      </Dialog>
      <Dialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        title="Resume this instance?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResumeOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              pending={control.pending === "resume"}
              onClick={() => void resume()}
            >
              Resume
            </Button>
          </>
        }
      >
        <p className="stm-text-sm">
          {instance.expiredWhilePaused.length} deadline
          {instance.expiredWhilePaused.length === 1 ? "" : "s"} passed while paused. Results that
          arrived before their deadline still count; the others time out and follow their timeout
          routes.
        </p>
        <ul className="stm-list">
          {instance.expiredWhilePaused.map((stateId) => (
            <li key={stateId}>{stateTitle(instance, stateId)}</li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

function blockedReason(instance: InstanceView): string | undefined {
  const blocking = instance.unknownOutcomes.find((outcome) => outcome.blocksRestartIn !== null);

  if (blocking === undefined) return undefined;

  return `Reconcile ${stateTitle(instance, blocking.stateId)} before starting again in ${blocking.blocksRestartIn ?? "this environment"}.`;
}

export function ControlError({ control }: { control: ControlState }) {
  if (control.error === null) return null;

  return <ErrorAlert error={control.error} onRetry={undefined} />;
}

export function PauseAfterStepNotice({ instance }: { instance: InstanceView }) {
  if (instance.lifecycle === "paused" && instance.pendingResultCount > 0)
    return (
      <Alert tone="info">
        Paused. {instance.pendingResultCount} result waiting; it's applied when you resume.
      </Alert>
    );

  return null;
}
