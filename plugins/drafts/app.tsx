import { toast } from "sonner";
import {
  definePluginApp,
  type ComposerSendMenuItem,
} from "@omnyo/plugin-sdk/app";

const saveDraft: ComposerSendMenuItem = {
  id: "drafts",
  label: "Save draft…",
  icon: "EditFile",
  description: "Keep this message in the queue until you send it manually.",
  disabled: (composer) => composer.isSubmittingBlocked,
  run: async ({ composer }) => {
    if (composer.isEmpty) {
      toast.error("Nothing to save", {
        description: "Type a message first, then save it as a draft.",
      });

      return;
    }

    const saving = composer.submit({
      experimental_data: { kind: "draft" },
      experimental_expectHeld: { reason: "Draft" },
    });

    const saved = toast.success("Draft saved");

    try {
      await saving;
    } catch (error: unknown) {
      toast.dismiss(saved);
      toast.error(error instanceof Error ? error.message : String(error));
    }
  },
};

export default definePluginApp((app) => {
  app.composer.customize({
    id: "drafts",
    scopes: ["thread", "new-thread"],
    sendMenu: [saveDraft],
  });
});
