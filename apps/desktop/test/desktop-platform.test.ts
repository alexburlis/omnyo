import { describe, expect, it } from "vitest";
import { resolveDesktopPlatform } from "../src/desktop-platform.js";

describe("resolveDesktopPlatform", () => {
  it("names each supported desktop platform", () => {
    expect(resolveDesktopPlatform("darwin")).toBe("macos");
    expect(resolveDesktopPlatform("linux")).toBe("linux");
    expect(resolveDesktopPlatform("win32")).toBe("windows");
  });
});
