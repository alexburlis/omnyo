import type { RefObject } from "react";
import {
  NewThreadComposer,
  type NewThreadComposerState,
} from "@/components/promptbox/NewThreadComposer";
import type { PromptBoxHandle } from "@/components/promptbox/PromptBoxInternal";
import { useQuickCreateProjectConfig } from "@/hooks/useQuickCreateProject";
import { useRootComposeProjectId } from "@/lib/root-compose-selection";
import { useProjectMachineSetup } from "@/views/new-chat/useProjectMachineSetup";
import { useProviderCliGate } from "@/views/new-chat/useProviderCliGate";
import { useOpenThreadInLayout } from "@/views/thread-detail/useOpenThreadInLayout";
import { usePendingChatSubmission } from "@/views/usePendingChatSubmission";

export type LauncherCloseReason = "opened" | "submitted" | "dismissed";

export interface LauncherComposerProps {
  focusRequest: number;
  promptBoxRef: RefObject<PromptBoxHandle | null>;
  onClose: (reason: LauncherCloseReason) => void;
  onUnopenedFailure: (error: unknown) => void;
}

export function LauncherComposer({
  focusRequest,
  promptBoxRef,
  onClose,
  onUnopenedFailure,
}: LauncherComposerProps) {
  const [projectId, setProjectId] = useRootComposeProjectId();
  const openThread = useOpenThreadInLayout();

  const { handleSubmit } = usePendingChatSubmission({
    projectId,
    isActiveSurface: true,
    open: (thread) => {
      onClose("opened");
      openThread(thread, "replace");
    },
    onUnopenedFailure,
  });

  return (
    <NewThreadComposer
      projectId={projectId}
      onProjectChange={setProjectId}
      draftStorage={{ kind: "new-thread" }}
      selectionScope="new-thread"
      preferReadyProviderWhenUnset
      focusRequest={focusRequest}
      onSubmit={(request) => {
        const submitted = handleSubmit(request);

        onClose("submitted");

        return submitted;
      }}
    >
      {(composer) => (
        <LauncherSurface composer={composer} promptBoxRef={promptBoxRef} />
      )}
    </NewThreadComposer>
  );
}

function LauncherSurface({
  composer,
  promptBoxRef,
}: {
  composer: NewThreadComposerState;
  promptBoxRef: RefObject<PromptBoxHandle | null>;
}) {
  const providerCliGate = useProviderCliGate({
    hostId: composer.projectHostId,
    providerId: composer.selectedProviderId,
  });

  const machineSetup = useProjectMachineSetup(composer);
  const createProject = useQuickCreateProjectConfig("select-only");

  return (
    <div data-new-chat-launcher="" className="p-2">
      {composer.renderPromptBox({
        id: "new-chat-launcher-prompt",
        autoFocus: true,
        mentionMenuPlacement: "bottom",
        banner: providerCliGate.banner,
        blockedReason: providerCliGate.blockedReason,
        allowNoProject: true,
        createProject,
        onRequestMachineSetup: machineSetup.request,
        selectionLayout: "dock",
        promptBoxRef,
      })}
      {machineSetup.dialog}
    </div>
  );
}
