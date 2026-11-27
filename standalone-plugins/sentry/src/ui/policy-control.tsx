import { useState } from "react";
import type { InboxStatus, ProjectPolicy } from "../../contract";

export function PolicyControl({
  policy,
  name,
  busy,
  onSave,
}: {
  policy: InboxStatus["projectPolicies"][number];
  name: string;
  busy: boolean;
  onSave: (value: ProjectPolicy) => void;
}) {
  const [limit, setLimit] = useState(String(policy.dailyLimit));

  return (
    <div className="sentry-policy">
      <div className="sentry-heading">
        <div>
          <h3>Auto solve</h3>
          <p>
            {busy
              ? "Saving…"
              : policy.autoSolve
                ? "New issues can start a solver automatically."
                : "Off. You choose when each solver starts."}
          </p>
        </div>
        <button
          type="button"
          className="sentry-switch"
          role="switch"
          aria-label={"Auto solve for " + name}
          aria-checked={policy.autoSolve}
          aria-busy={busy}
          disabled={busy}
          onClick={() =>
            onSave({
              projectId: policy.projectId,
              autoSolve: !policy.autoSolve,
              dailyLimit: policy.dailyLimit,
            })
          }
        >
          <span />
        </button>
      </div>
      <form
        className="sentry-limit"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            projectId: policy.projectId,
            autoSolve: policy.autoSolve,
            dailyLimit: Number(limit),
          });
        }}
      >
        <label>
          Daily automatic starts
          <input
            type="number"
            min={1}
            max={1000}
            required
            value={limit}
            aria-label={"Daily automatic starts for " + name}
            onChange={(event) => setLimit(event.target.value)}
          />
        </label>
        <button
          disabled={busy || Number(limit) === policy.dailyLimit}
          aria-label={"Save limit for " + name}
        >
          Save limit
        </button>
        <p>
          <strong>
            {policy.started} / {policy.dailyLimit}
          </strong>{" "}
          used today · resets at 00:00 UTC
        </p>
      </form>
      <p className="sentry-muted">
        Manual starts remain available. Existing issues stay manual when you turn this on.
      </p>
    </div>
  );
}
