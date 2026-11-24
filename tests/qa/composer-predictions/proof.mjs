import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const { values } = parseArgs({
  options: {
    codex: { type: "string" },
    output: { type: "string" },
  },
  strict: true,
});

assert.ok(values.codex, "An installed Codex executable is required");

assert.ok(values.output, "A receipt output path is required");

assert.ok(isAbsolute(values.codex), "The Codex executable must be absolute");

const cliPath = await realpath(values.codex);

const outputPath = resolve(values.output);

const createdScratch = await mkdtemp(
  join(tmpdir(), "omnyo-composer-predictions-"),
);

const scratch = await realpath(createdScratch);

const home = join(scratch, "home");

const codexHome = join(home, ".codex");

const workspace = join(scratch, "workspace");

const temporary = join(scratch, "tmp");

for (const name of Object.keys(process.env)) delete process.env[name];

Object.assign(process.env, {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C.UTF-8",
  LC_ALL: "C",
  HOME: home,
  CODEX_HOME: codexHome,
  TMPDIR: temporary,
});

const controller = new AbortController();

const abort = () => controller.abort();

const deadline = setTimeout(abort, 75_000);

process.once("SIGINT", abort);

process.once("SIGTERM", abort);

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: "running",
  verifiedSurface:
    "installed Codex, production runner and forwarding body, loopback Responses SSE",
  limitations: [
    "No live model, account eligibility, allowance, billing or production proof.",
    "Configured loopback isolation is not an operating-system egress firewall.",
    "No rendered UI or screenshot claim.",
  ],
  binary: null,
  sourceHashes: {},
  invariants: {},
  requests: [],
  failureStage: null,
  cleanup: null,
};

const nativePids = new Set();

let stage = "initialize isolated fixture";

let session;

let prediction;

let server;

let fixtureFailure = false;

let parentThreadId;

const fixtureCapability = randomUUID();

const expectedSuggestion = "Check the result.";

const parentResponse = "The local parent turn is complete.";

const parentToolName = "composer_proof_parent_tool";

const configuration = {
  is_enabled: true,
  prompt: "Suggest the next message for this local proof conversation.",
  prompt_version: "local-native-proof-v1",
  prediction_reasoning_effort: "low",
  unsupported_models: ["gpt-daybreak-blue-latest"],
};

function childExit(child) {
  return new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) => done(code));
  });
}

async function diagnostic(command, args) {
  const filter = spawn(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      'import runpy, sys; sys.path.insert(0, "/Users/developer/bin"); runpy.run_path("/Users/developer/.codex/bin/redact-stream", run_name="__main__")',
    ],
    { env: process.env, stdio: ["pipe", "pipe", "ignore"] },
  );

  const child = spawn(command, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const childClosed = childExit(child);
  const filterClosed = childExit(filter);
  let output = "";
  let exceeded = false;
  filter.stdin.on("error", () => child.kill("SIGTERM"));
  filter.stdout.setEncoding("utf8");
  filter.stdout.on("data", (chunk) => {
    if (output.length + chunk.length > 1024 * 1024) {
      exceeded = true;
      child.kill("SIGKILL");
      filter.kill("SIGKILL");
    } else output += chunk;
  });
  child.stdout.pipe(filter.stdin, { end: false });
  child.stderr.pipe(filter.stdin, { end: false });
  void childClosed.then(
    () => filter.stdin.end(),
    () => filter.stdin.end(),
  );

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    filter.kill("SIGKILL");
  }, 10_000);

  try {
    const [childCode, filterCode] = await Promise.all([
      childClosed,
      filterClosed,
    ]);

    assert.equal(childCode, 0, "The diagnostic command failed");
    assert.equal(filterCode, 0, "The maintained diagnostic redactor failed");
    assert.equal(exceeded, false, "Diagnostic output exceeded its bound");

    return output.trim();
  } finally {
    clearTimeout(timeout);

    if (child.exitCode === null) child.kill("SIGKILL");

    if (filter.exitCode === null) filter.kill("SIGKILL");
    await Promise.allSettled([childClosed, filterClosed]);
  }
}

