import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import { registerBrowserCommands } from "../../commands/browser.js";

const flags = [
  "--host",
  "host",
  "--instance",
  "instance",
  "--generation",
  "generation",
  "--thread",
  "thread",
];

describe("app renderer profile output", () => {
  setupCommandOutputTestEnvironment();
  it("uses the selected desktop window and a bounded duration", async () => {
    const profile = {
      requestedDurationMs: 2000,
      actualDurationMs: 2001,
      sampleIntervalUs: 1000,
      totalSamples: 0,
      omittedSamples: 0,
      hotspots: [],
      builtinSamples: { idle: 0, program: 0, garbageCollection: 0 },
      truncated: false,
    };

    const post = vi.fn(async () => profile);
    stubServerApi({ "v1.desktop-browsers.profile-renderer.$post": post });
    await runCommand(
      [
        "browser",
        "profile-renderer",
        "--host",
        "host",
        "--instance",
        "instance",
        "--generation",
        "generation",
        "--duration",
        "2s",
        "--json",
      ],
      (program) => registerBrowserCommands(program, () => "http://server"),
    );
    expect(post).toHaveBeenCalledWith({
      json: {
        hostId: "host",
        instanceId: "instance",
        generation: "generation",
        durationMs: 2000,
      },
    });
    expect(
      collectLogPayloads(vi.mocked(console.log)).map((line) =>
        JSON.parse(line),
      ),
    ).toEqual([profile]);
    await expect(
      runCommand(
        ["browser", "profile-renderer", "--duration", "6s"],
        (program) => registerBrowserCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");
    expect(collectLogPayloads(vi.mocked(console.error)).join("\n")).toContain(
      "between 200ms and 5s",
    );
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("browser credential output", () => {
  setupCommandOutputTestEnvironment();
  it("writes a new private file without printing the connection credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnyo-browser-cli-"));
    const output = join(dir, "connection.json");

    const connection = {
      hostId: "host",
      wsEndpoint: "ws://127.0.0.1:1234/private-token",
      expiresAt: Date.now() + 10000,
    };

    stubServerApi({
      "v1.desktop-browsers.connection.$post": vi.fn(async () => connection),
    });

    try {
      await runCommand(
        [
          "browser",
          "connection",
          "lease",
          ...flags,
          "--output",
          output,
          "--json",
        ],
        (program) => registerBrowserCommands(program, () => "http://server"),
      );
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(connection);

      if (process.platform !== "win32") {
        expect((await stat(output)).mode & 0o777).toBe(0o600);
      }

      expect(
        JSON.stringify(collectLogPayloads(vi.mocked(console.log))),
      ).not.toContain("private-token");
      await expect(
        runCommand(
          ["browser", "connection", "lease", ...flags, "--output", output],
          (program) => registerBrowserCommands(program, () => "http://server"),
        ),
      ).rejects.toThrow();
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(connection);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("browser cookie import output", () => {
  setupCommandOutputTestEnvironment();

  const instanceFlags = [
    "--host",
    "host",
    "--instance",
    "instance",
    "--generation",
    "generation",
  ];

  it("prints importable sources with readiness and cookie counts", async () => {
    stubServerApi({
      "v1.desktop-browsers.import-sources.$post": vi.fn(async () => ({
        sources: [
          {
            id: "chrome",
            name: "Google Chrome",
            profiles: [
              { directory: "Default", name: "Person 1", cookieCount: 4 },
            ],
          },
          {
            id: "safari",
            name: "Safari",
            profiles: [],
            unavailable: "needsFullDiskAccess",
          },
        ],
      })),
    });
    await runCommand(
      ["browser", "import-sources", ...instanceFlags],
      (program) => registerBrowserCommands(program, () => "http://server"),
    );
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      'chrome  ready  Default "Person 1" (4)\nsafari  needsFullDiskAccess',
    ]);
  });
  it("prints the default browser's profile as ready-to-use sync flags", async () => {
    stubServerApi({
      "v1.desktop-browsers.import-sources.$post": vi.fn(async () => ({
        sources: [
          {
            id: "dia",
            name: "Dia",
            profiles: [
              { directory: "Profile 7", name: "Work", cookieCount: 9 },
            ],
          },
        ],
        recommended: { sourceId: "dia", sourceProfileDirectory: "Profile 7" },
      })),
    });
    await runCommand(
      ["browser", "import-sources", ...instanceFlags],
      (program) => registerBrowserCommands(program, () => "http://server"),
    );
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      'dia  ready  Profile 7 "Work" (9)\nDefault browser: --from dia --profile "Profile 7"',
    ]);
  });
  it.each(["chrome", `storage-${"a".repeat(64)}`])(
    "sends the %s import request and reports skipped hosts or the failure reason",
    async (sourceId) => {
      const importCookies = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          imported: 3,
          skipped: 1,
          skippedDomains: ["a.test"],
        })
        .mockResolvedValueOnce({ ok: false, reason: "browserRunning" });

      stubServerApi({
        "v1.desktop-browsers.import-cookies.$post": importCookies,
      });
      await runCommand(
        [
          "browser",
          "import-cookies",
          ...instanceFlags,
          "--from",
          sourceId,
          "--profile",
          "Default",
        ],
        (program) => registerBrowserCommands(program, () => "http://server"),
      );
      expect(importCookies).toHaveBeenCalledWith({
        json: {
          hostId: "host",
          instanceId: "instance",
          generation: "generation",
          sourceId,
          sourceProfileDirectory: "Default",
        },
      });
      expect(collectLogLines(vi.mocked(console.log))).toEqual([
        "Imported 3 cookies, skipped 1 (a.test)",
      ]);
      vi.mocked(console.log).mockClear();
      await runCommand(
        [
          "browser",
          "import-cookies",
          ...instanceFlags,
          "--from",
          sourceId,
          "--profile",
          "Default",
        ],
        (program) => registerBrowserCommands(program, () => "http://server"),
      );
      expect(collectLogLines(vi.mocked(console.log))).toEqual([
        "Import failed: Quit the browser first so its cookie database can be read.",
      ]);
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    },
  );
});

describe("browser cookie sync output", () => {
  setupCommandOutputTestEnvironment();

  const instanceFlags = [
    "--host",
    "host",
    "--instance",
    "instance",
    "--generation",
    "generation",
  ];

  const target = {
    hostId: "host",
    instanceId: "instance",
    generation: "generation",
  };

  const source = { sourceId: "dia", sourceProfileDirectory: "Profile 7" };
  const at = Date.UTC(2026, 9, 27, 12, 0, 0);

  it("enables sync from a profile and prints counts and the next run", async () => {
    const configure = vi.fn(async () => ({
      source,
      running: false,
      lastRun: { ok: true, at, imported: 4, removed: 1, skipped: 2 },
      nextRunAt: at + 15 * 60 * 1000,
    }));

    stubServerApi({
      "v1.desktop-browsers.cookie-sync-configure.$post": configure,
    });
    await runCommand(
      [
        "browser",
        "cookie-sync",
        "enable",
        ...instanceFlags,
        "--from",
        "dia",
        "--profile",
        "Profile 7",
      ],
      (program) => registerBrowserCommands(program, () => "http://server"),
    );
    expect(configure).toHaveBeenCalledWith({ json: { ...target, source } });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      [
        'Cookie sync is on from dia profile "Profile 7"',
        "Last sync: 2026-10-27T12:00:00.000Z, imported 4, removed 1, skipped 2",
        "Next sync: 2026-10-27T12:15:00.000Z",
      ].join("\n"),
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports a failed run with exit code 1 and disables with JSON output", async () => {
    stubServerApi({
      "v1.desktop-browsers.cookie-sync-run.$post": vi.fn(async () => ({
        source,
        running: false,
        lastRun: { ok: false, at, reason: "needsKeychainApproval" },
        nextRunAt: null,
      })),
      "v1.desktop-browsers.cookie-sync-configure.$post": vi.fn(async () => ({
        source: null,
        running: false,
        lastRun: null,
        nextRunAt: null,
      })),
    });
    await runCommand(
      ["browser", "cookie-sync", "run", ...instanceFlags],
      (program) => registerBrowserCommands(program, () => "http://server"),
    );
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      [
        'Cookie sync is on from dia profile "Profile 7"',
        "Last sync failed 2026-10-27T12:00:00.000Z: Needs Keychain access to read its cookie encryption key. Approve the prompt and try again.",
      ].join("\n"),
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    vi.mocked(console.log).mockClear();

    await runCommand(
      ["browser", "cookie-sync", "disable", ...instanceFlags, "--json"],
      (program) => registerBrowserCommands(program, () => "http://server"),
    );
    expect(
      collectLogPayloads(vi.mocked(console.log)).map((line) =>
        JSON.parse(line),
      ),
    ).toEqual([
      { source: null, running: false, lastRun: null, nextRunAt: null },
    ]);
  });
});

describe("browser scope defaults", () => {
  setupCommandOutputTestEnvironment();

  const register = (program: Parameters<typeof registerBrowserCommands>[0]) =>
    registerBrowserCommands(program, () => "http://server");

  const host = (id: string, status: string) => ({ id, status });

  const window = (hostId: string, instanceId: string) => ({
    hostId,
    instanceId,
    generation: `${instanceId}-gen`,
    label: `Omnyo window ${instanceId}`,
  });

  it("reveals a new tab in the only connected desktop window of the current thread", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thr_current");
    const create = vi.fn(async () => ({ tab: { tabId: "tab-1" } }));

    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        host("mac", "connected"),
        host("vps", "connected"),
        host("asleep", "offline"),
      ]),
      "v1.desktop-browsers.instances.$post": vi.fn(
        async ({ json }: { json: { hostId: string } }) => ({
          instances: json.hostId === "mac" ? [window("mac", "w1")] : [],
        }),
      ),
      "v1.desktop-browsers.create.$post": create,
    });
    await runCommand(
      ["browser", "create", "--url", "http://localhost:5173", "--reveal"],
      register,
    );
    expect(create).toHaveBeenCalledWith({
      json: {
        hostId: "mac",
        instanceId: "w1",
        generation: "w1-gen",
        threadId: "thr_current",
        url: "http://localhost:5173",
        presentation: "reveal",
      },
    });
  });

  const expectFailure = async (args: string[], message: RegExp) => {
    vi.mocked(console.error).mockClear();
    await expect(runCommand(args, register)).rejects.toThrow("process.exit:1");
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      expect.stringMatching(message),
    );
  };

  it("refuses to guess between desktop windows or past an unlistable host", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thr_current");
    const create = vi.fn();

    const instances = vi
      .fn()
      .mockResolvedValueOnce({ instances: [window("mac", "w1")] })
      .mockResolvedValueOnce({ instances: [window("air", "w2")] })
      .mockResolvedValueOnce({ instances: [window("mac", "w1")] })
      .mockRejectedValueOnce(new Error("offline"));

    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        host("mac", "connected"),
        host("air", "connected"),
      ]),
      "v1.desktop-browsers.instances.$post": instances,
      "v1.desktop-browsers.create.$post": create,
    });
    await expectFailure(
      ["browser", "create", "--reveal"],
      /--host air --instance w2 --generation w2-gen/,
    );
    await expectFailure(
      ["browser", "create", "--reveal"],
      /Could not list desktop windows on: air/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("requires a thread outside Omnyo threads and paired window flags", async () => {
    await expectFailure(
      ["browser", "tabs", "--host", "mac"],
      /Missing thread ID/,
    );
    await expectFailure(
      ["browser", "tabs", "--thread", "thr_a", "--instance", "w1"],
      /--instance and --generation together/,
    );
  });
});
