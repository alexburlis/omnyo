// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { ManagedPreviewLink } from "./managed-preview-link.js";
import { PreviewAnnouncementsProvider } from "./preview-announcements.js";

let viewerHostId: string | null = null;

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ localDaemonHostId: viewerHostId }),
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    onConnected: () => () => {},
    onChanged: () => () => {},
  },
}));

const clients: QueryClient[] = [];

const original = "http://localhost:4399/compare/superwhisper?fixture=1#ready";

const binding = {
  id: "prv_fixture_1234",
  projectId: "proj_fixture",
  threadId: "thr_fixture",
  environmentId: "env_fixture",
  hostId: "host_mac",
  hostName: "Mac Pro",
  url: original,
  remoteUrl: "/preview/prv_fixture_1234/compare/superwhisper?fixture=1#ready",
  createdAt: 0,
};

let state = "stopped";

let registered = true;

let complete: ((response: Response) => void) | null = null;

beforeEach(() => {
  viewerHostId = null;
  state = "stopped";
  registered = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      ).pathname;

      if (path.endsWith("/restart"))
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });

      if (path.endsWith("/status"))
        return Response.json({
          state,
          checkedAt: Date.now(),
          detail: null,
          runId: state === "online" ? "run_fixture" : null,
        });

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
  complete = null;
});

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PreviewAnnouncementsProvider>
          <p>
            Open{" "}
            <ManagedPreviewLink href={original} threadId="thr_fixture" enabled>
              comparison preview
            </ManagedPreviewLink>
            .
          </p>
        </PreviewAnnouncementsProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("inline managed preview", () => {
  it("keeps the owner URL exactly and routes unproven viewers through Omnyo", async () => {
    viewerHostId = "host_mac";
    state = "online";
    show();
    await waitFor(() =>
      expect(screen.getByRole("link").getAttribute("href")).toBe(original),
    );
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    viewerHostId = null;
    show();
    await waitFor(() =>
      expect(screen.getByRole("link").getAttribute("href")).toBe(
        binding.remoteUrl,
      ),
    );
  });
  it("recovers in place by one tap and returns keyboard focus to the original link", async () => {
    show();

    const button = await screen.findByRole("button", {
      name: "Restart server on Mac Pro",
    });

    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(button.textContent).toContain("Starting…");
    fireEvent.click(button);
    const fetchMock = vi.mocked(fetch);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/restart"),
      ),
    ).toHaveLength(1);
    state = "online";
    await act(async () => {
      complete?.(
        Response.json({
          state,
          checkedAt: Date.now(),
          detail: null,
          runId: "run_fixture",
        }),
      );
    });
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("link"));
    expect(screen.getByRole("status").textContent).toBe("Server running");
  });
  it("withholds remote unmanaged links and never offers restart for a foreign port or offline host", async () => {
    registered = false;
    show();
    await screen.findAllByText("Only on Mac Pro");
    expect(screen.queryByRole("link")).toBeNull();
    cleanup();
    registered = true;
    state = "conflict";
    show();
    await screen.findAllByText("Port 4399 in use");
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    state = "host-offline";
    show();
    await screen.findAllByText("Mac Pro offline");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
