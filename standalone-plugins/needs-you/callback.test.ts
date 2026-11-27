import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import plugin from "./server.js";

test("Needs You adopts legacy records once and owns no callback RPC or command", async (t) => {
  const { api, harness } = createFakePluginHost({
    pluginId: "needs-you",
    sdk: { experimental_attention: { adopt: async () => ({ imported: false }) } },
  });

  t.after(() => harness.lifecycle.dispose());
  await plugin(api);
  assert.deepEqual(harness.inspection.sdk.callsTo("experimental_attention.adopt"), [
    [{ pluginId: "needs-you" }],
  ]);
  await assert.rejects(harness.behavior.callRpc("callbacks.list", null), /no rpc method/);
});
