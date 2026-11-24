// @vitest-environment jsdom

import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { PluginSidebarFooterCards } from "@/components/plugin/PluginSidebarFooterCards";
import {
  setPluginSlotRegistrations,
  removePluginSlotRegistrations,
  resetPluginSlotStoreForTest,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const clients: QueryClient[] = [];

function machine() {
  return {
    id: "host_mac",
    name: "Mac",
    connected: true,
    observedAt: Date.now(),
    error: null,
    snapshot: {
      cpu: 8,
      paused: false,
      blocked: false,
      gpu: { state: "busy" },
      jobs: [
        { state: "running", cpu: 2, gpu: true },
        { state: "starting", cpu: 1, gpu: false },
        { state: "blocked", cpu: 1, gpu: false },
        { state: "queued", cpu: 3, gpu: false },
        { state: "succeeded", cpu: 7, gpu: false },
      ],
    },
  };
}

function overview() {
  return {
    observedAt: Date.now(),
    complete: true,
    active: 3,
    queued: 1,
    machines: [
      machine(),
      {
        ...machine(),
        id: "host_worker",
        name: "Worker",
        snapshot: {
          cpu: 16,
          paused: false,
          blocked: false,
          gpu: { state: "ready" },
          jobs: [],
        },
      },
    ],
  };
}

function response(value = overview()) {
  return Response.json({ ok: true, result: value });
}

function mount(
  read: typeof fetch = async () => response(),
  enabled = true,
  placement: "status" | "footer" = "status",
) {
  const fetchMock = vi.fn(read);
  vi.stubGlobal("fetch", fetchMock);
  setPluginSlotRegistrations(
    "omnyo--account-usage",
    makePluginRegistrationSet({
      sidebarFooterCards: [
        {
          id: "usage",
          component: () => (
            <span role="img" aria-label="Claude work 75% remaining" />
          ),
        },
      ],
    }),
  );

  if (enabled)
    setPluginSlotRegistrations(
      "resources",
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "resources",
            title: "Resources",
            icon: "Cpu",
            path: "resources",
            component: () => null,
          },
        ],
      }),
    );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  clients.push(client);

  const rendered = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>
          <PluginSidebarFooterCards placement={placement} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );

  return { ...rendered, fetchMock, client };
}

async function findUsedUnits(value: string) {
  await waitFor(() =>
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe(value),
  );
}

