import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  listEvents,
  listQueuedThreadMessages,
  submissionReceipts,
} from "@omnyo/db";
import { threadScope } from "@omnyo/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@omnyo/host-daemon-contract";
import {
  submissionContractSchema,
  submissionReceiptSchema,
} from "@omnyo/server-contract";
import { expect, it } from "vitest";
import { z } from "zod";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createTestDb,
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

const BATCHES_PER_SOURCE = 12;

const EVENTS_PER_BATCH = 100;

const LOCK_HOLD_MS = 6_000;

const PROBE_INTERVAL_MS = 50;

const RESPONSE_BOUND_MS = 1_000;

const RETRY_DELAY_MS = 500;

const SUBMISSIONS_PER_SENDER = 3;

const peerPath = fileURLToPath(
  new URL("./ingress-lock-burst-peer.mjs", import.meta.url),
);

const sampleSchema = z.object({
  at: z.number(),
  durationMs: z.number(),
  ok: z.boolean().optional(),
});

const observedSchema = z.object({
  type: z.literal("observed"),
  health: z.array(sampleSchema),
  pongs: z.array(sampleSchema),
  unanswered: z.number(),
  errors: z.array(z.string()),
});

const peerMarkSchema = z.object({ type: z.string(), at: z.number() });

const batchBodySchema = z.object({
  acceptedEvents: z.array(z.unknown()).optional(),
  code: z.string().optional(),
  duplicateEvents: z.number().optional(),
  retryable: z.boolean().optional(),
});

const submissionRefusalSchema = z.object({
  code: z.string().optional(),
  retryable: z.boolean().optional(),
});

type Sample = z.infer<typeof sampleSchema>;

interface Source {
  hostId: string;
  sessionId: string;
  threadId: string;
}

interface Attempt {
  code: string | null;
  elapsedMs: number;
  retryable: boolean | null;
  status: number;
}

interface BatchAttempt extends Attempt {
  accepted: number | null;
  duplicateEvents: number | null;
}

interface SubmissionAttempt extends Attempt {
  queuedMessageId: string | null;
  replayed: boolean | null;
}

interface Submission {
  message: number;
  submissionId: string;
  threadId: string;
}

interface Window {
  from: number;
  to: number;
}

function burstEvents(source: Source, batch: number): HostDaemonEventEnvelope[] {
  return Array.from({ length: EVENTS_PER_BATCH }, (_, index) => ({
    threadId: source.threadId,
    event: {
      type: "system/error",
      threadId: source.threadId,
      scope: threadScope(),
      message: `burst ${batch * EVENTS_PER_BATCH + index + 1}`,
    },
  }));
}

async function postBatch(
  server: RunningTestServer,
  source: Source,
  batch: number,
): Promise<BatchAttempt> {
  const startedAt = performance.now();

  const response = await fetch(`${server.baseUrl}/internal/session/events`, {
    method: "POST",
    headers: internalAuthHeaders(server, { hostId: source.hostId }),
    body: JSON.stringify({
      sessionId: source.sessionId,
      eventGroups: groupHostDaemonEvents(burstEvents(source, batch)),
      firstEventIndex: batch * EVENTS_PER_BATCH + 1,
    }),
  });

  const body = batchBodySchema.parse(await response.json());

  return {
    accepted: body.acceptedEvents?.length ?? null,
    code: body.code ?? null,
    duplicateEvents: body.duplicateEvents ?? null,
    elapsedMs: performance.now() - startedAt,
    retryable: body.retryable ?? null,
    status: response.status,
  };
}

async function retryUntilAccepted<TAttempt extends Attempt>(
  post: () => Promise<TAttempt>,
): Promise<TAttempt[]> {
  const attempts: TAttempt[] = [];

  for (;;) {
    const attempt = await post();
    attempts.push(attempt);

    if (attempt.status === 200) {
      return attempts;
    }

    await sleep(RETRY_DELAY_MS);
  }
}

