// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { makeHost } from "@omnyo/test-helpers/domain-fixtures";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectPathDialog } from "@/components/dialogs/ProjectPathDialog";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  QuickCreateProjectProvider,
  useQuickCreateProjectController,
} from "@/hooks/useQuickCreateProject";
import { sdk } from "@/lib/sdk";
import { makeProjectResponse } from "@/test/fixtures/projects";
import { experimental_useAppNavigate as useAppNavigate } from "./plugin-sdk-hooks";

const host = makeHost({ id: "host_local", name: "Local Mac" });

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    localDaemonHostId: host.id,
    supportsNativeFolderPicker: false,
    platform: "darwin",
  }),
}));

vi.mock("@/hooks/queries/host-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/queries/host-queries")>()),
  useHosts: () => ({ data: [host], isPending: false }),
  usePrimaryHost: () => host,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function DialogHost() {
  const project = useQuickCreateProjectController();

  return (
    <ProjectPathDialog
      target={project.projectPathDialog.target}
      pending={project.isCreating}
      platform={project.platform}
      hostId={project.hostId}
      hostName={project.hostName}
      hosts={project.hosts}
      onOpenChange={project.projectPathDialog.onOpenChange}
      onSubmit={project.submitProjectPath}
    />
  );
}

function PluginPage() {
  const navigate = useAppNavigate();
  const [selection, setSelection] = useState("No project selected");
  const { pathname } = useLocation();

  return (
    <>
      <h1>Pending workflow review</h1>
      <p>{pathname}</p>
      <output>{selection}</output>
      <button
        type="button"
        onClick={() =>
          navigate.experimental_openProjectCreator?.(({ id, name }) =>
            setSelection(`${name} (${id})`),
          )
        }
      >
        Open project picker
      </button>
    </>
  );
}

it("opens the shared project picker, keeps the plugin page through cancel and retry, and selects the saved project", async () => {
  const path = "/workspace/storyboard";
  vi.spyOn(sdk.hosts, "directory").mockResolvedValue({
    directory: path,
    parent: "/workspace",
    entries: [],
  });

  const create = vi
    .spyOn(sdk.projects, "create")
    .mockResolvedValue(
      makeProjectResponse({ id: "proj_storyboard", name: "storyboard" }),
    );

  const pathname = "/plugins/automations/automations/import";

  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[pathname]}>
        <QuickCreateProjectProvider>
          <PluginSlotMount
            pluginId="automations"
            slotKind="test"
            slotId="probe"
          >
            <PluginPage />
          </PluginSlotMount>
          <DialogHost />
        </QuickCreateProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Open project picker" }));

  const firstPicker = await screen.findByRole("dialog", {
    name: "Add project",
  });

  fireEvent.click(within(firstPicker).getByRole("button", { name: "Close" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("No project selected")).toBeTruthy();
  expect(create).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Open project picker" }));
  const picker = await screen.findByRole("dialog", { name: "Add project" });
  const submit = within(picker).getByRole("button", { name: "Add project" });
  await waitFor(() => expect(submit).toHaveProperty("disabled", false));
  fireEvent.click(submit);

  expect(await screen.findByText("storyboard (proj_storyboard)")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText(pathname)).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Pending workflow review" }),
  ).toBeTruthy();
  expect(create).toHaveBeenCalledExactlyOnceWith({
    name: "storyboard",
    source: { type: "local_path", hostId: host.id, path },
  });
});
