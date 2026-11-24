// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { Host } from "@omnyo/domain";
import { makeHost } from "@omnyo/test-helpers/domain-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalPathSubmitParams } from "@/hooks/useLocalPathPicker";
import { useQuickCreateProject } from "./useQuickCreateProject";

const mocks = vi.hoisted(() => ({
  hosts: [] as Host[] | undefined,
  isLoadingHosts: false,
  mutate: vi.fn(),
  navigate: vi.fn(),
  onClose: vi.fn(),
  onOpen: vi.fn(),
  onOpenChange: vi.fn(),
  openPathEntry: vi.fn(),
  openPicker: vi.fn(),
  setRootComposeProjectId: vi.fn(),
  submit: null as ((params: LocalPathSubmitParams) => void) | null,
}));

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/" }),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useCreateProject: () => ({ isPending: false, mutate: mocks.mutate }),
}));

vi.mock("@/hooks/queries/host-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/queries/host-queries")>()),
  useHosts: () => ({ data: mocks.hosts, isPending: mocks.isLoadingHosts }),
}));

vi.mock("@/hooks/useLocalPathPicker", () => ({
  useLocalPathPicker: ({
    submit,
  }: {
    submit: (params: LocalPathSubmitParams) => void;
  }) => {
    mocks.submit = submit;

    return {
      isAvailable: true,
      hostId: "host_atum",
      hostName: "atum",
      openPathEntry: mocks.openPathEntry,
      openPicker: mocks.openPicker,
      platform: "linux",
      projectPathDialog: {
        isOpen: false,
        onClose: mocks.onClose,
        onOpen: mocks.onOpen,
        onOpenChange: mocks.onOpenChange,
        target: null,
      },
      submitProjectPath: vi.fn(),
    };
  },
}));

vi.mock("@/lib/root-compose-selection", () => ({
  useSetRootComposeProjectId: () => mocks.setRootComposeProjectId,
}));

function host(
  id: string,
  name: string,
  status: Host["status"] = "connected",
): Host {
  return makeHost({
    id,
    name,
    status,
  });
}

beforeEach(() => {
  mocks.hosts = [host("host_atum", "atum")];
  mocks.isLoadingHosts = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useQuickCreateProject", () => {
  it("delegates opening to the shared path-entry surface", () => {
    const { result } = renderHook(() => useQuickCreateProject());

    act(() => result.current.openCreateDialog());

    expect(mocks.openPathEntry).toHaveBeenCalledWith({ kind: "create" });
  });

  it("exposes every machine for the dialog's picker", () => {
    mocks.hosts = [
      host("host_atum", "atum"),
      host("host_thoth", "Thoth"),
      makeHost({
        id: "host_sandbox",
        name: "Sandbox",
        machineProviderId: "modal-sandbox",
      }),
    ];
    const { result } = renderHook(() => useQuickCreateProject());

    expect(result.current.hosts.map((item) => item.id)).toEqual([
      "host_atum",
      "host_thoth",
      "host_sandbox",
    ]);
  });

  function createProjectThrough(
    open: "openCreateDialog" | "openCreateDialogSelectOnly",
  ) {
    mocks.mutate.mockImplementation(
      (
        _input: unknown,
        options: { onSuccess: (project: { id: string }) => void },
      ) => options.onSuccess({ id: "proj_new" }),
    );

    const { result } = renderHook(() => useQuickCreateProject());

    act(() => result.current[open]());
    const [target] = mocks.openPathEntry.mock.lastCall ?? [];
    act(() =>
      mocks.submit?.({
        path: "/Users/developer/projects/new-app",
        hostId: "host_atum",
        target,
        closeDialog: vi.fn(),
      }),
    );
  }

  it("keeps the current view when the launcher creates a project", () => {
    createProjectThrough("openCreateDialogSelectOnly");

    expect(mocks.setRootComposeProjectId).toHaveBeenCalledWith("proj_new");
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("shows New chat after creating a project from elsewhere", () => {
    createProjectThrough("openCreateDialog");

    expect(mocks.setRootComposeProjectId).toHaveBeenCalledWith("proj_new");
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });
});
