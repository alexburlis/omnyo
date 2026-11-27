import type { ReactNode } from "react";
import type { InboxStatus } from "../../contract";
import { repositoryCount } from "./projection";
import "./style.css";

type Status = InboxStatus;

function plural(count: number, one: string, many: string) {
  return count + " " + (count === 1 ? one : many);
}

function summary(status: Status) {
  const repositories = repositoryCount(status.routes.filter((route) => route.enabled));

  return repositories === 0
    ? "No projects watched yet"
    : plural(repositories, "repository", "repositories") +
        " · " +
        plural(status.badge.count, "open issue", "open issues");
}

export function SentrySettingsSummary({
  status,
  error,
  onOpen,
  children,
}: {
  status: Status | null;
  error: string | null;
  onOpen: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="sentry-panel sentry-settings">
      <div className="sentry-settings-status">
        {error ? (
          <p role="alert" className="sentry-settings-error">
            {error}
          </p>
        ) : !status ? (
          <p className="sentry-muted">Checking connection…</p>
        ) : !status.connected ? (
          <>
            <span className="sentry-health sentry-health-stale">Not connected</span>
            <p className="sentry-muted">Add an auth token above.</p>
          </>
        ) : status.lastError ? (
          <>
            <span className="sentry-health sentry-health-stale">Sync failed</span>
            <p className="sentry-muted">{status.lastError}</p>
          </>
        ) : (
          <>
            <span className="sentry-health sentry-health-live">Connected</span>
            <p className="sentry-muted">{summary(status)}</p>
          </>
        )}
      </div>
      <button type="button" onClick={onOpen}>
        Open Sentry
      </button>
      {children}
    </div>
  );
}
