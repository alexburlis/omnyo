#!/usr/bin/env node

import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

let threadCounter = 0;

let turnCounter = 0;

const openTurnIdsByThreadId = new Map();

const pendingStartTurnIdsByThreadId = new Map();

const queuedInterruptibleTurnsByThreadId = new Map();

let interruptAttempts = 0;

const processInstanceId = `${process.pid}-${Date.now()}-${Math.random()}`;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const ZERO_WORK_PROMPT_TEXT = "/clear";

const COMPACTION_TURN_DELAY_MS = Number(
  process.env.FAKE_CODEX_COMPACTION_TURN_DELAY_MS ?? "20",
);

const COMPACTION_MODE = process.env.FAKE_CODEX_COMPACTION_MODE ?? "turn";

const LATE_TURN_START_PROMPT_TEXT = "/late-start";

const LATE_START_INTERRUPTIBLE_PROMPT_TEXT = "/late-start-interruptible";

const lateStartTurnIdsByThreadId = new Map();

const LATE_TURN_START_DELAY_MS = 350;

const RESPOND_THEN_EXIT_PROMPT_TEXT = "/respond-then-exit";

const RESPOND_COMPLETED_PROMPT_TEXT = "/respond-completed";

const STEER_INTO_ACTIVE_PROMPT_TEXT = "/steer-into-active";

const INTERRUPT_BEFORE_START_PROMPT_TEXT = "/interrupt-before-start";

const INTERRUPTIBLE_PROMPT_TEXT = "/wait-for-interrupt";

const LOST_COMPLETION_PROMPT_TEXT = "/lost-completion";

const SUBAGENT_THEN_CRASH_PROMPT_TEXT = "/subagent-then-crash";

const SUBAGENT_FINISHES_PROMPT_TEXT = "/subagent-finishes";

const SUBAGENT_KEEPS_TERMINAL_PROMPT_TEXT = "/subagent-keeps-terminal";

const loadedThreads = new Map();

function firstInputText(input) {
  const first = Array.isArray(input) ? input[0] : undefined;

  return first && first.type === "text" ? first.text : undefined;
}

const FIXED_TOKEN_USAGE = {
  total: {
    totalTokens: 39970,
    inputTokens: 39960,
    cachedInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 0,
  },
  last: {
    totalTokens: 19993,
    inputTokens: 19988,
    cachedInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0,
  },
  modelContextWindow: 258400,
};

function runCompaction(threadId) {
  if (COMPACTION_MODE === "exit-before-turn") {
    setTimeout(() => process.exit(1), 20);

    return;
  }

  setTimeout(() => {
    if (
      COMPACTION_MODE === "idle-without-turn" ||
      COMPACTION_MODE === "error-without-turn"
    ) {
      notify("thread/status/changed", {
        threadId,
        status: {
          type:
            COMPACTION_MODE === "error-without-turn" ? "systemError" : "idle",
        },
      });

      return;
    }

    turnCounter += 1;
    const turnId = `turn-fx-${turnCounter}`;
    const itemId = `compaction-fx-${turnCounter}`;
    notify("thread/status/changed", {
      threadId,
      status: { type: "active", activeFlags: [] },
    });
    notify("turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress" },
    });
    notify("item/started", {
      threadId,
      turnId,
      item: { type: "contextCompaction", id: itemId },
    });

    if (COMPACTION_MODE === "wait-for-interrupt") {
      openTurnIdsByThreadId.set(threadId, turnId);

      return;
    }

    notify("item/completed", {
      threadId,
      turnId,
      item: { type: "contextCompaction", id: itemId },
    });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "completed" },
    });
  }, COMPACTION_TURN_DELAY_MS);
}