async function observeNativeProcesses() {
  const rows = (
    await diagnostic("/bin/ps", ["-axo", "pid=,ppid=,lstart=,comm="])
  )
    .split("\n")
    .map((line) =>
      /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
        line,
      ),
    )
    .flatMap((match) =>
      match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              startedAt: match[3].replace(/\s+/g, " "),
              name: match[4],
            },
          ]
        : [],
    );

  const roots = rows.filter(
    (row) =>
      row.parent === process.pid &&
      (basename(row.name) === basename(cliPath) ||
        basename(row.name) === basename(values.codex)),
  );

  assert.equal(
    roots.length,
    1,
    "Exactly one owned native worker must be active",
  );
  const descendants = new Set(roots.map((row) => row.pid));
  let added;

  do {
    added = false;

    for (const row of rows) {
      if (descendants.has(row.parent) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        added = true;
      }
    }
  } while (added);

  report.ownedNativeProcesses ??= [];

  for (const row of rows) {
    if (descendants.has(row.pid) && !nativePids.has(row.pid)) {
      nativePids.add(row.pid);
      report.ownedNativeProcesses.push(row);
    }
  }
}

async function hashFile(path) {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) hash.update(chunk);

  return hash.digest("hex");
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function exists(path) {
  return access(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

function responsesSse(text, index) {
  const message = {
    id: `msg_local_${index}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };

  const response = {
    id: `resp_local_${index}`,
    object: "response",
    created_at: 1,
    model: "gpt-5.4",
    status: "completed",
    end_turn: true,
    output: [message],
  };

  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ];

  return events
    .map(
      (event, sequence_number) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
    )
    .join("");
}

try {
  await Promise.all([
    mkdir(codexHome, { recursive: true, mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 }),
    mkdir(temporary, { mode: 0o700 }),
  ]);
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: `synthetic-loopback-${randomUUID()}` }),
    { mode: 0o600 },
  );
  await writeFile(
    join(codexHome, "config.toml"),
    'model = "gpt-daybreak-blue-latest"\ncli_auth_credentials_store = "file"\nweb_search = "disabled"\n[analytics]\nenabled = false\n[features]\nplugins = false\n',
    { mode: 0o600 },
  );
  const { z } = await import("zod");

  const { NativeSession } =
    await import("../../../plugins/account-pool/src/prediction-native.ts");

  const { predictNative } =
    await import("../../../plugins/account-pool/src/prediction-runner.ts");

  const { composerPredictionBody } =
    await import("../../../plugins/account-pool/src/prediction-contract.ts");

  const bodySchema = z.object({
    model: z.string(),
    tools: z.array(z.json()),
    store: z.literal(false),
    client_metadata: z.record(z.string(), z.string()),
  });

  const metadataSchema = z.object({
    thread_id: z.string(),
    forked_from_thread_id: z.string().optional(),
    thread_source: z.string().optional(),
    turn_trigger: z.string().optional(),
  });

  stage = "verify installed binary";
  const version = await diagnostic(cliPath, ["--version"]);
  assert.equal(version, "codex-cli 0.163.0", "Codex 0.163.0 is required");
  report.binary = { path: cliPath, version, sha256: await hashFile(cliPath) };

  for (const source of [
    "../../../plugins/account-pool/src/prediction-native.ts",
    "../../../plugins/account-pool/src/prediction-runner.ts",
    "../../../plugins/account-pool/src/prediction-contract.ts",
    "./proof.mjs",
  ]) {
    const path = fileURLToPath(new URL(source, import.meta.url));
    report.sourceHashes[basename(path)] = await hashFile(path);
  }

  server = createServer(async (request, response) => {
    let fixtureStage = "validate local route";

    try {
      assert.equal(request.method, "POST", "Only Responses POST is allowed");
      assert.equal(
        request.url,
        "/v1/responses",
        "Only the local Responses route is allowed",
      );
      fixtureStage = "validate local capability";
      assert.equal(
        request.headers["x-omnyo-composer-prediction-token"],
        fixtureCapability,
        "The native capability must reach the local fixture",
      );
      assert.ok(
        report.requests.length < 2,
        "Only one parent and one prediction request are allowed",
      );
      fixtureStage = "read bounded Responses body";
      let bytes = 0;
      const chunks = [];

      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 1024 * 1024, "The local request exceeded its bound");
        chunks.push(chunk);
      }

      fixtureStage = "validate Responses body schema";

      const nativeBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const body = bodySchema.parse(nativeBody);
      assert.equal(
        body.model,
        "gpt-5.4",
        "Parent and prediction must preserve the explicitly selected source model",
      );

      const index = report.requests.length;
      report.toolNames ??= {};
      report.toolNames[index === 0 ? "parent" : "prediction"] = body.tools.map(
        (tool) => {
          const definition = z
            .object({
              type: z.string(),
              name: z.string().optional(),
              function: z.object({ name: z.string() }).optional(),
            })
            .parse(tool);

          return z
            .string()
            .regex(/^[A-Za-z0-9_.-]{1,128}$/)
            .parse(
              definition.name || definition.function?.name || definition.type,
            );
        },
      );

      fixtureStage = "validate native target header";
      const threadId = z.string().parse(request.headers["thread-id"]);
      fixtureStage = "validate native turn metadata schema";

      const metadata = metadataSchema.parse(
        JSON.parse(body.client_metadata["x-codex-turn-metadata"]),
      );

      fixtureStage = "require native dynamic tool declaration";
      report.observedToolCounts ??= [];
      report.observedToolCounts.push(body.tools.length);

      if (index === 0) {
        report.parentToolCount = body.tools.length;
        report.parentDynamicToolPresent =
          report.toolNames.parent.includes(parentToolName);
        assert.equal(
          report.parentDynamicToolPresent,
          true,
          "The persisted parent must expose its synthetic dynamic tool",
        );
      } else {
        report.predictionDynamicToolInherited =
          report.toolNames.prediction.includes(parentToolName);
        assert.equal(
          report.predictionDynamicToolInherited,
          true,
          "The native prediction must exercise inherited dynamic tool declarations",
        );
        fixtureStage = "normalize production prediction forwarding body";
        const normalized = composerPredictionBody(nativeBody, configuration);
        assert.notEqual(
          normalized.body,
          null,
          "The production forwarding boundary must accept the native prediction body",
        );
        fixtureStage = "require forwarded tool selection disabled";

        const forwarded = bodySchema
          .extend({ tool_choice: z.literal("none") })
          .parse(normalized.body);

        assert.deepEqual(
          forwarded.tools,
          body.tools,
          "Forwarding must preserve native tool declarations",
        );
        assert.deepEqual(
          forwarded.client_metadata,
          body.client_metadata,
          "Forwarding must preserve native prediction metadata",
        );
        report.predictionForwarding = {
          toolChoice: forwarded.tool_choice,
          toolDeclarationCount: forwarded.tools.length,
          declarationsPreserved: true,
          metadataPreserved: true,
          store: forwarded.store,
        };
      }

      fixtureStage = "require matching target metadata";
      assert.equal(
        body.client_metadata.thread_id,
        threadId,
        "Client metadata must identify the native target",
      );
      assert.equal(
        metadata.thread_id,
        threadId,
        "Turn metadata must identify the native target",
      );
      fixtureStage =
        index === 0
          ? "require persisted parent target"
          : "require prediction child metadata";

      if (index === 0)
        assert.equal(
          threadId,
          parentThreadId,
          "The persisted parent must own the first turn",
        );
      else {
        assert.notEqual(
          threadId,
          parentThreadId,
          "The prediction must target a child",
        );
        assert.equal(
          metadata.forked_from_thread_id,
          parentThreadId,
          "The prediction child must fork the persisted parent",
        );
        assert.equal(
          metadata.thread_source,
          "composer_predictions",
          "The child must retain prediction source metadata",
        );
        assert.equal(
          metadata.turn_trigger,
          "composer_predictions",
          "The turn must retain prediction trigger metadata",
        );
      }

      fixtureStage = "observe owned installed native process";
      await observeNativeProcesses();
      report.requests.push({
        kind: index === 0 ? "parent" : "prediction",
        model: body.model,
        tools: body.tools.length,
        store: body.store,
        threadIdSha256: hashText(threadId),
        headerAndMetadataAgree: true,
        predictionMetadata: index === 1,
        forksParent: index === 1,
      });
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      response.end(
        responsesSse(
          index === 0
            ? parentResponse
            : JSON.stringify({
                suggestion: expectedSuggestion,
                archiveReadiness: {
                  ready: false,
                  reason: "The requested check is still pending.",
                  waitingOn: null,
                },
              }),
          index,
        ),
      );
    } catch (error) {
      fixtureFailure = true;
      report.fixtureFailureStage = fixtureStage;
      report.fixtureFailureClass =
        error instanceof Error ? error.name : "UnknownError";

      if (error instanceof z.ZodError)
        report.fixtureSchemaIssues = error.issues.map((issue) => ({
          field: issue.path.join("."),
          code: issue.code,
          expected: issue.expected,
        }));
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end('{"error":{"message":"Local proof invariant failed"}}');
      controller.abort();
    }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });

  const address = z
    .object({ port: z.number().int().min(1) })
    .parse(server.address());

  const route = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    capability: fixtureCapability,
  };

  stage = "open native parent session";
  session = await NativeSession.open(
    cliPath,
    workspace,
    controller.signal,
    route,
  );

  stage = "request persisted parent start";

  const parentResult = await session.request(
    "thread/start",
    {
      model: "gpt-5.4",
      modelProvider: "omnyo-account-pool",
      cwd: workspace,
      ephemeral: false,
      approvalPolicy: "never",
      sandbox: "read-only",
      dynamicTools: [
        {
          type: "function",
          name: parentToolName,
          description:
            "Synthetic proof sentinel. The local fixture never calls this tool.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    },
    z.json(),
  );

  stage = "validate persisted parent response";

  const parentValidation = z
    .object({ thread: z.object({ id: z.string(), path: z.string() }) })
    .safeParse(parentResult);

  report.parentStartValidation = parentValidation.success
    ? { valid: true }
    : {
        valid: false,
        issues: parentValidation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          code: issue.code,
          expected: issue.expected,
        })),
      };
  assert.equal(
    parentValidation.success,
    true,
    "The persisted parent response must match the native contract",
  );
  const parent = parentValidation.data;

  parentThreadId = parent.thread.id;
  stage = "validate isolated parent rollout path";
  const rolloutPath = parent.thread.path;
  const relativeRollout = relative(codexHome, rolloutPath);
  report.parentPathValidation = {
    temporaryRootAliasCanonicalized: createdScratch !== scratch,
    returnedPathAbsolute: isAbsolute(rolloutPath),
    canonicalHomeContainsReturnedPath:
      !relativeRollout.startsWith("..") && !isAbsolute(relativeRollout),
  };
  assert.ok(
    report.parentPathValidation.canonicalHomeContainsReturnedPath,
    "The parent rollout must belong to the isolated Codex home",
  );
  const messages = [];
  let complete;
  let rejectCompletion;

  const completion = new Promise((done, reject) => {
    complete = done;
    rejectCompletion = reject;
  });

  void completion.catch(() => {});

  const cancelParent = () =>
    rejectCompletion(new Error("Local parent turn canceled"));

  controller.signal.addEventListener("abort", cancelParent, { once: true });

  const unsubscribe = session.onNotification(({ method, params }) => {
    if (method === "item/completed") {
      const item = z
        .object({
          threadId: z.string(),
          item: z.object({ type: z.string(), text: z.string().optional() }),
        })
        .parse(params);

      if (item.threadId === parentThreadId && item.item.type === "agentMessage")
        messages.push(item.item.text);
    }

    if (method === "turn/completed") {
      const result = z
        .object({
          threadId: z.string(),
          turn: z.object({ id: z.string(), status: z.string() }),
        })
        .parse(params);

      if (result.threadId === parentThreadId) complete(result.turn);
    }
  });

  try {
    stage = "request local parent turn";

    const turn = await session.request(
      "turn/start",
      {
        threadId: parentThreadId,
        input: [
          {
            type: "text",
            text: "Complete this local parent fixture turn.",
            text_elements: [],
          },
        ],
        environments: [],
      },
      z.object({ turn: z.object({ id: z.string() }) }),
    );

    stage = "await local parent turn completion";
    const completed = await completion;
    assert.equal(
      completed.id,
      turn.turn.id,
      "The parent completion must match its requested turn",
    );
    assert.equal(
      completed.status,
      "completed",
      "The persisted parent turn must complete",
    );
    assert.equal(
      messages.join("\n"),
      parentResponse,
      "The native parent must consume the Responses fixture",
    );
  } finally {
    unsubscribe();
    controller.signal.removeEventListener("abort", cancelParent);
    await session.close();
    session = undefined;
  }

  stage = "read completed parent rollout";
  const parentBytes = await readFile(rolloutPath);
  assert.ok(
    parentBytes.length > 0,
    "The parent history must be persisted before prediction",
  );
  const parentHash = hashText(parentBytes);
  report.invariants.parentPersistedBeforePrediction = true;
  report.invariants.parentRolloutSha256Before = parentHash;

  stage = "run production native prediction";
  prediction = predictNative(
    {
      nativeThreadId: parentThreadId,
      cwd: workspace,
      cliPath,
      route,
      configuration,
      tags: [],
    },
    controller.signal,
  );
  const result = await prediction;
  assert.equal(
    result.text,
    expectedSuggestion,
    "The production runner must return the fixture suggestion",
  );
  assert.deepEqual(result.archiveReadiness, {
    ready: false,
    reason: "The requested check is still pending.",
    waitingOn: null,
  });
  assert.equal(
    result.promptVersion,
    configuration.prompt_version,
    "The production runner must retain the prompt version",
  );
  assert.equal(
    fixtureFailure,
    false,
    "The local Responses fixture must accept every request",
  );
  assert.equal(
    report.requests.length,
    2,
    "Exactly two local Responses requests must complete",
  );
  const afterBytes = await readFile(rolloutPath);
  assert.ok(
    parentBytes.equals(afterBytes),
    "The prediction must leave parent history bytes unchanged",
  );
  report.invariants = {
    ...report.invariants,
    parentRolloutSha256After: hashText(afterBytes),
    parentHistoryUnchanged: true,
    predictionTargetsChild: true,
    predictionMetadataPresent: true,
    nativeToolDeclarationCount:
      report.predictionForwarding.toolDeclarationCount,
    forwardedToolChoice: report.predictionForwarding.toolChoice,
    forwardedToolSelectionDisabled: true,
    responseStored: false,
    expectedSuggestionReturned: true,
    expectedPromptVersionReturned: true,
    isolatedEnvironment: true,
    syntheticFileAuthenticationOnly: true,
    loopbackResponsesRequests: 2,
  };
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failureStage = stage;
  report.failureClass = error instanceof Error ? error.name : "UnknownError";

  const nativeError =
    error instanceof Error
      ? /^Native Codex request failed \((-?\d+)\)$/.exec(error.message)
      : null;

  if (nativeError) report.nativeErrorCode = Number(nativeError[1]);

  if (
    error instanceof Error &&
    ["ENOENT", "EACCES", "ENAMETOOLONG"].includes(error.code)
  )
    report.filesystemErrorCode = error.code;
  process.exitCode = 1;
} finally {
  controller.abort();
  clearTimeout(deadline);
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);

  const cleanup = {
    nativeProcessesObserved: nativePids.size,
    nativeProcessesExited: false,
    listenerClosed: false,
    scratchPath: scratch,
    scratchRemoved: false,
  };

  try {
    await session?.close();
    await prediction?.catch(() => {});

    if (server?.listening) {
      const closed = new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );

      server.closeAllConnections();
      await closed;
    }

    cleanup.listenerClosed = !server?.listening;

    const exitDeadline = Date.now() + 3000;

    while (Date.now() < exitDeadline) {
      const alive = [...nativePids].some((pid) => {
        try {
          process.kill(pid, 0);

          return true;
        } catch (error) {
          if (error.code === "ESRCH") return false;
          throw error;
        }
      });

      if (!alive) break;
      await new Promise((done) => setTimeout(done, 50));
    }

    for (const pid of nativePids) {
      try {
        process.kill(pid, 0);
        throw new Error("An observed native process survived cleanup");
      } catch (error) {
        assert.equal(
          error.code,
          "ESRCH",
          "Every observed native process must exit",
        );
      }
    }

    cleanup.nativeProcessesExited = true;
    await rm(scratch, { recursive: true });
    cleanup.scratchRemoved = !(await exists(scratch));
    assert.equal(
      cleanup.scratchRemoved,
      true,
      "The owned temporary directory must be removed",
    );
  } catch {
    report.status = "failed";
    report.failureStage ??= "cleanup owned resources";
    process.exitCode = 1;
  }

  report.cleanup = cleanup;
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(
  `Native composer prediction proof ${report.status}; receipt: ${outputPath}`,
);
