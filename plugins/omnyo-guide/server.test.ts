import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@omnyo/plugin-sdk/testing";
import plugin from "./server.js";

const bundledSkills = readdirSync(new URL("./skills", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

it("introduces Omnyo without user-question guidance", async () => {
  const { api, harness } = createFakePluginHost({
    pluginId: "omnyo-guide",
    agentSkillIds: bundledSkills,
  });

  try {
    await plugin(api);

    const introduction = harness.registrations.instructionProvider?.({
      threadId: "thr_test",
      projectId: "proj_test",
    });

    expect(introduction).toContain("You are working inside Omnyo");
    expect(introduction).toContain("agentic IDE");
    expect(introduction).toContain(
      "Reference an Omnyo thread as `@thread:thr_abc123`",
    );
    expect(introduction).toContain("Do not construct thread URLs manually");
    expect(introduction).toContain("`omnyo thread open <file.html>`");
    expect(introduction).toContain("`omnyo voice transcribe <path>`");
    expect(introduction).not.toContain(
      "Ask the user a blocking question only when",
    );
    expect(introduction).toBe(introduction?.trim());
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("keeps the introduction and skill switches independent across reloads", async () => {
  const { api, harness } = createFakePluginHost({
    pluginId: "omnyo-guide",
    agentSkillIds: bundledSkills,
  });

  try {
    await plugin(api);

    const instructions = () =>
      harness.registrations.instructionProvider?.({
        threadId: "thr_test",
        projectId: "proj_test",
      });

    const skills = async () =>
      (
        await harness.behavior.resolveAgentConfiguration(
          makePluginAgentConfigurationContext(),
        )
      ).skills;

    expect(instructions()).toContain("You are working inside Omnyo");
    expect((await skills()).sort()).toEqual([...bundledSkills].sort());
    await harness.behavior.setSettings({
      introduction: false,
      pluginAuthoring: false,
    });
    expect(instructions()).toBeNull();
    expect(await skills()).toEqual([
      "omnyo-cli",
      "skill-creator",
    ]);
    await harness.behavior.setSettings({ skills: false });
    expect(await skills()).toEqual([]);
    await harness.lifecycle.reload(plugin);
    expect(instructions()).toBeNull();
    expect(await skills()).toEqual([]);
    await harness.behavior.setSettings({ introduction: true, skills: true });
    expect(instructions()).toContain("omnyo status");
    expect(await skills()).toEqual([
      "omnyo-cli",
      "skill-creator",
    ]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

describe("individual skill selection", () => {
  it.each([
    ["omnyoCli", ["omnyo-plugin-authoring", "skill-creator"]],
    ["pluginAuthoring", ["omnyo-cli", "skill-creator"]],
    ["skillCreator", ["omnyo-cli", "omnyo-plugin-authoring"]],
  ])("disables %s", async (key, expected) => {
    const { api, harness } = createFakePluginHost({
      pluginId: "omnyo-guide",
      agentSkillIds: bundledSkills,
    });

    try {
      await plugin(api);
      await harness.behavior.setSettings({ [key]: false });
      expect(
        (
          await harness.behavior.resolveAgentConfiguration(
            makePluginAgentConfigurationContext(),
          )
        ).skills,
      ).toEqual(expected);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
