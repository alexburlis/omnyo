// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Link, MemoryRouter } from "react-router-dom";
import { getSettingsRouteIntent, SettingsRoute } from "./settings-view-split";

const loads = vi.hoisted(() => ({
  core: vi.fn(),
  installed: vi.fn(),
  detail: vi.fn(),
}));

vi.mock("./SettingsView", () => {
  loads.core();

  return {
    SettingsView: ({ section }: { section: string }) => <h1>{section}</h1>,
  };
});

vi.mock("@/components/plugin/PluginsOverview", () => {
  loads.installed();

  return { PluginsOverview: () => <h1>Installed plugins</h1> };
});

vi.mock("./ToolsView", () => {
  loads.detail();

  return {
    PluginDetailPaneView: ({ pluginId }: { pluginId: string }) => (
      <h1>Plugin details for {pluginId}</h1>
    ),
  };
});

afterEach(cleanup);

it("opens the installed overview directly and preloads a detail on focus", async () => {
  const to = "/settings/plugins/example?view=installed";

  render(
    <MemoryRouter initialEntries={["/settings/plugins"]}>
      <Link to={to} {...getSettingsRouteIntent(to)}>
        Open plugin
      </Link>
      <SettingsRoute />
    </MemoryRouter>,
  );

  expect(
    await screen.findByRole("heading", { name: "Installed plugins" }),
  ).toBeTruthy();
  expect(loads.installed).toHaveBeenCalledOnce();
  expect(loads.core).not.toHaveBeenCalled();
  expect(loads.detail).not.toHaveBeenCalled();

  const link = screen.getByRole("link", { name: "Open plugin" });

  fireEvent.focus(link);
  await waitFor(() => expect(loads.detail).toHaveBeenCalledOnce());
  expect(
    screen.queryByRole("heading", { name: "Plugin details for example" }),
  ).toBeNull();

  fireEvent.click(link);
  expect(
    await screen.findByRole("heading", { name: "Plugin details for example" }),
  ).toBeTruthy();
  expect(loads.detail).toHaveBeenCalledOnce();
  expect(loads.core).not.toHaveBeenCalled();
});
