// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRuntimeDisplayStatus } from "@omnyo/domain";
import {
  AutoCompactionChip,
  formatAutoCompactionTime,
} from "@/components/promptbox/CompactBeforeSendChip";
import { sdk } from "@/lib/sdk";
import { useAutoCompactionOffer } from "./useAutoCompactionOffer";

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { experimental_setAutoCompaction: vi.fn() } },
}));

vi.mock("@omnyo/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => false,
}));

const THREAD_ID = "thr_auto";

function Harness({
  autoCompactionAt,
  autoCompactionOptedOut = false,
  runtimeDisplayStatus = "idle",
}: {
  autoCompactionAt: string | undefined;
  autoCompactionOptedOut?: boolean;
  runtimeDisplayStatus?: ThreadRuntimeDisplayStatus;
}) {
  const offer = useAutoCompactionOffer({
    autoCompactionAt,
    autoCompactionOptedOut,
    runtimeDisplayStatus,
    threadId: THREAD_ID,
  });

  return offer === null ? null : <AutoCompactionChip {...offer} />;
}

function renderHarness(
  props: Parameters<typeof Harness>[0],
): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });

  const view = render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );

  return {
    ...view,
    rerender: (next) =>
      view.rerender(
        <QueryClientProvider client={queryClient}>{next}</QueryClientProvider>,
      ),
  };
}

function keepFullHistorySwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "Keep full history" });
}

afterEach(() => {
  cleanup();
  vi.mocked(sdk.threads.experimental_setAutoCompaction).mockReset();
});

describe("automatic compaction composer chip", () => {
  it("appears only from ten minutes before the scheduled compaction while the chat is idle", () => {
    const soon = Date.now() + 5 * 60 * 1000;
    const later = Date.now() + 15 * 60 * 1000;

    const { rerender } = renderHarness({
      autoCompactionAt: new Date(later).toISOString(),
    });

    expect(screen.queryByRole("switch")).toBeNull();

    rerender(<Harness autoCompactionAt={new Date(soon).toISOString()} />);

    expect(
      screen.getByText(
        `Compacts automatically at ${formatAutoCompactionTime(soon)}`,
      ),
    ).toBeTruthy();
    expect(keepFullHistorySwitch().getAttribute("aria-checked")).toBe("false");

    rerender(
      <Harness
        autoCompactionAt={new Date(soon).toISOString()}
        runtimeDisplayStatus="active"
      />,
    );

    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("opts the chat out with Keep full history and turns automatic compaction back on", async () => {
    vi.mocked(sdk.threads.experimental_setAutoCompaction).mockImplementation(
      (input) => Promise.resolve({ enabled: input.enabled }),
    );

    const soon = Date.now() + 5 * 60 * 1000;
    const soonText = `Compacts automatically at ${formatAutoCompactionTime(soon)}`;

    const { rerender } = renderHarness({
      autoCompactionAt: new Date(soon).toISOString(),
    });

    await act(async () => {
      fireEvent.click(keepFullHistorySwitch());
    });

    expect(sdk.threads.experimental_setAutoCompaction).toHaveBeenLastCalledWith(
      { threadId: THREAD_ID, enabled: false },
    );
    expect(keepFullHistorySwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(soonText)).toBeNull();

    rerender(<Harness autoCompactionAt={undefined} />);

    expect(keepFullHistorySwitch().getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      fireEvent.click(keepFullHistorySwitch());
    });

    expect(sdk.threads.experimental_setAutoCompaction).toHaveBeenLastCalledWith(
      { threadId: THREAD_ID, enabled: true },
    );
    expect(keepFullHistorySwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(soonText)).toBeTruthy();
  });

  it("shows an opted-out chat's switch on and turns automatic compaction back on from it", async () => {
    vi.mocked(sdk.threads.experimental_setAutoCompaction).mockImplementation(
      (input) => Promise.resolve({ enabled: input.enabled }),
    );

    const soon = Date.now() + 5 * 60 * 1000;
    const soonText = `Compacts automatically at ${formatAutoCompactionTime(soon)}`;

    renderHarness({
      autoCompactionAt: new Date(soon).toISOString(),
      autoCompactionOptedOut: true,
    });

    expect(keepFullHistorySwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(soonText)).toBeNull();

    await act(async () => {
      fireEvent.click(keepFullHistorySwitch());
    });

    expect(sdk.threads.experimental_setAutoCompaction).toHaveBeenLastCalledWith(
      { threadId: THREAD_ID, enabled: true },
    );
    expect(keepFullHistorySwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(soonText)).toBeTruthy();
  });

  it("restores the scheduled state when the opt-out request fails", async () => {
    vi.mocked(sdk.threads.experimental_setAutoCompaction).mockRejectedValue(
      new Error("offline"),
    );

    const soon = Date.now() + 5 * 60 * 1000;

    renderHarness({ autoCompactionAt: new Date(soon).toISOString() });

    await act(async () => {
      fireEvent.click(keepFullHistorySwitch());
    });

    expect(keepFullHistorySwitch().getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByText(
        `Compacts automatically at ${formatAutoCompactionTime(soon)}`,
      ),
    ).toBeTruthy();
  });
});
