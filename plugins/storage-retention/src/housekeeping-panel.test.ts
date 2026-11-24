// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  within,
  waitFor,
  act,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { HousekeepingPanel } from "../housekeeping-panel.js";
import {
  defaultHousekeepingBudget,
  housekeepingRunInputSchema,
  type HousekeepingHostState,
  type HousekeepingRun,
  type HousekeepingStatus,
} from "./housekeeping-contract.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function run(overrides: Partial<HousekeepingRun> = {}): HousekeepingRun {
  return {
    id: "3151bd23-133d-41d4-b4bf-fd6618687750",
    mode: "apply",
    state: "held",
    startedAt: 1,
    finishedAt: 2,
    registrationRevision: null,
    bindingsDigest: null,
    budget: { ...defaultHousekeepingBudget },
    reserved: { items: 0, bytes: 0 },
    stages: [
      {
        name: "process-private-temp",
        state: "held",
        reason: "The producer is still running.",
        items: 0,
        bytes: 0,
      },
    ],
    reason: null,
    ...overrides,
  };
}

function fixture(selectedRun: HousekeepingRun | null = run()) {
  const host: HousekeepingHostState = {
    hostId: "host_test",
    registration: null,
    currentRun: null,
    lastRun: selectedRun,
    nextRunAt: 3,
  };

  let state: HousekeepingStatus = { hosts: [host], failures: [] };
  const read = vi.fn(async () => state);

  const start = vi.fn(async (input: unknown) => {
    housekeepingRunInputSchema.parse(input);
    host.currentRun = run({ state: "running", finishedAt: null, stages: [] });

    return host;
  });

  const preview = vi.fn(async (input: unknown) => {
    housekeepingRunInputSchema.parse(input);

    return host;
  });

  const slot = renderSlot(
    { component: HousekeepingPanel },
    { hostId: "host_test", machineName: () => "Test Mac" },
    {
      rpc: {
        housekeepingStatus: read,
        housekeepingRun: start,
        housekeepingPreview: preview,
      },
    },
  );

  const page = within(slot.container);

  const open = async () => {
    fireEvent.click(page.getByRole("button", { name: "Open housekeeping" }));
    await page.findByRole("article", { name: "Housekeeping for Test Mac" });
  };

  return {
    slot,
    page,
    open,
    read,
    start,
    preview,
    host,
    setState: (next: HousekeepingStatus) => {
      state = next;
    },
  };
}

it("loads only when opened and shows held producers without claiming removal", async () => {
  const { slot, page, open, read, setState, host } = fixture();
  expect(read).not.toHaveBeenCalled();
  await open();
  expect(page.getByText("Built-in maintenance")).toBeTruthy();
  expect(
    page.getByText(
      "Worker temporary files: held · The producer is still running.",
    ),
  ).toBeTruthy();
  expect(page.getByText("Cleanup · Held · 0 B reported removed")).toBeTruthy();
  setState({
    hosts: [{ ...host, lastRun: run({ state: "completed" }) }],
    failures: [],
  });
  await act(async () => {
    await slot.emitRealtime("housekeeping-changed", null);
  });
  await page.findByText("Cleanup · Finished · 0 B reported removed");
  fireEvent.click(page.getByRole("button", { name: "Close housekeeping" }));
  const count = read.mock.calls.length;
  await act(async () => {
    await slot.emitRealtime("housekeeping-changed", null);
  });
  expect(read).toHaveBeenCalledTimes(count);
});

it("shows exact protected runtime proposals with their owner and required decision", async () => {
  const { page, open } = fixture(
    run({
      reviewProposals: [
        {
          id: "a".repeat(64),
          kind: "cua-placement-review",
          owner: "Cua Spaces",
          paths: ["/fixture/cua/datadisk"],
          observedAt: 1,
          logicalBytes: 1024,
          allocatedBytes: 512,
          reason: "The guest disk requires an external SSD review.",
          action:
            "Preserve the guest and identify its consumers before configuring the approved SSD route.",
          preservation: "Guest data and volumes remain protected.",
          state: "protected",
        },
      ],
    }),
  );

  await open();
  expect(
    page.getByLabelText("Protected storage review proposals"),
  ).toBeTruthy();
  expect(page.getByText("/fixture/cua/datadisk")).toBeTruthy();
  expect(
    page.getByText("Guest data and volumes remain protected."),
  ).toBeTruthy();
  expect(
    page.getByText(
      "Preserve the guest and identify its consumers before configuring the approved SSD route.",
    ),
  ).toBeTruthy();
});

it("starts the selected host through the shared run contract and displays actual running state", async () => {
  const { page, open, start, preview } = fixture(null);
  await open();
  fireEvent.click(
    page.getByRole("button", { name: "Run housekeeping on Test Mac" }),
  );
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith({
      hostId: "host_test",
      budget: defaultHousekeepingBudget,
    }),
  );
  await page.findByText("Cleanup · Running · 0 B reported removed");
  expect(preview).not.toHaveBeenCalled();
  expect(
    page
      .getByRole("button", { name: "Run housekeeping on Test Mac" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

it("labels preview bytes as eligible rather than removed", async () => {
  const { page, open } = fixture(
    run({
      mode: "preview",
      state: "completed",
      stages: [
        {
          name: "plugin-cache",
          state: "complete",
          reason: null,
          items: 2,
          bytes: 2048,
        },
      ],
    }),
  );

  await open();
  expect(page.getByText("Preview · Finished · 2 KiB eligible")).toBeTruthy();
  expect(page.queryByText(/reported removed/)).toBeNull();
});

it("keeps inspection failures visible and allows retry", async () => {
  const { page, read } = fixture(null);
  read.mockRejectedValueOnce(new Error("Machine status is unavailable."));
  fireEvent.click(page.getByRole("button", { name: "Open housekeeping" }));
  await page.findByRole("alert");
  expect(page.getByText("Machine status is unavailable.")).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Try again" }));
  await page.findByRole("article", { name: "Housekeeping for Test Mac" });
  expect(page.queryByRole("alert")).toBeNull();
});

it("does not present an unknown native removal size as zero bytes removed", async () => {
  const { page, open } = fixture(
    run({
      state: "completed",
      stages: [
        {
          name: "docker",
          state: "complete",
          reason: "The native utility did not report a size.",
          items: null,
          bytes: null,
        },
      ],
    }),
  );

  await open();
  expect(
    page.getByText("Cleanup · Finished · 0 B known; other sizes not measured"),
  ).toBeTruthy();
  expect(page.queryByText(/0 B reported removed/)).toBeNull();
});
