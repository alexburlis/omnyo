import { cliCommand, defineCli } from "@omnyo/plugin-sdk";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { expect, it } from "vitest";
import { managedCliCommands } from "./managed-cli.js";
import { defaultManagedPolicy, type ManagedState } from "./managed-contract.js";
import type { ManagedService } from "./managed-service.js";

function fixture() {
  const host = createFakePluginHost({ pluginId: "storage-retention" });

  const state: ManagedState = {
    policy: defaultManagedPolicy,
    allocations: [],
    failures: [],
    preview: null,
  };

  const requests: unknown[] = [];

  const service: ManagedService = {
    state: async () => state,
    request: async (input) => {
      requests.push(input);

      return state;
    },
    owner: async () => {
      throw new Error("The CLI cannot call native owner operations.");
    },
    lifecycle: async () => state,
    reconcile: async () => state,
  };

  host.api.cli.register(
    defineCli({
      name: "storage",
      summary: "Storage",
      root: cliCommand({
        summary: "Help",
        run: ({ help }) => ({ exitCode: 0, stdout: help }),
      }),
      commands: managedCliCommands(service),
    }),
  );

  return { host, requests };
}

it("uses account administrative exact references while ignoring forwarded CLI thread identity for owner decisions", async () => {
  const f = fixture();
  const id = "d5d7fc72-16ef-40e3-89ae-283750283837";
  const snapshot = "a".repeat(64);

  const args = [
    "managed",
    "review",
    "--machine",
    "host_test",
    "--id",
    id,
    "--revision",
    "4",
    "--snapshot-digest",
    snapshot,
  ];

  try {
    expect((await f.host.harness.runCli(args)).exitCode).toBe(1);
    expect(f.requests).toEqual([]);
    expect(
      (
        await f.host.harness.runCli([...args, "--yes"], {
          threadId: "thr_spoofed",
        })
      ).exitCode,
    ).toBe(0);
    expect(f.requests).toEqual([
      {
        action: "review",
        hostId: "host_test",
        id,
        revision: 4,
        snapshotDigest: snapshot,
      },
    ]);
    expect(
      (await f.host.harness.runCli(["managed", "release", "--yes"])).exitCode,
    ).toBe(1);
    expect(
      (await f.host.harness.runCli(["managed", "allocate", "--yes"])).exitCode,
    ).toBe(1);
    expect(
      (await f.host.harness.runCli(["managed", "list", "--id", id])).exitCode,
    ).toBe(1);
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.host.harness.dispose();
  }
});

it("requires explicit confirmation and an exact digest for namespace reanchoring", async () => {
  const f = fixture();

  try {
    expect(
      (
        await f.host.harness.runCli([
          "managed",
          "namespace-preview",
          "--machine",
          "host_test",
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await f.host.harness.runCli([
          "managed",
          "namespace-reanchor",
          "--machine",
          "host_test",
          "--preview-digest",
          "a".repeat(64),
        ])
      ).exitCode,
    ).toBe(1);
    expect(
      (
        await f.host.harness.runCli([
          "managed",
          "namespace-reanchor",
          "--machine",
          "host_test",
          "--preview-digest",
          "a".repeat(64),
          "--yes",
        ])
      ).exitCode,
    ).toBe(0);
    expect(f.requests).toEqual([
      { action: "namespace-preview", hostId: "host_test" },
      {
        action: "namespace-reanchor",
        hostId: "host_test",
        previewDigest: "a".repeat(64),
      },
    ]);
  } finally {
    await f.host.harness.dispose();
  }
});

it("requires policy preview compare-and-set and accepts only exact bounded purge batches", async () => {
  const f = fixture();
  const preview = "b".repeat(64);

  try {
    expect(
      (
        await f.host.harness.runCli([
          "managed-policy",
          "--automatic-expiry",
          "true",
        ])
      ).exitCode,
    ).toBe(0);
    expect(f.requests[0]).toEqual({
      action: "policy-preview",
      policy: {
        mode: "review",
        automaticExpiry: true,
        quarantineBudgetBytes: defaultManagedPolicy.quarantineBudgetBytes,
      },
    });
    expect(
      (
        await f.host.harness.runCli([
          "managed-policy",
          "--automatic-expiry",
          "true",
          "--save",
          "--yes",
        ])
      ).exitCode,
    ).toBe(1);
    expect(
      (
        await f.host.harness.runCli([
          "managed-policy",
          "--automatic-expiry",
          "true",
          "--save",
          "--yes",
          "--expected-revision",
          "0",
          "--preview-digest",
          preview,
        ])
      ).exitCode,
    ).toBe(0);
    expect(f.requests[1]).toMatchObject({
      action: "configure",
      expectedRevision: 0,
      previewDigest: preview,
    });

    const items = [
      {
        hostId: "host_test",
        id: "d5d7fc72-16ef-40e3-89ae-283750283837",
        revision: 4,
        snapshotDigest: "a".repeat(64),
      },
    ];

    expect(
      (
        await f.host.harness.runCli([
          "managed",
          "purge-batch",
          "--items",
          JSON.stringify(items),
          "--preview-digest",
          preview,
          "--yes",
        ])
      ).exitCode,
    ).toBe(0);
    expect(f.requests[2]).toEqual({
      action: "purge-batch",
      items,
      previewDigest: preview,
    });
    expect(
      (
        await f.host.harness.runCli([
          "managed",
          "purge-batch",
          "--items",
          "[]",
          "--preview-digest",
          preview,
          "--yes",
        ])
      ).exitCode,
    ).toBe(1);
    expect(
      (await f.host.harness.runCli(["managed-policy", "--yes"])).exitCode,
    ).toBe(1);
    expect(
      (
        await f.host.harness.runCli([
          "managed",
          "purge-preview",
          "--items",
          "not-json",
        ])
      ).exitCode,
    ).toBe(1);
  } finally {
    await f.host.harness.dispose();
  }
});
