import { describe, expect, it } from "vitest";
import { defineCli, type PluginCliRegistration } from "@omnyo/plugin-sdk";
import { workflowCliCommands } from "./workflow-cli.js";
import type { WorkflowHandlers } from "./workflow-contract.js";

const unused = () => {
  throw new Error("Unexpected workflow action");
};

function registration(
  onList: WorkflowHandlers["workflow_list"] = () => [],
): PluginCliRegistration {
  const handlers: WorkflowHandlers = {
    workflow_options: unused,
    workflow_graphs: unused,
    workflow_artifacts: unused,
    workflow_compare: unused,
    workflow_revise: unused,
    workflow_inspect: unused,
    workflow_previous: unused,
    workflow_install: unused,
    workflow_list: onList,
    workflow_bind: unused,
    workflow_preview: unused,
    workflow_confirm: unused,
    workflow_enable: unused,
    workflow_run: unused,
    workflow_export: unused,
    workflow_export_automation: unused,
  };

  return defineCli({
    name: "automation",
    summary: "Inspect and manage automations",
    commands: workflowCliCommands(handlers),
  });
}

describe("portable workflow CLI", () => {
  it("uses the shared list handler with explicit project identity", async () => {
    const projects: string[] = [];

    const cli = registration((input) => {
      projects.push(input.projectId);

      return [];
    });

    expect(
      (
        await cli.run(
          ["workflow", "list", "--project", "project-fixture", "--json"],
          {},
        )
      ).exitCode,
    ).toBe(0);
    expect(projects).toEqual(["project-fixture"]);
    expect(
      (await cli.run(["workflow", "list"], { projectId: "implicit" })).exitCode,
    ).toBe(1);
  });
  it("requires exactly one import source and supports the client stdin marker", async () => {
    const cli = registration();
    expect((await cli.run(["workflow", "inspect"], {})).exitCode).toBe(1);
    expect(
      (
        await cli.run(
          ["workflow", "inspect", "--text", "{}", "--share-id", "a".repeat(32)],
          {},
        )
      ).exitCode,
    ).toBe(1);
    const marker = await cli.run(["workflow", "inspect", "--text-stdin"], {});
    expect(marker.exitCode).toBe(1);
    expect(marker.stderr).toContain("read by the omnyo CLI");
  });
  it("does not advertise or run commands that create workflow links", async () => {
    const cli = registration();

    for (const command of ["share", "manage"]) {
      const result = await cli.run(["workflow", command, "--json"], {});
      expect(result.exitCode).toBe(1);
      expect(result.stdout ?? "").not.toContain("/dashboard/workflows");
    }
  });
});
