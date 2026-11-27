import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { statusSchema } from "../contract";
import { SentrySettingsSummary } from "../src/ui/settings-summary";
import { route, incident } from "./fixtures";

const noop = () => {};

function status(overrides: { connected?: boolean; lastError?: string | null } = {}) {
  return statusSchema.parse({
    connected: overrides.connected ?? true,
    apiOrigin: "https://de.sentry.io",
    lastError: overrides.lastError ?? null,
    routes: [
      route(),
      { ...route(), id: "server", repositoryPath: "/projects/umbrella/server" },
      { ...route(), id: "paused", repositoryPath: "/projects/paused", enabled: false },
    ],
    incidents: [incident()],
    runs: [],
    syncs: [],
    batches: [],
    projectIssueCounts: [],
    badge: {
      count: 7,
      watchedRoutes: 2,
      freshness: "live",
      lastSyncedAt: "2026-10-18T10:05:00Z",
    },
    projectPolicies: [],
    notificationLimit: "Uses existing Omnyo notification preferences",
  });
}

afterEach(cleanup);

describe("Sentry settings summary", () => {
  it("confirms a stored token by showing the connection and what it watches", () => {
    let opened = 0;
    render(<SentrySettingsSummary status={status()} error={null} onOpen={() => opened++} />);

    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("2 repositories · 7 open issues")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Open issues" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open Sentry" }));
    expect(opened).toBe(1);
  });

  it("asks for a token when none is stored", () => {
    render(
      <SentrySettingsSummary status={status({ connected: false })} error={null} onOpen={noop} />,
    );

    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.getByText("Add an auth token above.")).toBeTruthy();
  });

  it("shows a sync failure instead of claiming the connection works", () => {
    render(
      <SentrySettingsSummary
        status={status({ lastError: "Sentry rejected the token" })}
        error={null}
        onOpen={noop}
      />,
    );

    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByText("Sync failed")).toBeTruthy();
    expect(screen.getByText("Sentry rejected the token")).toBeTruthy();
  });

  it("reports a status load failure and a pending load", () => {
    const { rerender } = render(<SentrySettingsSummary status={null} error={null} onOpen={noop} />);

    expect(screen.getByText("Checking connection…")).toBeTruthy();

    rerender(<SentrySettingsSummary status={null} error="Could not load Sentry" onOpen={noop} />);
    expect(screen.getByRole("alert").textContent).toBe("Could not load Sentry");
  });
});
