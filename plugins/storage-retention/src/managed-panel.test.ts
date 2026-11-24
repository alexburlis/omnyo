// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { ManagedCleanupPanel } from "../managed-panel.js";
import {
  defaultManagedPolicy,
  managedAdminRequestSchema,
  MANAGED_HOLDING_MS,
  type ManagedAdminRequest,
  type ManagedAllocation,
  type ManagedState,
} from "./managed-contract.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function allocation(
  overrides: Partial<ManagedAllocation> = {},
): ManagedAllocation {
  return {
    id: "3151bd23-133d-41d4-b4bf-fd6618687750",
    hostId: "host_test",
    ownerThreadId: "thr_owner",
    projectId: null,
    purpose: "Temporary compiler output",
    storage: null,
    closeout: null,
    disposition: "keep-until-released",
    createdAt: 1,
    revision: 4,
    phase: "proposed",
    path: "/fixture/managed/payload",
    originalPath: "/fixture/managed/payload",
    snapshot: {
      digest: "a".repeat(64),
      logicalBytes: 1024,
      entryCount: 2,
      capturedAt: 2,
    },
    grant: { kind: "native-release", at: 3 },
    reviewedAt: null,
    quarantinedAt: null,
    purgeEligibleAt: null,
    hold: null,
    consumers: [],
    removedLogicalBytes: 0,
    reason: "Build verification finished",
    ...overrides,
  };
}

function fixture(
  allocations = [allocation()],
  failures: ManagedState["failures"] = [],
) {
  let state: ManagedState = {
    policy: { ...defaultManagedPolicy },
    allocations,
    failures,
    preview: null,
  };

  const read = vi.fn(async () => state);

  const request = vi.fn(
    async (_input: ManagedAdminRequest): Promise<ManagedState> => state,
  );

  const slot = renderSlot(
    { component: ManagedCleanupPanel },
    { hostId: "host_test" },
    {
      rpc: {
        managedState: read,
        managedRequest: (input) =>
          request(managedAdminRequestSchema.parse(input)),
      },
    },
  );

  const page = within(slot.container);

  const open = async () => {
    fireEvent.click(page.getByRole("button", { name: "Open managed cleanup" }));
    await page.findByRole("group", { name: "Quarantine approval" });
  };

  return {
    slot,
    page,
    open,
    read,
    request,
    state,
    setState: (next: ManagedState) => {
      state = next;
    },
  };
}

function exact(item: ManagedAllocation) {
  return {
    hostId: item.hostId,
    id: item.id,
    revision: item.revision,
    snapshotDigest: item.snapshot?.digest,
  };
}

function quarantine(overrides: Partial<ManagedAllocation> = {}) {
  const quarantinedAt = Date.now() - MANAGED_HOLDING_MS - 1000;

  return allocation({
    phase: "quarantined",
    reviewedAt: 4,
    quarantinedAt,
    purgeEligibleAt: quarantinedAt + MANAGED_HOLDING_MS,
    path: "/fixture/managed/quarantine",
    ...overrides,
  });
}

