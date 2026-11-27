import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { registerStateMachineCli } from "../src/cli.js";
import { stateMachinesRpc } from "../src/contracts/rpc.js";
import type { JsonObject } from "../src/contracts/definition.js";
import { createEmptyDraft } from "../src/definition/draft.js";

const failure = { ok: false, error: { code: "NOT_FOUND", message: "Exact run not found." } };

const controls = ["pause", "pause-after-step", "resume", "stop"];

describe("State Machines CLI transport", () => {
  it("forwards each run control with the exact control revision and stable request ID", async () => {
    const calls: JsonObject[] = [];

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        plugins: {
          callRpc(input) {
            expect(input.pluginId).toBe("state-machines");
            expect(input.method).toBe("sm_instance_control");
            const validated = stateMachinesRpc.sm_instance_control.input.parse(input.input);
            calls.push(validated);

            return failure;
          },
        },
      },
    });

    registerStateMachineCli(host.api);

    for (const operation of controls) {
      const result = await host.harness.behavior.runCli([
        operation,
        "ins_current",
        "--expected-revision",
        "7",
        "--request-id",
        `request-${operation}`,
        "--json",
      ]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual(failure);
    }

    expect(calls).toEqual(
      controls.map((kind) => ({
        instanceId: "ins_current",
        expectedControlRevision: 7,
        operation: { kind },
        requestId: `request-${kind}`,
      })),
    );
  });

  it("preserves all signal correlation fields and parses the payload before RPC", async () => {
    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        plugins: {
          callRpc(input) {
            expect(input.method).toBe("sm_instance_signal");
            expect(stateMachinesRpc.sm_instance_signal.input.parse(input.input)).toEqual({
              instanceId: "ins_current",
              entryId: "ent_current",
              subscriptionId: "sub_current",
              epoch: 3,
              sourceId: "git-main",
              eventId: "commit-abc",
              subject: "abc",
              eventType: "commit.available",
              payload: { sha: "abc", ready: true },
              requestId: "request-signal",
            });

            return { ok: true, value: { eventId: "evt_accepted" } };
          },
        },
      },
    });

    registerStateMachineCli(host.api);

    const result = await host.harness.behavior.runCli([
      "signal",
      "ins_current",
      "--entry",
      "ent_current",
      "--subscription",
      "sub_current",
      "--epoch",
      "3",
      "--source",
      "git-main",
      "--event-id",
      "commit-abc",
      "--subject",
      "abc",
      "--type",
      "commit.available",
      "--payload",
      '{"sha":"abc","ready":true}',
      "--request-id",
      "request-signal",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, value: { eventId: "evt_accepted" } });
    expect(host.harness.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
  });

  it("round-trips canonical export through import without coordinator file access", async () => {
    const draft = createEmptyDraft({ machineId: "mch_current", name: "Check loop" });
    const seen: string[] = [];

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        plugins: {
          callRpc(input) {
            seen.push(input.method);

            if (input.method === "sm_machine_export") {
              expect(stateMachinesRpc.sm_machine_export.input.parse(input.input)).toEqual({
                machineId: "mch_current",
              });

              return { ok: true, value: { definition: draft } };
            }

            expect(input.method).toBe("sm_machine_draft_save");
            expect(stateMachinesRpc.sm_machine_draft_save.input.parse(input.input)).toEqual({
              machineId: "mch_current",
              document: draft,
              expectedRevision: 4,
              requestId: "request-import",
            });

            return failure;
          },
        },
      },
    });

    registerStateMachineCli(host.api);
    const exported = await host.harness.behavior.runCli(["export", "--machine", "mch_current"]);
    expect(exported.exitCode).toBe(0);
    expect(JSON.parse(exported.stdout)).toEqual(draft);
    expect(exported.stdout.trim().split("\n")).toHaveLength(1);

    const imported = await host.harness.behavior.runCli([
      "import",
      "--machine",
      "mch_current",
      "--document",
      exported.stdout.trim(),
      "--expected-revision",
      "4",
      "--request-id",
      "request-import",
      "--json",
    ]);

    expect(imported.exitCode).toBe(1);
    expect(seen).toEqual(["sm_machine_export", "sm_machine_draft_save"]);
    expect(host.harness.sdk.calls).toHaveLength(2);
  });

  it("keeps invocation, entry and instance revisions on uncertainty controls", async () => {
    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        plugins: {
          callRpc(input) {
            expect(stateMachinesRpc.sm_instance_control.input.parse(input.input)).toEqual({
              instanceId: "ins_current",
              expectedControlRevision: 5,
              operation: {
                kind: "mark-unknown",
                invocationId: "inv_current",
                entryId: "ent_current",
                expectedRevision: 8,
                reason: "Host unreachable",
                evidence: "The exact host receipt is unavailable.",
                acknowledged: true,
              },
              requestId: "request-unknown",
            });

            return { ok: false, error: { code: "STOP_PENDING", message: "The step is live." } };
          },
        },
      },
    });

    registerStateMachineCli(host.api);

    const result = await host.harness.behavior.runCli([
      "mark-unknown",
      "ins_current",
      "--invocation",
      "inv_current",
      "--entry",
      "ent_current",
      "--expected-revision",
      "5",
      "--instance-revision",
      "8",
      "--reason",
      "Host unreachable",
      "--evidence",
      "The exact host receipt is unavailable.",
      "--request-id",
      "request-unknown",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("STOP_PENDING");
    expect(JSON.parse(result.stdout).error.code).toBe("STOP_PENDING");
  });

  it.each([
    ["history", "ins_current", "--after", "42", "--limit", "9", "--json"],
    ["state-history", "ins_current", "--after", "42", "--limit", "9", "--json"],
    ["logs", "inv_current", "--cursor", "42", "--limit", "9", "--json"],
    [
      "instances",
      "--project",
      "project",
      "--status",
      "paused",
      "--cursor",
      "ins_before",
      "--limit",
      "9",
      "--json",
    ],
  ])("passes page cursors and filters through shared RPC validation: %s", async (...argv) => {
    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        plugins: {
          callRpc(input) {
            const declaration = Object.entries(stateMachinesRpc).find(
              ([name]) => name === input.method,
            )?.[1];

            expect(declaration).toBeDefined();
            expect(declaration?.input.safeParse(input.input).success).toBe(true);

            return failure;
          },
        },
      },
    });

    registerStateMachineCli(host.api);
    const result = await host.harness.behavior.runCli(argv);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(failure);
    expect(host.harness.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
  });

  it.each([
    [
      "start",
      "--machine",
      "mch",
      "--version",
      "ver",
      "--environment",
      "env",
      "--context",
      "[]",
      "--request-id",
      "req",
      "--json",
    ],
    [
      "import",
      "--machine",
      "mch",
      "--expected-revision",
      "0",
      "--request-id",
      "req",
      "--document",
      "{bad}",
      "--json",
    ],
    [
      "start",
      "--machine",
      "mch",
      "--version",
      "ver",
      "--environment",
      "env",
      "--context",
      '{"__proto__":{}}',
      "--request-id",
      "req",
      "--json",
    ],
    ["pause", "ins", "--expected-revision", "-1", "--request-id", "req", "--json"],
    ["pause", "ins", "--expected-revision", "1", "--json"],
    ["logs", "inv", "--limit", "32769", "--json"],
    ["import", "--machine", "mch", "--file", "/invoking-machine/private.json", "--json"],
  ])("rejects invalid transport input without RPC work: %s", async (...argv) => {
    const host = createFakePluginHost({ pluginId: "state-machines" });
    registerStateMachineCli(host.api);
    const result = await host.harness.behavior.runCli(argv);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
    expect(host.harness.sdk.calls).toHaveLength(0);
  });

  it("bounds UTF-8 input before parsing or transport and does not echo its content", async () => {
    const host = createFakePluginHost({ pluginId: "state-machines" });
    registerStateMachineCli(host.api);

    const result = await host.harness.behavior.runCli([
      "import",
      "--machine",
      "mch",
      "--expected-revision",
      "0",
      "--request-id",
      "req",
      "--document",
      JSON.stringify({ name: "é".repeat(140_000) }),
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("OUTPUT_LIMIT");
    expect(result.stdout).not.toContain("é");
    expect(host.harness.sdk.calls).toHaveLength(0);
  });

  it.each(["disconnect", "invalid-output"])(
    "reports a stable safe failure without retrying an unavailable RPC: %s",
    async (mode) => {
      const host = createFakePluginHost({
        pluginId: "state-machines",
        sdk: {
          plugins: {
            callRpc() {
              if (mode === "disconnect") throw new Error("private transport diagnostics");

              return { unexpected: "private transport diagnostics" };
            },
          },
        },
      });

      registerStateMachineCli(host.api);
      const result = await host.harness.behavior.runCli(["list", "--json"]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("CAPABILITY_UNAVAILABLE");
      expect(result.stdout + result.stderr).not.toContain("private transport diagnostics");
      expect(host.harness.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    },
  );

  it("renders discoverable help and stdin limits without performing any SDK work", async () => {
    const host = createFakePluginHost({ pluginId: "state-machines" });
    registerStateMachineCli(host.api);
    const top = await host.harness.behavior.runCli(["--help"]);
    const command = await host.harness.behavior.runCli(["import", "--help"]);
    expect(top.exitCode).toBe(0);
    expect(top.stdout).toContain("pause-after-step");
    expect(command.stdout).toContain("--document-stdin");
    expect(command.stdout).toContain("16 KiB");
    expect(host.harness.sdk.calls).toHaveLength(0);
  });
});
