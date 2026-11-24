import { listStoredEventRows, setAppSettings } from "@omnyo/db";
import {
  defaultAppSettings,
  threadScope,
  turnScope,
  type JsonObject,
  type JsonValue,
} from "@omnyo/domain";
import {
  threadTimelineResponseSchema,
  timelineTurnSummaryDetailsResponseSchema,
} from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("thread history credential boundary", () => {
  it.each([6_000, 40_000])(
    "withholds unsafe timeline projections of valid JSON output with %i padding characters without changing stored history",
    async (paddingChars) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness);
        const synthetic = "synthetic-private-json-output-value";

        const output = JSON.stringify({
          credentials: { value: synthetic },
          visible: "Visible JSON answer",
          padding: "a ".repeat(paddingChars / 2),
          password: synthetic,
        });

        const turn = {
          threadId: thread.id,
          providerThreadId: "synthetic-provider",
          scope: turnScope("synthetic-turn"),
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
              id: "synthetic-tool",
              tool: "read_json",
              arguments: { path: "synthetic.json" },
              status: "completed",
              result: output,
            },
          },
        });
        seedEvent(harness.deps, {
          ...turn,
          sequence: 3,
          type: "item/completed",
          data: {
            item: {
              type: "agentMessage",
              id: "synthetic-answer",
              text: "Unaffected timeline answer",
            },
          },
        });
        const stored = listStoredEventRows(harness.db, { threadId: thread.id });

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await harness.app.request(
            `/api/v1/threads/${thread.id}/timeline?segmentLimit=8`,
          );

          expect(response.status).toBe(200);

          const timeline = threadTimelineResponseSchema.parse(
            await readJson(response),
          );

          expect(timeline.rows).toContainEqual(
            expect.objectContaining({
              workKind: "tool",
              output:
                "[Content withheld: this text could not be safely displayed]",
            }),
          );
          const serialized = JSON.stringify(timeline);
          expect(serialized).not.toContain(synthetic);
          expect(serialized).not.toContain("Visible JSON answer");
          expect(serialized).toContain("Unaffected timeline answer");
        }

        for (const suffix of [
          "/events",
          "/timeline/turn-summary-details?turnId=synthetic-turn&sourceSeqStart=2&sourceSeqEnd=2&itemId=synthetic-tool",
        ]) {
          const response = await harness.app.request(
            `/api/v1/threads/${thread.id}${suffix}`,
          );

          expect(response.status, suffix).toBe(200);
          const serialized = JSON.stringify(await readJson(response));
          expect(serialized, suffix).not.toContain(synthetic);
          expect(serialized, suffix).toContain("Visible JSON answer");
          expect(serialized, suffix).not.toContain("Content withheld");
        }

        expect(
          listStoredEventRows(harness.db, { threadId: thread.id }),
        ).toEqual(stored);
      });
    },
  );

  it.each(["progress", "json-console"])(
    "withholds malformed %s output on event pages and timeline reads",
    async (kind) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness);
        const synthetic = "synthetic-private-console-value";

        const output =
          kind === "progress"
            ? "[1/3] Building"
            : `[${JSON.stringify({ password: synthetic })}\ncommand completed]`;

        const turn = {
          threadId: thread.id,
          providerThreadId: "synthetic-provider",
          scope: turnScope("synthetic-turn"),
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
          type: "item/started",
          data: {
            item: {
              type: "commandExecution",
              id: "synthetic-command",
              command: "print synthetic JSON",
              cwd: "/tmp",
              status: "pending",
              approvalStatus: null,
              aggregatedOutput: output,
            },
          },
        });
        seedEvent(harness.deps, {
          ...turn,
          sequence: 3,
          type: "item/completed",
          data: {
            item: {
              type: "agentMessage",
              id: "synthetic-answer",
              text: `Unaffected timeline answer\npassword: ${synthetic}`,
            },
          },
        });

        const stored = listStoredEventRows(harness.db, { threadId: thread.id });

        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/timeline?deferContent=true&segmentLimit=8`,
        );

        expect(response.status).toBe(200);

        const timeline = threadTimelineResponseSchema.parse(
          await readJson(response),
        );

        expect(timeline.rows).toContainEqual(
          expect.objectContaining({
            workKind: "command",
            command: "print synthetic JSON",
            output:
              "[Content withheld: this text could not be safely displayed]",
          }),
        );
        expect(JSON.stringify(timeline)).not.toContain(synthetic);
        expect(JSON.stringify(timeline)).not.toContain("command completed");
        expect(JSON.stringify(timeline)).toContain(
          "Unaffected timeline answer",
        );

        const detailsResponse = await harness.app.request(
          `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=synthetic-turn&sourceSeqStart=2&sourceSeqEnd=2&itemId=synthetic-command`,
        );

        expect(detailsResponse.status).toBe(200);

        const details = timelineTurnSummaryDetailsResponseSchema.parse(
          await readJson(detailsResponse),
        );

        expect(details.rows).toContainEqual(
          expect.objectContaining({
            output:
              "[Content withheld: this text could not be safely displayed]",
          }),
        );
        expect(JSON.stringify(details)).not.toContain(synthetic);

        const eventsResponse = await harness.app.request(
          `/api/v1/threads/${thread.id}/events?limit=3`,
        );

        expect(eventsResponse.status).toBe(200);
        const events = await readJson(eventsResponse);
        expect(events).toHaveLength(3);
        expect(events).toMatchObject(
          stored.map(({ id, sequence }) => ({ id, seq: sequence })),
        );
        expect(events).toMatchObject([
          { seq: 1 },
          {
            seq: 2,
            data: {
              item: {
                aggregatedOutput:
                  "[Content withheld: this text could not be safely displayed]",
              },
            },
          },
          {
            seq: 3,
            data: {
              item: {
                text: "Unaffected timeline answer\npassword: [REDACTED]",
              },
            },
          },
        ]);
        expect(JSON.stringify(events)).not.toContain(synthetic);

        const nextPage = await harness.app.request(
          `/api/v1/threads/${thread.id}/events?afterSeq=2&limit=1`,
        );

        expect(nextPage.status).toBe(200);
        expect(await readJson(nextPage)).toMatchObject([{ seq: 3 }]);
        expect(
          listStoredEventRows(harness.db, { threadId: thread.id }),
        ).toEqual(stored);

        const wait = await harness.app.request(
          `/api/v1/threads/${thread.id}/events/wait?type=item%2Fstarted&afterSeq=1&waitMs=1`,
        );

        expect(wait.status).toBe(413);
        expect(await readJson(wait)).toMatchObject({
          code: "history_redaction_limit",
        });
      });
    },
  );

  it.each(["depth", "nodes", "characters"])(
    "keeps the %s redaction budget strict for timeline output",
    async (budget) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness);
        let value: JsonValue = { visible: "Synthetic budget fixture" };

        if (budget === "depth") {
          for (let depth = 0; depth < 70; depth += 1) value = { nested: value };
        } else if (budget === "nodes") {
          value = Array.from({ length: 100_001 }, () => "x");
        }

        let output = JSON.stringify(value);

        if (budget === "characters") {
          output = "x ".repeat(1024 * 1024);

          for (let depth = 0; depth < 9; depth += 1)
            output = JSON.stringify({ nested: output });
        }

        const turn = {
          threadId: thread.id,
          providerThreadId: "synthetic-provider",
          scope: turnScope("synthetic-turn"),
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
              id: "synthetic-tool",
              tool: "read_json",
              arguments: {},
              status: "completed",
              result: output,
            },
          },
        });

        for (const suffix of [
          "/events",
          "/timeline/turn-summary-details?turnId=synthetic-turn&sourceSeqStart=2&sourceSeqEnd=2&itemId=synthetic-tool",
        ]) {
          const response = await harness.app.request(
            `/api/v1/threads/${thread.id}${suffix}`,
          );

          expect(response.status, suffix).toBe(413);
          expect(await readJson(response)).toMatchObject({
            code: "history_redaction_limit",
          });
        }
      });
    },
  );

  it.each(["count", "characters"])(
    "keeps the known credential %s budget strict on timeline reads",
    async (budget) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness);
        seedEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "synthetic-provider",
          sequence: 1,
          scope: threadScope(),
          type: "provider.env-resolved",
          data: {
            entries:
              budget === "count"
                ? Array.from({ length: 1025 }, (_, index) => ({
                    name: `SYNTHETIC_TOKEN_${index}`,
                    source: "shell",
                    value: `synthetic-value-${index}`,
                  }))
                : [
                    {
                      name: "SYNTHETIC_TOKEN",
                      source: "shell",
                      value: "x".repeat(1024 * 1024 + 1),
                    },
                  ],
          },
        });

        for (const suffix of ["/timeline", "/events"]) {
          const response = await harness.app.request(
            `/api/v1/threads/${thread.id}${suffix}`,
          );

          expect(response.status, suffix).toBe(413);
          expect(await readJson(response)).toMatchObject({
            code: "history_redaction_limit",
          });
        }
      });
    },
  );

  it("withholds scalar-looking labelled passwords across supported history reads without environment values", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const synthetic = "314159";
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "synthetic-provider",
        sequence: 1,
        scope: turnScope("synthetic-turn"),
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "synthetic-provider",
        sequence: 2,
        scope: turnScope("synthetic-turn"),
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "synthetic-answer",
            text: `password: ${synthetic}\nVisible answer`,
          },
        },
      });

      for (const suffix of [
        "/events",
        "/events/wait?type=item%2Fcompleted&afterSeq=1&waitMs=1",
        "/timeline?includeNestedRows=true",
        "/messages/2",
        "/output",
        "/conversation?limit=10",
      ]) {
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}${suffix}`,
        );

        expect(response.status, suffix).toBe(200);
        const serialized = JSON.stringify(await readJson(response));
        expect(serialized.includes(synthetic), suffix).toBe(false);
        expect(serialized.includes("Visible answer"), suffix).toBe(true);
      }
    });
  });

  it("masks historical environment values and their copies across supported history reads", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const synthetic = "synthetic-pool-value-for-history-proof";
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "synthetic-provider",
        sequence: 1,
        scope: threadScope(),
        type: "provider.env-resolved",
        data: {
          entries: [
            {
              name: "ANTHROPIC_AUTH_TOKEN",
              source: { plugin: "account-pool" },
              value: synthetic,
            },
            {
              name: "OMNYO_ACCOUNT_POOL_PARENT_TOKEN",
              source: "shell",
              value: synthetic,
            },
            { name: "PATH", source: "shell", value: "/synthetic/bin" },
          ],
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "synthetic-provider",
        sequence: 2,
        scope: turnScope("synthetic-turn"),
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "synthetic-provider",
        sequence: 3,
        scope: turnScope("synthetic-turn"),
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "synthetic-answer",
            text: `Result ${synthetic}; password: tiny-secret\nAuthorization: Bearer synthetic-header-value-for-history`,
          },
        },
      });
      setAppSettings(harness.db, {
        ...defaultAppSettings,
        showDiagnosticEvents: true,
      });

      const surfaces = [
        "/events",
        "/events?afterSeq=1",
        "/events/wait?type=item%2Fcompleted&afterSeq=2&waitMs=1",
        "/timeline?includeNestedRows=true",
        "/messages/3",
        "/output",
      ];

      for (const suffix of surfaces) {
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}${suffix}`,
        );

        expect(response.status).toBe(200);
        const serialized = JSON.stringify(await readJson(response));
        expect(serialized.includes(synthetic), suffix).toBe(false);
        expect(serialized.includes("tiny-secret"), suffix).toBe(false);
        expect(
          serialized.includes("synthetic-header-value-for-history"),
          suffix,
        ).toBe(false);
      }

      const raw = await readJson(
        await harness.app.request(
          `/api/v1/threads/${thread.id}/events?limit=1`,
        ),
      );

      expect(raw).toMatchObject([
        {
          seq: 1,
          type: "provider.env-resolved",
          data: {
            entries: [
              { name: "ANTHROPIC_AUTH_TOKEN", value: { masked: true } },
              {
                name: "OMNYO_ACCOUNT_POOL_PARENT_TOKEN",
                value: { masked: true },
              },
              { name: "PATH", value: { masked: true } },
            ],
          },
        },
      ]);
    });
  });

  it("redacts strings inside singular and plural credential objects while retaining shape and counters", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const nestedValue = "synthetic-history-nested-value";
      const pluralValue = "synthetic-history-plural-value";
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "synthetic-provider",
        sequence: 1,
        scope: threadScope(),
        type: "provider/unhandled",
        data: {
          providerId: "codex",
          rawType: "synthetic-credentials",
          rawEvent: {
            jsonrpc: "2.0",
            method: "synthetic/credentials",
            params: {
              token: { value: nestedValue, usage: 42 },
              credentials: { nested: { value: pluralValue }, count: 7 },
              visible: "Visible answer",
            },
          },
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events`,
      );

      expect(response.status).toBe(200);
      const result = await readJson(response);
      expect(JSON.stringify(result).includes(nestedValue)).toBe(false);
      expect(JSON.stringify(result).includes(pluralValue)).toBe(false);
      expect(result).toMatchObject([
        {
          data: {
            rawEvent: {
              params: {
                token: { value: "[REDACTED]", usage: 42 },
                credentials: { nested: { value: "[REDACTED]" }, count: 7 },
                visible: "Visible answer",
              },
            },
          },
        },
      ]);
    });
  });

  it("returns compact conversation pages with stable message sequences and bounded limits", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "synthetic-provider",
        sequence: 1,
        type: "turn/started",
        scope: turnScope("synthetic-turn"),
        data: {},
      });

      for (const sequence of [2, 4, 7]) {
        seedEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "synthetic-provider",
          sequence,
          type: "item/completed",
          scope: turnScope("synthetic-turn"),
          data: {
            item: {
              type: "agentMessage",
              id: `answer-${sequence}`,
              text: `Answer ${sequence}`,
            },
          },
        });
      }

      const first = await harness.app.request(
        `/api/v1/threads/${thread.id}/conversation?limit=2`,
      );

      expect(first.status).toBe(200);
      expect(await readJson(first)).toEqual({
        rows: [
          { seq: 2, role: "assistant", text: "Answer 2" },
          { seq: 4, role: "assistant", text: "Answer 4" },
        ],
        hasMore: true,
        nextAfterSeq: 4,
        maxSeq: 7,
      });

      const second = await harness.app.request(
        `/api/v1/threads/${thread.id}/conversation?limit=2&afterSeq=4&throughSeq=7`,
      );

      expect(second.status).toBe(200);
      expect(await readJson(second)).toEqual({
        rows: [{ seq: 7, role: "assistant", text: "Answer 7" }],
        hasMore: false,
        nextAfterSeq: null,
        maxSeq: 7,
      });

      for (const query of [
        "limit=0",
        "limit=101",
        "afterSeq=-1",
        "throughSeq=1&afterSeq=4",
      ]) {
        expect(
          (
            await harness.app.request(
              `/api/v1/threads/${thread.id}/conversation?${query}`,
            )
          ).status,
        ).toBe(400);
      }
    });
  });

  it("fails visibly instead of returning a history payload beyond the redaction nesting bound", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);

      let rawEvent: JsonObject = {
        Authorization: "synthetic-deep-value",
      };

      for (let depth = 0; depth < 70; depth += 1)
        rawEvent = { nested: rawEvent };
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "synthetic-provider",
        sequence: 1,
        scope: threadScope(),
        type: "provider/unhandled",
        data: {
          providerId: "codex",
          rawType: "synthetic-deep-event",
          rawEvent: {
            jsonrpc: "2.0",
            method: "synthetic/deep",
            params: rawEvent,
          },
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events`,
      );

      expect(response.status).toBe(413);
      expect(await readJson(response)).toMatchObject({
        code: "history_redaction_limit",
      });
    });
  });
});
