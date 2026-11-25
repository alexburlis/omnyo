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

function renderProfiles(setup: ClaudeSetup | null = null) {
  const onCloseSetup = vi.fn();
  render(
    <NativeClaudeProfiles
      setup={setup}
      onCloseSetup={onCloseSetup}
      showEmpty
    />,
  );

  return onCloseSetup;
}

describe("Native Claude accounts", () => {
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
    expect(close).toHaveBeenCalledOnce();
  });

  it("changes the default only on the explicit action", async () => {
    renderProfiles();
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
