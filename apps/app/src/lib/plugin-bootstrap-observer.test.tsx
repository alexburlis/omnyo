// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThreadWithIncludesResponse } from "@omnyo/server-contract";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { PluginContext } from "@/components/plugin/plugin-context";
import { threadPluginBootstrapQueryKey } from "@/hooks/queries/query-keys";
import {
  useThreadDetailBootstrap,
  useThreadPluginBootstrap,
} from "@/hooks/queries/thread-queries";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { experimental_useThreadBootstrapData } from "./plugin-sdk-hooks";
import { sdk } from "./sdk";

describe("plugin bootstrap observation", () => {
  it("opens core conversation data while plugin data remains pending and cancels the abandoned plugin read", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const core = makeThreadResponse({ id: "observer-thread" });
    let release: ((value: ThreadWithIncludesResponse) => void) | undefined;
    let pluginSignal: AbortSignal | undefined;

    const held = new Promise<ThreadWithIncludesResponse>((resolve) => {
      release = resolve;
    });

    const read = vi.spyOn(sdk.threads, "get").mockImplementation((input) => {
      if (input.include?.includes("experimental_pluginData")) {
        pluginSignal = input.signal;

        return held;
      }

      return Promise.resolve(core);
    });

    const owner = renderHook(
      () => ({
        core: useThreadDetailBootstrap("observer-thread"),
        plugins: useThreadPluginBootstrap("observer-thread"),
        card: experimental_useThreadBootstrapData(
          "observer-thread",
          "card.read",
        ),
      }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={["/threads/observer-thread"]}>
              <PluginContext.Provider value="glance">
                {children}
              </PluginContext.Provider>
            </MemoryRouter>
          </QueryClientProvider>
        ),
      },
    );

    try {
      await waitFor(() =>
        expect(owner.result.current.core.isSuccess).toBe(true),
      );
      expect(owner.result.current.core.data?.id).toBe("observer-thread");
      expect(owner.result.current.plugins.isPending).toBe(true);
      expect(owner.result.current.card).toEqual({ status: "pending" });
      expect(pluginSignal?.aborted).toBe(false);
      owner.unmount();
      expect(pluginSignal?.aborted).toBe(true);
    } finally {
      owner.unmount();
      release?.(core);
      client.clear();
      read.mockRestore();
    }
  });

  it("keeps plugin errors and unavailable data distinct after core data loads", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const read = vi
      .spyOn(sdk.threads, "get")
      .mockRejectedValueOnce(new Error("plugin read failed"))
      .mockResolvedValue({
        ...makeThreadResponse({ id: "observer-thread" }),
        experimental_pluginData: [],
      });

    const owner = renderHook(
      () => ({
        plugins: useThreadPluginBootstrap("observer-thread"),
        card: experimental_useThreadBootstrapData(
          "observer-thread",
          "card.read",
        ),
      }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>
            <MemoryRouter>
              <PluginContext.Provider value="glance">
                {children}
              </PluginContext.Provider>
            </MemoryRouter>
          </QueryClientProvider>
        ),
      },
    );

    try {
      await waitFor(() =>
        expect(owner.result.current.card.status).toBe("error"),
      );
      await act(async () => {
        await owner.result.current.plugins.refetch();
      });
      await waitFor(() =>
        expect(owner.result.current.card).toEqual({ status: "unavailable" }),
      );
    } finally {
      owner.unmount();
      client.clear();
      read.mockRestore();
    }
  });

  it("keeps the conversation read callable when a plugin observes bootstrap data", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const queryKey = threadPluginBootstrapQueryKey("observer-thread");

    const payload = (headline: string): ThreadWithIncludesResponse => ({
      ...makeThreadResponse({ id: "observer-thread" }),
      experimental_pluginData: [
        {
          pluginId: "glance",
          method: "card.read",
          outcome: { ok: true, result: { headline } },
        },
      ],
    });

    const readConversation = vi
      .spyOn(sdk.threads, "get")
      .mockResolvedValueOnce(payload("Initial card"))
      .mockResolvedValue(payload("Current card"));

    const plugin = renderHook(
      () => ({
        owner: useThreadPluginBootstrap("observer-thread"),
        card: experimental_useThreadBootstrapData(
          "observer-thread",
          "card.read",
        ),
      }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={["/threads/observer-thread"]}>
              <PluginContext.Provider value="glance">
                {children}
              </PluginContext.Provider>
            </MemoryRouter>
          </QueryClientProvider>
        ),
      },
    );

    try {
      await waitFor(() =>
        expect(plugin.result.current.card).toMatchObject({
          status: "ready",
          result: { headline: "Initial card" },
        }),
      );
      expect(readConversation).toHaveBeenCalledTimes(1);
      await act(async () => {
        await client.invalidateQueries({ queryKey, exact: true });
      });
      await waitFor(() => expect(readConversation).toHaveBeenCalledTimes(2));
      expect(plugin.result.current.owner.error).toBeNull();
      await waitFor(() =>
        expect(plugin.result.current.card).toMatchObject({
          status: "ready",
          result: { headline: "Current card" },
        }),
      );
    } finally {
      plugin.unmount();
      client.clear();
      readConversation.mockRestore();
    }
  });
});
