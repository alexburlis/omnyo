import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  prepare: vi.fn(async () => {}),
  toolchain: {
    esbuild: "fixture-esbuild",
    tailwindNode: "fixture-tailwind-node",
    tailwindOxide: "fixture-tailwind-oxide",
    tailwindCssDir: "fixture-tailwind-css",
  },
  resolveToolchain: vi.fn(),
}));

vi.mock("./prepare-plugin-runtime.js", () => ({
  preparePluginRuntime: calls.prepare,
}));

vi.mock("./toolchain.js", () => ({
  resolvePluginBuildToolchain: calls.resolveToolchain,
}));

const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  calls.resolveToolchain.mockResolvedValue(calls.toolchain);
  process.argv = [process.execPath, "omnyo-plugin-build", "prepare-bundled"];
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

it("reports the actual canonical command before any build or cache effect", async () => {
  process.argv = [process.execPath, "omnyo-plugin-build", "unsupported"];

  await expect(import("./cli.js")).rejects.toThrow(
    "Usage: omnyo-plugin-build prepare-bundled",
  );
  expect(calls.prepare).not.toHaveBeenCalled();
  expect(calls.resolveToolchain).not.toHaveBeenCalled();
});

it("selects the canonical fresh cache owner and forwards neutral core version", async () => {
  await import("./cli.js");

  expect(calls.resolveToolchain).toHaveBeenCalledExactlyOnceWith(
    fileURLToPath(new URL("../node_modules/.omnyo-toolchain", import.meta.url)),
  );
  expect(calls.prepare).toHaveBeenCalledExactlyOnceWith({
    sourceRoot: process.cwd(),
    targetDir: resolve(process.cwd(), ".bundled-runtime"),
    coreVersion: "bundled",
    hostProvidedZod: true,
    toolchain: calls.toolchain,
  });
});
