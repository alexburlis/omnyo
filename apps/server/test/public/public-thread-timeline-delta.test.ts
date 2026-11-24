import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createOmnyoSdk } from "@omnyo/sdk/core";
import { createHttpTransport } from "@omnyo/sdk/node";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  type Thread,
} from "@omnyo/domain";
import { createConnection, getAppSettings } from "@omnyo/db";
import {
  applyTimelineDelta,
  maintenanceStatusSchema,
  threadTimelineResponseSchema,
  type ThreadTimelineResponse,
  type TimelineRow,
} from "@omnyo/server-contract";
import { countTimelineSelectionMemoEntries } from "../../src/services/threads/timeline-selection-memo.js";
import { readJson } from "../helpers/json.js";
import {
  seedEvent,
  seedPrimaryHost,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { startTestServer, withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import {
  buildRouteTimelinePage,
  latestTimelinePage,
} from "../provider-corpus/corpus-harness.js";

async function getTimeline(
  harness: TestAppHarness,
  threadId: string,
  afterSequence?: number,
  appendOptions?: { afterRevision?: string },
): Promise<ThreadTimelineResponse> {
  const params = new URLSearchParams();

  if (afterSequence !== undefined) {
    params.set("afterSequence", String(afterSequence));
  }

  if (appendOptions !== undefined) {
    params.set("deltaFormat", "assistant-text-append-v1");

    if (appendOptions.afterRevision !== undefined) {
      params.set("afterRevision", appendOptions.afterRevision);
    }
  }

  const url = `/api/v1/threads/${threadId}/timeline?${params}`;
  const response = await harness.app.request(url);

  if (response.status !== 200) {
    throw new Error(
      `timeline ${url} -> ${response.status}: ${await response.text()}`,
    );
  }

  return threadTimelineResponseSchema.parse(await readJson(response));
}

function buildColdLatestRows(
  harness: TestAppHarness,
  thread: Thread,
): TimelineRow[] {
  const clone = createConnection(harness.deps.db.$client.serialize());

  try {
    return buildRouteTimelinePage({
      db: clone,
      eventBudget: harness.deps.config.featureFlags.timelineWindowEventBudget,
      includeDiagnosticOperations: getAppSettings(clone).showDiagnosticEvents,
      page: latestTimelinePage(),
      registry: harness.deps.providerRegistry,
      thread,
      variant: "default",
    }).response.rows;
  } finally {
    clone.$client.close();
  }
}

function assistantText(rows: readonly TimelineRow[]): string | null {
  for (const row of rows) {
    if (row.kind === "conversation" && row.role === "assistant") {
      return row.text;
    }

    if (row.kind === "turn" && row.children !== null) {
      const nested = assistantText(row.children);

      if (nested !== null) return nested;
    }
  }

  return null;
}

describe("GET /threads/:id/timeline?afterSequence (row-patch delta)", () => {
  it.each([false, true])(
    "replaces delivered text when credentials are recognized later (capable=%s)",
    async (capableMode) => {
      await withTestHarness(async (harness) => {
        const { environment, thread } = seedThreadFixture(harness, {
          thread: { status: "active" },
        });

        const turn = {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "p1",
          scope: turnScope("turn-1"),
        } as const;

        const firstValue = "synthetic-first-history-value";
        const secondValue = "synthetic-second-history-value";
        seedThreadRuntimeState(harness.deps, turn);
        seedTurnStarted(harness.deps, { ...turn, turnId: "turn-1" });
        seedEvent(harness.deps, {
          ...turn,
          sequence: 4,
          type: "turn/input/accepted",
          data: {
            clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          },
        });
        seedEvent(harness.deps, {
          ...turn,
          sequence: 5,
          type: "item/started",
          data: { item: { type: "agentMessage", id: "assistant-1", text: "" } },
        });
        seedEvent(harness.deps, {
          ...turn,
          sequence: 6,
          type: "item/agentMessage/delta",
          data: {
            itemId: "assistant-1",
            delta: `${firstValue} ${secondValue}\n`,
          },
        });

        const before = await getTimeline(
          harness,
          thread.id,
          undefined,
          capableMode ? {} : undefined,
        );

        const entries = [
          {
            name: "SYNTHETIC_TOKEN",
            source: "shell" as const,
            value: firstValue,
          },
        ];

        seedEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: turn.providerThreadId,
          sequence: 7,
          scope: threadScope(),
          type: "provider.env-resolved",
          data: { entries },
        });

        const reconcile = async (
          previous: ThreadTimelineResponse,
        ): Promise<ThreadTimelineResponse> => {
          const response = await getTimeline(
            harness,
            thread.id,
            previous.maxSeq,
            capableMode ? { afterRevision: previous.revision } : undefined,
          );

          const rows =
            response.delta === undefined
              ? response.rows
              : applyTimelineDelta(
                  previous.rows,
                  response.delta,
                  previous.revision,
                );

          expect(rows).not.toBeNull();
          const full = await getTimeline(harness, thread.id);
          expect(rows).toEqual(full.rows);
          expect(JSON.stringify(rows)).not.toContain(firstValue);

          return { ...response, rows: rows! };
        };

        const after = await reconcile(before);
        entries.push({
          name: "SYNTHETIC_SECOND_TOKEN",
          source: "shell",
          value: secondValue,
        });
        harness.deps.db.$client
          .prepare(
            "UPDATE events SET data = ? WHERE thread_id = ? AND sequence = 7",
          )
          .run(JSON.stringify({ entries }), thread.id);
        const sameSequence = await reconcile(after);
        expect(sameSequence.maxSeq).toBe(after.maxSeq);
        expect(JSON.stringify(sameSequence.rows)).not.toContain(secondValue);
      });
    },
  );

  it("reconstructs a long streaming turn through the actual HTTP route and SDK", async () => {
    const server = await startTestServer();

    const measurements: {
      deltaCount: number;
      mode: string;
      sample: number;
      wallMs: number;
      cpuMs: number;
      bytes: number;
      appendOperations: number;
    }[] = [];

    let responseBytes = 0;

    const sdk = createOmnyoSdk({
      transport: createHttpTransport({
        baseUrl: server.baseUrl,
        runtime: "node",
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          const body = await response.text();
          responseBytes = Buffer.byteLength(body);

          return new Response(body, {
            status: response.status,
            headers: response.headers,
          });
        },
      }),
    });

    try {
      for (const deltaCount of [8_000, 24_000]) {
        const { environment, thread } = seedThreadFixture(server, {
          thread: { status: "active" },
        });

        const turn = {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "p1",
          scope: turnScope("turn-1"),
        } as const;

        seedThreadRuntimeState(server.deps, turn);
        seedTurnStarted(server.deps, { ...turn, turnId: "turn-1" });
        seedEvent(server.deps, {
          ...turn,
          sequence: 4,
          type: "turn/input/accepted",
          data: {
            clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          },
        });
        seedEvent(server.deps, {
          ...turn,
          sequence: 5,
          type: "item/started",
          data: { item: { type: "agentMessage", id: "assistant-1", text: "" } },
        });
        let sequence = 5;

        const insert = server.deps.db.$client.prepare(
          "INSERT INTO events (id,thread_id,scope_kind,turn_id,provider_thread_id,sequence,type,item_id,item_kind,data,created_at) VALUES (?,?,'turn','turn-1','p1',?,'item/agentMessage/delta','assistant-1',NULL,?,?)",
        );

        const append = (text: string): void => {
          sequence += 1;
          insert.run(
            `stream-${thread.id}-${sequence}`,
            thread.id,
            sequence,
            JSON.stringify({ itemId: "assistant-1", delta: text }),
            sequence,
          );
        };

        server.deps.db.$client.transaction(() => {
          for (let index = 0; index < deltaCount; index += 1) {
            append("Synthetic benchmark text.\n");
          }
        })();
        let legacy = await sdk.threads.timeline({ threadId: thread.id });

        let capable = await sdk.threads.timeline({
          threadId: thread.id,
          deltaFormat: "assistant-text-append-v1",
        });

        for (let sample = 0; sample < 12; sample += 1) {
          append("next\n");

          for (const mode of ["capable", "legacy"] as const) {
            const previous = mode === "capable" ? capable : legacy;
            const cpuStart = process.cpuUsage();
            const startedAt = performance.now();

            const request: Parameters<typeof sdk.threads.timeline>[0] = {
              threadId: thread.id,
              afterSequence: String(previous.maxSeq),
            };

            if (mode === "capable") {
              request.deltaFormat = "assistant-text-append-v1";
              request.afterRevision = previous.revision;
            }

            const tick = await sdk.threads.timeline(request);

            const wallMs = performance.now() - startedAt;
            const cpu = process.cpuUsage(cpuStart);
            measurements.push({
              deltaCount,
              mode,
              sample,
              wallMs,
              cpuMs: (cpu.user + cpu.system) / 1_000,
              bytes: responseBytes,
              appendOperations: tick.delta?.assistantTextAppends?.length ?? 0,
            });

            const rows =
              tick.delta === undefined
                ? tick.rows
                : applyTimelineDelta(
                    previous.rows,
                    tick.delta,
                    previous.revision,
                  );

            expect(rows).not.toBeNull();
            expect(assistantText(rows!)).toBe(
              "Synthetic benchmark text.\n".repeat(deltaCount) +
                "next\n".repeat(sample + 1),
            );

            if (mode === "capable") capable = { ...tick, rows: rows! };
            else legacy = { ...tick, rows: rows! };
          }

          expect(capable.rows).toEqual(legacy.rows);
        }

        expect(legacy.rows).toEqual(
          (await sdk.threads.timeline({ threadId: thread.id })).rows,
        );
      }

      const output = process.env.OMNYO_TIMELINE_MEASUREMENT_OUTPUT;

      if (output !== undefined) {
        await writeFile(
          output,
          `${JSON.stringify(
            {
              surface:
                "isolated local HTTP + SDK + response capture; synthetic SQLite history; process CPU includes request parsing and capture",
              node: process.version,
              eventBudget:
                server.deps.config.featureFlags.timelineWindowEventBudget,
              measurements,
            },
            null,
            2,
          )}\n`,
        );
      }
    } finally {
      await server.close();
    }
  }, 30_000);

  it("negotiates sanitized assistant suffixes without changing legacy clients", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });

      const turn = {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "p1",
        scope: turnScope("turn-1"),
      } as const;

      seedThreadRuntimeState(harness.deps, turn);
      seedTurnStarted(harness.deps, { ...turn, turnId: "turn-1" });
      seedEvent(harness.deps, {
        ...turn,
        sequence: 4,
        type: "turn/input/accepted",
        data: {
          clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        },
      });
      seedEvent(harness.deps, {
        ...turn,
        sequence: 5,
        type: "item/started",
        data: { item: { type: "agentMessage", id: "assistant-1", text: "" } },
      });
      seedEvent(harness.deps, {
        ...turn,
        sequence: 6,
        createdAt: 6,
        type: "item/agentMessage/delta",
        data: { itemId: "assistant-1", delta: "A visible first line.\n" },
      });
      const capable = await getTimeline(harness, thread.id, undefined, {});
      const legacy = await getTimeline(harness, thread.id);
      expect(capable.revision).toEqual(expect.any(String));
      expect(legacy.revision).toBeUndefined();

      seedEvent(harness.deps, {
        ...turn,
        sequence: 7,
        createdAt: 7,
        type: "item/agentMessage/delta",
        data: { itemId: "assistant-1", delta: "next\n" },
      });

      const tick = await getTimeline(harness, thread.id, capable.maxSeq, {
        afterRevision: capable.revision,
      });

      expect(tick.delta?.baseRevision).toBe(capable.revision);
      expect(tick.delta?.assistantTextAppends).toEqual([
        expect.objectContaining({
          appendText: "next\n",
          sourceSeqEnd: 7,
          createdAt: 7,
          messageSeq: 7,
        }),
      ]);
      expect(tick.delta?.upsertRows).toHaveLength(0);
      const legacyTick = await getTimeline(harness, thread.id, legacy.maxSeq);
      expect(legacyTick.delta?.assistantTextAppends).toBeUndefined();
      expect(legacyTick.delta?.baseRevision).toBeUndefined();
      expect(legacyTick.delta?.upsertRows.length).toBeGreaterThan(0);
      const fresh = await getTimeline(harness, thread.id);
      expect(
        applyTimelineDelta(capable.rows, tick.delta!, capable.revision),
      ).toEqual(fresh.rows);
      expect(applyTimelineDelta(legacy.rows, legacyTick.delta!)).toEqual(
        fresh.rows,
      );

      const wrongBase = await getTimeline(harness, thread.id, capable.maxSeq, {
        afterRevision: "not-a-delivered-revision",
      });

      expect(wrongBase.delta).toBeUndefined();
      expect(wrongBase.rows).toEqual(fresh.rows);
    });
  });

  it("a full fetch carries no delta and echoes maxSeq", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "hello" },
      });

      const full = await getTimeline(harness, thread.id);
      expect(full.delta).toBeUndefined();
      expect(full.rows.length).toBeGreaterThan(0);
      expect(full.maxSeq).toBe(1);
    });
  });

  it("delta + merge reproduces a fresh full window when rows are appended", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "p1",
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "p1",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            type: "toolCall",
            id: "tool-1",
            tool: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed",
          },
        },
      });

      const before = await getTimeline(harness, thread.id);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "p1",
        scope: turnScope("turn-1"),
        sequence: 3,
        type: "item/completed",
        data: {
          item: { type: "agentMessage", id: "assistant-1", text: "Done." },
        },
      });

      const delta = await getTimeline(harness, thread.id, before.maxSeq);
      expect(delta.delta).toBeDefined();
      expect(delta.rows).toHaveLength(0);
      expect(delta.maxSeq).toBe(3);
      expect(delta.delta!.upsertRows.length).toBeGreaterThan(0);

      const merged = applyTimelineDelta(before.rows, delta.delta!);
      const fresh = await getTimeline(harness, thread.id);
      expect(merged).toEqual(fresh.rows);
    });
  });

  it("delta + merge reproduces a fresh full window when a turn completes (collapse)", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      const turn = {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "p1",
        scope: turnScope("turn-1"),
      } as const;

      seedEvent(harness.deps, {
        ...turn,
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        ...turn,
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            type: "toolCall",
            id: "tool-1",
            tool: "exec_command",
            arguments: { cmd: "ls" },
            status: "completed",
          },
        },
      });
      seedEvent(harness.deps, {
        ...turn,
        sequence: 3,
        type: "item/completed",
        data: {
          item: { type: "agentMessage", id: "assistant-1", text: "First." },
        },
      });

      const before = await getTimeline(harness, thread.id);

      seedEvent(harness.deps, {
        ...turn,
        sequence: 4,
        type: "turn/completed",
        data: { status: "completed" },
      });

      const delta = await getTimeline(harness, thread.id, before.maxSeq);
      expect(delta.delta).toBeDefined();

      const merged = applyTimelineDelta(before.rows, delta.delta!);
      const fresh = await getTimeline(harness, thread.id);
      expect(merged).not.toBeNull();
      expect(merged).toEqual(fresh.rows);
      expect(fresh.rows).not.toEqual(before.rows);
      const beforeIds = new Set(before.rows.map((row) => row.id));
      const freshIds = new Set(fresh.rows.map((row) => row.id));
      expect([...beforeIds].some((id) => !freshIds.has(id))).toBe(true);
    });
  });

  it("two interleaved clients both receive deltas (snapshot ring per params key)", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      const turn = {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "p1",
        scope: turnScope("turn-1"),
      } as const;

      let sequence = 0;

      const appendMessage = (text: string): void => {
        sequence += 1;
        seedEvent(harness.deps, {
          ...turn,
          sequence,
          type: "item/completed",
          data: {
            item: { type: "agentMessage", id: `assistant-${sequence}`, text },
          },
        });
      };

      sequence += 1;
      seedEvent(harness.deps, {
        ...turn,
        sequence,
        type: "turn/started",
        data: {},
      });
      appendMessage("one");

      const desktop = await getTimeline(harness, thread.id);
      const phone = desktop;

      appendMessage("two");
      const desktopAt3 = await getTimeline(harness, thread.id, desktop.maxSeq);
      expect(desktopAt3.delta).toBeDefined();
      appendMessage("three");

      const desktopAt4 = await getTimeline(
        harness,
        thread.id,
        desktopAt3.maxSeq,
      );

      expect(desktopAt4.delta).toBeDefined();

      const phoneAt4 = await getTimeline(harness, thread.id, phone.maxSeq);
      expect(phoneAt4.maxSeq).toBe(4);
      expect(phoneAt4.rows).toHaveLength(0);
      expect(phoneAt4.delta).toBeDefined();
      const merged = applyTimelineDelta(phone.rows, phoneAt4.delta!);
      const fresh = await getTimeline(harness, thread.id);
      expect(merged).toEqual(fresh.rows);

      for (const text of ["four", "five", "six", "seven"]) {
        appendMessage(text);
        const polled = await getTimeline(harness, thread.id, sequence - 1);
        expect(polled.delta).toBeDefined();
      }

      const evicted = await getTimeline(harness, thread.id, 2);
      expect(evicted.delta).toBeUndefined();
      expect(evicted.rows.length).toBeGreaterThan(0);
    });
  });

  it("streaming deltas: delta + merge equals a cold window on invisible and visible ticks", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });

      const turn = {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "p1",
        scope: turnScope("turn-1"),
      } as const;

      seedThreadRuntimeState(harness.deps, turn);
      seedTurnStarted(harness.deps, { ...turn, turnId: "turn-1" });
      seedEvent(harness.deps, {
        ...turn,
        sequence: 4,
        type: "turn/input/accepted",
        data: {
          clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        },
      });
      seedEvent(harness.deps, {
        ...turn,
        sequence: 5,
        type: "item/started",
        data: { item: { type: "agentMessage", id: "assistant-1", text: "" } },
      });

      let before = await getTimeline(harness, thread.id);
      let streamed = "";

      for (const chunk of [
        "Roses",
        " are red",
        "\nViolets",
        " are",
        " blue\n",
        "Sugar",
      ]) {
        streamed += chunk;
        seedEvent(harness.deps, {
          ...turn,
          sequence: before.maxSeq + 1,
          type: "item/agentMessage/delta",
          data: { itemId: "assistant-1", delta: chunk },
        });

        const tick = await getTimeline(harness, thread.id, before.maxSeq);
        expect(tick.maxSeq).toBe(before.maxSeq + 1);
        expect(tick.delta).toBeDefined();
        const merged = applyTimelineDelta(before.rows, tick.delta!) ?? [];
        expect(merged).toEqual(buildColdLatestRows(harness, thread));
        expect(assistantText(merged) ?? "").toBe(
          streamed.slice(0, streamed.lastIndexOf("\n") + 1),
        );
        before = { ...tick, rows: merged };
      }

      expect(
        countTimelineSelectionMemoEntries(harness.deps.db),
      ).toBeGreaterThan(0);
    });
  });

  it("answers every viewer of a compacted thread with a full window at the unchanged sequence", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "before compaction" },
      });
      const before = await getTimeline(harness, thread.id);
      expect(JSON.stringify(before.rows)).toContain("before compaction");

      harness.deps.db.$client
        .prepare(
          "UPDATE events SET data = ? WHERE thread_id = ? AND sequence = 1",
        )
        .run(JSON.stringify({ text: "after compaction" }), thread.id);
      harness.deps.hub.notifyThread(thread.id, ["history-compacted"]);

      const firstViewer = await getTimeline(harness, thread.id, before.maxSeq);
      const secondViewer = await getTimeline(harness, thread.id, before.maxSeq);

      for (const after of [firstViewer, secondViewer]) {
        expect(after.maxSeq).toBe(before.maxSeq);
        expect(after.delta).toBeUndefined();
        expect(JSON.stringify(after.rows)).toContain("after compaction");
      }

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "next" },
      });
      const caughtUp = await getTimeline(harness, thread.id, before.maxSeq);
      expect(caughtUp.delta).toBeUndefined();
      const next = await getTimeline(harness, thread.id, caughtUp.maxSeq);
      expect(next.delta).toEqual({ upsertRows: [] });
    });
  });

  it("a no-op delta (no new events) returns an empty patch and merges to the same rows", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "hello" },
      });

      const before = await getTimeline(harness, thread.id);
      const delta = await getTimeline(harness, thread.id, before.maxSeq);
      expect(delta.delta).toBeDefined();
      expect(delta.delta!.upsertRows).toHaveLength(0);
      expect(delta.delta!.rowOrder).toBeUndefined();
      expect(applyTimelineDelta(before.rows, delta.delta!)).toEqual(
        before.rows,
      );
    });
  });
});

