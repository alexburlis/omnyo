import { describe, expect, it } from "vitest";
import { defaultFeatureFlags, threadScope, turnScope } from "@omnyo/domain";
import {
  prependOlderTimelineRows,
  readTimelineHistoryIdentity,
} from "@omnyo/client-core";
import {
  threadTimelineResponseSchema,
  type TimelinePaginationCursor,
  type TimelineRow,
} from "@omnyo/server-contract";
import { readJson } from "../helpers/json.js";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("timeline content continuation at the history epoch", () => {
  it.each([
    { label: "long title", title: "A".repeat(5000) },
    {
      label: "credential-bearing title",
      title: "synthetic-cursor-private-value",
    },
  ])(
    "keeps $label metadata private and cursor-compatible",
    async ({ title }) => {
      await withTestHarness(
        {
          featureFlags: {
            ...defaultFeatureFlags,
            timelineWindowEventBudget: 2,
          },
        },
        async (harness) => {
          const { thread } = seedThreadFixture(harness, {
            thread: { providerId: "codex", title },
          });

          seedEvent(harness.deps, {
            threadId: thread.id,
            providerThreadId: "inert-cursor-metadata",
            sequence: 1,
            type: "provider.env-resolved",
            scope: threadScope(),
            data: {
              entries: [
                {
                  name: "SYNTHETIC_TOKEN",
                  source: "shell",
                  value: "synthetic-cursor-private-value",
                },
              ],
            },
          });

          for (const sequence of [10, 20, 30]) {
            const scope = {
              threadId: thread.id,
              providerThreadId: "inert-cursor-metadata",
              scope: turnScope(`inert-turn-${sequence}`),
            };

            seedEvent(harness.deps, {
              ...scope,
              sequence,
              type: "turn/started",
              data: {},
            });
            seedEvent(harness.deps, {
              ...scope,
              sequence: sequence + 1,
              type: "item/completed",
              data: {
                item: {
                  type: "commandExecution",
                  id: `inert-command-${sequence}`,
                  command: `echo ${sequence}`,
                  cwd: "/inert",
                  status: "completed",
                  approvalStatus: null,
                  aggregatedOutput: `inert ${sequence}`,
                  exitCode: 0,
                  durationMs: 1,
                },
              },
            });
            seedEvent(harness.deps, {
              ...scope,
              sequence: sequence + 2,
              type: "turn/completed",
              data: { status: "completed" },
            });
          }

          const latestUrl = `/api/v1/threads/${thread.id}/timeline?segmentLimit=1&deferContent=true`;

          const latest = threadTimelineResponseSchema.parse(
            await readJson(await harness.app.request(latestUrl)),
          );

          expect(latest.timelinePage.historySnapshot?.length).toBeLessThan(
            4096,
          );
          expect(
            readTimelineHistoryIdentity(latest.timelinePage.historySnapshot),
          ).not.toBeNull();
          const cursor = latest.timelinePage.olderCursor;
          expect(cursor).not.toBeNull();

          if (cursor === null)
            throw new Error("Fixture must have an older page");

          const decoded = Buffer.from(
            cursor.anchorId.slice("timeline-v5:".length),
            "base64url",
          ).toString("utf8");

          expect(decoded).not.toContain("synthetic-cursor-private-value");
          const olderUrl = `${latestUrl}&beforeAnchorId=${encodeURIComponent(cursor.anchorId)}&beforeAnchorSeq=${cursor.anchorSeq}`;
          expect((await harness.app.request(olderUrl)).status).toBe(200);

          harness.db.$client
            .prepare("UPDATE threads SET title = ? WHERE id = ?")
            .run(`${title} changed`, thread.id);
          expect((await harness.app.request(olderUrl)).status).toBe(400);
        },
      );
    },
  );

  it("accepts every cursor it returns while paging the oldest nested turn", async () => {
    await withTestHarness(
      {
        featureFlags: { ...defaultFeatureFlags, timelineWindowEventBudget: 2 },
      },
      async (harness) => {
        const { thread, environment } = seedThreadFixture(harness, {
          thread: { providerId: "codex" },
        });

        const scope = {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "provider-thread",
          scope: turnScope("turn-1"),
        };

        seedEvent(harness.deps, {
          ...scope,
          sequence: 1,
          type: "turn/started",
          data: {},
        });

        for (let index = 0; index < 3; index += 1) {
          seedEvent(harness.deps, {
            ...scope,
            sequence: index + 2,
            type: "item/completed",
            data: {
              item: {
                type: "commandExecution",
                id: `command-${index}`,
                command: `echo ${index}`,
                cwd: "/tmp",
                status: "completed",
                approvalStatus: null,
                aggregatedOutput: `${index}\n`,
                exitCode: 0,
                durationMs: 1,
              },
            },
          });
        }

        seedEvent(harness.deps, {
          ...scope,
          sequence: 5,
          type: "turn/completed",
          data: { status: "completed" },
        });
        let cursor: TimelinePaginationCursor | null = null;
        let rows: TimelineRow[] = [];
        let sawEpochCursor = false;
        let pages = 0;

        do {
          const query = new URLSearchParams({ includeNestedRows: "true" });

          if (cursor !== null) {
            query.set("beforeAnchorId", cursor.anchorId);
            query.set("beforeAnchorSeq", String(cursor.anchorSeq));
          }

          const response = await harness.app.request(
            `/api/v1/threads/${thread.id}/timeline?${query}`,
          );

          expect(response.status).toBe(200);

          const page = threadTimelineResponseSchema.parse(
            await readJson(response),
          );

          rows = prependOlderTimelineRows({
            loadedRows: rows,
            olderRows: page.rows,
          });
          cursor = page.timelinePage.olderCursor;
          sawEpochCursor ||= cursor?.anchorSeq === 0;
          expect(page.timelinePage.hasOlderRows).toBe(cursor !== null);
          expect(++pages).toBeLessThan(5);
        } while (cursor !== null);

        expect(sawEpochCursor).toBe(true);
        expect(rows).toHaveLength(1);
        const summary = rows[0];
        expect(summary?.kind).toBe("turn");

        if (summary?.kind !== "turn") throw new Error("Missing summary");
        expect(summary.children?.map((row) => row.id)).toHaveLength(3);
        expect(new Set(summary.children?.map((row) => row.id)).size).toBe(3);
      },
    );
  });

  it.each(["rewrite", "backfill", "delete-reuse", "credential"] as const)(
    "rejects an older cursor after an unnotified %s changes historical content",
    async (mutation) => {
      await withTestHarness(
        {
          featureFlags: {
            ...defaultFeatureFlags,
            timelineWindowEventBudget: 2,
          },
        },
        async (harness) => {
          const { thread, environment } = seedThreadFixture(harness);

          const scope = {
            threadId: thread.id,
            environmentId: environment.id,
            providerThreadId: "inert-history-epoch",
            scope: turnScope("epoch-turn"),
          };

          seedEvent(harness.deps, {
            ...scope,
            sequence: 10,
            type: "turn/started",
            data: {},
          });

          const item = (id: string, text: string) => ({
            type: "commandExecution" as const,
            id,
            command: `echo ${id}`,
            cwd: "/inert",
            status: "completed" as const,
            approvalStatus: null,
            aggregatedOutput: text,
            exitCode: 0,
            durationMs: 1,
          });

          for (const sequence of [20, 30, 40]) {
            seedEvent(harness.deps, {
              ...scope,
              sequence,
              type: "item/completed",
              data: {
                item: item(`command-${sequence}`, "synthetic-history-value"),
              },
            });
          }

          seedEvent(harness.deps, {
            ...scope,
            sequence: 50,
            type: "turn/completed",
            data: { status: "completed" },
          });
          const latestUrl = `/api/v1/threads/${thread.id}/timeline?includeNestedRows=true`;

          const latest = threadTimelineResponseSchema.parse(
            await readJson(await harness.app.request(latestUrl)),
          );

          const cursor = latest.timelinePage.olderCursor;
          expect(cursor).not.toBeNull();

          if (cursor === null)
            throw new Error("Expected historical continuation");
          const olderUrl = `${latestUrl}&beforeAnchorId=${encodeURIComponent(cursor.anchorId)}&beforeAnchorSeq=${cursor.anchorSeq}`;
          expect((await harness.app.request(olderUrl)).status).toBe(200);

          if (mutation === "rewrite") {
            harness.db.$client
              .prepare(
                "UPDATE events SET data = ? WHERE thread_id = ? AND sequence = 20",
              )
              .run(
                JSON.stringify({ item: item("command-20", "changed history") }),
                thread.id,
              );
          } else if (mutation === "delete-reuse") {
            harness.db.$client
              .prepare(
                "DELETE FROM events WHERE thread_id = ? AND sequence = 20",
              )
              .run(thread.id);
            seedEvent(harness.deps, {
              ...scope,
              sequence: 20,
              type: "item/completed",
              data: { item: item("command-20", "replacement history") },
            });
          } else if (mutation === "backfill") {
            seedEvent(harness.deps, {
              ...scope,
              sequence: 25,
              type: "item/completed",
              data: { item: item("backfilled", "inserted history") },
            });
          } else {
            seedEvent(harness.deps, {
              threadId: thread.id,
              providerThreadId: "inert-history-epoch",
              sequence: 51,
              type: "provider.env-resolved",
              scope: threadScope(),
              data: {
                entries: [
                  {
                    name: "SYNTHETIC_TOKEN",
                    source: "shell",
                    value: "synthetic-history-value",
                  },
                ],
              },
            });
          }

          const changed = threadTimelineResponseSchema.parse(
            await readJson(await harness.app.request(latestUrl)),
          );

          expect(changed.timelinePage.historySnapshot).not.toBe(
            latest.timelinePage.historySnapshot,
          );
          expect((await harness.app.request(olderUrl)).status).toBe(400);

          if (mutation === "credential") {
            let next: TimelinePaginationCursor | null = null;
            let pages = 0;

            do {
              const query =
                next === null
                  ? ""
                  : `&beforeAnchorId=${encodeURIComponent(next.anchorId)}&beforeAnchorSeq=${next.anchorSeq}`;

              const response = await harness.app.request(
                `${latestUrl}${query}`,
              );

              expect(response.status).toBe(200);

              const page = threadTimelineResponseSchema.parse(
                await readJson(response),
              );

              expect(JSON.stringify(page.rows)).not.toContain(
                "synthetic-history-value",
              );
              next = page.timelinePage.olderCursor;
              expect(++pages).toBeLessThan(6);
            } while (next !== null);
          }
        },
      );
    },
  );
});
