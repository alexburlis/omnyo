import { useContext, useState } from "react";
import type { NewThreadComposerProps as PluginComposerProps } from "@omnyo/plugin-sdk";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  NewThreadComposer,
  type NewThreadComposerSeed,
  type NewThreadComposerSubmission,
} from "@/components/promptbox/NewThreadComposer";
import { useComposerShortcutCapture } from "@/components/commands/composer-shortcut-capture";
import { PluginContext } from "@/components/plugin/plugin-context";

export function PluginNewThreadComposer({
  defaultProjectId,
  defaultProviderId,
  defaultModel,
  defaultReasoningLevel,
  defaultServiceTier,
  defaultPermissionMode,
  defaultEnvironment,
  initialPrompt,
  placeholder,
  layout = "contained",
  focusRequest,
  className,
  draftKey,
  onSubmit,
}: PluginComposerProps) {
  const pluginId = useContext(PluginContext);
  const captureShortcut = useComposerShortcutCapture();

  const [pickedProjectId, setPickedProjectId] = useState<string | null>(
    defaultProjectId ?? null,
  );

  const [seededDefaultProjectId, setSeededDefaultProjectId] =
    useState(defaultProjectId);

  if (seededDefaultProjectId !== defaultProjectId) {
    setSeededDefaultProjectId(defaultProjectId);
    setPickedProjectId(defaultProjectId ?? null);
  }

  const seed: NewThreadComposerSeed = {
    providerId: defaultProviderId,
    model: defaultModel,
    reasoningLevel: defaultReasoningLevel,
    serviceTier: defaultServiceTier,
    permissionMode: defaultPermissionMode,
    environment: defaultEnvironment,
    initialPrompt,
  };

  const composerKey = draftKey ?? pluginId ?? "default";

  const handleSubmit = async (request: NewThreadComposerSubmission) => {
    const {
      capturedUploads: _uploads,
      prepareInput,
      sendReservation: _reservation,
      expectedPluginWait: _expectedWait,
      ...fields
    } = request;

    const input =
      prepareInput === undefined ? fields.input : await prepareInput();

    await onSubmit({
      ...fields,
      input,
      executionInputSources: {
        ...request.executionInputSources,
        providerId: "explicit",
      },
    });
  };

  return (
    <NewThreadComposer
      projectId={pickedProjectId}
      onProjectChange={setPickedProjectId}
      draftStorage={{ kind: "plugin-new-thread", key: composerKey }}
      selectionScope="component-local"
      seed={seed}
      resetKey={defaultProjectId ?? null}
      focusRequest={focusRequest}
      onSubmit={handleSubmit}
    >
      {({ renderPromptBox }) => (
        <div
          onKeyDownCapture={captureShortcut}
          className={cn(
            layout === "contained"
              ? "flex h-full min-h-0 flex-col justify-end"
              : "flex flex-col",
            className,
          )}
        >
          {renderPromptBox({
            placeholder,
            allowNoProject: true,
            mentionMenuPlacement: layout === "contained" ? "top" : "bottom",
          })}
        </div>
      )}
    </NewThreadComposer>
  );
}