function runScriptedTurn(threadId, presetTurnId) {
  turnCounter += 1;
  const turnId = presetTurnId ?? `turn-fx-${turnCounter}`;
  const itemId = `item-fx-${turnCounter}`;
  const text = `hello from codex turn ${turnCounter}`;
  openTurnIdsByThreadId.set(threadId, turnId);

  notify("turn/started", {
    threadId,
    turn: { id: turnId, status: "inProgress" },
  });

  if (script?.lateStartTool && presetTurnId !== undefined) {
    const item = {
      type: "commandExecution",
      id: `command-${turnId}`,
      command: "echo verified",
      cwd: "/tmp",
      processId: null,
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };

    notify("item/started", { threadId, turnId, item });
    notify("item/completed", {
      threadId,
      turnId,
      item: {
        ...item,
        status: "completed",
        aggregatedOutput: "verified",
        exitCode: 0,
        durationMs: 1,
      },
    });
  }

  notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: text });
  notify("item/completed", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: itemId, text },
  });

  if (String(threadId).startsWith("usage-replay-")) {
    notify("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: FIXED_TOKEN_USAGE,
    });
  }

  notify("turn/completed", {
    threadId,
    turn: { id: turnId, status: "completed" },
  });
  openTurnIdsByThreadId.delete(threadId);
}

function scriptPathFromArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "-c" || argument === "--config") {
      index += 1;
      continue;
    }

    if (argument.startsWith("-")) continue;

    return argument;
  }

  return undefined;
}

const scriptPath = scriptPathFromArgs(process.argv.slice(2));

const script = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : null;

const scriptedTurns = script?.turns ?? null;

const turnModule = script?.turnModule
  ? await import(pathToFileURL(script.turnModule).href)
  : null;

const threadContexts = new Map();

function rememberThreadContext(threadId, params, sourceThreadId) {
  const source = sourceThreadId ? threadContexts.get(sourceThreadId) : null;

  threadContexts.set(threadId, {
    cwd: params.cwd ?? source?.cwd ?? null,
    model: params.model ?? source?.model ?? null,
  });
}

function startModuleTurn(id, params) {
  turnCounter += 1;
  const turnId = `turn-${randomUUID()}`;
  const threadContext = threadContexts.get(params.threadId);
  const isOpen = () => openTurnIdsByThreadId.get(params.threadId) === turnId;

  openTurnIdsByThreadId.set(params.threadId, turnId);

  const playback = turnModule.runTurn({
    threadId: params.threadId,
    turnId,
    params,
    cwd: threadContext?.cwd ?? process.cwd(),
    model: params.model ?? threadContext?.model ?? null,
    notify,
    request: requestFromClient,
    isOpen,
    close: () => {
      if (isOpen()) openTurnIdsByThreadId.delete(params.threadId);
    },
  });

  respond(id, { turn: { id: turnId, items: [], status: "inProgress" } });

  playback.catch((error) => {
    if (!isOpen()) return;

    openTurnIdsByThreadId.delete(params.threadId);
    notify("turn/completed", {
      threadId: params.threadId,
      turn: {
        id: turnId,
        items: [],
        status: "failed",
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      },
    });
  });
}

const requestLogPath = script?.requestLogPath ?? null;

if (script?.launchLogPath) {
  appendFileSync(
    script.launchLogPath,
    JSON.stringify({
      pid: process.pid,
      args: process.argv.slice(2),
      codexHome: process.env.CODEX_HOME ?? null,
      ...(script.captureTestEnvironment === true
        ? {
            testEnvironment: {
              PROJECT_FIXTURE_VALUE: process.env.PROJECT_FIXTURE_VALUE ?? null,
              trustedProcessControls: {
                path: process.env.PATH === "/synthetic/trusted/bin",
                home: process.env.HOME === "/synthetic/trusted/home",
                loader: process.env.NODE_OPTIONS === "--no-warnings",
                providerIdentity: process.env.OPENAI_API_KEY === "inherited",
                providerEndpoint:
                  process.env.OPENAI_BASE_URL === "http://127.0.0.1:1/trusted",
                providerNamespace:
                  process.env.CODEX_TEST_CONTROL === "inherited",
                proxy: process.env.HTTPS_PROXY === "http://127.0.0.1:2/trusted",
                tls:
                  process.env.SSL_CERT_FILE ===
                  "/synthetic/trusted/certificate.pem",
                launchOverrideAbsent:
                  process.env.OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND ===
                  undefined,
              },
            },
          }
        : {}),
    }) + "\n",
  );
}

const responseLogPath = script?.responseLogPath ?? null;

const modelListFailOnceMarkerPath = script?.modelListFailOnceMarkerPath ?? null;

const archiveStatePath = script?.archiveStatePath ?? null;