it("loads only when opened, shows held allocations and incomplete hosts, and refreshes on managed changes", async () => {
  const item = allocation({
    grant: null,
    hold: {
      code: "unsupported-platform",
      message: "Windows process inspection is unsupported; files are held.",
      at: 5,
    },
    consumers: [{ threadId: "thr_consumer", releasedAt: null }],
  });

  const { slot, page, open, read } = fixture(
    [item],
    [{ hostId: "host_test", message: "Machine inspection is incomplete" }],
  );

  expect(read).not.toHaveBeenCalled();
  await open();
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    page.getByText(
      "Held: Windows process inspection is unsupported; files are held.",
    ),
  ).toBeTruthy();
  expect(
    page.getByText("host_test: Machine inspection is incomplete"),
  ).toBeTruthy();
  expect(
    page.getByText(
      "thr_consumer: release not recorded; settlement is checked before cleanup",
    ),
  ).toBeTruthy();
  expect(page.queryByRole("button", { name: "Review cleanup" })).toBeNull();
  expect(
    page.queryByRole("button", { name: "Permanently remove files" }),
  ).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Inspect allocation" }));
  await waitFor(() =>
    expect(slot.rpcCalls.at(-1)?.input).toEqual({
      action: "inspect",
      hostId: item.hostId,
      id: item.id,
    }),
  );
  await waitFor(() =>
    expect(
      page
        .getByRole("button", { name: "Inspect allocation" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  await act(async () => {
    await slot.emitRealtime("managed-changed", null);
  });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});

it("binds review to the exact native-granted snapshot after inline confirmation", async () => {
  const item = allocation();
  const { page, open, request, state } = fixture([item]);
  request.mockResolvedValueOnce({
    ...state,
    allocations: [{ ...item, phase: "approved", reviewedAt: 10, revision: 5 }],
  });
  await open();
  fireEvent.click(page.getByRole("button", { name: "Review cleanup" }));
  expect(request).not.toHaveBeenCalled();

  const confirmation = page.getByRole("region", {
    name: "Confirm managed cleanup",
  });

  expect(confirmation.textContent).toContain(item.snapshot?.digest);
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Approve quarantine" }),
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({ action: "review", ...exact(item) }),
  );
  await page.findByText(/Approved for quarantine/);
  expect(
    page.queryByRole("region", { name: "Confirm managed cleanup" }),
  ).toBeNull();
});

it("offers exact restore while a quarantined allocation is held and its owner grant is missing", async () => {
  const item = quarantine({
    grant: null,
    hold: {
      code: "owner-unarchived",
      message: "Owner resumed; permanent removal is held.",
      at: 5,
    },
  });

  const { page, open, request } = fixture([item]);
  await open();
  expect(
    page.queryByRole("button", { name: "Permanently remove files" }),
  ).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Restore files" }));

  const confirmation = page.getByRole("region", {
    name: "Confirm managed cleanup",
  });

  expect(confirmation.textContent).toContain("It never overwrites files.");
  fireEvent.click(
    within(confirmation).getByRole("button", {
      name: "Restore exact allocation",
    }),
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({ action: "restore", ...exact(item) }),
  );
});

it("permits confirmed per-item purge after the fixed floor with automatic expiry off", async () => {
  const item = quarantine({
    consumers: [{ threadId: "thr_settled", releasedAt: null }],
  });

  const early = quarantine({
    id: "e169fb61-4d70-41c4-8f1c-aa85b3e81956",
    purpose: "Recent output",
    quarantinedAt: Date.now(),
    purgeEligibleAt: Date.now() + MANAGED_HOLDING_MS,
  });

  const { page, open, request } = fixture([item, early]);
  await open();
  expect(
    page
      .getByRole("switch", { name: "Automatically remove quarantined files" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    page.getAllByRole("button", { name: "Permanently remove files" }),
  ).toHaveLength(1);
  expect(page.getByText(/Quarantined:/).textContent).toContain("still on disk");
  fireEvent.click(
    page.getByRole("button", { name: "Permanently remove files" }),
  );
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(
    within(
      page.getByRole("region", { name: "Confirm managed cleanup" }),
    ).getByRole("button", { name: "Confirm permanent removal" }),
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({ action: "purge", ...exact(item) }),
  );
});

it("retains a failed managed-policy draft and retries the preview-bound revision without changing thread retention", async () => {
  const { page, open, request, state, slot } = fixture();

  const preview = {
    digest: "b".repeat(64),
    affectedCount: 1,
    eligibleCount: 0,
    quarantinedCount: 0,
  };

  request.mockResolvedValueOnce({ ...state, preview });
  request.mockRejectedValueOnce(new Error("Policy changed; preview again"));
  request.mockResolvedValueOnce({
    ...state,
    policy: {
      ...state.policy,
      automaticExpiry: true,
      expiryEnabledAt: 100,
      revision: 1,
    },
  });
  await open();

  const toggle = page.getByRole("switch", {
    name: "Automatically remove quarantined files",
  });

  fireEvent.click(toggle);
  fireEvent.click(page.getByRole("button", { name: "Preview policy change" }));
  await page.findByRole("button", { name: "Apply managed policy" });

  const policy = {
    mode: "review",
    automaticExpiry: true,
    quarantineBudgetBytes: defaultManagedPolicy.quarantineBudgetBytes,
  };

  expect(request).toHaveBeenNthCalledWith(1, {
    action: "policy-preview",
    policy,
  });
  expect(
    page.getByText(
      /Existing quarantined files receive a new seven-day minimum/,
    ),
  ).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Apply managed policy" }));
  await page.findByText("Policy changed; preview again");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(
    page.getByRole("region", { name: "Confirm managed cleanup" }),
  ).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Apply managed policy" }));
  await waitFor(() =>
    expect(request).toHaveBeenNthCalledWith(3, {
      action: "configure",
      policy,
      expectedRevision: 0,
      previewDigest: preview.digest,
    }),
  );
  await waitFor(() =>
    expect(
      page.queryByRole("region", { name: "Confirm managed cleanup" }),
    ).toBeNull(),
  );
  expect(slot.rpcCalls.some((call) => call.method === "configure")).toBe(false);
});

it("uses the exact selected item list and digest for confirmed batch removal", async () => {
  const item = quarantine();
  const { page, open, request, state } = fixture([item]);
  request.mockResolvedValueOnce({
    ...state,
    preview: {
      digest: "c".repeat(64),
      affectedCount: 1,
      eligibleCount: 1,
      quarantinedCount: 1,
    },
  });
  await open();
  fireEvent.click(
    page.getByRole("checkbox", {
      name: `Select ${item.purpose} for permanent removal`,
    }),
  );
  fireEvent.click(
    page.getByRole("button", { name: "Preview 1 selected permanent removals" }),
  );
  await page.findByRole("region", { name: "Confirm managed cleanup" });
  expect(request).toHaveBeenNthCalledWith(1, {
    action: "purge-preview",
    items: [exact(item)],
  });
  fireEvent.click(
    page.getByRole("button", { name: "Confirm permanent removal" }),
  );
  await waitFor(() =>
    expect(request).toHaveBeenNthCalledWith(2, {
      action: "purge-batch",
      items: [exact(item)],
      previewDigest: "c".repeat(64),
    }),
  );
});

it("shows authoritative policy updates until the user starts editing", async () => {
  const { slot, page, open, state, setState } = fixture();
  await open();

  const toggle = page.getByRole("switch", {
    name: "Automatically remove quarantined files",
  });

  setState({
    ...state,
    policy: {
      ...state.policy,
      automaticExpiry: true,
      expiryEnabledAt: 100,
      revision: 1,
    },
  });
  await act(async () => {
    await slot.emitRealtime("managed-changed", null);
  });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(toggle);
  setState({
    ...state,
    policy: {
      ...state.policy,
      automaticExpiry: true,
      expiryEnabledAt: 100,
      revision: 2,
    },
  });
  await act(async () => {
    await slot.emitRealtime("managed-changed", null);
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

it("ignores an earlier host response after selection changes", async () => {
  const { slot, page, read } = fixture();
  let finish: (value: ManagedState) => void = () => {};

  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(page.getByRole("button", { name: "Open managed cleanup" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

  const next = {
    policy: { ...defaultManagedPolicy },
    allocations: [
      allocation({ hostId: "host_other", purpose: "Other machine output" }),
    ],
    failures: [],
    preview: null,
  };

  read.mockResolvedValueOnce(next);
  slot.rerender(createElement(ManagedCleanupPanel, { hostId: "host_other" }));
  await page.findByText("Other machine output");
  await act(async () => {
    finish({ ...next, allocations: [allocation()] });
  });
  expect(page.getByText("Other machine output")).toBeTruthy();
  expect(page.queryByText("Temporary compiler output")).toBeNull();
});

it("offers renewed review for a quarantined native grant without allowing purge first", async () => {
  const item = quarantine({ reviewedAt: null });
  const { page, open, request } = fixture([item]);
  await open();
  expect(
    page.queryByRole("button", { name: "Permanently remove files" }),
  ).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Review cleanup" }));
  fireEvent.click(
    within(
      page.getByRole("region", { name: "Confirm managed cleanup" }),
    ).getByRole("button", { name: "Approve quarantine" }),
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({ action: "review", ...exact(item) }),
  );
});
