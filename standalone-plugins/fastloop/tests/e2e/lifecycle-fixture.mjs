import { createServer } from "node:http";
import { mkdir, chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const [
  packageRoot,
  projectRoot,
  ownerOutput,
  selectedPort = "0",
  scenario = "before-save",
  explicitDataRoot,
] = process.argv.slice(2);

if (!packageRoot || !projectRoot || !ownerOutput)
  throw new Error("Explicit sealed package root, fixture project and owner output are required.");

const load = (path) => import(pathToFileURL(join(packageRoot, "dist/src", path)).href);

const [
  { fastLoopConfigSchema, hashChecks, hashRequirements },
  { AgentBrowserDriver },
  { Journal },
  { ProjectCoordinator },
  { resolveProjectDiscovery, claimCoordinator },
  { policyFingerprint },
  { runtimeIdentity },
  { startIpcServer },
] = await Promise.all([
  load("config.js"),
  load("driver/agent-browser.js"),
  load("evidence/journal.js"),
  load("service/project.js"),
  load("service/discovery.js"),
  load("service/client.js"),
  load("service/identity.js"),
  load("service/ipc.js"),
]);

let typedValue = "Original";

let typedUpdates = 0;

let saves = 0;

let plans = 0;

let coordinator;

let journal;

let ipc;

let lease;

let closing;

const typedWaiters = new Set();

const saveWaiters = new Set();

const app = createServer(async (request, response) => {
  if (request.url === "/await-saved") {
    if (saves) {
      response.end(JSON.stringify({ typedValue, typedUpdates, saves }));

      return;
    }

    const timer = setTimeout(() => {
      saveWaiters.delete(done);
      response.writeHead(408);
      response.end("save effect not observed");
    }, 8000);

    const done = () => {
      clearTimeout(timer);
      saveWaiters.delete(done);
      response.end(JSON.stringify({ typedValue, typedUpdates, saves }));
    };

    saveWaiters.add(done);

    return;
  }

  if (request.url === "/await-typed") {
    if (typedValue === "PendingEdit") {
      response.end(JSON.stringify({ typedValue, typedUpdates, saves }));

      return;
    }

    const timer = setTimeout(() => {
      typedWaiters.delete(done);
      response.writeHead(408);
      response.end("typed effect not observed");
    }, 8000);

    const done = () => {
      clearTimeout(timer);
      typedWaiters.delete(done);
      response.end(JSON.stringify({ typedValue, typedUpdates, saves }));
    };

    typedWaiters.add(done);

    return;
  }

  if (request.url?.startsWith("/await-terminal?")) {
    const runId = new URL(request.url, "http://fixture").searchParams.get("runId");
    const owner = journal.owner(runId);
    let after = 0;
    const deadline = performance.now() + 8000;

    while (performance.now() < deadline) {
      const batch = await coordinator.events(owner.clientScope, runId, after, 1000);
      after = batch.nextSequence;

      if (["completed", "cancelled", "interrupted"].includes(batch.job.state)) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(batch.job));

        return;
      }
    }

    response.writeHead(408);
    response.end("terminal state not observed");

    return;
  }

  if (request.url === "/truth") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ typedValue, typedUpdates, saves, plans }));

    return;
  }

  if (request.url?.startsWith("/actions?")) {
    const runId = new URL(request.url, "http://fixture").searchParams.get("runId");
    const db = new DatabaseSync(join(discovery.dataRoot, "journal.sqlite"), { readOnly: true });

    try {
      const actions = db
        .prepare(
          "SELECT id,phase,operation_json,receipt_json,plan_node_id FROM actions WHERE run_id=? ORDER BY rowid",
        )
        .all(runId)
        .map((row) => ({
          id: row.id,
          phase: row.phase,
          kind: JSON.parse(row.operation_json).kind,
          planNodeId: row.plan_node_id,
          receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
        }));

      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ actions }));
    } finally {
      db.close();
    }

    return;
  }

  if (request.method === "POST" && request.url === "/typed") {
    const chunks = [];

    for await (const chunk of request) chunks.push(chunk);
    typedValue = JSON.parse(Buffer.concat(chunks).toString()).value;
    typedUpdates++;

    if (typedValue === "PendingEdit") for (const done of typedWaiters) done();
    response.end("ok");

    return;
  }

  if (request.method === "POST" && request.url === "/save") {
    saves++;

    for (const done of saveWaiters) done();
    response.end(scenario === "after-submit" ? "Submitted" : "Saved");

    return;
  }

  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    `<!doctype html><title>FastLoop Stop fixture</title><label>Display name<input aria-label="Display name" value="Original" oninput="fetch('/typed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:this.value})})"></label><button onclick="fetch('/save',{method:'POST'}).then(r=>r.text()).then(t=>document.querySelector('[role=status]').textContent=t)">Save</button><div role="status">Waiting for approval</div>`,
  );
});

await new Promise((resolve) => app.listen(Number(selectedPort), "127.0.0.1", resolve));

const url = `http://127.0.0.1:${app.address().port}`;

const config = fastLoopConfigSchema.parse({
  allowedOrigins: [url],
  mutationOrigins: [url],
  allowOpenAIText: true,
  actionTimeoutMs: 1000,
  navigationTimeoutMs: 3000,
  defaultCheckTimeoutMs: 500,
  budget: {
    wallMs: 30000,
    maxActions: 4,
    maxDecisionsRequests: 0,
    maxResponsesRequests: 1,
    maxVisualReviews: 0,
    maxObservationBytes: 524288,
  },
});

