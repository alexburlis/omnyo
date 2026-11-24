import type { ComponentType } from "react";
import type { ResolvedComposerPopup } from "@/lib/plugin-slot-resolvers";
import { PluginSlotMount } from "./PluginSlotMount";

export function PluginComposerPopup({
  contribution,
  initialSkillQuery,
  onClose,
}: {
  contribution: ResolvedComposerPopup;
  initialSkillQuery?: string;
  onClose(): void;
}) {
  const { pluginId, popup } = contribution;

  const Content: ComponentType<{ initialSkillQuery?: string }> =
    popup.component;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-popover text-popover-foreground">
      <PluginSlotMount
        pluginId={pluginId}
        slotKind="composerPopup"
        slotId={popup.id}
        crashFallback={
          <button type="button" onClick={onClose}>
            Close popup
          </button>
        }
      >
        {initialSkillQuery === undefined ? (
          <Content />
        ) : (
          <Content initialSkillQuery={initialSkillQuery} />
        )}
      </PluginSlotMount>
    </div>
  );
}
