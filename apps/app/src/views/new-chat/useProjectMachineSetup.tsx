import { useCallback, useState, type ReactNode } from "react";
import { PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID } from "@omnyo/client-core";
import type { Host } from "@omnyo/domain";
import {
  ProjectMachineSetupDialog,
  type ProjectMachineSetupCompletion,
  type ProjectMachineSetupDialogTarget,
} from "@/components/dialogs/ProjectMachineSetupDialog";
import { encodeProviderValue } from "@/components/pickers/environment-picker-value";
import type { NewThreadComposerState } from "@/components/promptbox/NewThreadComposer";

export interface ProjectMachineSetup {
  request: (host: Host) => void;
  dialog: ReactNode;
}

export function useProjectMachineSetup({
  projectId,
  currentProject,
  parsedEnvironment,
  setEnvironmentSelectionValue,
}: Pick<
  NewThreadComposerState,
  | "projectId"
  | "currentProject"
  | "parsedEnvironment"
  | "setEnvironmentSelectionValue"
>): ProjectMachineSetup {
  const [machineSetupTarget, setMachineSetupTarget] =
    useState<ProjectMachineSetupDialogTarget | null>(null);

  const currentProjectName = currentProject?.name ?? null;
  const currentProjectGitRemoteUrl = currentProject?.gitRemoteUrl ?? null;

  const handleRequestMachineSetup = useCallback(
    (setupHost: Host) => {
      if (!projectId || currentProjectName === null) return;
      setMachineSetupTarget({
        projectId,
        projectName: currentProjectName,
        gitRemoteUrl: currentProjectGitRemoteUrl,
        hostId: setupHost.id,
        hostName: setupHost.name,
      });
    },
    [currentProjectGitRemoteUrl, currentProjectName, projectId],
  );

  const handleMachineSetupComplete = useCallback(
    ({ hostId: setUpHostId }: ProjectMachineSetupCompletion) => {
      setMachineSetupTarget(null);

      if (parsedEnvironment?.type === "provider") {
        setEnvironmentSelectionValue(
          encodeProviderValue(parsedEnvironment.environmentProviderId),
          setUpHostId,
        );

        return;
      }

      setEnvironmentSelectionValue(
        encodeProviderValue(PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID),
        setUpHostId,
      );
    },
    [parsedEnvironment, setEnvironmentSelectionValue],
  );

  return {
    request: handleRequestMachineSetup,
    dialog: (
      <ProjectMachineSetupDialog
        target={machineSetupTarget}
        onOpenChange={(open) => {
          if (!open) setMachineSetupTarget(null);
        }}
        onComplete={handleMachineSetupComplete}
      />
    ),
  };
}
