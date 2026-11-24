// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeClaudeProfiles } from "./NativeClaudeProfiles.js";

const client = vi.hoisted(() => ({
  hosts: { list: vi.fn() },
  providers: {
    claudeProfiles: {
      list: vi.fn(),
      add: vi.fn(),
      status: vi.fn(),
      loginStart: vi.fn(),
      loginGet: vi.fn(),
      defaultsSet: vi.fn(),
    },
  },
}));

vi.mock("@omnyo/plugin-sdk/app", () => ({ useSdk: () => client }));

const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Personal Claude",
  status: "ready",
  loginExpiresAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  client.hosts.list.mockResolvedValue([
    { id: "host-mac", name: "Mac", status: "connected" },
  ]);
  client.providers.claudeProfiles.list.mockResolvedValue({
    action: "list",
    supported: true,
    profiles: [profile],
    defaultSelection: { kind: "unprofiled" },
  });
});

afterEach(cleanup);

describe("Native Claude accounts", () => {
  it("disables setup on an unsupported server", async () => {
    client.providers.claudeProfiles.list.mockResolvedValue({
      action: "list",
      supported: false,
      profiles: [],
      defaultSelection: { kind: "unprofiled" },
    });
    render(<NativeClaudeProfiles />);
    await screen.findByText(
      "Native Claude accounts are not enabled on this machine.",
    );
    expect(
      screen
        .getByRole("button", { name: "Add Claude account" })
        .hasAttribute("disabled"),
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
    render(<NativeClaudeProfiles />);
    await screen.findByText("Personal Claude");
    fireEvent.click(screen.getByRole("button", { name: "Add Claude account" }));
    await screen.findByText("Finish sign-in in the browser on this machine.");
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
  });

  it("changes the default only on the explicit action", async () => {
    render(<NativeClaudeProfiles />);
    await screen.findByText("Personal Claude");
    expect(client.providers.claudeProfiles.defaultsSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Make default" }));
    await waitFor(() =>
      expect(
        client.providers.claudeProfiles.defaultsSet,
      ).toHaveBeenCalledExactlyOnceWith({
        hostId: "host-mac",
        selection: { kind: "profile", profileId: profile.id },
      }),
    );
  });
});
