// @vitest-environment jsdom
import {
  PluginSettingsSections,
  PluginMobileSettingsSections,
} from "@/components/plugin/PluginSettingsSections";
import {
  setPluginSlotRegistrations,
  resetPluginSlotStoreForTest,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { MemoryRouter } from "react-router-dom";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import {
  installNativeShellForTest,
  removeNativeShellForTest,
} from "@/test/native-shell-test-utils";
import { MobileAppSection } from "./MobileAppSection";

beforeEach(() => {
  vi.spyOn(sdk.system, "config").mockResolvedValue(makeSystemConfig());
});

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  removeNativeShellForTest();
  vi.restoreAllMocks();
});

function renderSection() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <MobileAppSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const PAIRING_NOTE = "Any pairing code below is for another phone.";

function selectRelayWithPairingSection() {
  setPluginSlotRegistrations(
    "connection",
    makePluginRegistrationSet({
      settingsSections: [
        {
          id: "pair",
          experimental_page: "mobile",
          component: () => <p>Pair this phone</p>,
        },
        { id: "manage", component: () => <p>Manage connection</p> },
      ],
    }),
  );
  vi.mocked(sdk.system.config).mockResolvedValue(
    makeSystemConfig({
      serverAccess: {
        defaultProviderId: "relay",
        effectiveUrl: null,
        urlSource: null,
        providers: [
          {
            id: "relay",
            displayName: "Relay",
            description: "Relay",
            pluginId: "connection",
            availability: { status: "available" },
          },
        ],
      },
    }),
  );
}

it("places mobile plugin sections only on Mobile and removes them when unregistered", async () => {
  selectRelayWithPairingSection();
  renderSection();

  const plugin = render(
    <MemoryRouter>
      <PluginSettingsSections pluginId="connection" />
    </MemoryRouter>,
  );

  expect(await screen.findByText("Pair this phone")).toBeTruthy();
  expect(plugin.container.textContent).toContain("Manage connection");
  expect(plugin.container.textContent).not.toContain("Pair this phone");
  act(() =>
    setPluginSlotRegistrations("connection", makePluginRegistrationSet()),
  );
  expect(screen.queryByText("Pair this phone")).toBeNull();
});

it("hides pairing slots when Direct or a different provider is selected", () => {
  setPluginSlotRegistrations(
    "connection",
    makePluginRegistrationSet({
      settingsSections: [
        {
          id: "pair",
          experimental_page: "mobile",
          component: () => <p>Pair this phone</p>,
        },
      ],
    }),
  );

  const view = (pluginId: string | null) => (
    <MemoryRouter>
      <PluginMobileSettingsSections pluginId={pluginId} />
    </MemoryRouter>
  );

  const rendered = render(view("connection"));
  expect(screen.getByText("Pair this phone")).toBeTruthy();
  rendered.rerender(view(null));
  expect(screen.queryByText("Pair this phone")).toBeNull();
  rendered.rerender(view("other-provider"));
  expect(screen.queryByText("Pair this phone")).toBeNull();
  rendered.rerender(view("connection"));
  expect(screen.getByText("Pair this phone")).toBeTruthy();
});

it("shows iOS as invite only without an Android placeholder or download links", () => {
  renderSection();

  expect(screen.getByText("Invite only, through TestFlight")).toBeTruthy();
  expect(screen.queryByText("Android")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});

it("tells the phone which server it is using and opens its server list", () => {
  const shell = installNativeShellForTest({ profileMode: "direct" });
  renderSection();

  const card = screen
    .getByRole("heading", { name: "This phone" })
    .closest("section");

  expect(card?.textContent).toContain(
    `This phone is using ${window.location.host} through a direct URL.`,
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Servers and phone settings" }),
  );
  expect(shell.messages()).toContainEqual({
    type: "open-native",
    screen: "device-settings",
  });
});

it("tells the phone that pairing on this page is for another phone", async () => {
  selectRelayWithPairingSection();
  installNativeShellForTest();
  renderSection();

  expect(await screen.findByText("Pair this phone")).toBeTruthy();
  expect(screen.getByText(PAIRING_NOTE)).toBeTruthy();
});

it("leaves the pairing note out on the phone when Direct is selected", async () => {
  installNativeShellForTest();
  renderSection();

  expect(
    await screen.findByRole("textbox", { name: "Server address" }),
  ).toBeTruthy();
  expect(screen.queryByText(PAIRING_NOTE)).toBeNull();
});

it("keeps the phone card out of a plain browser", async () => {
  selectRelayWithPairingSection();
  renderSection();

  expect(await screen.findByText("Pair this phone")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "This phone" })).toBeNull();
  expect(screen.queryByText(PAIRING_NOTE)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Servers and phone settings" }),
  ).toBeNull();
});
