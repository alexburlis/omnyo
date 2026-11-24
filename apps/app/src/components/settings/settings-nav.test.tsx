// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@omnyo/server-contract";
import { resetPluginSlotStoreForTest } from "@/lib/plugin-slots";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { pluginListQueryKey } from "@/hooks/queries/query-keys";
import { useSettingsNavState } from "./settings-nav";
import { resolveSettingsRoute } from "./settings-route";
import {
  getSettingsSectionRoutePath,
  SETTINGS_NAV_SECTIONS,
} from "./settings-sections";
import { makeInstalledPlugin } from "@/test/fixtures/plugins";

const mocks = vi.hoisted(() => ({
  accessState: "unavailable",
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: false }),
  useLocalHostDaemonAccess: () => ({ accessState: mocks.accessState }),
}));

function wrapperFor(path: string, plugins: readonly InstalledPlugin[] = []) {
  const { queryClient, wrapper: QueryWrapper } = createQueryClientTestHarness();
  queryClient.setQueryData(pluginListQueryKey(true), plugins);

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryWrapper>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryWrapper>
    );
  };
}

function disabledPlugin(): InstalledPlugin {
  return makeInstalledPlugin({
    id: "linear",
    source: "path:/plugins/linear",
    rootDir: "/plugins/linear",
    enabled: false,
    status: "disabled",
    description: "Linear integration",
    name: "Linear",
    sourceDisplay: "path · /plugins/linear",
  });
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  mocks.accessState = "unavailable";
});

describe("settings routes", () => {
  it.each(SETTINGS_NAV_SECTIONS)("resolves the $label link", ({ id }) => {
    expect(
      resolveSettingsRoute({ pathname: getSettingsSectionRoutePath(id) }),
    ).toEqual(
      id === "plugins" ? { kind: "installed" } : { kind: "core", section: id },
    );
  });

  it.each([
    ["/settings/plugins/example", "", { kind: "plugin", pluginId: "example" }],
    [
      "/settings/plugins/example%20plugin",
      "?view=installed",
      { kind: "installed-detail", pluginId: "example plugin" },
    ],
    ["/settings/projects/example", "", { kind: "project" }],
    ["/settings/machines/example", "", { kind: "machine" }],
    ["/settings/unknown/nested", "", null],
  ] as const)("resolves %s %s", (pathname, search, route) => {
    expect(resolveSettingsRoute({ pathname, search })).toEqual(route);
  });
});

describe("useSettingsNavState", () => {
  it.each(["ai-services", "website"])(
    "treats retired %s as an unknown settings route",
    (section) => {
      const { result } = renderHook(() => useSettingsNavState(), {
        wrapper: wrapperFor(`/settings/${section}`),
      });

      expect(
        resolveSettingsRoute({ pathname: `/settings/${section}` }),
      ).toEqual({ kind: "unknown" });
      expect(
        result.current.sections.map((section) => section.id),
      ).not.toContain(section);
    },
  );

  it("resolves the Providers bucket from its section route", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/providers"),
    });

    expect(result.current.activeSection).toBe("providers");
  });

  it("shows the Machines section", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/machines"),
    });

    expect(result.current.sections.map((section) => section.id)).toContain(
      "machines",
    );
  });

  it("shows Files when local helper access can be enabled", () => {
    mocks.accessState = "permission-required";

    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/files"),
    });

    expect(result.current.sections).toContainEqual(
      expect.objectContaining({ icon: "File", id: "files" }),
    );
  });

  it("resolves archived threads as a settings section", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/archived"),
    });

    expect(result.current.activeSection).toBe("archived");
    expect(result.current.sections.map((section) => section.id)).toContain(
      "archived",
    );
  });

  it("recognizes installed plugins as a settings section", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings/plugins"),
    });

    expect(result.current.sections.map((section) => section.id)).toContain(
      "plugins",
    );
  });

  it("omits disabled plugins from individual settings entries", () => {
    const { result } = renderHook(() => useSettingsNavState(), {
      wrapper: wrapperFor("/settings", [disabledPlugin()]),
    });

    expect(result.current.pluginEntries).toEqual([]);
  });
});
