import { describe, expect, it } from "vitest";
import {
  idleProviderSessionGraceMs,
  parseDarwinMemoryPressure,
  readProviderProcessMemory,
} from "./memory-pressure.js";

describe("memory pressure cleanup policy", () => {
  it.each([
    ["1\n", "normal", 600_000],
    ["2\n", "warning", 120_000],
    ["4\n", "critical", 60_000],
  ] as const)("uses the native %s pressure level", (raw, level, grace) => {
    const sample = parseDarwinMemoryPressure(raw);
    expect(sample).toEqual({ status: "observed", level });
    expect(idleProviderSessionGraceMs(sample)).toBe(grace);
  });

  it("reports unknown pressure and preserves the normal grace", () => {
    const sample = parseDarwinMemoryPressure("8");
    expect(sample).toEqual({ status: "unavailable", reason: "invalid-result" });
    expect(idleProviderSessionGraceMs(sample)).toBe(600_000);
  });

  it("reads process RSS once for duplicate process IDs without summing it", async () => {
    const memory = await readProviderProcessMemory([process.pid, process.pid]);

    if (process.platform === "darwin" || process.platform === "linux") {
      expect(memory.size).toBe(1);
      expect(memory.get(process.pid)).toBeGreaterThan(0);
    } else {
      expect(memory.size).toBe(0);
    }
  });
});
