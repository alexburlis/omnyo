// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTimelineRowTitle,
  type TimelineActivitySystemRow,
} from "@omnyo/thread-view";
import { isRowExpandable } from "@omnyo/client-core";
import type { TimelinePreviewActivityRef } from "@omnyo/server-contract";
import { PreviewActivityRow } from "./PreviewActivityRow.js";
import { isTimelineLedgerRow } from "./timeline-nested-group-line.js";

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ localDaemonHostId: "host_phone" }),
}));

vi.mock("@/lib/localhost-link-rewrite-preference", () => ({
  useRewriteLocalhostLinksPreference: () => [true, () => {}],
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    onConnected: () => () => {},
    onChanged: () => () => {},
  },
}));

const PREVIEW_URL = "http://127.0.0.1:4317/lab";

const binding = {
  id: "prv_lab",
  projectId: "proj_fixture",
  threadId: "thr_fixture",
  environmentId: "env_fixture",
  hostId: "host_mac",
  hostName: "Mac Pro",
  url: PREVIEW_URL,
  remoteUrl: "/preview/prv_lab/lab",
  createdAt: 0,
};

const row: TimelineActivitySystemRow<TimelinePreviewActivityRef> = {
  id: "row-activity",
  threadId: "thr_fixture",
  turnId: "turn-1",
  sourceSeqStart: 3,
  sourceSeqEnd: 3,
  startedAt: 3,
  createdAt: 3,
  kind: "system",
  systemKind: "operation",
  operationKind: "generic",
  title: "Started localhost:4317/lab",
  detail: "Dev server on Studio",
  status: "completed",
  completedAt: 3,
  activityRef: {
    kind: "preview",
    previewId: "prv_lab",
    url: PREVIEW_URL,
    hostName: "Studio",
  },
};

const clients: QueryClient[] = [];

let state = "online";

let registered = true;

beforeEach(() => {
  state = "online";
  registered = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      ).pathname;

      if (path.endsWith("/status"))
        return registered
          ? Response.json({
              state,
              checkedAt: Date.now(),
              detail: null,
              runId: "run_fixture",
            })
          : new Response(null, { status: 404 });

      return Response.json({
        previews: registered ? [binding] : [],
        sourceHost: { id: "host_mac", name: "Mac Pro" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();

  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

function show(onOpenLink = vi.fn(() => false)) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <PreviewActivityRow
        horizontalPadding="default"
        onOpenLink={onOpenLink}
        onTitleAction={undefined}
        row={row}
        title={buildTimelineRowTitle(row, {
          summaryStyle: "bundle",
          workStyle: "default",
        })}
      />
    </QueryClientProvider>,
  );

  return onOpenLink;
}

function meta() {
  return document.querySelector("[data-preview-activity-state]");
}

describe("preview activity row", () => {
  it("joins the ledger rail as a step that does not expand", () => {
    expect(isTimelineLedgerRow(row)).toBe(true);
    expect(isRowExpandable(row)).toBe(false);
  });

  it("shows the live status with the host and opens through the preview route", async () => {
    const onOpenLink = show(vi.fn(() => true));

    expect(screen.getByText("Started")).toBeTruthy();
    expect(screen.getByText("localhost:4317/lab")).toBeTruthy();
    await waitFor(() => expect(meta()?.textContent).toBe("Running · Mac Pro"));
    expect(document.querySelector(".bg-success")).not.toBeNull();

    const open = screen.getByRole("link", { name: "Open localhost:4317/lab" });
    expect(open.getAttribute("href")).toBe("/preview/prv_lab/lab");
    expect(fireEvent.click(open)).toBe(false);
    expect(onOpenLink).toHaveBeenCalledWith({
      href: new URL("/preview/prv_lab/lab", window.location.href).href,
    });
  });

  it("marks a starting server as a warning and keeps Open", async () => {
    state = "starting";
    show();

    await waitFor(() =>
      expect(meta()?.textContent).toBe("Starting… · Mac Pro"),
    );
    expect(document.querySelector(".bg-warning")).not.toBeNull();
    expect(screen.queryByRole("link", { name: /Open/ })).not.toBeNull();
  });

  it("shows a failed server without Open", async () => {
    state = "error";
    show();

    await waitFor(() =>
      expect(meta()?.textContent).toBe("Didn't start · Mac Pro"),
    );
    expect(document.querySelector(".bg-destructive-text")).not.toBeNull();
    expect(screen.queryByRole("link", { name: /Open/ })).toBeNull();
  });

  it("keeps the snapshot URL and says Removed once the preview is gone", async () => {
    registered = false;
    show();

    await waitFor(() => expect(meta()?.textContent).toBe("Removed"));
    expect(screen.getByText("localhost:4317/lab")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open/ })).toBeNull();
  });
});
