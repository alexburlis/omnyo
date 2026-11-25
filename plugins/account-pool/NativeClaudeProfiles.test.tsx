// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NativeClaudeProfiles,
  type ClaudeSetup,
} from "./NativeClaudeProfiles.js";

const client = vi.hoisted(() => ({
  hosts: { list: vi.fn() },
  system: { config: vi.fn() },
  providers: {
    claudeProfiles: {
      list: vi.fn(),
      add: vi.fn(),
      status: vi.fn(),
      usage: vi.fn(),
      loginStart: vi.fn(),
      loginGet: vi.fn(),
      defaultsSet: vi.fn(),
    },
  },
}));

vi.mock("@omnyo/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnyo/plugin-sdk/app")>()),
  experimental_Icon: () => null,
  useSdk: () => client,
}));

const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Personal Claude",
  status: "ready",
  loginExpiresAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  client.system.config.mockResolvedValue({ primaryHostId: "host-mac" });
  client.hosts.list.mockResolvedValue([
    { id: "host-mac", name: "Mac", status: "connected" },
  ]);
  client.providers.claudeProfiles.list.mockResolvedValue({
    action: "list",
    supported: true,
    profiles: [profile],
    defaultSelection: { kind: "unprofiled" },
  });
  client.providers.claudeProfiles.usage.mockResolvedValue({
    action: "usage",
    usage: { status: "error", accountEmail: null, planLabel: null },
  });
});

afterEach(cleanup);

function renderProfiles(setup: ClaudeSetup | null = null) {
  const onCloseSetup = vi.fn();
  render(
    <NativeClaudeProfiles
      setup={setup}
      onCloseSetup={onCloseSetup}
      showEmpty
      threshold={0.98}
    />,
  );

  return onCloseSetup;
}

