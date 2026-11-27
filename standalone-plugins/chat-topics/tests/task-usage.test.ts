import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexUsage, memoryLabel, usageSchema } from "../lib/task-usage.ts";

describe("Task Manager usage", () => {
  it("keeps missing threads unknown and preserves partial or unknown CPU readings", () => {
    const readings = indexUsage({
      hosts: [
        {
          hostId: "a",
          coverage: "partial",
          threads: [{ threadId: "chat", cpuPercent: null, memoryBytes: 1024 }],
        },
      ],
    });

    assert.equal(readings.has("missing"), false);
    assert.deepEqual(readings.get("chat"), {
      kind: "measured",
      coverage: "partial",
      value: {
        threadId: "chat",
        cpuPercent: null,
        memoryBytes: 1024,
      },
    });
    assert.equal(
      indexUsage({ hosts: [{ hostId: "a", coverage: "complete", threads: [] }] }).has("missing"),
      false,
    );
  });

  it("rejects ambiguous attribution and failed or unsupported host readings", () => {
    for (const coverage of ["complete", "partial", "failed", "unsupported"] as const) {
      const thread = { threadId: "chat", cpuPercent: 2, memoryBytes: 1024 };

      const readings = indexUsage({
        hosts: [
          { hostId: "a", coverage: "complete", threads: [thread] },
          { hostId: "b", coverage, threads: [thread] },
        ],
      });

      assert.deepEqual(readings.get("chat"), { kind: "unknown" });
    }

    for (const coverage of ["failed", "unsupported"] as const)
      assert.deepEqual(
        indexUsage({
          hosts: [
            {
              hostId: "a",
              coverage,
              threads: [{ threadId: "chat", cpuPercent: 0, memoryBytes: 0 }],
            },
          ],
        }).get("chat"),
        { kind: "unknown" },
      );
  });

  it("validates measurements and formats memory without discarding small samples", () => {
    assert.equal(
      usageSchema.safeParse({
        hosts: [
          {
            hostId: "a",
            coverage: "complete",
            threads: [{ threadId: "chat", cpuPercent: -1, memoryBytes: 0 }],
          },
        ],
      }).success,
      false,
    );
    assert.equal(memoryLabel(1024 * 1024), "1.0 MB");
    assert.equal(memoryLabel(32 * 1024 * 1024), "32 MB");
    assert.equal(memoryLabel(2 * 1024 ** 3), "2.0 GB");
  });
});
