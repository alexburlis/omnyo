import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import plugin from "../server";
import { discoveryContract } from "../host-contract";
import { createFakePluginHost, installFakeGh } from "../testing/fake-gh";

const head = "a".repeat(40);

it("checks current GitHub permissions, preserves merge rules, and binds a merge to the reviewed head", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-actions-"));
  const fixture = join(scratch, "repository.json");
  const requests = join(scratch, "writes.jsonl");

  const repository = {
    viewerPermission: "READ",
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: false,
    item: {
      state: "OPEN",
      viewerCanClose: false,
      viewerCanReopen: false,
      headRefOid: head,
      isDraft: false,
      mergeStateStatus: "CLEAN",
    },
  };

  let merged = true;
  const save = () => writeFileSync(fixture, JSON.stringify({ data: { repository }, merged }));
  save();
  writeFileSync(requests, "");

  const restore = installFakeGh(
    scratch,
    `
    if (args[0] === "api" && args[1] === "graphql") out(fs.readFileSync(${JSON.stringify(fixture)}, "utf8"));
    else if (args[0] !== "--version" && args[0] !== "auth") {
      fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + "\\n");
      out(JSON.stringify({ merged: JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, "utf8")).merged }));
    }
  `,
  );

  const { api, harness } = createFakePluginHost({
    sdk: {
      projects: { list: async () => [] },
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
    },
  });

  try {
    await plugin(api);
    expect(
      await harness.behavior.callRpc("itemActions", {
        kind: "pr",
        repo: "acme/widgets",
        number: 7,
      }),
    ).toMatchObject({ canClose: false, canMerge: false });
    await expect(
      harness.behavior.callRpc("setIssueState", {
        repo: "acme/widgets",
        number: 7,
        state: "closed",
      }),
    ).rejects.toThrow("permission");
    await expect(
      harness.behavior.callRpc("mergePull", {
        repo: "acme/widgets",
        number: 7,
        method: "squash",
        headOid: head,
      }),
    ).rejects.toThrow("permission");
    expect(readFileSync(requests, "utf8")).toBe("");

    repository.viewerPermission = "WRITE";
    repository.item.viewerCanClose = true;
    save();
    expect(
      await harness.behavior.callRpc("setIssueState", {
        repo: "acme/widgets",
        number: 7,
        state: "closed",
      }),
    ).toEqual({ ok: true });
    expect(
      await harness.behavior.callRpc("setPullState", {
        repo: "acme/widgets",
        number: 7,
        state: "closed",
      }),
    ).toEqual({ ok: true });
    repository.item.state = "CLOSED";
    repository.item.viewerCanReopen = true;
    save();
    expect(
      await harness.behavior.callRpc("setPullState", {
        repo: "acme/widgets",
        number: 7,
        state: "open",
      }),
    ).toEqual({ ok: true });
    writeFileSync(requests, "");
    repository.item.state = "OPEN";
    repository.item.mergeStateStatus = "BLOCKED";
    save();
    await expect(
      harness.behavior.callRpc("mergePull", {
        repo: "acme/widgets",
        number: 7,
        method: "squash",
        headOid: head,
      }),
    ).rejects.toThrow("requirements");
    repository.item.mergeStateStatus = "CLEAN";
    save();
    await expect(
      harness.behavior.callRpc("mergePull", {
        repo: "acme/widgets",
        number: 7,
        method: "squash",
        headOid: "b".repeat(40),
      }),
    ).rejects.toThrow("changed");
    await expect(
      harness.behavior.callRpc("mergePull", {
        repo: "acme/widgets",
        number: 7,
        method: "rebase",
        headOid: head,
      }),
    ).rejects.toThrow("method");
    expect(readFileSync(requests, "utf8")).toBe("");
    expect(
      await harness.behavior.callRpc("mergePull", {
        repo: "acme/widgets",
        number: 7,
        method: "squash",
        headOid: head,
      }),
    ).toEqual({ ok: true });
    expect(
      readFileSync(requests, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      [
        "api",
        "--method",
        "PUT",
        "repos/acme/widgets/pulls/7/merge",
        "-f",
        `sha=${head}`,
        "-f",
        "merge_method=squash",
      ],
    ]);
    const signalCount = harness.inspection.realtimeSignals.length;
    merged = false;
    save();
    await expect(
      harness.behavior.callRpc("mergePull", {
        repo: "acme/widgets",
        number: 7,
        method: "squash",
        headOid: head,
      }),
    ).rejects.toThrow("did not merge");
    expect(harness.inspection.realtimeSignals).toHaveLength(signalCount);
  } finally {
    await harness.lifecycle.dispose();
    restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

it.each([
  [
    "api",
    "--method",
    "POST",
    "repos/acme/widgets/pulls/7/merge",
    "-f",
    `sha=${head}`,
    "-f",
    "merge_method=squash",
  ],
  [
    "api",
    "--method",
    "PUT",
    "repos/acme/widgets/pulls/7/merge",
    "-f",
    "sha=anything",
    "-f",
    "merge_method=squash",
  ],
  [
    "api",
    "--method",
    "PUT",
    "repos/acme/widgets/issues/7",
    "-f",
    `sha=${head}`,
    "-f",
    "merge_method=squash",
  ],
  ["pr", "merge", "7", "-R", "acme/widgets", "--admin"],
])("rejects unsupported merge capabilities %j", (...args) => {
  expect(() => discoveryContract.gh.input.parse({ args, timeoutMs: 1000 })).toThrow(
    "Unsupported GitHub capability",
  );
});
