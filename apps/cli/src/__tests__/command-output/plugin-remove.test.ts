import { describe, expect, it, vi } from "vitest";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerPluginCommands } from "../../commands/plugin.js";

const coreRefusal =
  '"workflows" is part of Omnyo core, so it can be disabled but not removed.';

function json(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("omnyo plugin remove", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerPluginCommands(program, () => "http://server");

  it("removes an included plugin through the plugin route", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ ok: true }));

    await runCommand(["plugin", "remove", "chime-local"], register);

    expect(fetch).toHaveBeenCalledWith(
      "http://server/api/v1/plugins/chime-local",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Removed chime-local.",
    ]);
  });

  it("prints the server's reason when it refuses to remove a core plugin", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: false, error: coreRefusal }, 409),
    );

    await expect(
      runCommand(["plugin", "remove", "workflows"], register),
    ).rejects.toThrow("process.exit:1");

    const error = collectLogPayloads(vi.mocked(console.error)).join("\n");
    expect(error).toContain(coreRefusal);
    expect(error).not.toContain("HTTP 409");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("returns the refusal as JSON and exits 1", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: false, error: coreRefusal }, 409),
    );

    await expect(
      runCommand(["plugin", "uninstall", "workflows", "--json"], register),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify({ ok: false, error: coreRefusal }, null, 2),
    ]);
  });
});
