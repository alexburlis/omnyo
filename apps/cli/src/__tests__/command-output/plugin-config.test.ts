import { describe, expect, it, vi } from "vitest";
import { createHttpTransport, createOmnyoSdk } from "@omnyo/sdk/node";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerPluginCommands } from "../../commands/plugin.js";

function settingsResponse(value: number): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      schema: {
        retries: { type: "number", label: "Retries", default: 3 },
      },
      values: { retries: value },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("omnyo plugin config", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerPluginCommands(program, () => "http://server");

  it("accepts a negative number while preserving unknown-option errors", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(settingsResponse(3))
      .mockResolvedValueOnce(settingsResponse(-4.5));

    await runCommand(
      ["plugin", "config", "demo", "set", "retries", "-4.5"],
      register,
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://server/api/v1/plugins/demo/settings",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://server/api/v1/plugins/demo/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ values: { retries: -4.5 } }),
      }),
    );

    vi.mocked(fetch).mockClear();

    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      runCommand(
        ["plugin", "config", "demo", "set", "retries", "3", "--bogus"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(stderr).toHaveBeenCalledWith("error: unknown option '--bogus'\n");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a negative value passed to unset", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      runCommand(
        ["plugin", "config", "demo", "unset", "retries", "-1"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(stderr).toHaveBeenCalledWith("error: unknown option '-1'\n");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary extra value", ["extra"]],
    ["negative value after --", ["--", "-1"]],
  ])("rejects the %s passed to unset", async (_, extraArgs) => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      runCommand(
        ["plugin", "config", "demo", "unset", "retries", ...extraArgs],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(stderr).toHaveBeenCalledWith(
      "error: too many arguments for 'config'. Expected 3 arguments but got 4.\n",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("unsets a setting when no value is passed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(settingsResponse(3));

    await runCommand(
      ["plugin", "config", "demo", "unset", "retries"],
      register,
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "http://server/api/v1/plugins/demo/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ values: { retries: null } }),
      }),
    );
  });

  it("keeps descriptor metadata in --json output", async () => {
    const schema = {
      notes: {
        type: "string",
        label: "Notes",
        experimental_multiline: true,
        experimental_placeholder: "Write notes",
        experimental_section: {
          title: "General",
          description: "Shared options",
        },
      },
      mode: {
        type: "select",
        label: "Mode",
        options: ["fast", "slow"],
        experimental_optionLabels: { fast: "Fast", slow: "Slow" },
      },
    };

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, schema, values: { mode: "fast" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCommand(["plugin", "config", "demo", "--json"], register);

    expect(JSON.parse(String(stdout.mock.calls[0]?.[0])).schema).toEqual(
      schema,
    );
  });

  it.each([
    {
      name: "an older success envelope without settings fields",
      body: { ok: true },
      lines: ["This plugin declares no settings."],
    },
    {
      name: "a descriptor with future metadata",
      body: {
        ok: true,
        values: {},
        schema: {
          mode: { type: "string", label: "Mode", experimental_future: true },
        },
      },
      lines: ["mode = (unset)  (string)", "  Mode"],
    },
  ])(
    "preserves $name without weakening the strict SDK",
    async ({ body, lines }) => {
      const typedFetch = vi.fn(async () => Response.json(body));

      const sdk = createOmnyoSdk({
        transport: createHttpTransport({
          baseUrl: "http://server",
          fetch: typedFetch,
          runtime: "node",
        }),
      });

      await expect(
        sdk.plugins.getSettings({ pluginId: "pack/demo" }),
      ).rejects.toMatchObject({ name: "ZodError" });
      expect(typedFetch).toHaveBeenCalledOnce();

      vi.mocked(fetch).mockImplementation(async () => Response.json(body));
      await runCommand(["plugin", "config", "pack/demo", "--json"], register);
      const printed = vi.mocked(console.log).mock.calls[0]?.[0];

      expect(JSON.parse(String(printed))).toEqual(body);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        "http://server/api/v1/plugins/pack%2Fdemo/settings",
        expect.objectContaining({ method: "GET" }),
      );

      vi.mocked(console.log).mockClear();
      await runCommand(["plugin", "config", "pack/demo"], register);
      expect(vi.mocked(console.log).mock.calls).toEqual(
        lines.map((line) => [line]),
      );
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it("keeps strict SDK reads and writes on the encoded settings route", async () => {
    const response = {
      ok: true,
      schema: { retries: { type: "number", label: "Retries" } },
      values: { retries: 3 },
    };

    const typedFetch = vi.fn(async () => Response.json(response));

    const sdk = createOmnyoSdk({
      transport: createHttpTransport({
        baseUrl: "http://server/",
        fetch: typedFetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.plugins.getSettings({ pluginId: "pack/demo" }),
    ).resolves.toEqual(response);
    await expect(
      sdk.plugins.updateSettings({
        pluginId: "pack/demo",
        values: { retries: 3 },
      }),
    ).resolves.toEqual(response);
    expect(typedFetch).toHaveBeenCalledTimes(2);
    expect(typedFetch).toHaveBeenNthCalledWith(
      1,
      "http://server/api/v1/plugins/pack%2Fdemo/settings",
      expect.not.objectContaining({ body: expect.anything() }),
    );
    expect(typedFetch).toHaveBeenNthCalledWith(
      2,
      "http://server/api/v1/plugins/pack%2Fdemo/settings",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { retries: 3 } }),
      },
    );
  });

  it.each([400, 404, 409, 422])(
    "keeps a structured HTTP %i failure in text and JSON",
    async (status) => {
      const body = { ok: false, error: "Settings unavailable" };

      vi.mocked(fetch).mockImplementation(async () =>
        Response.json(body, { status }),
      );
      await expect(
        runCommand(["plugin", "config", "demo", "--json"], register),
      ).rejects.toThrow("process.exit:1");
      expect(
        JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
      ).toEqual(body);
      expect(console.error).not.toHaveBeenCalled();

      vi.mocked(console.log).mockClear();
      await expect(
        runCommand(["plugin", "config", "demo"], register),
      ).rejects.toThrow("process.exit:1");
      expect(console.error).toHaveBeenCalledExactlyOnceWith(body.error);
      expect(console.log).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    [
      502,
      "not JSON",
      "Unexpected response from /api/v1/plugins/demo/settings (502): not JSON",
    ],
    [502, '{"ok":false}', "/api/v1/plugins/demo/settings failed: HTTP 502"],
  ])(
    "keeps the HTTP %i transport diagnostic for %s",
    async (status, body, message) => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status }));

      await expect(
        runCommand(["plugin", "config", "demo"], register),
      ).rejects.toThrow("process.exit:1");
      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        `Error: ${message}`,
      );
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("rejects a non-finite number before sending an update", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(settingsResponse(3));

    await expect(
      runCommand(
        ["plugin", "config", "demo", "set", "retries", "Infinity"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      'Setting "retries" is a number — pass a finite number.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