describe("Native Claude accounts", () => {
  it("lists saved accounts from the server machine without a machine picker", async () => {
    client.hosts.list.mockResolvedValue([
      { id: "host-worker", name: "Worker", status: "connected" },
      { id: "host-mac", name: "Mac", status: "connected" },
    ]);
    client.providers.claudeProfiles.list.mockImplementation(
      async ({ hostId }) => ({
        action: "list",
        supported: hostId === "host-mac",
        profiles: hostId === "host-mac" ? [profile] : [],
        defaultSelection: { kind: "unprofiled" },
      }),
    );
    renderProfiles();

    expect(await screen.findByText("Personal Claude")).toBeTruthy();
    expect(screen.getByText("Mac")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View usage in Claude" }),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows the verified email, plan and only the usage windows Claude reports", async () => {
    client.providers.claudeProfiles.usage.mockResolvedValue({
      action: "usage",
      usage: {
        status: "ok",
        accountEmail: "claude@example.com",
        planLabel: "Max",
        windows: [{ label: "7D", usedPercent: 30, resetsAt: null }],
      },
    });
    renderProfiles();

    expect(await screen.findByText("claude@example.com")).toBeTruthy();
    expect(screen.getByText("Max")).toBeTruthy();
    expect(screen.getByText("30%")).toBeTruthy();
    expect(screen.queryByText("5H")).toBeNull();
    expect(
      client.providers.claudeProfiles.usage,
    ).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-mac",
      profileId: profile.id,
    });
  });
  it("disables setup on an unsupported server", async () => {
    client.providers.claudeProfiles.list.mockResolvedValue({
      action: "list",
      supported: false,
      profiles: [],
      defaultSelection: { kind: "unprofiled" },
    });
    renderProfiles("sign-in");
    await screen.findByText(
      "Claude account setup is unavailable on this machine.",
    );
    expect(
      screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("adds a profile then starts native browser sign-in without an auth-code form", async () => {
    client.providers.claudeProfiles.add.mockResolvedValue({
      action: "add",
      profile,
    });
    client.providers.claudeProfiles.loginStart.mockResolvedValue({
      action: "loginStart",
      profile,
      loginState: "running",
    });
    const close = renderProfiles("sign-in");
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Sign in" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Finish sign-in in the browser on Mac.");
    expect(client.providers.claudeProfiles.add).toHaveBeenCalledExactlyOnceWith(
      { hostId: "host-mac", label: "Claude account 2" },
    );
    expect(
      client.providers.claudeProfiles.loginStart,
    ).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-mac",
      profileId: profile.id,
    });
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(
      screen.getByRole("textbox", { name: "Claude account name" }),
    ).toBeTruthy();
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows the new account details after browser sign-in finishes", async () => {
    const unsignedProfile = { ...profile, status: "sign-in-required" };
    client.providers.claudeProfiles.list.mockResolvedValue({
      action: "list",
      supported: true,
      profiles: [unsignedProfile],
      defaultSelection: { kind: "unprofiled" },
    });
    client.providers.claudeProfiles.add.mockResolvedValue({
      action: "add",
      profile: unsignedProfile,
    });
    client.providers.claudeProfiles.loginStart.mockResolvedValue({
      action: "loginStart",
      profile: unsignedProfile,
      loginState: "running",
    });
    client.providers.claudeProfiles.loginGet
      .mockResolvedValueOnce({
        action: "loginGet",
        profile: unsignedProfile,
        loginState: "running",
      })
      .mockResolvedValue({
        action: "loginGet",
        profile,
        loginState: "finished",
      });
    client.providers.claudeProfiles.usage.mockResolvedValue({
      action: "usage",
      usage: {
        status: "ok",
        accountEmail: "new@example.com",
        planLabel: "Max",
        windows: [{ label: "7D", usedPercent: 30, resetsAt: null }],
      },
    });

    renderProfiles("sign-in");
    const submit = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submit);

    await screen.findByText("Finish sign-in in the browser on Mac.");
    expect(client.providers.claudeProfiles.usage).not.toHaveBeenCalled();
    expect(
      await screen.findByText("new@example.com", {}, { timeout: 4_000 }),
    ).toBeTruthy();
    expect(screen.getByText("Max")).toBeTruthy();
    expect(screen.getByText("30%")).toBeTruthy();
    expect(
      screen.queryByText("Finish sign-in in the browser on Mac."),
    ).toBeNull();
  });

  it("changes the default only on the explicit action", async () => {
    renderProfiles();
    await screen.findByText("Personal Claude");
    expect(client.providers.claudeProfiles.defaultsSet).not.toHaveBeenCalled();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Personal Claude actions" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Make default" }),
    );
    await waitFor(() =>
      expect(
        client.providers.claudeProfiles.defaultsSet,
      ).toHaveBeenCalledExactlyOnceWith({
        hostId: "host-mac",
        selection: { kind: "profile", profileId: profile.id },
      }),
    );
  });

  it("explains a duplicate account without enabling it or fetching usage", async () => {
    client.providers.claudeProfiles.list.mockResolvedValue({
      action: "list",
      supported: true,
      profiles: [{ ...profile, status: "duplicate-account" }],
      defaultSelection: { kind: "unprofiled" },
    });
    renderProfiles();

    expect(await screen.findByText("Account already added")).toBeTruthy();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Personal Claude actions" }),
    );
    expect(
      await screen.findByRole("menuitem", {
        name: "Sign in with a different account…",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Make default" })).toBeNull();
    expect(client.providers.claudeProfiles.usage).not.toHaveBeenCalled();
  });

  it("adopts the sign-in on the selected machine", async () => {
    client.providers.claudeProfiles.add.mockResolvedValue({
      action: "add",
      profile,
    });
    const close = renderProfiles("adopt");
    const submit = screen.getByRole("button", { name: "Use existing sign-in" });

    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(client.providers.claudeProfiles.add).toHaveBeenCalledExactlyOnceWith(
      {
        hostId: "host-mac",
        label: "Existing Claude sign-in",
        adoptExisting: true,
      },
    );
    expect(client.providers.claudeProfiles.loginStart).not.toHaveBeenCalled();
  });
});
