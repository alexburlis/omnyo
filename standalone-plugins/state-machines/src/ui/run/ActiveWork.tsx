import {
  experimental_copyToClipboard as copyToClipboard,
  experimental_useAppNavigate,
} from "@omnyo/plugin-sdk/app";
import { useId, useState } from "react";

import type { InstanceView, StepView } from "../data/contract.js";
import { displayStepStatus, formatRelativeDuration, stepStatusText } from "../data/projection.js";
import { Button, Dialog, ErrorAlert, formatAbsolute } from "../primitives.js";
import { activeSteps } from "./RunControls.js";
import type { ControlState } from "./useControl.js";

function stateTitle(instance: InstanceView, stateId: string): string {
  return instance.definition.states.find((state) => state.id === stateId)?.title ?? stateId;
}

export function ActiveWork({
  instance,
  control,
  now,
  frozen,
  onOpenOutput,
}: {
  instance: InstanceView;
  control: ControlState;
  now: number;
  frozen: boolean;
  onOpenOutput(step: StepView): void;
}) {
  const navigate = experimental_useAppNavigate();
  const [cancelling, setCancelling] = useState<StepView | null>(null);
  const [marking, setMarking] = useState<StepView | null>(null);
  const steps = activeSteps(instance);

  return (
    <section className="stm-card" aria-labelledby="stm-active-work">
      <h2 id="stm-active-work" className="stm-h2">
        Active work
      </h2>
      {steps.length === 0 ? <p className="stm-text-sm stm-text-muted">No work running.</p> : null}
      <ul className="stm-work-list">
        {steps.map((step) => {
          const display = displayStepStatus(step);

          return (
            <li key={step.attemptId} className={`stm-work stm-work--${display}`}>
              <div className="stm-work-main">
                <span className="stm-text-strong">{stateTitle(instance, step.stateId)}</span>
                <span className="stm-text-sm">{stepStatusText(step, now, frozen)}</span>
                <span className="stm-text-xs stm-text-muted">
                  {step.kind === "agent" ? "Agent" : "Command"} · attempt {step.attempt}/
                  {step.maxAttempts} · {step.environmentLabel}
                  {step.deadlineAt === null ? null : (
                    <>
                      {" · "}
                      <time
                        dateTime={formatAbsolute(step.deadlineAt)}
                        title={formatAbsolute(step.deadlineAt)}
                      >
                        {step.deadlineAt > now
                          ? `deadline in ${formatRelativeDuration(step.deadlineAt - now)}`
                          : "deadline passed"}
                      </time>
                    </>
                  )}
                  {step.confirmedLive ? " · confirmed running" : ""}
                </span>
              </div>
              <div className="stm-row stm-row--tight">
                {step.threadId !== null ? (
                  <Button
                    icon="MessageSquare"
                    onClick={() =>
                      step.threadId !== null && navigate.toThread(step.threadId, { split: true })
                    }
                  >
                    Open thread
                  </Button>
                ) : null}
                {step.kind === "command" ? (
                  <Button icon="FileText" onClick={() => onOpenOutput(step)}>
                    Output
                  </Button>
                ) : null}
                {display !== "cancelling" &&
                display !== "uncertain" &&
                instance.lifecycle !== "stopped" ? (
                  <Button variant="ghost" onClick={() => setCancelling(step)}>
                    Cancel step
                  </Button>
                ) : null}
                {instance.lifecycle === "stopping" &&
                step.markUnknownAllowed &&
                !step.confirmedLive ? (
                  <Button variant="ghost" onClick={() => setMarking(step)}>
                    Mark outcome unknown…
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {cancelling === null ? null : (
        <CancelStepDialog
          instance={instance}
          step={cancelling}
          control={control}
          onClose={() => setCancelling(null)}
        />
      )}
      {marking === null ? null : (
        <MarkUnknownDialog
          instance={instance}
          step={marking}
          control={control}
          onClose={() => setMarking(null)}
        />
      )}
    </section>
  );
}

function CancelStepDialog({
  instance,
  step,
  control,
  onClose,
}: {
  instance: InstanceView;
  step: StepView;
  control: ControlState;
  onClose(): void;
}) {
  const title = stateTitle(instance, step.stateId);

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Cancel ${title}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep running
          </Button>
          <Button
            variant="destructive"
            pending={control.pending === "cancel-step"}
            onClick={() =>
              void control
                .run({
                  kind: "cancel-step",
                  invocationId: step.invocationId,
                  entryId: step.entryId,
                })
                .then((ok) => ok && onClose())
            }
          >
            Cancel step
          </Button>
        </>
      }
    >
      <p className="stm-text-sm">
        New work waits until it ends. Then it follows its cancellation route, or asks you.
      </p>
      {control.error === null ? null : <ErrorAlert error={control.error} />}
    </Dialog>
  );
}

function MarkUnknownDialog({
  instance,
  step,
  control,
  onClose,
}: {
  instance: InstanceView;
  step: StepView;
  control: ControlState;
  onClose(): void;
}) {
  const [evidence, setEvidence] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const evidenceId = useId();
  const title = stateTitle(instance, step.stateId);
  const ready = evidence.trim().length > 0 && acknowledged;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Record outcome as unknown?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            pending={control.pending === "mark-unknown"}
            onClick={() =>
              void control
                .run({
                  kind: "mark-unknown",
                  invocationId: step.invocationId,
                  entryId: step.entryId,
                  expectedRevision: instance.revision,
                  evidence: evidence.trim(),
                  acknowledged: true,
                })
                .then((ok) => ok && onClose())
            }
          >
            Record unknown
          </Button>
        </>
      }
    >
      <p className="stm-text-sm">
        Omnyo can't see whether {title} is still running. Record its outcome as unknown so the
        instance can finish stopping? This doesn't stop the process or allow a retry. Check{" "}
        {step.environmentLabel} yourself.
      </p>
      <div className="stm-field">
        <label className="stm-field-label" htmlFor={evidenceId}>
          What you checked (required)
        </label>
        <textarea
          id={evidenceId}
          className="stm-input stm-textarea"
          maxLength={4000}
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
        />
      </div>
      <label className="stm-check">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>I understand the outcome stays unknown.</span>
      </label>
      {control.error === null ? null : <ErrorAlert error={control.error} />}
    </Dialog>
  );
}

export function ContextCard({ instance }: { instance: InstanceView }) {
  return (
    <section className="stm-card" aria-labelledby="stm-context">
      <h2 id="stm-context" className="stm-h2">
        Context
      </h2>
      {instance.context.length === 0 && instance.budgets.length === 0 ? (
        <p className="stm-text-sm stm-text-muted">No context values.</p>
      ) : null}
      <dl className="stm-kv">
        {instance.context.map((entry) => (
          <div key={entry.path} className="stm-kv-row">
            <dt className="stm-text-muted">{entry.path}</dt>
            <dd className={entry.isHash ? "stm-mono" : undefined}>
              {entry.display}
              {entry.isHash ? (
                <button
                  type="button"
                  className="stm-tool"
                  aria-label={`Copy ${entry.path}`}
                  onClick={() => void copyToClipboard({ text: entry.display })}
                >
                  Copy
                </button>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      {instance.budgets.map((budget) => (
        <div key={`${budget.label}:${budget.subject}`} className="stm-meter">
          <span className="stm-text-sm">
            {budget.label}
            {budget.subject.length > 0 ? ` for ${budget.subject}` : ""}: {budget.used} of{" "}
            {budget.limit}
          </span>
          <progress
            max={budget.limit}
            value={Math.min(budget.used, budget.limit)}
            aria-label={`${budget.label}: ${budget.used} of ${budget.limit}`}
          />
        </div>
      ))}
      <p className="stm-text-sm stm-text-muted">Cycles completed: {instance.cyclesCompleted}</p>
    </section>
  );
}
