import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { renderTemplate } from "@omnyo/templates";
import { registerMarketplaceCommands } from "../commands/marketplace.js";
import { registerPluginCommands } from "../commands/plugin.js";

function buildGroupCommand(name: "plugin" | "marketplace"): Command {
  const program = new Command();
  registerPluginCommands(program, () => "http://localhost");
  registerMarketplaceCommands(program, () => "http://localhost");
  const group = program.commands.find((command) => command.name() === name);
  expect(group).toBeDefined();

  if (group === undefined) throw new Error(`missing "${name}" command group`);

  return group;
}

function buildPluginCommand(): Command {
  return buildGroupCommand("plugin");
}

describe("plugins guide chapter", () => {
  it("mentions every omnyo plugin subcommand", () => {
    const plugin = buildPluginCommand();
    const names = plugin.commands.map((command) => command.name());
    expect(names.length).toBeGreaterThan(0);

    const guide = renderTemplate("omnyoGuidePlugins", {});

    for (const name of names) {
      const pattern = new RegExp(`omnyo plugin (?:[a-z-]+\\|)*${name}\\b`);
      expect(
        guide,
        `"omnyo plugin ${name}" is not documented in omnyo-guide-plugins.md`,
      ).toMatch(pattern);
    }
  });

  it("mentions every declared omnyo plugin option flag", () => {
    const plugin = buildPluginCommand();
    const guide = renderTemplate("omnyoGuidePlugins", {});
    let optionCount = 0;

    for (const command of plugin.commands) {
      for (const option of command.options) {
        optionCount += 1;

        const forms = [option.long, option.short].filter(
          (form): form is string => typeof form === "string",
        );

        expect(forms.length).toBeGreaterThan(0);
        expect(
          forms.some((form) => guide.includes(form)),
          `"omnyo plugin ${command.name()}" flag "${option.flags}" is not documented in omnyo-guide-plugins.md`,
        ).toBe(true);
      }
    }

    expect(optionCount).toBeGreaterThan(0);
  });

  it("mentions every omnyo marketplace subcommand", () => {
    const marketplace = buildGroupCommand("marketplace");
    const names = marketplace.commands.map((command) => command.name());
    expect(names.length).toBeGreaterThan(0);

    const guide = renderTemplate("omnyoGuidePlugins", {});

    for (const name of names) {
      expect(
        guide,
        `"omnyo marketplace ${name}" is not documented in omnyo-guide-plugins.md`,
      ).toMatch(new RegExp(`omnyo marketplace ${name}\\b`));
    }
  });
});
