import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { createSentryPlugin } from "../server";
import { completionSchema } from "../contract";
import { SentryStore } from "../src/store";
import { incident, route, sentryIssue } from "./fixtures";

const head = "a".repeat(40);

const release = "app@2.0.0";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function fixture(targetRelease = release) {
  let status = "unresolved";
  let holdUntil: string | null = null;
  let source: string | null = null;
  let environment = "staging";
  const writes: unknown[] = [];

  const host = createFakePluginHost({
    pluginId: "sentry",
    settings: { apiToken: "fixture-token" },
  });

  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);

    if (path.endsWith("/events/")) {
      expect(url.searchParams.get("project")).toBe("100");
      expect(url.searchParams.get("environment")).toBe("production");
      expect(url.searchParams.get("query")).toBe("release:" + JSON.stringify(targetRelease));

      return Response.json({
        data: source ? [{ release: "example@" + source, environment }] : [],
      });
    }

    if (path.endsWith("/deploys/"))
      return Response.json([{ environment, dateFinished: "2026-10-18T09:00:00Z" }]);

    if (path.endsWith("/releases/" + release + "/"))
      return source
        ? Response.json({
            version: release,
            projects: [{ id: "100" }],
            lastCommit: { id: source, repository: { name: "fixture/example" } },
          })
        : new Response(null, { status: 404 });

    if (path.endsWith("/issues/101/")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        status = body.status;
        holdUntil = body.ignoreDuration
          ? new Date(Date.now() + body.ignoreDuration * 60000).toISOString()
          : null;
      }

      return Response.json({
        ...sentryIssue("101"),
        status,
        statusDetails: holdUntil ? { ignoreUntil: holdUntil } : {},
      });
    }

    throw new Error("Unexpected fixture request");
  };

  await createSentryPlugin(transport)(host.api);
  disposers.push(() => host.harness.lifecycle.dispose());
  const store = new SentryStore(host.api.storage);
  const target = store.saveRoute({ ...route(), githubRepository: "fixture/example" });
  const issue = incident();
  const run = store.enqueue(issue, target, true, true);
  store.bindThread(run.id, "thr_logging", "env_logging");
  store.updateRun(run.id, {
    state: "local-ready",
    result: completionSchema.parse({
      outcome: "fix-ready",
      classification: "Reproduced",
      summary: "Verified missing logging",
      rootCause: "The original failure cause is unknown",
      commit: head,
      changedFiles: ["capture.test.ts"],
      reproduction: {
        command: "node --test",
        before: "Missing failure phase",
        after: "Failure phase present in the emitted diagnostic",
        evidence: ["capture.test.ts"],
      },
      issueFindings: [
        {
          key: issue.key,
          outcome: "blocked",
          summary: "The failure remains under investigation",
          evidence: ["capture.test.ts"],
          diagnosticsRelease: targetRelease,
        },
      ],
    }),
    verification: {
      head,
      tree: "b".repeat(40),
      changedFiles: ["capture.test.ts"],
      checks: target.checks.map(({ name }) => ({ name, exitCode: 0, durationMs: 1, output: "" })),
    },
  });

  const wait = () =>
    host.harness.behavior.callAgentTool(
      "sentry_wait_for_diagnostics_release",
      { issueKey: issue.key },
      { threadId: "thr_logging", projectId: target.projectId },
    );

  const reconcile = () => host.harness.behavior.runSchedule("sync");

  return {
    ...host,
    store,
    run,
    issue,
    wait,
    reconcile,
    writes,
    publish: (commit: string, env: string) => {
      source = commit;
      environment = env;
    },
    replaceArchive: () => {
      status = "ignored";
      holdUntil = null;
    },
  };
}

it("only resumes an owned diagnostics pause after the exact source and environment deploy", async () => {
  const f = await fixture();
  expect(JSON.parse(String(await f.wait()))).toMatchObject({ state: "paused" });
  await f.wait();
  f.publish("c".repeat(40), "production");
  await f.reconcile();
  f.publish(head, "staging");
  await f.reconcile();
  expect(f.writes).toEqual([{ status: "ignored", ignoreDuration: expect.any(Number) }]);
  f.publish(head, "production");
  await f.reconcile();
  expect(f.writes.at(-1)).toEqual({ status: "unresolved" });
  expect(f.store.getRun(f.run.id).result?.issueFindings?.[0]?.outcome).toBe("blocked");
});

it("requires verification before pausing and preserves someone else's archive", async () => {
  const f = await fixture();
  const { verification } = f.store.getRun(f.run.id);
  f.store.updateRun(f.run.id, { verification: null });
  await expect(f.wait()).rejects.toThrow(/verif/i);
  expect(f.writes).toEqual([]);
  f.store.updateRun(f.run.id, { verification });
  await f.wait();
  f.replaceArchive();
  f.publish(head, "production");
  await f.reconcile();
  expect(f.writes).toHaveLength(1);
});

it("does not pause for an existing release with unconfirmed source or already-shipped diagnostics", async () => {
  const f = await fixture();
  f.publish("c".repeat(40), "production");
  expect(JSON.parse(String(await f.wait()))).toMatchObject({
    state: "pending",
    reason: expect.stringMatching(/exact project and commit/i),
  });
  f.publish(head, "production");
  await f.reconcile();
  expect(f.store.diagnosticsHold(f.issue.key)).toMatchObject({ state: "resumed" });
  expect(f.writes).toEqual([]);
});

it("uses exact project and environment telemetry for commit-addressed releases", async () => {
  const f = await fixture("example@" + head);
  expect(JSON.parse(String(await f.wait()))).toMatchObject({ state: "paused" });
  f.publish(head, "staging");
  await f.reconcile();
  f.publish("c".repeat(40), "production");
  await f.reconcile();
  expect(f.writes).toHaveLength(1);
  f.publish(head, "production");
  await f.reconcile();
  expect(f.writes.at(-1)).toEqual({ status: "unresolved" });
});
