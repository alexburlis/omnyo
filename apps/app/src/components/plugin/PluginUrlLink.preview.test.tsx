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
import { AppNavigationHostProvider } from "@/lib/app-navigation-host";
import { PluginUrlLink } from "./PluginUrlLink";

vi.mock("@/components/ui/app-route-anchor", () => ({
  RouteAnchor: (props: React.ComponentPropsWithoutRef<"a">) => <a {...props} />,
}));

vi.mock("@/lib/route-paths", () => ({ resolveRouteHref: () => null }));

vi.mock("@/lib/api-server", () => ({
  apiClient: {
    previews: {
      ":previewId": {
        $get: (
          { param }: { param: { previewId: string } },
          options: { init?: RequestInit },
        ) =>
          fetch(
            `http://localhost/api/v1/previews/${param.previewId}`,
            options.init,
          ),
      },
    },
  },
}));

const identity = vi.hoisted(() => ({
  hostId: "host_mac" as string | null,
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ localDaemonHostId: identity.hostId }),
}));

const clients: QueryClient[] = [];

const local = "http://127.0.0.1:3237/initial?original=1#first";

const remote = "/preview/prv_fixture/nested/page?requested=2#ready";

const binding = {
  id: "prv_fixture",
  projectId: "project",
  threadId: "thread",
  environmentId: "environment",
  hostId: "host_mac",
  hostName: "Mac",
  url: local,
  remoteUrl: "/preview/prv_fixture/initial?original=1#first",
  createdAt: 0,
};

beforeEach(() => {
  identity.hostId = "host_mac";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(binding)),
  );
});

afterEach(() => {
  cleanup();

  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

function show(href = remote, target?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  clients.push(client);
  const openUrl = vi.fn(() => true);
  render(
    <QueryClientProvider client={client}>
      <AppNavigationHostProvider capabilities={{ openUrl }}>
        <PluginUrlLink href={href} target={target}>
          Preview
        </PluginUrlLink>
      </AppNavigationHostProvider>
    </QueryClientProvider>,
  );

  return { client, openUrl };
}

describe("plugin managed preview links", () => {
  it("opens the requested path directly on a proven owner machine", async () => {
    const { openUrl } = show();
    const link = screen.getByRole("link", { name: "Preview" });
    await waitFor(() =>
      expect(link.getAttribute("href")).toBe(
        "http://localhost:3237/nested/page?requested=2#ready",
      ),
    );
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledWith({
      url: "http://localhost:3237/nested/page?requested=2#ready",
    });
  });

  it.each(["host_phone", null])(
    "keeps the private route for an unproven owner %s",
    async (hostId) => {
      identity.hostId = hostId;
      const { client, openUrl } = show();

      if (hostId !== null)
        await waitFor(() =>
          expect(
            client.getQueryState(["managed-preview-binding", "prv_fixture"])
              ?.status,
          ).toBe("success"),
        );
      const link = screen.getByRole("link", { name: "Preview" });
      expect(link.getAttribute("href")).toBe(remote);
      fireEvent.click(link);
      expect(openUrl).toHaveBeenCalledWith({ url: remote });

      if (hostId === null) expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("retains the private destination until the binding is proven", async () => {
    let complete!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    show();
    const link = screen.getByRole("link", { name: "Preview" });
    expect(link.getAttribute("href")).toBe(remote);
    await act(async () => complete(Response.json(binding)));
    await waitFor(() =>
      expect(link.getAttribute("href")).toBe(
        "http://localhost:3237/nested/page?requested=2#ready",
      ),
    );
  });

  it("keeps the private route when binding lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const { client } = show();
    await waitFor(() =>
      expect(
        client.getQueryState(["managed-preview-binding", "prv_fixture"])
          ?.status,
      ).toBe("error"),
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe(remote);
  });

  it("retains native modifier and target behavior with the resolved href", async () => {
    const { openUrl } = show(remote, "_blank");
    const link = screen.getByRole("link", { name: "Preview" });
    await waitFor(() =>
      expect(link.getAttribute("href")).toBe(
        "http://localhost:3237/nested/page?requested=2#ready",
      ),
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(link, { metaKey: true });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not treat a different site's preview path as a managed link", () => {
    show("https://different.example/preview/prv_fixture/path");
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://different.example/preview/prv_fixture/path",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
