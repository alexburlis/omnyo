import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import { useId, useRef, useState } from "react";

import type { AttentionDecision } from "../data/contract.js";
import { Button } from "../primitives.js";

export function DecisionActions({
  decisions,
  onDecide,
}: {
  decisions: AttentionDecision[];
  onDecide: (decision: AttentionDecision, evidence: string) => Promise<void>;
}) {
  const evidenceId = useId();
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [withNote, setWithNote] = useState(false);
  const [evidence, setEvidence] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState<AttentionDecision | null>(null);
  const [recorded, setRecorded] = useState<AttentionDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const decision = decisions.find((option) => option.name === reviewing);
  const pending = submitting !== null;
  const leading = decisions.find((option) => option.disabledReason === null)?.name;

  async function decide(option: AttentionDecision) {
    if (inFlight.current || option.disabledReason !== null) return;
    inFlight.current = true;
    setSubmitting(option);
    setError(null);

    try {
      await onDecide(option, evidence.trim());
      setRecorded(option);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't record the decision.");
    } finally {
      inFlight.current = false;
      setSubmitting(null);
    }
  }

  function choose(option: AttentionDecision) {
    if (withNote || option.evidenceRequired || option.acknowledgement !== null) {
      setReviewing(option.name);
      setAcknowledged(false);
      setError(null);

      return;
    }

    void decide(option);
  }

  if (recorded !== null) {
    return (
      <p className="stm-decision-recorded" role="status">
        <span className="stm-decision-recorded-glyph" aria-hidden="true">
          <Icon name="Check" fallback="Circle" />
        </span>
        Recorded: {recorded.label}
      </p>
    );
  }

  return (
    <div className="stm-decision-actions">
      {decision === undefined ? (
        <div className="stm-decision-row">
          {decisions.map((option) => (
            <div key={option.name} className="stm-decision-action">
              <Button
                variant={option.name === leading ? "primary" : "secondary"}
                disabled={option.disabledReason !== null || pending}
                pending={submitting?.name === option.name}
                onClick={() => choose(option)}
              >
                {option.label}
              </Button>
              {option.disabledReason === null ? null : (
                <span className="stm-text-xs stm-text-muted">{option.disabledReason}</span>
              )}
            </div>
          ))}
          {decisions.some(
            (option) =>
              option.disabledReason === null &&
              !option.evidenceRequired &&
              option.evidencePrompt !== "",
          ) ? (
            <span className="stm-decision-note-toggle">
              <Button
                variant="ghost"
                icon={withNote ? "X" : "Edit"}
                disabled={pending}
                onClick={() => setWithNote(!withNote)}
              >
                {withNote ? "Cancel note" : "Add a note"}
              </Button>
            </span>
          ) : null}
        </div>
      ) : (
        <>
          {withNote || decision.evidenceRequired ? (
            <div className="stm-field">
              <label className="stm-field-label" htmlFor={evidenceId}>
                {decision.evidencePrompt || "Note"}
                {decision.evidenceRequired ? " (required)" : ""}
              </label>
              <textarea
                id={evidenceId}
                className="stm-input stm-textarea"
                value={evidence}
                maxLength={4000}
                disabled={pending}
                onChange={(event) => setEvidence(event.target.value)}
              />
            </div>
          ) : null}
          {decision.acknowledgement === null ? null : (
            <label className="stm-check">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={pending}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>{decision.acknowledgement}</span>
            </label>
          )}
          <div className="stm-decision-row">
            <Button
              variant="primary"
              disabled={
                decision.disabledReason !== null ||
                (decision.evidenceRequired && evidence.trim() === "") ||
                (decision.acknowledgement !== null && !acknowledged)
              }
              pending={pending}
              onClick={() => void decide(decision)}
            >
              {decision.label}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setReviewing(null);
                setEvidence("");
                setError(null);
              }}
            >
              Back
            </Button>
          </div>
        </>
      )}
      {pending ? (
        <p className="stm-decision-pending" role="status">
          Recording decision…
        </p>
      ) : null}
      {error === null ? null : (
        <p className="stm-attention-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
