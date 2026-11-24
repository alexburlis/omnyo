import type { PluginApi } from "@omnyo/plugin-sdk";
import { introduction } from "./introduction.js";

export default async function plugin(api: PluginApi) {
  const settings = api.settings.define({
    introduction: {
      type: "boolean",
      label: "Send Omnyo introduction",
      description:
        "Tell agents about the Omnyo CLI, threads, and clickable links. Applies to new agent sessions.",
      default: true,
    },
    skills: {
      type: "boolean",
      label: "Enable bundled skills",
      description: "Make the selected Omnyo guide skills available to agents.",
      default: true,
    },
    omnyoCli: {
      type: "boolean",
      label: "Omnyo CLI skill",
      description: "Inspect and manage Omnyo through the CLI.",
      default: true,
    },
    pluginAuthoring: {
      type: "boolean",
      label: "Plugin authoring skill",
      description: "Create and change Omnyo plugins and SDK extensions.",
      default: true,
    },
    skillCreator: {
      type: "boolean",
      label: "Skill creator skill",
      description: "Create and improve Omnyo skills.",
      default: true,
    },
  });

  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });
  api.agents.contributeInstructions(() =>
    current.introduction ? introduction : null,
  );
  api.agents.configure(() => ({
    tools: [],
    skills: current.skills
      ? [
          ...(current.omnyoCli ? ["omnyo-cli"] : []),
          ...(current.pluginAuthoring ? ["omnyo-plugin-authoring"] : []),
          ...(current.skillCreator ? ["skill-creator"] : []),
        ]
      : [],
  }));
}
