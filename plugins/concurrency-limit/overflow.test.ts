import { describe, expect, it } from "vitest";
import { formatNeed, parseNeedToken, satisfiesNeed } from "./overflow.js";

const studio = {
  availableParallelism: 14,
  os: "macos" as const,
  arch: "arm64",
  tools: { xcode: true, nvidiaGpu: null },
};

describe("needs", () => {
  it.each([
    "macos",
    "windows",
    "linux",
    "arm64",
    "x64",
    "xcode",
    "nvidia-gpu",
    "tag:dia",
  ])("round-trips %s", (token) => {
    const need = parseNeedToken(token);

    expect(need).not.toBeNull();
    expect(need === null ? null : formatNeed(need)).toBe(token);
  });

  it.each(["", "mac", "tag:", "tag:Has Space", "gpu"])(
    "rejects %j",
    (token) => {
      expect(parseNeedToken(token)).toBeNull();
    },
  );

  it("matches needs against detected facts and machine tags", () => {
    const need = (token: string) => {
      const parsed = parseNeedToken(token);

      if (parsed === null) throw new Error(`invalid ${token}`);

      return parsed;
    };

    expect(satisfiesNeed(need("macos"), studio, [])).toBe(true);
    expect(satisfiesNeed(need("windows"), studio, [])).toBe(false);
    expect(satisfiesNeed(need("xcode"), studio, [])).toBe(true);
    expect(satisfiesNeed(need("nvidia-gpu"), studio, [])).toBe(false);
    expect(satisfiesNeed(need("tag:dia"), studio, ["dia"])).toBe(true);
    expect(satisfiesNeed(need("tag:dia"), studio, [])).toBe(false);
  });
});