afterEach(() => {
  cleanup();

  for (const client of clients.splice(0)) client.clear();
  resetPluginSlotStoreForTest();
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native Resources readings", () => {
  it("reads the existing enabled plugin's dashboard and shows exact scheduler numbers beside usage", async () => {
    const { fetchMock } = mount();

    const meter = await screen.findByRole("meter", {
      name: "Mac: CPU units in use",
    });

    expect(meter.getAttribute("aria-valuenow")).toBe("4");
    expect(meter.getAttribute("aria-valuetext")).toBe(
      "4 of 8 CPU units in use",
    );
    expect(within(meter).getByText("4")).toBeDefined();
    expect(within(meter).getByText("/8")).toBeDefined();
    expect(screen.getByLabelText("Mac: 3 running jobs")).toBeDefined();
    expect(screen.getByLabelText("Mac: 1 queued job")).toBeDefined();
    expect(screen.getByLabelText("Mac: GPU busy")).toBeDefined();
    expect(
      screen.getByRole("img", { name: "Claude work 75% remaining" }),
    ).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/plugins\/resources\/rpc\/overview$/),
      expect.objectContaining({ method: "POST", body: "null" }),
    );
  });

  it("does not call or display Resources when its frontend is disabled", () => {
    const { fetchMock } = mount(undefined, false);
    expect(screen.queryByRole("region", { name: "Resources" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("img", { name: "Claude work 75% remaining" }),
    ).toBeDefined();
  });

  it("shows loading before the read completes", async () => {
    let finish: (value: Response) => void = () => {
      throw new Error("Read not started");
    };

    mount(
      async () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    expect(screen.getByText("Loading…")).toBeDefined();
    await act(async () => finish(response()));

    expect(
      (
        await screen.findByRole("meter", { name: "Mac: CPU units in use" })
      ).getAttribute("aria-valuenow"),
    ).toBe("4");
  });

  it("polls current readings and hides old numbers on a failed read until recovery", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let failed = false;
    let current = overview();
    mount(async () => {
      if (failed) throw new Error("Resources read failed");

      return response(current);
    });
    await findUsedUnits("4");
    current.machines[0]!.snapshot.jobs = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await findUsedUnits("0");
    failed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await screen.findByRole("status", { name: "Unavailable" });
    expect(screen.queryByRole("meter")).toBeNull();
    failed = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await findUsedUnits("0");
  });

  it("shows browser offline state and refreshes when connectivity returns", async () => {
    mount();
    await findUsedUnits("4");
    act(() => onlineManager.setOnline(false));
    expect(screen.getByText("Offline")).toBeDefined();
    expect(screen.queryByRole("meter")).toBeNull();
    act(() => onlineManager.setOnline(true));
    await findUsedUnits("4");
  });

  it.each([
    { connected: false, error: "Machine disconnected", label: "Offline" },
    {
      connected: true,
      error: "Resource status unavailable",
      label: "Unavailable",
    },
  ])(
    "does not present a retained snapshot as live when its host is $label",
    async ({ connected, error, label }) => {
      const current = overview();
      mount(async () =>
        Response.json({
          ok: true,
          result: {
            ...current,
            complete: false,
            machines: [{ ...current.machines[0], connected, error }],
          },
        }),
      );
      await screen.findByRole("status", { name: label });
      expect(screen.queryByRole("meter")).toBeNull();
    },
  );

  it.each([{ gpu: { state: "unconfigured" } }, { gpu: undefined }])(
    "omits GPU admission for a host without GPU scheduling ($gpu)",
    async ({ gpu }) => {
      const current = overview();
      const [mac] = current.machines;

      mount(async () =>
        Response.json({
          ok: true,
          result: {
            ...current,
            machines: [{ ...mac, snapshot: { ...mac!.snapshot, gpu } }],
          },
        }),
      );
      await screen.findByRole("meter", { name: "Mac: CPU units in use" });
      expect(screen.queryByLabelText(/GPU/)).toBeNull();
    },
  );

  it("names a single host without offering a machine picker", async () => {
    const current = overview();
    mount(async () =>
      response({ ...current, machines: [current.machines[0]!] }),
    );
    await screen.findByRole("meter", { name: "Mac: CPU units in use" });
    expect(screen.getByText("Mac")).toBeDefined();
    expect(
      screen.queryByRole("combobox", { name: "Resources machine" }),
    ).toBeNull();
  });

  it("names the selected host in full and marks a held queue", async () => {
    const current = overview();
    current.machines[0]!.name = "Windows 5080";
    current.machines[0]!.snapshot.blocked = true;
    mount(async () => response(current));
    await screen.findByRole("meter", {
      name: "Windows 5080: CPU units in use",
    });
    expect(
      screen.getByText("Windows 5080", { selector: "span" }),
    ).toBeDefined();
    expect(screen.getByText("Held")).toBeDefined();
  });

  it("rejects an incompatible dashboard response instead of displaying guessed numbers", async () => {
    mount(async () =>
      Response.json({
        ok: true,
        result: {
          ...overview(),
          machines: [{ ...machine(), snapshot: { cpu: "eight", jobs: [] } }],
        },
      }),
    );
    await screen.findByRole("status", { name: "Unavailable" });
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("shows an empty host inventory without fabricating zero capacity", async () => {
    mount(async () => response({ ...overview(), machines: [] }));
    await screen.findByText("No machines connected");
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("aborts an in-flight dashboard read when the Resources contribution disappears", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    mount(async (_input, init) => {
      signals.push(init?.signal);

      return new Promise<Response>(() => {});
    });
    expect(screen.getByText("Loading…")).toBeDefined();
    act(() => removePluginSlotRegistrations("resources"));
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.queryByRole("region", { name: "Resources" })).toBeNull();
    expect(
      screen.getByRole("img", { name: "Claude work 75% remaining" }),
    ).toBeDefined();
  });

  it("reads the same numbers on one app-footer line and picks the host from a menu", async () => {
    mount(undefined, true, "footer");

    const meter = await screen.findByRole("meter", {
      name: "Mac: CPU units in use",
    });

    expect(meter.getAttribute("aria-valuenow")).toBe("4");
    expect(within(meter).getByText("4")).toBeDefined();
    expect(within(meter).getByText("/8")).toBeDefined();
    expect(screen.getByLabelText("Mac: 3 running jobs")).toBeDefined();
    expect(screen.getByLabelText("Mac: 1 queued job")).toBeDefined();
    expect(screen.queryByRole("combobox")).toBeNull();

    const group = screen.getByRole("group", {
      name: "Live usage and resources",
    });

    const usage = within(group).getByRole("img", {
      name: "Claude work 75% remaining",
    });

    const resources = within(group).getByRole("region", { name: "Resources" });
    expect(
      usage.compareDocumentPosition(resources) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Resources machine: Mac" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Worker" }),
    );

    await waitFor(() =>
      expect(
        screen
          .getByRole("meter", { name: "Worker: CPU units in use" })
          .getAttribute("aria-valuenow"),
      ).toBe("0"),
    );
    expect(
      screen.getByRole("button", { name: "Resources machine: Worker" }),
    ).toBeDefined();
  });

  it("shows the footer status instead of numbers while the read is pending", () => {
    mount(async () => new Promise<Response>(() => {}), true, "footer");

    expect(screen.getByRole("status", { name: "Loading" })).toBeDefined();
    expect(screen.queryByRole("meter")).toBeNull();
  });
});
