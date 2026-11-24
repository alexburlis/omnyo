import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";
import {
  runWalk,
  seedPropertyWorld,
  uninstallWalkSources,
} from "./inbox-property.js";

const WALKS = Number(process.env.INBOX_PROPERTY_WALKS ?? 6);

const LENGTH = Number(process.env.INBOX_PROPERTY_LENGTH ?? 30);

const FIRST_SEED = Number(process.env.INBOX_PROPERTY_SEED ?? 1);

afterEach(() => {
  uninstallWalkSources();
  vi.useRealTimers();
});

describe("inbox invariants on the real server", () => {
  it(
    `hold over ${WALKS} random walks of ${LENGTH} events`,
    { timeout: 600_000 },
    async () => {
      const failures: string[] = [];
      const totals = new Map<string, number>();

      for (let walk = 0; walk < WALKS; walk += 1) {
        const seed = FIRST_SEED + walk;

        vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
        vi.setSystemTime(Date.UTC(2026, 9, 29, 9));

        await withTestHarness(async (harness) => {
          const world = seedPropertyWorld(harness, `host-inbox-walk-${seed}`);
          const result = await runWalk(world, { seed, length: LENGTH });

          for (const [kind, count] of result.eventCounts)
            totals.set(kind, (totals.get(kind) ?? 0) + count);

          for (const found of result.violations.slice(0, 3))
            failures.push(
              `seed ${seed} step ${found.step} ${found.violation.code} ${found.violation.role}: ${found.violation.message}\n  trace: ${found.trace.join(" → ")}`,
            );
        });

        vi.useRealTimers();
      }

      if (process.env.INBOX_PROPERTY_REPORT)
        writeFileSync(
          process.env.INBOX_PROPERTY_REPORT,
          JSON.stringify({
            walks: WALKS,
            length: LENGTH,
            seed: FIRST_SEED,
            events: Object.fromEntries(totals),
            violations: failures.length,
          }),
        );

      expect(failures).toEqual([]);
    },
  );
});
