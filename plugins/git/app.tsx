import { definePluginApp } from "@omnyo/plugin-sdk/app";
import { GitHeaderControl } from "./GitHeaderControl";

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "git",
    title: "Git",
    component: GitHeaderControl,
  });
});
