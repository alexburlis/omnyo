// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUiPreferences } from "@omnyo/domain";
import {
  useUiPreferencesLoadState,
  useUiPreferencesReady,
} from "./UiPreferencesSync";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/sdk", async () => {
  const actual = await import("@omnyo/sdk/browser");

  return {
    OmnyoHttpError: actual.OmnyoHttpError,
    sdk: { system: { uiPreferences: { list: mocks.list } } },
  };
});

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useSystemRealtimeSubscription: () => {},
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function defaultPreferencesResponse() {
  return {
    preferences: Object.fromEntries(
      Object.entries(defaultUiPreferences).map(([key, value]) => [
        key,
        { revision: 0, value },
      ]),
    ),
  };
}

describe("useUiPreferencesReady", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mocks.list.mockReset();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("stays not ready until the preferences query resolves", async () => {
    let resolve: ((value: unknown) => void) | null = null;
    mocks.list.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );

    const { result } = renderHook(() => useUiPreferencesReady(), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current).toBe(false);
    await act(async () => {
      resolve!(defaultPreferencesResponse());
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("becomes ready with defaults when the query fails", async () => {
    mocks.list.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useUiPreferencesReady(), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("stays ready while a failed query fetches again for a new observer", async () => {
    let resolve: ((value: unknown) => void) | null = null;
    mocks.list
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
    const wrapper = createWrapper(queryClient);

    const first = renderHook(
      () => ({
        ready: useUiPreferencesReady(),
        state: useUiPreferencesLoadState(),
      }),
      { wrapper },
    );

    await waitFor(() => expect(first.result.current.state).toBe("failed"));

    const second = renderHook(() => useUiPreferencesReady(), { wrapper });

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(second.result.current).toBe(true);
    expect(first.result.current).toEqual({ ready: true, state: "failed" });

    await act(async () => {
      resolve!(defaultPreferencesResponse());
    });
    await waitFor(() => expect(first.result.current.state).toBe("loaded"));
  });
});
