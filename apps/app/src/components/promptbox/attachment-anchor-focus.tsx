import { createContext, useContext } from "react";
import type { PromptDraftAttachment } from "@omnyo/client-core";

export type PromptImageAnchorStatus =
  | {
      status: "bound";
      attachment: PromptDraftAttachment;
      key: string;
      previewSrc: string;
    }
  | { status: "pending" }
  | { status: "ambiguous" }
  | { status: "missing" };

export interface PromptImageAnchorState {
  activeKey: string | null;
  setActiveKey: (key: string | null) => void;
  resolve: (anchor: { path: string; label: string }) => PromptImageAnchorStatus;
}

export const PromptImageAnchorContext =
  createContext<PromptImageAnchorState | null>(null);

export function usePromptImageAnchors(): PromptImageAnchorState | null {
  return useContext(PromptImageAnchorContext);
}

export function promptAttachmentKey(attachment: PromptDraftAttachment): string {
  return [
    attachment.hostId ?? "",
    attachment.sourceProjectId ?? "",
    attachment.path,
    attachment.alias ?? "",
  ].join("\0");
}
