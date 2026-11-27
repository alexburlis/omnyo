import { afterEach, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import plugin from "../server.js";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

it("loads through the public plugin host and restricts a worker to its result tool", async () => {
  const host = createFakePluginHost({
    pluginId: "state-machines",
    agentSkillIds: ["state-machines"],
  });

  hosts.push(host);
  await plugin(host.api);

  const worker = await host.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      pluginMetadata: {
        stateMachineWorker: 1,
        instanceId: "ins_test",
        entryId: "ent_test",
        invocationId: "inv_test",
        attemptId: "try_test",
        generation: 1,
        specHash: "a".repeat(64),
      },
    }),
  );

  expect(worker.tools.map((tool) => tool.name)).toEqual(["omnyo_state_machine_result"]);
  expect(worker.skills).toEqual([]);
  await expect(
    host.harness.behavior.callAgentTool(
      "omnyo_state_machine_result",
      JSON.parse('{"outcome":"ok","payload":{"__proto__":{"x":1}}}'),
    ),
  ).rejects.toThrow("Expected a JSON object");
});
