// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";

const state = vi.hoisted(() => {
  const enabled: boolean[] = [];

  return { enabled };
});

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: true }),
  useLocalHostDaemonAccess: () => ({
    accessState: "available",
    requestAccess: vi.fn(),
  }),
}));

vi.mock("@/hooks/useWorkspaceOpenTargets", () => ({
  useWorkspaceOpenTargets: ({ enabled }: { enabled: boolean }) => {
    state.enabled.push(enabled);

    return { workspaceOpenTargets: [] };
  },
}));

vi.mock("@/components/settings/CliSkillsSettingsSection", () => ({
  CliSkillsSettingsSection: () => null,
}));

vi.mock("@/components/settings/VoiceInputSettingsSection", () => ({
  VoiceInputSettingsSection: () => null,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.enabled.length = 0;
});

it("requests local file targets only while their settings section is open", () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });

  const content = (section: "general" | "files") => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <SettingsView section={section} />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );

  const view = render(content("general"));
  expect(state.enabled).toEqual([]);
  view.rerender(content("files"));
  expect(state.enabled.at(-1)).toBe(true);
  state.enabled.length = 0;
  view.rerender(content("general"));
  expect(state.enabled).toEqual([]);
  client.clear();
});
