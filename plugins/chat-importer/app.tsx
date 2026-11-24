import { definePluginApp } from "@omnyo/plugin-sdk/app";
import { ChatImportPanel } from "./src/ui/ChatImportPanel.js";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "import",
    title: "Import chats",
    description:
      "Bring recent Codex CLI and Claude Code chats into Omnyo and continue them here.",
    component: ChatImportPanel,
  });
});
