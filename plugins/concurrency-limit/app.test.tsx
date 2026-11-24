// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

const hosts = [
  {
    id: "host-a",
    name: "Laptop",
    status: "connected" as const,
    availableParallelism: 8,
    automaticLimit: 8,
    effectiveLimit: 8,
    override: null,
    facts: null,
    takesOverflow: true,
    tags: [],
  },
  {
    id: "host-b",
    name: "Studio",
    status: "disconnected" as const,
    availableParallelism: null,
    automaticLimit: 1,
    effectiveLimit: 1,
    override: null,
    facts: null,
    takesOverflow: true,
    tags: [],
  },
];

const overflowOff = { enabled: false, hosts: [], projectNeeds: [] };

interface ConfigurationInput {
  globalLimit: number | null;
  hostOverrides: Array<{ hostId: string; limit: number }>;
  overflow: unknown;
}

function configurationInput(input: unknown): ConfigurationInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected configuration input");
  }

  const globalLimit = Reflect.get(input, "globalLimit");
  const rawOverrides = Reflect.get(input, "hostOverrides");

  if (
    (globalLimit !== null && typeof globalLimit !== "number") ||
    !Array.isArray(rawOverrides)
  ) {
    throw new Error("Expected configuration input");
  }

  const hostOverrides = rawOverrides.map((rawOverride) => {
    if (typeof rawOverride !== "object" || rawOverride === null) {
      throw new Error("Expected host override");
    }

    const hostId = Reflect.get(rawOverride, "hostId");
    const limit = Reflect.get(rawOverride, "limit");

    if (typeof hostId !== "string" || typeof limit !== "number") {
      throw new Error("Expected host override");
    }

    return { hostId, limit };
  });

  return {
    globalLimit,
    hostOverrides,
    overflow: Reflect.get(input, "overflow"),
  };
}

describe("Concurrency limit settings", () => {
  it("shows compact automatic per-host defaults", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfiguration: () => ({
            globalLimit: null,
            hostOverrides: [],
            overflow: overflowOff,
            hosts,
            projects: [],
          }),
          setConfiguration: (input) => ({
            ...configurationInput(input),
            hosts,
            projects: [],
          }),
        },
      },
    );

    expect(await slot.findByText("Host limits")).toBeTruthy();
    expect(
      slot.getByText("Auto allows one thread per available processor."),
    ).toBeTruthy();
    expect(slot.getByText("8 processors")).toBeTruthy();
    expect(slot.getByText("Offline")).toBeTruthy();
    expect(
      slot
        .getByRole("spinbutton", { name: "Laptop thread limit" })
        .getAttribute("placeholder"),
    ).toBe("Auto (8)");
  });

  it("saves overall and per-host limits without accepting invalid numbers", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfiguration: () => ({
            globalLimit: null,
            hostOverrides: [],
            overflow: overflowOff,
            hosts,
            projects: [],
          }),
          setConfiguration: (input) => {
            const configuration = configurationInput(input);

            return {
              ...configuration,
              projects: [],
              hosts: hosts.map((host) => {
                const override = configuration.hostOverrides.find(
                  (candidate) => candidate.hostId === host.id,
                );

                return override === undefined
                  ? host
                  : {
                      ...host,
                      effectiveLimit: override.limit,
                      override: override.limit,
                    };
              }),
            };
          },
        },
      },
    );

    const overall = await slot.findByRole("spinbutton", {
      name: "Overall thread limit",
    });

    fireEvent.change(overall, { target: { value: "1.5" } });
    fireEvent.blur(overall);
    expect((await slot.findByRole("alert")).textContent).toBe(
      "Use a whole number from 0 to 10000, or leave blank.",
    );
    expect(
      slot.rpcCalls.filter((call) => call.method === "setConfiguration"),
    ).toHaveLength(0);

    fireEvent.change(overall, { target: { value: "3" } });
    fireEvent.blur(overall);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: { globalLimit: 3, hostOverrides: [], overflow: overflowOff },
      }),
    );

    const laptop = slot.getByRole("spinbutton", {
      name: "Laptop thread limit",
    });

    fireEvent.change(laptop, { target: { value: "2" } });
    fireEvent.blur(laptop);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: {
          globalLimit: 3,
          hostOverrides: [{ hostId: "host-a", limit: 2 }],
          overflow: overflowOff,
        },
      }),
    );
  });

  it("returns a host to Auto when its override is cleared", async () => {
    const configuredHosts = [
      { ...hosts[0]!, effectiveLimit: 2, override: 2 },
      hosts[1]!,
    ];

    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfiguration: () => ({
            globalLimit: null,
            hostOverrides: [{ hostId: "host-a", limit: 2 }],
            overflow: overflowOff,
            hosts: configuredHosts,
            projects: [],
          }),
          setConfiguration: (input) => ({
            ...configurationInput(input),
            hosts,
            projects: [],
          }),
        },
      },
    );

    const laptop = await slot.findByRole("spinbutton", {
      name: "Laptop thread limit",
    });

    fireEvent.change(laptop, { target: { value: "" } });
    fireEvent.blur(laptop);

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: { globalLimit: null, hostOverrides: [], overflow: overflowOff },
      }),
    );
  });

  it("records which machines take overflow and what projects need", async () => {
    const overflowOn = { enabled: true, hosts: [], projectNeeds: [] };
    const laptopOff = [{ hostId: "host-a", takesOverflow: false, tags: [] }];

    const appNeeds = [
      {
        projectId: "proj-a",
        needs: [
          { kind: "os", os: "macos" },
          { kind: "tool", tool: "xcode" },
        ],
      },
    ];

    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfiguration: () => ({
            globalLimit: null,
            hostOverrides: [],
            overflow: overflowOn,
            hosts,
            projects: [{ id: "proj-a", name: "App", needs: null }],
          }),
          setConfiguration: (input) => ({
            ...configurationInput(input),
            hosts,
            projects: [{ id: "proj-a", name: "App", needs: null }],
          }),
        },
      },
    );

    fireEvent.click(
      await slot.findByRole("switch", {
        name: "Laptop takes waiting chats from full machines",
      }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: {
          globalLimit: null,
          hostOverrides: [],
          overflow: { ...overflowOn, hosts: laptopOff },
        },
      }),
    );

    const needs = slot.getByRole("textbox", { name: "App needs" });

    fireEvent.change(needs, { target: { value: "quantum" } });
    fireEvent.blur(needs);
    expect((await slot.findByRole("alert")).textContent).toContain("xcode");

    fireEvent.change(needs, { target: { value: "macos, xcode" } });
    fireEvent.blur(needs);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: {
          globalLimit: null,
          hostOverrides: [],
          overflow: { ...overflowOn, hosts: laptopOff, projectNeeds: appNeeds },
        },
      }),
    );

    fireEvent.click(
      slot.getByRole("switch", {
        name: "Start waiting chats on a free machine",
      }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: {
          globalLimit: null,
          hostOverrides: [],
          overflow: {
            enabled: false,
            hosts: laptopOff,
            projectNeeds: appNeeds,
          },
        },
      }),
    );
  });
});
