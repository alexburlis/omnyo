import { useEffect, useId, useState } from "react";

import { errorFromCatch, newRequestId, SmError, useSmClient } from "../data/client.js";
import type { ValidationView } from "../data/contract.js";
import { ChangeSummaryList } from "../inspector/DraftOverview.js";
import { Button, Dialog, ErrorAlert, Skeleton } from "../primitives.js";

export function PublishDialog({
  machineId,
  flush,
  getRevision,
  onClose,
  onPublished,
  externalWriteSteps,
}: {
  machineId: string;
  flush(): Promise<boolean>;
  getRevision(): number;
  onClose(): void;
  onPublished(number: number): void;
  externalWriteSteps: readonly string[];
}) {
  const client = useSmClient();
  const [validation, setValidation] = useState<ValidationView | null>(null);
  const [error, setError] = useState<SmError | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [requestId] = useState(newRequestId);
  const noteId = useId();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const saved = await flush();

      if (!saved) {
        if (!cancelled) setError(new SmError("DRAFT_NOT_SAVED", "The draft isn't saved yet."));

        return;
      }

      try {
        const result = await client.call("sm_machine_validate", {
          machineId,
          revision: getRevision(),
        });

        if (!cancelled) setValidation(result);
      } catch (caught) {
        if (!cancelled) setError(errorFromCatch(caught instanceof Error ? caught : null));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, flush, getRevision, machineId]);

  const errors = validation?.problems.filter((problem) => problem.severity === "error") ?? [];

  const publish = async () => {
    if (validation === null) return;

    setPending(true);
    setError(null);

    try {
      const result = await client.call("sm_machine_publish", {
        machineId,
        expectedRevision: validation.revision,
        note: note.trim(),
        requestId,
      });

      onPublished(result.number);
    } catch (caught) {
      setError(errorFromCatch(caught instanceof Error ? caught : null));
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={validation === null ? "Publish" : `Publish v${validation.nextVersionNumber}`}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={validation === null || errors.length > 0}
            pending={pending}
            onClick={() => void publish()}
          >
            {validation === null ? "Publish" : `Publish v${validation.nextVersionNumber}`}
          </Button>
        </>
      }
    >
      {validation === null && error === null ? <Skeleton rows={3} /> : null}
      {error === null ? null : <ErrorAlert error={error} />}
      {validation !== null && errors.length > 0 ? (
        <>
          <h3 className="stm-h3">Fix these before publishing</h3>
          <ul className="stm-problem-list">
            {errors.map((problem) => (
              <li
                key={`${problem.code}:${problem.path}`}
                className="stm-problem stm-problem--error"
              >
                {problem.message}{" "}
                <span className="stm-mono stm-text-xs stm-text-muted">{problem.path}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {validation !== null && errors.length === 0 ? (
        <>
          <ChangeSummaryList summary={validation.changeSummary} />
          {externalWriteSteps.length > 0 ? (
            <p className="stm-text-sm">
              {externalWriteSteps.join(", ")} change{externalWriteSteps.length === 1 ? "s" : ""}{" "}
              external services. Without an exact existing standing authority,{" "}
              {externalWriteSteps.length === 1 ? "it" : "they"} will stop and ask for authority when
              reached.
            </p>
          ) : null}
          <p className="stm-text-sm">
            Running instances stay on their current version. New instances use v
            {validation.nextVersionNumber}.
          </p>
          <div className="stm-field">
            <label className="stm-field-label" htmlFor={noteId}>
              Release note (optional)
            </label>
            <textarea
              id={noteId}
              className="stm-input stm-textarea"
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
