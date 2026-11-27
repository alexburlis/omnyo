import type { InboxStatus } from "../../contract";
import { isActiveRun } from "../run-state";
import { dateLabel } from "./projection";
import { operationKey } from "./operations";

export function Investigations({
  runs,
  selectedProject,
  selected,
  onShowInbox,
  pending,
  onOpenThread,
  onStop,
  onRetry,
}: {
  runs: InboxStatus["runs"];
  selectedProject: string;
  selected: string;
  onShowInbox: () => void;
  pending: (key: string) => boolean;
  onOpenThread: (id: string) => void;
  onStop: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  return (
    <section aria-label="Investigations">
      {!runs.length && (
        <div className="sentry-empty">
          <h2>
            {selectedProject || selected ? "No matching investigations" : "No investigations yet"}
          </h2>
          <p>
            {selectedProject || selected
              ? "Choose another project or clear your filters."
              : "Start a solver from the inbox to investigate an issue."}
          </p>
          <button onClick={onShowInbox}>Open inbox</button>
        </div>
      )}
      <div className="sentry-run-list">
        {runs.map((run) => (
          <article className="sentry-run" key={run.id}>
            <div className="sentry-heading">
              <div>
                <span className="sentry-eyebrow">{run.incident.shortId}</span>
                <h3>{run.incident.exceptionType}</h3>
              </div>
              <span
                className={"sentry-state " + (isActiveRun(run.state) ? "sentry-state-active" : "")}
              >
                {run.interruptedAt && isActiveRun(run.state)
                  ? "interrupted"
                  : run.state.replaceAll("-", " ")}
              </span>
            </div>
            <p className="sentry-muted">
              {run.route.name} · {run.manual ? "Started manually" : "Auto solve"} ·{" "}
              {dateLabel(run.createdAt)}
            </p>
            {run.result && <p className="sentry-tldr">{run.result.summary}</p>}
            {run.result && (
              <details>
                <summary>Evidence and changes · {run.result.classification}</summary>
                <p>{run.result.rootCause}</p>
                <p>{run.result.change}</p>
                {run.result.reproduction && (
                  <div>
                    <p>
                      <code>{run.result.reproduction.command}</code>
                    </p>
                    <p>Before: {run.result.reproduction.before}</p>
                    <p>After: {run.result.reproduction.after}</p>
                    {run.result.reproduction.evidence.map((value) => (
                      <p key={value}>{value}</p>
                    ))}
                  </div>
                )}
              </details>
            )}
            {run.reason && <p className="sentry-notice">{run.reason}</p>}
            {run.verification && (
              <p>
                {run.verification.checks.length} required checks passed ·{" "}
                <code>{run.verification.head.slice(0, 8)}</code>
              </p>
            )}
            {run.result?.limitations.map((value) => (
              <p key={value} className="sentry-muted">
                {value}
              </p>
            ))}
            <div className="sentry-actions">
              {run.threadId && (
                <button className="sentry-solve" onClick={() => onOpenThread(run.threadId!)}>
                  Open chat ↗
                </button>
              )}
              {run.publication && (
                <a href={run.publication.url} target="_blank" rel="noreferrer">
                  Open draft PR ↗
                </a>
              )}
              {isActiveRun(run.state) ? (
                <button disabled={pending(operationKey.run(run.id))} onClick={() => onStop(run.id)}>
                  {pending(operationKey.run(run.id)) ? "Stopping…" : "Stop run"}
                </button>
              ) : ["failed", "cancelled", "no-fix", "needs-evidence"].includes(run.state) ? (
                <button
                  disabled={pending(operationKey.run(run.id))}
                  onClick={() => onRetry(run.id)}
                >
                  {pending(operationKey.run(run.id)) ? "Resuming…" : "Retry"}
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
