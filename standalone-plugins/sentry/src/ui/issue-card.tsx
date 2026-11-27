import type { Incident, Route, Run, ModelDefaults } from "../../contract";
import { modelLabel } from "./models";
import { dateLabel } from "./projection";
import { operationKey } from "./operations";

export function IssueCard({
  incident,
  mappedRoutes,
  existing,
  connected,
  models,
  pending,
  onOpenThread,
  onInvestigate,
}: {
  incident: Incident;
  mappedRoutes: Route[];
  existing: Run | undefined;
  connected: boolean;
  models: ModelDefaults;
  pending: (key: string) => boolean;
  onOpenThread: (id: string) => void;
  onInvestigate: (routeId: string, url: string) => void;
}) {
  const route = mappedRoutes[0];

  return (
    <article className="sentry-issue">
      <span
        className={"sentry-severity sentry-severity-" + incident.level}
        aria-label={incident.level}
      >
        !
      </span>
      <details className="sentry-issue-body">
        <summary>
          <span className="sentry-issue-title">
            <strong>{incident.exceptionType}</strong>
            <span className="sentry-issue-id">
              <bdi>{incident.shortId}</bdi>
            </span>
            {incident.substatus === "regressed" && (
              <span className="sentry-state sentry-regressed">Regressed</span>
            )}
            <span className="sentry-disclosure" aria-hidden="true">
              Details
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                <path
                  d="M4 6l4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </span>
          <span className="sentry-issue-meta">
            {route?.name ?? "Unmapped"}
            {route?.name.toLowerCase().includes(incident.environment.toLowerCase()) ? null : (
              <>
                <span aria-hidden="true">·</span>
                {incident.environment === "*" ? "All environments" : incident.environment}
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>Last seen {dateLabel(incident.lastSeen)}</span>
          </span>
        </summary>
        <div className="sentry-issue-details">
          <dl>
            <div>
              <dt>First seen</dt>
              <dd>{dateLabel(incident.firstSeen)}</dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{dateLabel(incident.lastSeen)}</dd>
            </div>
            <div>
              <dt>Release</dt>
              <dd>
                <bdi>{incident.release ?? "Not reported"}</bdi>
              </dd>
            </div>
            <div>
              <dt>Sentry project</dt>
              <dd>
                <bdi>{incident.projectId}</bdi>
              </dd>
            </div>
          </dl>
          <div className="sentry-issue-mappings">
            {mappedRoutes.map((mapping) => (
              <div key={mapping.id}>
                <strong>{mapping.name}</strong>
                <p className="sentry-path">
                  <bdi>{mapping.repositoryPath}</bdi>
                </p>
                <p className="sentry-muted">
                  <bdi>{mapping.baseRef}</bdi> · {mapping.environment} ·{" "}
                  {mapping.delivery === "pr" ? "Draft PR" : "Local commit"}
                </p>
              </div>
            ))}
          </div>
          <a
            href={incident.url}
            target="_blank"
            rel="noreferrer"
            aria-label={"Open " + incident.shortId + " in Sentry"}
          >
            Open in Sentry ↗
          </a>
        </div>
      </details>
      {existing?.threadId ? (
        <button onClick={() => onOpenThread(existing.threadId!)}>Open solver</button>
      ) : (
        route && (
          <button
            className="sentry-solve"
            disabled={pending(operationKey.issue(incident.url)) || !connected || Boolean(existing)}
            aria-busy={pending(operationKey.issue(incident.url))}
            aria-label={"Start solver for " + incident.shortId}
            title={"Solve with " + modelLabel(models.solver)}
            onClick={() => onInvestigate(route.id, incident.url)}
          >
            {pending(operationKey.issue(incident.url))
              ? "Starting…"
              : existing
                ? existing.state === "preparing"
                  ? "Starting…"
                  : "Queued"
                : "Start solver"}
            <span aria-hidden="true"> ↗</span>
          </button>
        )
      )}
    </article>
  );
}
