import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("names every supported channel when the built channel is invalid", async () => {
  vi.stubEnv("OMNYO_DESKTOP_RELEASE_CHANNEL", "beta");

  await expect(import("../src/desktop-update-provider.js")).rejects.toThrow(
    "Built desktop release channel must be latest, nightly or public-beta, got beta.",
  );
});