function seedSenderThread(server: RunningTestServer, id: string): string {
  const { environment, thread } = seedThreadFixture(server, {
    session: { id },
    thread: { status: "active" },
  });

  seedThreadRuntimeState(server.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: `provider-${id}`,
  });
  seedTurnStarted(server.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${id}`,
    threadId: thread.id,
    turnId: "turn-current",
  });

  return thread.id;
}

async function readStoreId(server: RunningTestServer): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/submissions/contract`);

  return submissionContractSchema.parse(await response.json()).storeId;
}

async function postSubmission(
  server: RunningTestServer,
  storeId: string,
  submission: Submission,
): Promise<SubmissionAttempt> {
  const startedAt = performance.now();

  const response = await fetch(`${server.baseUrl}/api/v1/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      submissionId: submission.submissionId,
      storeId,
      action: {
        kind: "thread-message",
        threadId: submission.threadId,
        message: {
          input: [
            {
              type: "text",
              text: `send ${submission.message + 1}`,
              mentions: [],
            },
          ],
        },
      },
      attachments: [],
    }),
  });

  const payload: unknown = await response.json();
  const elapsedMs = performance.now() - startedAt;

  if (response.status === 200) {
    const receipt = submissionReceiptSchema.parse(payload);

    return {
      code: null,
      elapsedMs,
      queuedMessageId: receipt.queuedMessageId,
      replayed: receipt.replayed,
      retryable: null,
      status: response.status,
    };
  }

  const body = submissionRefusalSchema.parse(payload);

  return {
    code: body.code ?? null,
    elapsedMs,
    queuedMessageId: null,
    replayed: null,
    retryable: body.retryable ?? null,
    status: response.status,
  };
}

function senderSubmissions(threadId: string, sender: number): Submission[] {
  return Array.from({ length: SUBMISSIONS_PER_SENDER }, (_, message) => ({
    message,
    submissionId: `sub_${String(
      sender * SUBMISSIONS_PER_SENDER + message + 1,
    ).padStart(32, "0")}`,
    threadId,
  }));
}

function summarizeRefusals(attempts: readonly Attempt[]) {
  const refusals = attempts.filter((attempt) => attempt.status !== 200);

  return {
    refusalCodes: [...new Set(refusals.map((attempt) => attempt.code))],
    refusalMaxMs: Math.round(
      refusals.reduce((max, attempt) => Math.max(max, attempt.elapsedMs), 0),
    ),
    refusalStatuses: [...new Set(refusals.map((attempt) => attempt.status))],
    refusals: refusals.length,
    unretryableRefusals: refusals.filter(
      (attempt) => attempt.retryable !== true,
    ).length,
  };
}

function waitForPeerMessage(worker: Worker, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === type
      ) {
        worker.off("message", onMessage);
        resolve(message);
      }
    };

    worker.on("message", onMessage);
    worker.once("error", reject);
  });
}

function summarize(samples: Sample[], window: Window) {
  const inWindow = samples.filter(
    (sample) => sample.at >= window.from && sample.at <= window.to,
  );

  return {
    failed: inWindow.filter((sample) => sample.ok === false).length,
    maxMs: Math.round(
      inWindow.reduce((max, sample) => Math.max(max, sample.durationMs), 0),
    ),
    samples: inWindow.length,
  };
}

function storedBurstOrder(server: RunningTestServer, source: Source): number[] {
  return listEvents(server.db, { threadId: source.threadId })
    .filter((row) => row.type === "system/error")
    .map((row) =>
      Number(
        z
          .object({ message: z.string() })
          .parse(JSON.parse(row.data))
          .message.replace("burst ", ""),
      ),
    );
}

it("keeps health and browser pongs under one second during an ingress burst and a held primary lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnyo-ingress-burst-"));
  const file = join(directory, "omnyo.db");
  const template = createTestDb();
  await writeFile(file, template.$client.serialize());
  template.$client.close();

  const server = await startTestServer({ databaseSource: file });
  const require = createRequire(import.meta.url);

  const sources: Source[] = ["host-burst-a", "host-burst-b"].map((id) => {
    const { host, session, thread } = seedThreadFixture(server, {
      session: { id },
    });

    return { hostId: host.id, sessionId: session.id, threadId: thread.id };
  });

  const senders = ["host-send-a", "host-send-b"].map((id, sender) =>
    senderSubmissions(seedSenderThread(server, id), sender),
  );

  const storeId = await readStoreId(server);

  const probe = new Worker(peerPath, {
    workerData: {
      kind: "probe",
      healthUrl: `${server.baseUrl}/health`,
      intervalMs: PROBE_INTERVAL_MS,
      origin: server.baseUrl,
      websocketUrl: `${server.baseUrl.replace("http", "ws")}/ws`,
      wsModule: require.resolve("ws"),
    },
  });

  let reading = true;
  const readStatuses = new Set<number>();

  const reads = (async () => {
    while (reading) {
      for (const source of sources) {
        const response = await fetch(
          `${server.baseUrl}/api/v1/threads/${source.threadId}`,
        );

        await response.arrayBuffer();
        readStatuses.add(response.status);
      }

      await sleep(20);
    }
  })();

  try {
    await waitForPeerMessage(probe, "ready");

    const idle: Window = { from: Date.now(), to: 0 };
    await sleep(500);
    idle.to = Date.now();

    const burst: Window = { from: Date.now(), to: 0 };

    const burstAttempts = await Promise.all(
      sources.map(async (source) => {
        const attempts: BatchAttempt[] = [];

        for (let batch = 0; batch < BATCHES_PER_SOURCE; batch += 1) {
          attempts.push(await postBatch(server, source, batch));
        }

        return attempts;
      }),
    );

    burst.to = Date.now();

    const lock = new Worker(peerPath, {
      workerData: {
        kind: "lock",
        databasePath: file,
        holdMs: LOCK_HOLD_MS,
        sqliteModule: fileURLToPath(import.meta.resolve("better-sqlite3")),
      },
    });

    const released = waitForPeerMessage(lock, "released");

    const locked = peerMarkSchema.parse(
      await waitForPeerMessage(lock, "locked"),
    );

    const [lockedAttempts, submissionAttempts] = await Promise.all([
      Promise.all(
        sources.map((source) =>
          retryUntilAccepted(() =>
            postBatch(server, source, BATCHES_PER_SOURCE),
          ),
        ),
      ),
      Promise.all(
        senders.map(async (submissions) => {
          const attempts: SubmissionAttempt[][] = [];

          for (const submission of submissions) {
            attempts.push(
              await retryUntilAccepted(() =>
                postSubmission(server, storeId, submission),
              ),
            );
          }

          return attempts;
        }),
      ),
    ]);

    const held: Window = {
      from: locked.at,
      to: peerMarkSchema.parse(await released).at,
    };

    reading = false;
    await reads;
    probe.postMessage("stop");

    const observed = observedSchema.parse(
      await waitForPeerMessage(probe, "observed"),
    );

    const replays = await Promise.all(
      senders.map((submissions) =>
        Promise.all(
          submissions.map((submission) =>
            postSubmission(server, storeId, submission),
          ),
        ),
      ),
    );

    const submissionsAcceptedOnce = senders.map((submissions, sender) =>
      submissions.map((_, message) => {
        const accepted = (submissionAttempts[sender]?.[message] ?? []).filter(
          (attempt) => attempt.status === 200,
        );

        const replay = replays[sender]?.[message];

        return (
          accepted.length === 1 &&
          accepted[0]?.replayed === false &&
          replay?.status === 200 &&
          replay.replayed === true &&
          replay.queuedMessageId === accepted[0].queuedMessageId
        );
      }),
    );

    const queuedInOrder = senders.map((submissions, sender) => {
      const threadId = submissions[0]?.threadId ?? "";

      return (
        JSON.stringify(
          listQueuedThreadMessages(server.db, threadId).map((row) => row.id),
        ) ===
        JSON.stringify(
          (submissionAttempts[sender] ?? []).map(
            (attempts) => attempts.at(-1)?.queuedMessageId,
          ),
        )
      );
    });

    const expectedOrder = Array.from(
      { length: (BATCHES_PER_SOURCE + 1) * EVENTS_PER_BATCH },
      (_, index) => index + 1,
    );

    const report = {
      burst: {
        elapsedMs: burst.to - burst.from,
        health: summarize(observed.health, burst),
        pongs: summarize(observed.pongs, burst),
        rejectedBatches: burstAttempts
          .flat()
          .filter(
            (attempt) =>
              attempt.status !== 200 || attempt.accepted !== EVENTS_PER_BATCH,
          ).length,
      },
      held: {
        acceptedAfterRelease: lockedAttempts.map((attempts) => {
          const last = attempts.at(-1);

          return {
            accepted: last?.accepted,
            duplicateEvents: last?.duplicateEvents,
          };
        }),
        events: summarizeRefusals(lockedAttempts.flat()),
        health: summarize(observed.health, held),
        heldMs: held.to - held.from,
        pongs: summarize(observed.pongs, held),
        submissions: {
          ...summarizeRefusals(submissionAttempts.flat(2)),
          acceptedOnce: submissionsAcceptedOnce,
          queuedInOrder,
          receipts: server.db.select().from(submissionReceipts).all().length,
        },
      },
      idle: {
        health: summarize(observed.health, idle),
        pongs: summarize(observed.pongs, idle),
      },
      probeErrors: observed.errors,
      readStatuses: [...readStatuses],
      storedInOrder: sources.map(
        (source) =>
          JSON.stringify(storedBurstOrder(server, source)) ===
          JSON.stringify(expectedOrder),
      ),
      unansweredPings: observed.unanswered,
    };

    if (process.env.INGRESS_LOCK_BURST_REPORT !== undefined) {
      await writeFile(
        process.env.INGRESS_LOCK_BURST_REPORT,
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }

    const phases = [report.idle, report.burst, report.held];

    expect({
      acceptedAfterRelease: report.held.acceptedAfterRelease,
      failedProbes: phases.map(
        (phase) => phase.health.failed + phase.pongs.failed,
      ),
      probeErrors: report.probeErrors,
      probesWithinBound: phases.map(
        (phase) =>
          phase.health.samples > 0 &&
          phase.pongs.samples > 0 &&
          phase.health.maxMs < RESPONSE_BOUND_MS &&
          phase.pongs.maxMs < RESPONSE_BOUND_MS,
      ),
      readStatuses: report.readStatuses,
      refusals: [report.held.events, report.held.submissions].map(
        (refusals) => ({
          codes: refusals.refusalCodes,
          refused: refusals.refusals > 0,
          statuses: refusals.refusalStatuses,
          unretryable: refusals.unretryableRefusals,
          withinBound: refusals.refusalMaxMs < RESPONSE_BOUND_MS,
        }),
      ),
      rejectedBatches: report.burst.rejectedBatches,
      storedInOrder: report.storedInOrder,
      submissions: {
        acceptedOnce: report.held.submissions.acceptedOnce,
        queuedInOrder: report.held.submissions.queuedInOrder,
        receipts: report.held.submissions.receipts,
      },
      unansweredPings: report.unansweredPings,
    }).toEqual({
      acceptedAfterRelease: [
        { accepted: EVENTS_PER_BATCH, duplicateEvents: 0 },
        { accepted: EVENTS_PER_BATCH, duplicateEvents: 0 },
      ],
      failedProbes: [0, 0, 0],
      probeErrors: [],
      probesWithinBound: [true, true, true],
      readStatuses: [200],
      refusals: [
        {
          codes: ["coordinator_busy"],
          refused: true,
          statuses: [503],
          unretryable: 0,
          withinBound: true,
        },
        {
          codes: ["coordinator_busy"],
          refused: true,
          statuses: [503],
          unretryable: 0,
          withinBound: true,
        },
      ],
      rejectedBatches: 0,
      storedInOrder: [true, true],
      submissions: {
        acceptedOnce: senders.map((submissions) => submissions.map(() => true)),
        queuedInOrder: [true, true],
        receipts: senders.length * SUBMISSIONS_PER_SENDER,
      },
      unansweredPings: 0,
    });
  } finally {
    reading = false;
    await reads.catch(() => undefined);
    await probe.terminate();
    await server.close();
    server.db.$client.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