describe("runtime-bound timeline HTTP", () => {
  it("binds opted-in responses and rejects a delta base from another runtime", async () => {
    await withTestHarness(async (harness) => {
      const { host, environment, thread } = seedThreadFixture(harness);
      seedPrimaryHost(harness.deps, host.id);

      const event = {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "runtime-fixture",
        scope: turnScope("runtime-turn"),
      } as const;

      seedEvent(harness.deps, {
        ...event,
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        ...event,
        sequence: 2,
        type: "item/started",
        data: {
          item: { type: "agentMessage", id: "runtime-answer", text: "" },
        },
      });
      seedEvent(harness.deps, {
        ...event,
        sequence: 3,
        type: "item/agentMessage/delta",
        data: { itemId: "runtime-answer", delta: "Before" },
      });

      const status = maintenanceStatusSchema.parse(
        await readJson(await harness.app.request("/api/v1/server/maintenance")),
      );

      const url = `/api/v1/threads/${thread.id}/timeline?runtimeIdentity=server-v1&deltaFormat=assistant-text-append-v1`;

      const first = threadTimelineResponseSchema.parse(
        await readJson(await harness.app.request(url)),
      );

      expect(first.runtimeId).toBe(status.runtime.runtimeId);
      seedEvent(harness.deps, {
        ...event,
        sequence: 4,
        type: "item/agentMessage/delta",
        data: { itemId: "runtime-answer", delta: " After" },
      });
      const args = `&afterSequence=${first.maxSeq}&afterRevision=${first.revision}`;

      const wrong = threadTimelineResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `${url}${args}&afterRuntimeId=different-runtime`,
          ),
        ),
      );

      expect(wrong.runtimeId).toBe(status.runtime.runtimeId);
      expect(wrong.delta).toBeUndefined();
      expect(
        assistantText(threadTimelineResponseSchema.parse(wrong).rows),
      ).toBe("Before After");

      const current = threadTimelineResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `${url}${args}&afterRuntimeId=${status.runtime.runtimeId}`,
          ),
        ),
      );

      expect(current.delta).toBeDefined();
    });
  });

  it("keeps unavailable identity visible for opted-in clients while legacy reads remain available", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const path = `/api/v1/threads/${thread.id}/timeline`;
      expect((await harness.app.request(path)).status).toBe(200);
      expect(
        (await harness.app.request(`${path}?runtimeIdentity=server-v1`)).status,
      ).toBe(503);
    });
  });
});
