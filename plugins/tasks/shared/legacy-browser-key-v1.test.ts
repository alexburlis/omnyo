// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { importLegacyTasksBrowserKeyV1 } from "./legacy-browser-key-v1.js";

const LEGACY = "legacy-key";

const CURRENT = "current-key";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("importLegacyTasksBrowserKeyV1", () => {
  it("moves a legacy value once when the current key is absent", () => {
    window.localStorage.setItem(LEGACY, "saved");
    importLegacyTasksBrowserKeyV1(LEGACY, CURRENT);
    expect(window.localStorage.getItem(CURRENT)).toBe("saved");
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
  });

  it("keeps the current value and retires the legacy value", () => {
    window.localStorage.setItem(LEGACY, "old");
    window.localStorage.setItem(CURRENT, "new");
    importLegacyTasksBrowserKeyV1(LEGACY, CURRENT);
    expect(window.localStorage.getItem(CURRENT)).toBe("new");
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
  });

  it("does nothing without a legacy value", () => {
    importLegacyTasksBrowserKeyV1(LEGACY, CURRENT);
    expect(window.localStorage.getItem(CURRENT)).toBeNull();
  });

  it("keeps the legacy value and does not throw when storage is full", () => {
    window.localStorage.setItem(LEGACY, "saved");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    expect(() => importLegacyTasksBrowserKeyV1(LEGACY, CURRENT)).not.toThrow();
    expect(window.localStorage.getItem(LEGACY)).toBe("saved");
  });

  it("does not throw when storage is unavailable", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => importLegacyTasksBrowserKeyV1(LEGACY, CURRENT)).not.toThrow();
  });
});
