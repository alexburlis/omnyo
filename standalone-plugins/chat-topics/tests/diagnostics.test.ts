import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import plugin from "../server.ts";
import { z } from "zod";
import {
  layoutTraceSchema,
  storedLayoutTraceSchema,
  type LayoutTrace,
} from "../lib/diagnostics-contract.ts";

function trace(): LayoutTrace {
  return {
    v: 1,
    session: randomUUID(),
    asset: null,
    platform: "browser",
    chromeVersion: "152.0.0.0",
    electronVersion: null,
    startedAt: 1,
    samples: [
      {
        at: 1,
        reason: "hover",
        visibility: "visible",
        target: 1,
        hit: 1,
        scrollTop: 0,
        list: { width: 300, height: 700 },
        root: { top: 30, height: 900 },
        toolbar: { top: 0, height: 30 },
        rows: [
          {
            id: 1,
            top: 10,
            left: 0,
            width: 300,
            height: 30,
            offsetTop: 40,
            translate: [0, -30],
            transform: [1, 0, 0, 1, 0, 0],
            animations: [],
          },
        ],
      },
    ],
  };
}

describe("sidebar diagnostic boundary", () => {
  it("rejects content, identifying URLs and oversized captures", () => {
    const input = trace();
    assert.equal(layoutTraceSchema.safeParse(input).success, true);
    assert.equal(layoutTraceSchema.safeParse({ ...input, title: "private chat" }).success, false);
    assert.equal(
      layoutTraceSchema.safeParse({ ...input, asset: "https://private.test/?token=secret" })
        .success,
      false,
    );
    assert.equal(
      layoutTraceSchema.safeParse({ ...input, samples: Array(41).fill(input.samples[0]) }).success,
      false,
    );
    assert.equal(
      layoutTraceSchema.safeParse({
        ...input,
        samples: [{ ...input.samples[0], rows: Array(13).fill(input.samples[0].rows[0]) }],
      }).success,
      false,
    );
    assert.equal(
      layoutTraceSchema.safeParse({
        ...input,
        samples: [{ ...input.samples[0], title: "private" }],
      }).success,
      false,
    );
    assert.equal(
      layoutTraceSchema.safeParse({
        ...input,
        samples: [
          { ...input.samples[0], rows: [{ ...input.samples[0].rows[0], text: "private" }] },
        ],
      }).success,
      false,
    );
  });

  it("fits a maximum capture in one host KV value", async () => {
    const host = createFakePluginHost({ pluginId: "chat-topics" });

    try {
      await plugin(host.api);
      const input = trace();
      const sample = input.samples[0];
      sample.rows = Array.from({ length: 12 }, (_, index) => ({
        ...sample.rows[0],
        id: index + 1,
        animations: Array.from({ length: 3 }, () => ({
          state: "running" as const,
          time: 10_000_000,
        })),
      }));
      input.samples = Array.from({ length: 40 }, () => sample);
      await host.harness.callRpc("diagnostics.record", { trace: input });
      assert.ok(JSON.stringify({ receivedAt: Date.now(), trace: input }).length < 256 * 1024);
    } finally {
      await host.harness.dispose();
    }
  });

  it("keeps eight concurrent captures through RPC and reads the same data through the CLI", async () => {
    const host = createFakePluginHost({ pluginId: "chat-topics" });

    try {
      await plugin(host.api);
      const inputs = Array.from({ length: 12 }, () => trace());
      await Promise.all(
        inputs.map((input) => host.harness.callRpc("diagnostics.record", { trace: input })),
      );

      const output = z
        .object({ traces: z.array(storedLayoutTraceSchema) })
        .parse(await host.harness.callRpc("diagnostics.list", {}));

      assert.deepEqual(
        output.traces.map((item) => item.trace.session),
        inputs.slice(-8).map((item) => item.session),
      );
      const cli = await host.harness.runCli(["diagnostics", "--json"]);
      assert.equal(cli.exitCode, 0);
      assert.deepEqual(JSON.parse(cli.stdout), output);

      for (let index = 0; index < 8; index++) {
        const stored = storedLayoutTraceSchema.parse(
          await host.api.storage.kv.get(`layout-diagnostics:v1:${index}`),
        );

        assert.ok(output.traces.some((item) => item.trace.session === stored.trace.session));
      }
    } finally {
      await host.harness.dispose();
    }
  });
});