let renameEmptyRolloutFailuresLeft = script?.renameEmptyRolloutFailures ?? 0;

const archivedThreadIds = new Set();

const processLogPath = script?.processLogPath ?? null;

const stallThreadStart = script?.stallThreadStart ?? false;

const writerLockPath = script?.writerLockPath ?? null;

const sigtermDelayMs = script?.sigtermDelayMs ?? 0;

const stdinCloseDelayMs = script?.stdinCloseDelayMs ?? 0;

let ownsWriterLock = false;

let servesThread = false;

function logProcessStep(step) {
  if (processLogPath === null) {
    return;
  }

  const ownership =
    step === "spawn"
      ? `ownership:${JSON.stringify([process.env.OMNYO_THREAD_ID, process.env.OMNYO_THREAD_STORAGE])}\n`
      : "";

  appendFileSync(
    processLogPath,
    `${step}:${process.pid}:${process.ppid}\n${ownership}`,
  );
}

function releaseWriterLock() {
  if (!ownsWriterLock || writerLockPath === null) {
    return;
  }

  ownsWriterLock = false;

  if (
    existsSync(writerLockPath) &&
    readFileSync(writerLockPath, "utf8") === String(process.pid)
  ) {
    unlinkSync(writerLockPath);
  }
}

function acquireWriterLock() {
  if (writerLockPath === null || ownsWriterLock) {
    return true;
  }

  try {
    writeFileSync(writerLockPath, String(process.pid), { flag: "wx" });
    ownsWriterLock = true;

    return true;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") {
      throw error;
    }

    const ownerPid = Number(readFileSync(writerLockPath, "utf8"));

    try {
      process.kill(ownerPid, 0);

      return false;
    } catch (ownerError) {
      if (
        !ownerError ||
        typeof ownerError !== "object" ||
        ownerError.code !== "ESRCH"
      ) {
        throw ownerError;
      }

      unlinkSync(writerLockPath);

      return acquireWriterLock();
    }
  }
}

function exitCleanly() {
  releaseWriterLock();
  logProcessStep("exit");
  process.exit(0);
}

process.on("exit", releaseWriterLock);

process.on("SIGTERM", () => {
  logProcessStep("sigterm");

  if (sigtermDelayMs > 0 && servesThread) {
    setTimeout(exitCleanly, sigtermDelayMs);

    return;
  }

  exitCleanly();
});

logProcessStep("spawn");

let scriptedTurnIndex = 0;

function readArchivedThreadIds() {
  if (archiveStatePath === null) {
    return archivedThreadIds;
  }

  if (!existsSync(archiveStatePath)) {
    return new Set();
  }

  return new Set(JSON.parse(readFileSync(archiveStatePath, "utf8")));
}

function setThreadArchived(threadId, archived) {
  const ids = readArchivedThreadIds();

  if (archived) {
    ids.add(threadId);
  } else {
    ids.delete(threadId);
  }

  if (archiveStatePath === null) {
    return;
  }

  writeFileSync(archiveStatePath, JSON.stringify([...ids]));
}

function isThreadArchived(threadId) {
  return readArchivedThreadIds().has(threadId);
}

function shouldFailThisModelList() {
  if (modelListFailOnceMarkerPath === null) {
    return false;
  }

  try {
    closeSync(openSync(modelListFailOnceMarkerPath, "wx"));

    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      return false;
    }

    throw error;
  }
}

