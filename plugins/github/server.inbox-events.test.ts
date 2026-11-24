import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import plugin from "./server";

const fake = vi.hoisted(() => ({
  calls: [] as string[][],
  states: new Map<string, string>(),
  signedIn: true,
}));

vi.mock("node:child_process", () => ({
  execFile(
    file: string,
    args: string[],
    _options: object,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) {
    if (file !== "gh") throw new Error(`Unexpected executable: ${file}`);
    fake.calls.push(args);

    if (args[0] === "auth") {
      if (fake.signedIn) callback(null, "Logged in to github.com", "");
      else
        callback(
          new Error("You are not logged into any GitHub hosts."),
          "",
          "",
        );

      return;
    }

    if (args[0] === "pr") {
      const state = fake.states.get(`${args[4]}#${args[2]}`);

      if (state === undefined)
        callback(
          new Error(
            "GraphQL: Could not resolve to a PullRequest with the number.",
          ),
          "",
          "",
        );
      else
        callback(
          null,
          JSON.stringify({ state, mergedAt: null, statusCheckRollup: [] }),
          "",
        );

      return;
    }

    callback(
      null,
      JSON.stringify({
        data: {
          repository: {
            hasIssuesEnabled: true,
            openIssues: { nodes: [] },
            closedIssues: { nodes: [] },
            openPrs: { nodes: [] },
            closedPrs: { nodes: [] },
          },
        },
      }),
      "",
    );
  },
}));

const hosts: ReturnType<typeof createFakePluginHost>[] = [];

beforeEach(() => {
  fake.calls = [];
  fake.states = new Map();
  fake.signedIn = true;
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

async function load() {
  const host = createFakePluginHost({
    pluginId: "github",
    sdk: { projects: { list: async () => [] } },
  });

  hosts.push(host);
  await plugin(host.api);

  return host.harness.registrations.eventSources;
}

const context = () => ({ signal: new AbortController().signal });

it("registers PR and checks sources that Omnyo polls every two minutes", async () => {
  const sources = await load();

  expect([...sources.keys()]).toEqual(["github-pr", "github-checks"]);

  const pr = sources.get("github-pr");

  expect(pr?.poll?.everyMs).toBe(120_000);
  expect(pr?.validate("example/omnyo#17")).toBeNull();
  expect(pr?.validate("omnyo#17")).toBe("expected <owner>/<repo>#<number>");
  expect(pr?.describe("example/omnyo#17")).toBe(
    "example/omnyo#17 merges or closes",
  );
});

it("fires merged PRs, omits open ones and reports missing ones as problems", async () => {
  const pr = (await load()).get("github-pr");

  fake.states.set("example/omnyo#17", "MERGED");
  fake.states.set("example/omnyo#18", "OPEN");

  await expect(
    pr?.poll?.check(
      ["example/omnyo#17", "example/omnyo#18", "example/omnyo#99"],
      context(),
    ),
  ).resolves.toEqual([
    {
      target: "example/omnyo#17",
      result: "example/omnyo#17 merged.",
    },
    {
      target: "example/omnyo#99",
      problem:
        "gh pr view 99 failed: GraphQL: Could not resolve to a PullRequest with the number.",
    },
  ]);
  expect(fake.calls.filter((args) => args[0] === "pr")[0]).toEqual([
    "pr",
    "view",
    "17",
    "--repo",
    "example/omnyo",
    "--json",
    "state,mergedAt,statusCheckRollup",
  ]);
});

it("proves gh sign-in before Omnyo polls", async () => {
  const pr = (await load()).get("github-pr");

  await expect(pr?.proof?.(context())).resolves.toBe(
    "gh is signed in to github.com",
  );
});
