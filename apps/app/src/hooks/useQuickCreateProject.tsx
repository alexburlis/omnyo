import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { deriveProjectNameFromPath, type Host } from "@omnyo/domain";
import type { HostPlatform } from "@omnyo/host-daemon-contract";
import type { ProjectResponse } from "@omnyo/server-contract";
import { useCreateProject } from "@/hooks/mutations/project-mutations";
import { selectHosts, useHosts } from "@/hooks/queries/host-queries";
import {
  useLocalPathPicker,
  type LocalPathSubmitParams,
} from "@/hooks/useLocalPathPicker";
import {
  APP_ROOT_ROUTE_PATH,
  getRootComposeRoutePath,
} from "@/lib/route-paths";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { AppNavigationHostProvider } from "@/lib/app-navigation-host";
import type {
  ProjectPathDialogSubmitHandler,
  ProjectPathDialogTarget,
} from "@/components/dialogs/ProjectPathDialog";
import type { ProjectSelectorCreateProjectConfig } from "@/components/pickers/ProjectSelector";

export type QuickCreateAfterCreate = "show-new-chat" | "select-only";

interface QuickCreateProjectDialogState {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  target: ProjectPathDialogTarget | null;
}

interface QuickCreateProjectController {
  isAvailable: boolean;
  isCreating: boolean;
  openCreateDialog: () => void;
  openCreateDialogSelectOnly: (
    onCreated?: (project: Pick<ProjectResponse, "id" | "name">) => void,
  ) => boolean;
  platform: HostPlatform | null;
  hostId: string | null;
  hostName: string | null;
  hosts: readonly Host[];
  projectPathDialog: QuickCreateProjectDialogState;
  submitProjectPath: ProjectPathDialogSubmitHandler;
}

const quickCreateProjectContext =
  createContext<QuickCreateProjectController | null>(null);

export function useQuickCreateProject(): QuickCreateProjectController {
  const { mutate, isPending } = useCreateProject();
  const hostsQuery = useHosts();

  const hosts = useMemo(
    () => selectHosts(hostsQuery.data, "all"),
    [hostsQuery.data],
  );

  const navigate = useNavigate();
  const location = useLocation();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const shouldReplaceRoute = location.pathname === APP_ROOT_ROUTE_PATH;

  const submit = useCallback(
    ({ path, hostId, target, closeDialog }: LocalPathSubmitParams) => {
      if (target.kind !== "create") return;
      const name = deriveProjectNameFromPath(path).trim();

      if (!name) return;

      mutate(
        {
          name,
          source: { type: "local_path", hostId, path },
        },
        {
          onSuccess: (project) => {
            closeDialog();
            setRootComposeProjectId(project.id);

            if (target.select !== undefined) {
              target.select.onCreated?.({ id: project.id, name: project.name });

              return;
            }

            void navigate(getRootComposeRoutePath(), {
              replace: shouldReplaceRoute,
            });
          },
        },
      );
    },
    [mutate, navigate, setRootComposeProjectId, shouldReplaceRoute],
  );

  const controller = useLocalPathPicker({
    isPending,
    submit,
  });

  const openCreateDialog = useCallback(() => {
    controller.openPathEntry({ kind: "create" });
  }, [controller]);

  const openCreateDialogSelectOnly = useCallback<
    QuickCreateProjectController["openCreateDialogSelectOnly"]
  >(
    (onCreated) => {
      if (
        !controller.isAvailable ||
        isPending ||
        controller.projectPathDialog.isOpen
      )
        return false;

      controller.openPathEntry({ kind: "create", select: { onCreated } });

      return true;
    },
    [controller, isPending],
  );

  return useMemo(
    () => ({
      isAvailable: controller.isAvailable,
      isCreating: isPending,
      openCreateDialog,
      openCreateDialogSelectOnly,
      platform: controller.platform,
      hostId: controller.hostId,
      hostName: controller.hostName,
      hosts,
      projectPathDialog: controller.projectPathDialog,
      submitProjectPath: controller.submitProjectPath,
    }),
    [
      controller,
      hosts,
      isPending,
      openCreateDialog,
      openCreateDialogSelectOnly,
    ],
  );
}

interface QuickCreateProjectProviderProps {
  children: ReactNode;
}

export function QuickCreateProjectProvider({
  children,
}: QuickCreateProjectProviderProps) {
  const quickCreateProject = useQuickCreateProject();

  return (
    <quickCreateProjectContext.Provider value={quickCreateProject}>
      <AppNavigationHostProvider
        capabilities={{
          openProjectCreator: quickCreateProject.openCreateDialogSelectOnly,
        }}
      >
        {children}
      </AppNavigationHostProvider>
    </quickCreateProjectContext.Provider>
  );
}

export function useQuickCreateProjectController(): QuickCreateProjectController {
  const quickCreateProject = useContext(quickCreateProjectContext);

  if (!quickCreateProject) {
    throw new Error("QuickCreateProjectProvider is required");
  }

  return quickCreateProject;
}

export function useQuickCreateProjectConfig(
  afterCreate: QuickCreateAfterCreate,
): ProjectSelectorCreateProjectConfig {
  const {
    isAvailable,
    isCreating,
    openCreateDialog,
    openCreateDialogSelectOnly,
  } = useQuickCreateProjectController();

  return useMemo(
    () => ({
      onCreate:
        afterCreate === "select-only"
          ? openCreateDialogSelectOnly
          : openCreateDialog,
      disabled: !isAvailable || isCreating,
      isCreating,
    }),
    [
      afterCreate,
      isAvailable,
      isCreating,
      openCreateDialog,
      openCreateDialogSelectOnly,
    ],
  );
}
