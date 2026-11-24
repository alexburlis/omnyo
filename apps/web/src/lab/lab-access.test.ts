import { isNotFound } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requireLabPreview } from "./lab-access";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireLabPreview", () => {
  it("answers not found in a production build", () => {
    vi.stubEnv("PROD", true);

    let thrown: unknown;

    try {
      requireLabPreview();
    } catch (error) {
      thrown = error;
    }

    expect(isNotFound(thrown)).toBe(true);
  });

  it("lets the lab render outside production", () => {
    vi.stubEnv("PROD", false);

    expect(() => requireLabPreview()).not.toThrow();
  });
});