function withThreadId(value, threadId) {
  if (Array.isArray(value)) {
    return value.map((entry) => withThreadId(entry, threadId));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const rewritten = {};

  for (const [key, entry] of Object.entries(value)) {
    rewritten[key] =
      key === "threadId" && typeof entry === "string"
        ? threadId
        : withThreadId(entry, threadId);
  }

  return rewritten;
}

let outboundRequestCounter = 0;

const pendingOutboundRequests = new Map();

function requestFromClient(method, params) {
  outboundRequestCounter += 1;
  const id = `fx-req-${outboundRequestCounter}`;

  return new Promise((resolve) => {
    pendingOutboundRequests.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const turnCursorPath = script?.turnCursorPath ?? null;

function takeScriptedTurnIndex() {
  if (turnCursorPath === null) {
    const index = scriptedTurnIndex;
    scriptedTurnIndex += 1;

    return index;
  }

  const index = existsSync(turnCursorPath)
    ? Number(readFileSync(turnCursorPath, "utf8"))
    : 0;

  writeFileSync(turnCursorPath, String(index + 1));

  return index;
}

async function runScriptFileTurn(threadId) {
  const turn = scriptedTurns[takeScriptedTurnIndex()] ?? [];

  for (const entry of turn) {
    const params = withThreadId(entry.params ?? {}, threadId);

    if (entry.kind === "request") {
      await requestFromClient(entry.method, params);
      continue;
    }

    if (entry.method === "turn/started") {
      openTurnIdsByThreadId.set(threadId, params.turn.id);
    }

    if (entry.method === "turn/completed") {
      openTurnIdsByThreadId.delete(threadId);
    }

    notify(entry.method, params);
  }
}

function replayLastTurnUsage(threadId) {
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId: "turn-fx-1",
    tokenUsage: FIXED_TOKEN_USAGE,
  });
}

async function handleRequest(message) {
  const { id, method } = message;
  const params = message.params ?? {};

  if (requestLogPath !== null) {
    appendFileSync(requestLogPath, `${JSON.stringify({ method, params })}\n`);
  }

  switch (method) {
    case "initialize":
      respond(
        id,
        script?.initializeResult ?? { userAgent: "omnyo/0.169.0 fixture" },
      );

      return;
    case "account/rateLimits/read":
      if (script?.rateLimitRead) {
        if (script.rateLimitRead.hang) return;
        setTimeout(() => {
          if (script.rateLimitRead.error)
            respondError(id, -32603, "Quota read unavailable");
          else respond(id, script.rateLimitRead.result);
        }, script.rateLimitRead.delayMs ?? 0);

        return;
      }

      respond(id, { rateLimits: {} });

      return;
    case "model/list":
      if (shouldFailThisModelList()) {
        respond(id, { data: [] });

        return;
      }

      if (script?.modelList) {
        setTimeout(
          () => respond(id, script.modelList),
          script.modelListDelayMs ?? 0,
        );

        return;
      }

      respond(id, {
        data: [
          {
            id: `fake-model-${processInstanceId}`,
            model: `fake-model-${processInstanceId}`,
            displayName: "Fake model",
            description: "Hermetic bridge fixture model",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Medium" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
      });

      return;
    case "config/read":
      if (script?.configReadError) {
        respondError(id, -32601, "Configuration read unavailable");
      } else {
        respond(id, {
          origins: {},
          ...(script?.configRead ?? { config: { model: null } }),
        });
      }

      return;
    case "configRequirements/read":
      respond(id, script?.configRequirementsRead ?? { requirements: null });

      return;
    case "permissionProfile/list":
      respond(
        id,
        script?.permissionProfileListPages?.[params?.cursor ?? "first"] ??
          script?.permissionProfileList ?? { data: [] },
      );

      return;
    case "skills/list":
      respond(id, script?.skillsList ?? { data: [] });

      return;
    case "skills/extraRoots/set":
      respond(id, {});

      return;
    case "thread/start": {
      servesThread = true;

      if (stallThreadStart) {
        await new Promise(() => undefined);
      }

      threadCounter += 1;
      const threadId = `codex-fx-${processInstanceId}-${threadCounter}`;
      loadedThreads.set(threadId, { parentThreadId: null, status: "idle" });
      rememberThreadContext(threadId, params, null);
      notify("thread/started", { thread: { id: threadId } });
      respond(id, { thread: { id: threadId } });

      return;
    }

    case "thread/loaded/list":
      respond(id, { data: [...loadedThreads.keys()], nextCursor: null });

      return;
    case "thread/read": {
      const persisted = script?.threadReadResults?.[params.threadId];

      if (persisted !== undefined) {
        if (script?.threadReadDelayMs) {
          await new Promise((done) =>
            setTimeout(done, script.threadReadDelayMs),
          );
        }

        respond(id, { thread: persisted });

        return;
      }

      const loaded = loadedThreads.get(params.threadId);

      if (loaded === undefined) {
        respondError(id, -32603, `thread ${params.threadId} is not loaded`);

        return;
      }

      respond(id, {
        thread: {
          id: params.threadId,
          parentThreadId: loaded.parentThreadId,
          status: { type: loaded.status },
        },
      });

      return;
    }

    case "thread/backgroundTerminals/list": {
      const loaded = loadedThreads.get(params.threadId);

      respond(id, {
        data: Array.from({ length: loaded?.terminals ?? 0 }, (_, index) => ({
          processId: String(index),
        })),
        nextCursor: null,
      });

      return;
    }

    case "thread/unsubscribe": {
      if (!loadedThreads.has(params.threadId)) {
        respond(id, { status: "notLoaded" });

        return;
      }

      respond(id, { status: "unsubscribed" });
      setTimeout(() => {
        loadedThreads.delete(params.threadId);

        if (requestLogPath !== null) {
          appendFileSync(
            requestLogPath,
            `${JSON.stringify({ method: "emitted:thread/closed", params: { threadId: params.threadId } })}\n`,
          );
        }

        notify("thread/closed", { threadId: params.threadId });
      }, script?.unloadDelayMs ?? 50);

      return;
    }

    case "thread/resume": {
      servesThread = true;

      if (!acquireWriterLock()) {
        logProcessStep("writer-conflict");
        respondError(
          id,
          -32603,
          `thread ${params.threadId} already has an active writer`,
        );

        return;
      }

      if (
        String(params.threadId).startsWith("archived-") ||
        isThreadArchived(params.threadId)
      ) {
        respondError(
          id,
          -32603,
          `session ${params.threadId} is archived; unarchive it and retry`,
        );

        return;
      }

      if (String(params.threadId).startsWith("usage-replay-")) {
        replayLastTurnUsage(params.threadId);
      }

      loadedThreads.set(params.threadId, {
        parentThreadId: null,
        status: "idle",
      });
      rememberThreadContext(params.threadId, params, null);
      respond(id, {
        thread: {
          id: params.threadId,
          ...(script?.resumedDaybreakEnabled === undefined
            ? {}
            : { daybreakEnabled: script.resumedDaybreakEnabled }),
        },
      });

      return;
    }

    case "thread/metadata/update":
      if (script?.metadataUpdateError) {
        respondError(id, -32603, "Thread metadata is unavailable");
      } else {
        respond(id, { thread: { id: params.threadId } });
      }

      return;
    case "thread/fork": {
      servesThread = true;

      if (
        String(params.threadId).startsWith("archived-") ||
        isThreadArchived(params.threadId)
      ) {
        respondError(
          id,
          -32603,
          `session ${params.threadId} is archived; unarchive it and retry`,
        );

        return;
      }

      threadCounter += 1;
      const replaysUsage = String(params.threadId).startsWith("usage-replay-");

      const threadId = replaysUsage
        ? `usage-replay-fork-${processInstanceId}-${threadCounter}`
        : `codex-fx-${processInstanceId}-fork-${threadCounter}`;

      rememberThreadContext(threadId, params, params.threadId);
      respond(id, { thread: { id: threadId } });

      if (replaysUsage) {
        replayLastTurnUsage(threadId);
      }

      return;
    }

    case "turn/start": {
      if (turnModule !== null) {
        startModuleTurn(id, params);

        return;
      }

      if (script?.interruptQueueMode) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        const activeTurnId = openTurnIdsByThreadId.get(params.threadId);

        if (activeTurnId === undefined) {
          openTurnIdsByThreadId.set(params.threadId, turnId);
          notify("turn/started", {
            threadId: params.threadId,
            turn: { id: turnId, status: "inProgress" },
          });

          if (script.interruptQueueMode === "child") {
            const childThreadId = `${params.threadId}-child`;
            loadedThreads.set(childThreadId, {
              parentThreadId: params.threadId,
              status: "active",
            });
            openTurnIdsByThreadId.set(childThreadId, "turn-child-fx");
            notify("item/completed", {
              threadId: params.threadId,
              turnId,
              item: {
                type: "subAgentActivity",
                id: "queued-child-call",
                kind: "started",
                agentThreadId: childThreadId,
                agentPath: "reviewer",
              },
            });
            notify("turn/started", {
              threadId: childThreadId,
              turn: { id: "turn-child-fx", status: "inProgress" },
            });
          }
        } else {
          const queued =
            queuedInterruptibleTurnsByThreadId.get(params.threadId) ?? [];

          queued.push(turnId);
          queuedInterruptibleTurnsByThreadId.set(params.threadId, queued);
        }

        respond(id, { turn: { id: turnId, status: "inProgress" } });

        return;
      }

      if (firstInputText(params.input) === ZERO_WORK_PROMPT_TEXT) {
        respond(id, {});

        return;
      }

      if (firstInputText(params.input) === SUBAGENT_THEN_CRASH_PROMPT_TEXT) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        openTurnIdsByThreadId.set(params.threadId, turnId);
        notify("turn/started", {
          threadId: params.threadId,
          turn: { id: turnId, status: "inProgress" },
        });
        notify("item/completed", {
          threadId: params.threadId,
          turnId,
          item: {
            type: "subAgentActivity",
            id: `call-fx-${turnCounter}`,
            kind: "started",
            agentThreadId: `codex-fx-sub-${turnCounter}`,
            agentPath: "reviewer",
          },
        });
        respond(id, {});
        setTimeout(() => process.exit(1), 20);

        return;
      }

      if (
        firstInputText(params.input) === SUBAGENT_FINISHES_PROMPT_TEXT ||
        firstInputText(params.input) === SUBAGENT_KEEPS_TERMINAL_PROMPT_TEXT
      ) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        const subThreadId = `codex-fx-sub-${processInstanceId}-${turnCounter}`;
        const subTurnId = `turn-fx-sub-${turnCounter}`;

        const setStatus = (threadId, status) => {
          const loaded = loadedThreads.get(threadId);

          if (loaded !== undefined) loaded.status = status;
          notify("thread/status/changed", {
            threadId,
            status: { type: status },
          });
        };

        respond(id, { turn: { id: turnId, status: "inProgress" } });
        setStatus(params.threadId, "active");
        notify("turn/started", {
          threadId: params.threadId,
          turn: { id: turnId, status: "inProgress" },
        });
        loadedThreads.set(subThreadId, {
          parentThreadId: params.threadId,
          status: "active",
          terminals:
            firstInputText(params.input) === SUBAGENT_KEEPS_TERMINAL_PROMPT_TEXT
              ? 1
              : 0,
        });
        notify("item/completed", {
          threadId: params.threadId,
          turnId,
          item: {
            type: "subAgentActivity",
            id: `call-fx-${turnCounter}`,
            kind: "started",
            agentThreadId: subThreadId,
            agentPath: "reviewer",
          },
        });
        notify("turn/started", {
          threadId: subThreadId,
          turn: { id: subTurnId, status: "inProgress" },
        });
        notify("turn/completed", {
          threadId: subThreadId,
          turn: { id: subTurnId, status: "completed" },
        });
        setStatus(subThreadId, "idle");
        setTimeout(() => {
          notify("turn/completed", {
            threadId: params.threadId,
            turn: { id: turnId, status: "completed" },
          });
          setStatus(params.threadId, "idle");
        }, 100);

        return;
      }

      if (firstInputText(params.input) === LATE_TURN_START_PROMPT_TEXT) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        respond(id, { turn: { id: turnId, status: "inProgress" } });
        setTimeout(
          () => runScriptedTurn(params.threadId, turnId),
          LATE_TURN_START_DELAY_MS,
        );

        return;
      }

      if (
        firstInputText(params.input) === LATE_START_INTERRUPTIBLE_PROMPT_TEXT
      ) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        lateStartTurnIdsByThreadId.set(params.threadId, turnId);
        respond(id, { turn: { id: turnId, status: "inProgress" } });

        if (script?.neverStart) return;
        setTimeout(() => {
          lateStartTurnIdsByThreadId.delete(params.threadId);
          openTurnIdsByThreadId.set(params.threadId, turnId);
          notify("turn/started", {
            threadId: params.threadId,
            turn: { id: turnId, status: "inProgress" },
          });
        }, script?.lateStartDelayMs ?? LATE_TURN_START_DELAY_MS);

        return;
      }

      if (firstInputText(params.input) === RESPOND_THEN_EXIT_PROMPT_TEXT) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        respond(id, { turn: { id: turnId, status: "inProgress" } });
        setTimeout(() => process.exit(1), 20);

        return;
      }

      if (firstInputText(params.input) === RESPOND_COMPLETED_PROMPT_TEXT) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        respond(id, { turn: { id: turnId, status: "completed" } });

        return;
      }

      if (firstInputText(params.input) === STEER_INTO_ACTIVE_PROMPT_TEXT) {
        const activeTurnId = openTurnIdsByThreadId.get(params.threadId);
        respond(id, { turn: { id: activeTurnId, status: "inProgress" } });

        return;
      }

      if (firstInputText(params.input) === INTERRUPT_BEFORE_START_PROMPT_TEXT) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        pendingStartTurnIdsByThreadId.set(params.threadId, turnId);
        respond(id, { turn: { id: turnId, status: "inProgress" } });

        return;
      }

      if (firstInputText(params.input) === INTERRUPTIBLE_PROMPT_TEXT) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        openTurnIdsByThreadId.set(params.threadId, turnId);
        notify("turn/started", {
          threadId: params.threadId,
          turn: { id: turnId, status: "inProgress" },
        });
        setTimeout(() => respond(id, {}), script?.startResponseDelayMs ?? 0);

        return;
      }

      if (firstInputText(params.input) === LOST_COMPLETION_PROMPT_TEXT) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        notify("turn/started", {
          threadId: params.threadId,
          turn: { id: turnId, status: "inProgress" },
        });
        respond(id, {});

        return;
      }

      if (scriptedTurns) {
        await runScriptFileTurn(params.threadId);
      } else {
        runScriptedTurn(params.threadId);
      }

      respond(id, {});

      return;
    }

    case "turn/steer":
      if (script?.steerError) {
        respondError(id, script.steerError.code, script.steerError.message);

        return;
      }

      respond(id, {});

      return;
    case "turn/interrupt": {
      interruptAttempts += 1;

      if (script?.interruptQueueMode) {
        const mode = script.interruptQueueMode;

        if (mode === "settled" && interruptAttempts === 1) {
          notify("turn/completed", {
            threadId: params.threadId,
            turn: { id: "turn-fx-1", status: "completed" },
          });
        }

        const activeTurnId =
          mode === "unknown"
            ? "turn-foreign-fx"
            : mode === "child"
              ? "turn-child-fx"
              : mode === "cycle"
                ? params.turnId === "turn-fx-1"
                  ? "turn-fx-3"
                  : "turn-fx-1"
                : openTurnIdsByThreadId.get(params.threadId);

        if (activeTurnId !== params.turnId) {
          respondError(
            id,
            -32600,
            `expected active turn id ${params.turnId} but found ${activeTurnId}`,
          );

          return;
        }

        openTurnIdsByThreadId.delete(params.threadId);
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: activeTurnId, status: "interrupted" },
        });

        const nextTurnId = queuedInterruptibleTurnsByThreadId
          .get(params.threadId)
          ?.shift();

        if (nextTurnId !== undefined) {
          openTurnIdsByThreadId.set(params.threadId, nextTurnId);
          notify("turn/started", {
            threadId: params.threadId,
            turn: { id: nextTurnId, status: "inProgress" },
          });
        }

        respond(id, {});

        return;
      }

      if (
        script?.interruptError &&
        interruptAttempts <= (script.interruptErrorCount ?? 1)
      ) {
        if (script.startBeforeInterruptError) {
          const turnId = lateStartTurnIdsByThreadId.get(params.threadId);
          lateStartTurnIdsByThreadId.delete(params.threadId);
          openTurnIdsByThreadId.set(params.threadId, turnId);
          notify("turn/started", {
            threadId: params.threadId,
            turn: { id: turnId, status: "inProgress" },
          });
        }

        if (script.settleBeforeInterruptError) {
          notify("turn/completed", {
            threadId: params.threadId,
            turn: { id: params.turnId, status: "completed" },
          });
        }

        respondError(
          id,
          script.interruptError.code,
          script.interruptError.message,
        );

        return;
      }

      if (lateStartTurnIdsByThreadId.has(params.threadId)) {
        respondError(id, -32600, "no active turn to interrupt");

        return;
      }

      const pendingTurnId = pendingStartTurnIdsByThreadId.get(params.threadId);

      if (pendingTurnId !== undefined) {
        pendingStartTurnIdsByThreadId.delete(params.threadId);
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: pendingTurnId, status: "interrupted" },
        });
        notify("turn/started", {
          threadId: params.threadId,
          turn: { id: pendingTurnId, status: "inProgress" },
        });
        respond(id, {});

        return;
      }

      const openTurnId = openTurnIdsByThreadId.get(params.threadId);

      if (openTurnId !== undefined) {
        openTurnIdsByThreadId.delete(params.threadId);
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: openTurnId, status: "interrupted" },
        });
      } else if (script?.rejectIdleInterrupt) {
        respondError(id, -32600, "no active turn to interrupt");

        return;
      }

      respond(id, {});

      return;
    }

    case "thread/archive":
      if (isThreadArchived(params.threadId)) {
        respondError(
          id,
          -32603,
          `no rollout found for thread id ${params.threadId}`,
        );

        return;
      }

      setThreadArchived(params.threadId, true);
      respond(id, {});

      return;
    case "thread/unarchive":
      if (!isThreadArchived(params.threadId)) {
        respondError(
          id,
          -32603,
          `no archived rollout found for thread id ${params.threadId}`,
        );

        return;
      }

      setThreadArchived(params.threadId, false);
      respond(id, {});

      return;
    case "thread/name/set":
      if (renameEmptyRolloutFailuresLeft > 0) {
        renameEmptyRolloutFailuresLeft -= 1;
        respondError(
          id,
          -32603,
          `failed to set thread name: rollout at /tmp/${params.threadId}.jsonl is empty`,
        );

        return;
      }

      respond(id, {});

      return;
    case "thread/compact/start":
      if (COMPACTION_MODE === "idle-before-rejection") {
        notify("thread/status/changed", {
          threadId: params.threadId,
          status: { type: "idle" },
        });
        setTimeout(() => respondError(id, -32600, "compaction rejected"), 30);

        return;
      }

      if (
        COMPACTION_MODE === "idle-before-response" ||
        COMPACTION_MODE === "error-before-response"
      ) {
        notify("thread/status/changed", {
          threadId: params.threadId,
          status: {
            type:
              COMPACTION_MODE === "idle-before-response"
                ? "idle"
                : "systemError",
          },
        });
        setTimeout(() => respond(id, {}), 30);

        return;
      }

      respond(id, {});
      runCompaction(params.threadId);

      return;
    case "thread/settings/update":
      respond(id, {});

      return;
    case "thread/inject_items":
      respond(id, {});

      return;
    case "turn/settings/update":
      if (!process.argv.includes("features.step_model_switching=true")) {
        respondError(
          id,
          -32600,
          "turn settings updates require the step_model_switching feature",
        );

        return;
      }

      respond(id, {
        status:
          openTurnIdsByThreadId.get(params.threadId) === params.turnId
            ? "applied"
            : "targetUnavailable",
      });

      return;
    case "thread/goal/clear":
      if (script?.goalClearError) {
        respondError(id, -32600, script.goalClearError);
      } else {
        respond(id, script?.goalClearResult ?? { cleared: true });
      }

      return;
    default:
      respondError(id, -32601, `Unknown method "${method}"`);
  }
}

const stdinLines = createInterface({ input: process.stdin, terminal: false });

stdinLines.on("line", (line) => {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  let parsed;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return;
  }

  if (parsed.id !== undefined && typeof parsed.method === "string") {
    void handleRequest(parsed);

    return;
  }

  if (parsed.id !== undefined) {
    const resolve = pendingOutboundRequests.get(parsed.id);

    if (resolve) {
      pendingOutboundRequests.delete(parsed.id);

      if (responseLogPath !== null) {
        appendFileSync(responseLogPath, `${JSON.stringify(parsed)}\n`);
      }

      resolve(parsed);
    }
  }
});

stdinLines.on("close", () => {
  logProcessStep("stdin-close");

  if (stdinCloseDelayMs > 0 && servesThread) {
    setTimeout(exitCleanly, stdinCloseDelayMs);

    return;
  }

  exitCleanly();
});
