// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  CommandCatalogResponse,
  ProviderCommand,
} from "@omnyo/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import {
  projectCommandCatalogQueryKey,
  systemConfigQueryKey,
} from "@/hooks/queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useCommandSuggestions } from "./useCommandSuggestions";

vi.mock("@/lib/sdk", () => ({
  OmnyoHttpError: class OmnyoHttpError extends Error {},
  sdk: {
    projects: {
      commands: vi.fn(),
      commandCatalog: vi.fn(),
    },
    system: { config: vi.fn() },
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useProjectDetailRealtimeSubscription: vi.fn(),
  useSystemRealtimeSubscription: vi.fn(),
}));

const BOOTSTRAP_COMMAND = {
  name: "bootstrap-action",
  source: "command",
  origin: "builtin",
  description: "Provided by the server",
  argumentHint: null,
} satisfies ProviderCommand;

const SECURITY_SKILL = {
  name: "security",
  source: "skill",
  origin: "user",
  description: "Audit code",
  argumentHint: null,
} satisfies ProviderCommand;

const BASE_ARGS = {
  projectId: "project-1",
  providerId: "codex",
  commandScope: "thread" as const,
  skillsTriggers: ["/"] as const,
  activeTrigger: null,
  environmentId: "env-1",
  query: null,
};

function createHarness() {
  const harness = createQueryClientTestHarness();
  harness.queryClient.setQueryData(systemConfigQueryKey(), {
    commandDefaultsByProvider: { codex: [BOOTSTRAP_COMMAND] },
  });

  return harness;
}

beforeEach(() => {
  vi.mocked(sdk.projects.commandCatalog).mockResolvedValue({
    state: "ready",
    commands: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("useCommandSuggestions prepared catalog", () => {
  it("prepares commands when the workspace is known before editor focus", async () => {
    const { wrapper } = createHarness();

    renderHook(() => useCommandSuggestions(BASE_ARGS), { wrapper });

    await waitFor(() => {
      expect(sdk.projects.commandCatalog).toHaveBeenCalledTimes(1);
    });
    expect(sdk.projects.commands).not.toHaveBeenCalled();
    expect(vi.mocked(sdk.projects.commandCatalog).mock.calls[0]?.[0]).toEqual({
      projectId: "project-1",
      provider: "codex",
      environmentId: "env-1",
      signal: expect.any(AbortSignal),
    });
  });

  it("offers server bootstrap commands immediately while the first snapshot waits", async () => {
    let releaseSnapshot: (response: CommandCatalogResponse) => void = () => {
      throw new Error("Snapshot request has not started");
    };

    vi.mocked(sdk.projects.commandCatalog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSnapshot = resolve;
        }),
    );
    const { wrapper } = createHarness();

    const { result } = renderHook(
      () =>
        useCommandSuggestions({ ...BASE_ARGS, activeTrigger: "/", query: "" }),
      { wrapper },
    );

    expect(result.current.suggestions.map((item) => item.name)).toEqual([
      "bootstrap-action",
    ]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isUpdating).toBe(true);

    await act(async () => {
      releaseSnapshot({ state: "ready", commands: [SECURITY_SKILL] });
    });
    await waitFor(() => {
      expect(result.current.suggestions.map((item) => item.name)).toEqual([
        "security",
      ]);
    });
    expect(result.current.isUpdating).toBe(false);
  });

  it.each([false, true])(
    "explains an unavailable machine with advertised commands: %s",
    async (hasCommands) => {
      vi.mocked(sdk.projects.commandCatalog).mockRejectedValue(
        Object.assign(new Error("Host is not connected"), {
          status: 502,
          code: "host_unavailable",
        }),
      );
      const { wrapper } = createHarness();

      const { result } = renderHook(
        () =>
          useCommandSuggestions({
            ...BASE_ARGS,
            activeTrigger: "/",
            query: "compact",
            threadProviderCommands: hasCommands
              ? [
                  {
                    name: "compact",
                    source: "command",
                    origin: "builtin",
                    description: "Compact context",
                    argumentHint: null,
                  },
                ]
              : [],
          }),
        { wrapper },
      );

      await waitFor(() => expect(result.current.errorMessage).not.toBeNull());
      expect(result.current.isError).toBe(!hasCommands);
      expect(result.current.errorMessage).toBe(
        "Machine unavailable. Reconnect it to update commands.",
      );
      expect(result.current.suggestions.map((item) => item.name)).toEqual(
        hasCommands ? ["compact"] : [],
      );
      expect(result.current.isUpdating).toBe(false);
    },
  );

  it("preserves ready rows and exposes a background discovery failure", async () => {
    vi.mocked(sdk.projects.commandCatalog).mockResolvedValue({
      state: "failed",
      commands: [SECURITY_SKILL],
      error: {
        code: "command_timeout",
        message: "Command discovery timed out",
      },
    });
    const { wrapper } = createHarness();

    const { result } = renderHook(
      () =>
        useCommandSuggestions({
          ...BASE_ARGS,
          activeTrigger: "/",
          query: "sec",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.errorMessage).toBe("Failed to load commands"),
    );
    expect(result.current.suggestions.map((item) => item.name)).toEqual([
      "security",
    ]);
    expect(result.current.isError).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isUpdating).toBe(false);
  });

  it("distinguishes a still-preparing skill catalog from a completed no-match", async () => {
    vi.mocked(sdk.projects.commandCatalog).mockResolvedValue({
      state: "preparing",
      commands: [BOOTSTRAP_COMMAND],
    });
    const { wrapper } = createHarness();

    const { result } = renderHook(
      () =>
        useCommandSuggestions({
          ...BASE_ARGS,
          skillsTriggers: ["/", "$"],
          activeTrigger: "$",
          query: "review",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(sdk.projects.commandCatalog).toHaveBeenCalledTimes(1),
    );
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.isUpdating).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it("treats an unknown command as literal text only after a complete snapshot", async () => {
    const { wrapper } = createHarness();

    const { result } = renderHook(
      () =>
        useCommandSuggestions({
          ...BASE_ARGS,
          activeTrigger: "/",
          query: "does-not-exist",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isUpdating).toBe(false));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.suggestions).toEqual([]);
  });

  it("reuses the prepared catalog while the query changes", async () => {
    vi.mocked(sdk.projects.commandCatalog).mockResolvedValue({
      state: "ready",
      commands: [SECURITY_SKILL],
    });
    const { wrapper } = createHarness();

    const initialProps: { query: string | null; trigger: "/" | null } = {
      query: null,
      trigger: null,
    };

    const { result, rerender } = renderHook(
      (props: { query: string | null; trigger: "/" | null }) =>
        useCommandSuggestions({
          ...BASE_ARGS,
          query: props.query,
          activeTrigger: props.trigger,
        }),
      { wrapper, initialProps },
    );

    await waitFor(() =>
      expect(sdk.projects.commandCatalog).toHaveBeenCalledTimes(1),
    );
    rerender({ query: "sec", trigger: "/" });
    await waitFor(() =>
      expect(result.current.suggestions[0]?.name).toBe("security"),
    );
    rerender({ query: "security", trigger: "/" });
    expect(result.current.suggestions[0]?.name).toBe("security");
    expect(sdk.projects.commandCatalog).toHaveBeenCalledTimes(1);
  });

  it("keeps ready commands available without preparation status during a snapshot refresh", async () => {
    vi.mocked(sdk.projects.commandCatalog).mockResolvedValueOnce({
      state: "ready",
      commands: [SECURITY_SKILL],
    });
    const { wrapper, queryClient } = createHarness();

    const { result } = renderHook(
      () =>
        useCommandSuggestions({
          ...BASE_ARGS,
          activeTrigger: "/",
          query: "sec",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.suggestions[0]?.name).toBe("security"),
    );

    let releaseSnapshot: (response: CommandCatalogResponse) => void = () => {
      throw new Error("Refresh request has not started");
    };

    vi.mocked(sdk.projects.commandCatalog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSnapshot = resolve;
        }),
    );
    act(() => {
      void queryClient.invalidateQueries({
        queryKey: projectCommandCatalogQueryKey(
          "project-1",
          "codex",
          "env-1",
          null,
        ),
      });
    });
    await waitFor(() =>
      expect(sdk.projects.commandCatalog).toHaveBeenCalledTimes(2),
    );
    expect(result.current.suggestions[0]?.name).toBe("security");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isUpdating).toBe(false);

    await act(async () => {
      releaseSnapshot({ state: "ready", commands: [SECURITY_SKILL] });
    });
  });

  it("shares catalog data when an environment already determines host routing", async () => {
    vi.mocked(sdk.projects.commandCatalog).mockResolvedValue({
      state: "ready",
      commands: [SECURITY_SKILL],
    });
    const { wrapper } = createHarness();
    const initialProps: { hostId: string | null } = { hostId: "host-1" };

    const { result, rerender } = renderHook(
      (props: { hostId: string | null }) =>
        useCommandSuggestions({
          ...BASE_ARGS,
          ...props,
          activeTrigger: "/",
          query: "sec",
        }),
      { wrapper, initialProps },
    );

    await waitFor(() =>
      expect(result.current.suggestions[0]?.name).toBe("security"),
    );
    rerender({ hostId: null });
    expect(result.current.suggestions[0]?.name).toBe("security");
    expect(sdk.projects.commandCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not reuse another environment's commands while its snapshot is pending", async () => {
    vi.mocked(sdk.projects.commandCatalog).mockResolvedValueOnce({
      state: "ready",
      commands: [SECURITY_SKILL],
    });

    let releaseSnapshot: (response: CommandCatalogResponse) => void = () => {
      throw new Error("Second snapshot request has not started");
    };

    vi.mocked(sdk.projects.commandCatalog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSnapshot = resolve;
        }),
    );
    const { wrapper } = createHarness();

    const { result, rerender } = renderHook(
      (props: { environmentId: string }) =>
        useCommandSuggestions({
          ...BASE_ARGS,
          ...props,
          activeTrigger: "/",
          query: "sec",
        }),
      { wrapper, initialProps: { environmentId: "env-1" } },
    );

    await waitFor(() =>
      expect(result.current.suggestions[0]?.name).toBe("security"),
    );
    rerender({ environmentId: "env-2" });
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.isUpdating).toBe(true);
    await act(async () => {
      releaseSnapshot({ state: "ready", commands: [] });
    });
    await waitFor(() => expect(result.current.isUpdating).toBe(false));
  });

  it("offers only skills for the explicit dollar trigger", async () => {
    vi.mocked(sdk.projects.commandCatalog).mockResolvedValue({
      state: "ready",
      commands: [SECURITY_SKILL, BOOTSTRAP_COMMAND],
    });
    const { wrapper } = createHarness();

    const { result } = renderHook(
      () =>
        useCommandSuggestions({
          ...BASE_ARGS,
          activeTrigger: "$",
          skillsTriggers: ["/", "$"],
          query: "",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.suggestions.map((item) => item.name)).toEqual([
        "security",
      ]);
    });
  });
});