await mkdir(join(projectRoot, ".fastloop"), { recursive: true, mode: 0o700 });

await chmod(join(projectRoot, ".fastloop"), 0o700);

await writeFile(join(projectRoot, ".fastloop/config.json"), JSON.stringify(config));

const discoveryOptions = { projectRoot, policyHash: policyFingerprint(config) };

if (explicitDataRoot) discoveryOptions.dataRoot = explicitDataRoot;

const discovery = await resolveProjectDiscovery(discoveryOptions);

journal = new Journal(join(discovery.dataRoot, "journal.sqlite"));

const identity = await runtimeIdentity();

lease = claimCoordinator({
  discovery,
  packageVersion: identity.packageVersion,
  compatibilityLockHash: identity.compatibilityLockHash,
  runtimeDigest: identity.runtimeDigest,
  withOwnershipLock: (action) => journal.withCoordinatorLock(action),
});

const close = () =>
  (closing ??= (async () => {
    clearTimeout(deadline);
    await coordinator?.close();
    await ipc?.close();
    lease?.close();
    journal?.close();
    await new Promise((resolve) => app.close(resolve));
    process.stdout.write(
      JSON.stringify({ closed: true, plans, providerCalls: 0, typedValue, typedUpdates, saves }) +
        "\n",
    );
  })());

coordinator = new ProjectCoordinator({
  projectRoot: discovery.projectRoot,
  dataRoot: discovery.dataRoot,
  config,
  journal,
  coordinatorId: lease.record.coordinatorId,
  compatibilityLockHash: identity.compatibilityLockHash,
  runtimeDigest: identity.runtimeDigest,
  packageVersion: identity.packageVersion,
  capabilities: {
    nativeDelta: true,
    screenshots: true,
    diagnostics: true,
    upload: false,
    frames: false,
    nativeTrace: false,
  },
  onIdle() {},
  makeSessionDriver: (runId, sessionId, artifactStore, effectiveConfig = config) =>
    new AgentBrowserDriver({
      config: effectiveConfig,
      runId,
      sessionId,
      artifactStore,
      dataRoot: discovery.dataRoot,
      projectRoot: discovery.projectRoot,
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    }),
  makeModels: () => ({
    planner: {
      async plan(request) {
        plans++;
        const requirements = request.requirements ?? [];

        if (requirements.length !== 1 || requirements[0].id !== "stop-proof")
          throw new Error("FIXTURE_REQUIREMENT_SCOPE_INVALID");
        const target = { role: "textbox", name: "Display name", exact: true, interaction: "form" };
        const status = { role: "status", exact: true, interaction: "pointer" };

        const checks = [
          {
            id: "saved",
            requirementId: "stop-proof",
            predicate: { kind: "text", target: status, equals: "Saved" },
            timeoutMs: 500,
            required: true,
            evidence: ["state"],
          },
        ];

        const fill = {
          id: "fill-name",
          kind: "act",
          op: { kind: "fill", target, value: { kind: "literal", value: "PendingEdit" } },
        };

        const save = {
          id: "save",
          kind: "act",
          op: {
            kind: "click",
            target: { role: "button", name: "Save", exact: true, interaction: "pointer" },
          },
        };

        const wait = {
          id: "wait-for-acknowledgment",
          kind: "wait",
          predicate: {
            kind: "text",
            target: status,
            equals: scenario === "after-submit" ? "Saved" : "Approved",
          },
          timeoutMs: 10000,
        };

        const assertion = { id: "assert-saved", kind: "assert", checkId: "saved" };

        return {
          checks,
          plan: {
            version: 1,
            id: "stop-proof",
            requirementsHash: hashRequirements(requirements),
            checksHash: hashChecks(checks),
            variables: {},
            nodes:
              scenario === "after-submit"
                ? [fill, save, wait, assertion]
                : [fill, wait, save, assertion],
          },
        };
      },
      async repair() {
        throw new Error("UNEXPECTED_FIXTURE_REPAIR");
      },
    },
    decisionProvider: {
      async choose() {
        throw new Error("UNEXPECTED_FIXTURE_CHOICE");
      },
    },
  }),
});

ipc = await startIpcServer({
  socketPath: discovery.socketPath,
  nonce: lease.record.nonce,
  coordinatorId: lease.record.coordinatorId,
  requestTimeoutMs: 140000,
  handler: (request) => coordinator.handle(request),
});

lease.publish();

const owner = {
  surface:
    "authored planner fixture with real packaged engine/driver; no natural-language or provider qualification",
  pid: process.pid,
  projectRoot: discovery.projectRoot,
  dataRoot: discovery.dataRoot,
  url,
  runtimeDigest: identity.runtimeDigest,
  packageRoot: resolve(packageRoot),
  providerCalls: 0,
};

await writeFile(ownerOutput, JSON.stringify(owner));

process.stdout.write(JSON.stringify({ ...owner, ready: true }) + "\n");

const deadline = setTimeout(() => {
  void close();
}, 120000);

process.once("SIGTERM", () => {
  void close();
});

process.once("SIGINT", () => {
  void close();
});
