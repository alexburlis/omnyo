import { describe, expect, it } from "vitest";
import type { ObservedProcess } from "../contract";
import { redact } from "../lib/redact";
import {
  classifyProcesses,
  daemonDataDir,
  displayCommand,
  joinProcessRows,
  parseCommandRow,
  parseExecutableRow,
  parseLineageRow,
  parseTagRow,
  parseTopRow,
  withMemory,
  type ClassifiedProcess,
  type CommandRow,
  type ExecutableRow,
  type ProcessRow,
  type ProcessTags,
} from "../process-table";

const DATA_DIR = "/Users/test/.omnyo";

const STORAGE = `${DATA_DIR}/thread-storage/thr_one`;

const FOREIGN_STORAGE = "/Users/test/dev-data/thread-storage/thr_dev";

const STARTED = "Sun Nov  1 10:00:00 2026";

const STARTED_NORMAL = "Sun Nov 1 10:00:00 2026";

const CANARY = "canary-value-9f2c";

const assign = (name: string, value: string) => [name, value].join("=");

const TAG = `${assign("OMNYO_THREAD_ID", "thr_one")} ${assign("OMNYO_THREAD_STORAGE", STORAGE)}`;

function tagsOf(environment: string): ProcessTags {
  const value = (name: string) =>
    environment
      .split(" ")
      .reverse()
      .find((entry) => entry.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null;

  return {
    threadId: value("OMNYO_THREAD_ID"),
    storage: value("OMNYO_THREAD_STORAGE"),
    keepRequested: value("OMNYO_KEEP_RUNNING") === "1",
  };
}

describe("tag rows from the kernel reader", () => {
  it("reads the three tags", () => {
    expect(parseTagRow(`4242\tthr_one\t${STORAGE}\t1`)).toEqual({
      pid: 4242,
      threadId: "thr_one",
      storage: STORAGE,
      keepRequested: true,
    });
  });

  it("treats a missing tag as absent", () => {
    expect(parseTagRow("5\t\t\t")).toEqual({
      pid: 5,
      threadId: null,
      storage: null,
      keepRequested: false,
    });
  });

  it("reads a storage path that contains spaces", () => {
    const storage = "/Users/test/Application Support/omnyo/thread-storage/thr_one";

    expect(parseTagRow(`6\tthr_one\t${storage}\t`)?.storage).toBe(storage);
  });

  it("only accepts 1 as a keep request", () => {
    expect(parseTagRow(`7\tthr_one\t${STORAGE}\t0`)?.keepRequested).toBe(false);
  });

  it.each(["", "not a row", "x\ty\tz\tw", "8\tonly\ttwo"])("ignores %j", (line) => {
    expect(parseTagRow(line)).toBeNull();
  });
});

describe("process lineage rows", () => {
  it.each([
    ["0:00.01", 0.01],
    ["546:15.77", 32_775.77],
    ["10948:16.06", 656_896.06],
    ["1:02:03", 3723],
    ["1-02:03:04", 93_784],
  ])("parses accumulated CPU time %s", (cpu, seconds) => {
    expect(parseLineageRow(`  9  1 ${STARTED}   ${cpu}`)?.cpuSeconds).toBeCloseTo(seconds);
  });

  it("reads the pid, parent and start time", () => {
    expect(parseLineageRow(`  4242  1 ${STARTED}   0:01.50`)).toEqual({
      pid: 4242,
      ppid: 1,
      startedAt: STARTED_NORMAL,
      cpuSeconds: 1.5,
    });
  });

  it("ignores anything else", () => {
    expect(parseLineageRow("PID PPID")).toBeNull();
  });
});

describe("plain ps rows", () => {
  it("reads an executable path with spaces and converts rss to bytes", () => {
    expect(
      parseExecutableRow(
        `  12 ${STARTED}  2048 S+   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      ),
    ).toEqual({
      pid: 12,
      startedAt: STARTED_NORMAL,
      rssBytes: 2048 * 1024,
      zombie: false,
      comm: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
  });

  it("flags a zombie", () => {
    expect(parseExecutableRow(`  13 ${STARTED}  0 Z  (node)`)?.zombie).toBe(true);
  });

  it("ignores the padding ps puts before a command", () => {
    expect(parseCommandRow(`  14 ${STARTED}    /bin/sleep 300`)?.command).toBe("/bin/sleep 300");
  });

  it("reads a command row", () => {
    expect(parseCommandRow(`  14 ${STARTED} /bin/sleep 300`)).toEqual({
      pid: 14,
      startedAt: STARTED_NORMAL,
      command: "/bin/sleep 300",
    });
  });
});

describe("top MEM parsing", () => {
  it.each([
    ["72237  2480K ", 2480 * 1024],
    ["21311  326M", 326 * 1024 ** 2],
    ["9000   8741M+", 8741 * 1024 ** 2],
    ["9001   12G-", 12 * 1024 ** 3],
    ["9002   1.5G", 1.5 * 1024 ** 3],
    ["9003   512B", 512],
    ["9004   2T", 2 * 1024 ** 4],
    ["9005   0", 0],
  ])("parses %s", (line, bytes) => {
    expect(parseTopRow(line)?.bytes).toBe(bytes);
  });

  it.each([
    "PID    MEM",
    "PhysMem: 45G used (8857M wired), 2624M unused.",
    "Processes: 5 total",
    "",
  ])("ignores the summary line %j", (line) => {
    expect(parseTopRow(line)).toBeNull();
  });
});

type RowSpec = {
  pid: number;
  ppid: number;
  comm?: string;
  command?: string;
  environment?: string;
};

function table(specs: readonly RowSpec[]): ProcessRow[] {
  const lineage = specs.map((spec) => ({
    pid: spec.pid,
    ppid: spec.ppid,
    startedAt: STARTED_NORMAL,
    cpuSeconds: 1.5,
  }));

  const tags = new Map(specs.map((spec) => [spec.pid, tagsOf(spec.environment ?? "")]));

  const executables = new Map<number, ExecutableRow>(
    specs.map((spec) => [
      spec.pid,
      {
        pid: spec.pid,
        startedAt: STARTED_NORMAL,
        rssBytes: 1024,
        zombie: false,
        comm: spec.comm ?? "/bin/tool",
      },
    ]),
  );

  const commands = new Map<number, CommandRow>(
    specs.map((spec) => [
      spec.pid,
      {
        pid: spec.pid,
        startedAt: STARTED_NORMAL,
        command: spec.command ?? spec.comm ?? "/bin/tool",
      },
    ]),
  );

  return joinProcessRows(lineage, tags, executables, commands);
}

function classify(specs: readonly RowSpec[], selfPid = 999_999): ClassifiedProcess[] {
  return classifyProcesses(table(specs), { dataDir: DATA_DIR, selfPid });
}

function byPid(processes: readonly ClassifiedProcess[], pid: number) {
  return processes.find((process) => process.pid === pid);
}

const BRIDGE = "/usr/bin/node /opt/omnyo-provider-bridge-worker.mjs /artifact";

const AGENT_CHAIN: RowSpec[] = [
  { pid: 100, ppid: 1, comm: "/usr/bin/node", command: BRIDGE },
  {
    pid: 101,
    ppid: 100,
    comm: "/Users/test/.local/bin/claude",
    command: "/Users/test/.local/bin/claude --resume",
    environment: TAG,
  },
];

describe("ownership", () => {
  it("holds a conflicting process and descendants without hiding other owners", () => {
    const rows = table([
      { pid: 10, ppid: 1, environment: TAG },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11, environment: TAG },
      { pid: 20, ppid: 1, environment: TAG },
    ]);

    const processes = classifyProcesses(rows, {
      dataDir: DATA_DIR,
      selfPid: 999_999,
      unverifiedPids: new Set([11]),
    });

    expect(processes.map((process) => process.pid)).toEqual([10, 20]);
  });

  it("ignores a tag from another Omnyo data directory", () => {
    const foreign = `${assign("OMNYO_THREAD_ID", "thr_dev")} ${assign("OMNYO_THREAD_STORAGE", FOREIGN_STORAGE)}`;

    expect(classify([{ pid: 10, ppid: 1, environment: foreign }])).toEqual([]);
  });

  it("ignores a storage path that only starts like the data directory", () => {
    const lookalike = `${assign("OMNYO_THREAD_ID", "thr_dev")} ${assign("OMNYO_THREAD_STORAGE", `${DATA_DIR}-dev/thread-storage/thr_dev`)}`;
    const nested = `${assign("OMNYO_THREAD_ID", "thr_dev")} ${assign("OMNYO_THREAD_STORAGE", `${DATA_DIR}/nested/thread-storage/thr_dev`)}`;

    expect(classify([{ pid: 10, ppid: 1, environment: lookalike }])).toEqual([]);
    expect(classify([{ pid: 11, ppid: 1, environment: nested }])).toEqual([]);
  });

  it("ignores a path that escapes the storage folder", () => {
    const escaped = `${assign("OMNYO_THREAD_ID", "thr_one")} ${assign("OMNYO_THREAD_STORAGE", `${DATA_DIR}/thread-storage/../../other/x`)}`;

    expect(classify([{ pid: 10, ppid: 1, environment: escaped }])).toEqual([]);
  });

  it("ignores a tag that has no storage path", () => {
    expect(
      classify([{ pid: 10, ppid: 1, environment: assign("OMNYO_THREAD_ID", "thr_one") }]),
    ).toEqual([]);
  });

  it("rejects a thread id that is not a plain identifier", () => {
    const hostile = `${assign("OMNYO_THREAD_ID", "../../etc")} ${assign("OMNYO_THREAD_STORAGE", STORAGE)}`;

    expect(classify([{ pid: 10, ppid: 1, environment: hostile }])).toEqual([]);
  });

  it("ignores an untagged process with no tagged ancestor", () => {
    expect(classify([{ pid: 10, ppid: 1 }])).toEqual([]);
  });

  it("gives an untagged child its nearest tagged ancestor, as for pnpm dev", () => {
    const processes = classify([
      { pid: 10, ppid: 1, comm: "/usr/bin/pnpm", environment: TAG },
      { pid: 11, ppid: 10, comm: "/usr/bin/node" },
      { pid: 12, ppid: 11, comm: "/usr/bin/esbuild" },
    ]);

    expect(processes.map((process) => [process.pid, process.threadId])).toEqual([
      [10, "thr_one"],
      [11, "thr_one"],
      [12, "thr_one"],
    ]);
  });

  it("gives a foreign-scoped child of a chat's dev Omnyo to the owning chat", () => {
    const foreign = `${assign("OMNYO_THREAD_ID", "thr_dev")} ${assign("OMNYO_THREAD_STORAGE", FOREIGN_STORAGE)}`;

    const processes = classify([
      { pid: 10, ppid: 1, comm: "/usr/bin/pnpm", environment: TAG },
      { pid: 11, ppid: 10, comm: "/usr/bin/node", environment: foreign },
    ]);

    expect(byPid(processes, 11)?.threadId).toBe("thr_one");
  });

  it("does not loop on a ppid cycle", () => {
    expect(
      classify([
        { pid: 10, ppid: 11 },
        { pid: 11, ppid: 10 },
      ]),
    ).toEqual([]);
  });

  it("inherits a launch keep request from an ancestor", () => {
    const processes = classify([
      { pid: 10, ppid: 1, environment: `${TAG} ${assign("OMNYO_KEEP_RUNNING", "1")}` },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 1, environment: TAG },
    ]);

    expect(byPid(processes, 10)?.keepRequested).toBe(true);
    expect(byPid(processes, 11)?.keepRequested).toBe(true);
    expect(byPid(processes, 12)?.keepRequested).toBe(false);
  });
});

describe("exclusions", () => {
  it("excludes the plugin worker and every ancestor, even when tagged", () => {
    const processes = classify(
      [
        { pid: 10, ppid: 1, environment: TAG },
        { pid: 11, ppid: 10, environment: TAG },
        { pid: 12, ppid: 11, environment: TAG },
        { pid: 13, ppid: 12, environment: TAG },
      ],
      12,
    );

    expect(processes.map((process) => process.pid)).toEqual([13]);
  });

  it("leaves daemons other chats share alone, but not what they started", () => {
    const shared = ["adb", "dirmngr", "gpg-agent", "keyboxd", "op", "scdaemon"];

    expect(
      classify(
        shared.map((name, index) => ({
          pid: 10 + index,
          ppid: 1,
          comm: `/opt/homebrew/bin/${name}`,
          command: `/opt/homebrew/bin/${name} daemon`,
          environment: TAG,
        })),
      ),
    ).toEqual([]);

    const started = classify([
      {
        pid: 20,
        ppid: 1,
        comm: "/opt/homebrew/bin/op",
        command: "op run -- node a.js",
        environment: TAG,
      },
      { pid: 21, ppid: 20, comm: "/usr/local/bin/node", command: "node a.js", environment: TAG },
    ]);

    expect(started.map((process) => process.pid)).toEqual([21]);
  });

  it("excludes an executable under app-versions", () => {
    const comm = `${DATA_DIR}/app-versions/0.46.208+private.1/node_modules/omnyo-app/host-daemon/dist/omnyo`;

    expect(
      classify([{ pid: 10, ppid: 1, comm, command: `${comm} status`, environment: TAG }]),
    ).toEqual([]);
  });

  it("excludes an Omnyo runtime script as ps really prints it", () => {
    const script = `${DATA_DIR}/app-versions/0.46.208+private.1/omnyo.js`;
    const row = parseCommandRow(`  10 ${STARTED}   /usr/bin/node ${script} status`);

    const rows = joinProcessRows(
      [{ pid: 10, ppid: 1, startedAt: STARTED_NORMAL, cpuSeconds: 1 }],
      new Map([[10, tagsOf(TAG)]]),
      new Map([
        [
          10,
          { pid: 10, startedAt: STARTED_NORMAL, rssBytes: 0, zombie: false, comm: "/usr/bin/node" },
        ],
      ]),
      new Map(row === null ? [] : [[10, row]]),
    );

    expect(classifyProcesses(rows, { dataDir: DATA_DIR, selfPid: 999_999 })).toEqual([]);
  });

  it("excludes a script under app-versions, including after runtime flags", () => {
    const script = `${DATA_DIR}/app-versions/0.46.208+private.1/worker.mjs`;

    expect(
      classify([
        {
          pid: 10,
          ppid: 1,
          comm: "/usr/bin/node",
          command: `/usr/bin/node ${script}`,
          environment: TAG,
        },
        {
          pid: 11,
          ppid: 1,
          comm: "/usr/bin/node",
          command: `node --no-warnings ${script}`,
          environment: TAG,
        },
      ]),
    ).toEqual([]);
  });

  it("keeps a process that only mentions app-versions in a later argument", () => {
    const command = `/usr/bin/python3 /tmp/scan.py ${DATA_DIR}/app-versions/x`;

    const processes = classify([
      { pid: 10, ppid: 1, comm: "/usr/bin/python3", command, environment: TAG },
    ]);

    expect(processes.map((process) => process.pid)).toEqual([10]);
  });

  it("still attributes the child of an excluded process to its chat", () => {
    const comm = `${DATA_DIR}/app-versions/0.46.208+private.1/omnyo`;

    const processes = classify([
      { pid: 10, ppid: 1, comm, command: comm, environment: TAG },
      { pid: 11, ppid: 10, comm: "/usr/bin/node" },
    ]);

    expect(processes.map((process) => process.pid)).toEqual([11]);
  });
});

describe("roles", () => {
  it("makes a claude under the bridge worker an agent", () => {
    expect(byPid(classify(AGENT_CHAIN), 101)?.role).toBe("agent");
  });

  it("recognizes a claude by argv0 when the executable has another name", () => {
    const processes = classify([
      AGENT_CHAIN[0] ?? { pid: 0, ppid: 0 },
      {
        pid: 102,
        ppid: 100,
        comm: "/Users/test/.local/share/claude/versions/2.1.5",
        command: "claude --resume",
        environment: TAG,
      },
    ]);

    expect(byPid(processes, 102)?.role).toBe("agent");
  });

  it("makes an agent CLI that lost its bridge a workload", () => {
    const processes = classify([
      { pid: 10, ppid: 1, comm: "/Users/test/.local/bin/claude", environment: TAG },
    ]);

    expect(byPid(processes, 10)?.role).toBe("workload");
  });

  it("makes a non-shell child of an agent and its descendants helpers", () => {
    const processes = classify([
      ...AGENT_CHAIN,
      { pid: 103, ppid: 101, comm: "/usr/bin/node", command: "/usr/bin/node mcp.js" },
      { pid: 104, ppid: 103, comm: "/bin/sh", command: "sh -c helper" },
      { pid: 105, ppid: 104, comm: "/usr/bin/helper" },
    ]);

    expect(byPid(processes, 103)?.role).toBe("helper");
    expect(byPid(processes, 104)?.role).toBe("helper");
    expect(byPid(processes, 105)?.role).toBe("helper");
  });

  it.each(["/bin/zsh", "/bin/bash", "/bin/sh", "/bin/dash", "/opt/homebrew/bin/fish", "-zsh"])(
    "makes a tool shell %s and what it started workloads",
    (shell) => {
      const processes = classify([
        ...AGENT_CHAIN,
        { pid: 103, ppid: 101, comm: shell, command: `${shell} -c build` },
        { pid: 104, ppid: 103, comm: "/usr/bin/node", command: "/usr/bin/node build.js" },
      ]);

      expect(byPid(processes, 103)?.role).toBe("workload");
      expect(byPid(processes, 104)?.role).toBe("workload");
    },
  );

  it("sees through an untagged codex app-server to its tagged tool shell", () => {
    const processes = classify([
      { pid: 100, ppid: 1, comm: "/usr/bin/node", command: BRIDGE },
      { pid: 101, ppid: 100, comm: "/opt/bin/codex", command: "/opt/bin/codex app-server" },
      { pid: 102, ppid: 101, comm: "/opt/mcp/server", command: "/opt/mcp/server" },
      { pid: 103, ppid: 101, comm: "/bin/zsh", command: "/bin/zsh -lc build", environment: TAG },
      { pid: 104, ppid: 103, comm: "/usr/bin/node", command: "/usr/bin/node build.js" },
    ]);

    expect(processes.map((process) => [process.pid, process.role])).toEqual([
      [103, "workload"],
      [104, "workload"],
    ]);
  });
});

describe("process rows that did not join", () => {
  it("reports nothing for a pid reused between the ps runs", () => {
    const lineage = [{ pid: 10, ppid: 1, startedAt: STARTED_NORMAL, cpuSeconds: 1.5 }];
    const tags = new Map([[10, tagsOf(TAG)]]);

    const executables = new Map<number, ExecutableRow>([
      [
        10,
        {
          pid: 10,
          startedAt: "Sun Nov 1 09:00:00 2026",
          rssBytes: 0,
          zombie: false,
          comm: "/bin/tool",
        },
      ],
    ]);

    const commands = new Map<number, CommandRow>([
      [10, { pid: 10, startedAt: STARTED_NORMAL, command: "/bin/tool" }],
    ]);

    const rows = joinProcessRows(lineage, tags, executables, commands);

    expect(classifyProcesses(rows, { dataDir: DATA_DIR, selfPid: 999_999 })).toEqual([]);
  });

  it("reports nothing for a zombie", () => {
    const lineage = [{ pid: 10, ppid: 1, startedAt: STARTED_NORMAL, cpuSeconds: 1.5 }];
    const tags = new Map([[10, tagsOf(TAG)]]);

    const executables = new Map<number, ExecutableRow>([
      [10, { pid: 10, startedAt: STARTED_NORMAL, rssBytes: 0, zombie: true, comm: "(tool)" }],
    ]);

    const commands = new Map<number, CommandRow>([
      [10, { pid: 10, startedAt: STARTED_NORMAL, command: "(tool)" }],
    ]);

    expect(
      classifyProcesses(joinProcessRows(lineage, tags, executables, commands), {
        dataDir: DATA_DIR,
        selfPid: 999_999,
      }),
    ).toEqual([]);
  });
});

describe("memory", () => {
  const workload = classify([{ pid: 10, ppid: 1, environment: TAG }])[0];

  if (workload === undefined) throw new Error("fixture must classify");

  const agent = { ...workload, pid: 11, role: "agent" as const };

  it("uses footprint for a workload that top returned", () => {
    expect(withMemory([workload], new Map([[10, 9000]]))[0]).toMatchObject({
      memoryBytes: 9000,
      memorySource: "footprint",
    });
  });

  it("labels rss for a pid that top did not return", () => {
    expect(withMemory([workload], new Map())[0]).toMatchObject({
      memoryBytes: 1024,
      memorySource: "rss",
    });
  });

  it("labels rss for an agent, which never goes through top", () => {
    expect(withMemory([agent], new Map([[11, 9000]]))[0]).toMatchObject({
      memoryBytes: 1024,
      memorySource: "rss",
    });
  });
});

describe("display command", () => {
  it("shows the executable basename and its arguments", () => {
    expect(displayCommand("/usr/bin/python3", "/usr/bin/python3 serve.py --port 8000")).toBe(
      "python3 serve.py --port 8000",
    );
  });

  it("handles an executable path with spaces", () => {
    const comm = "/Applications/My App.app/Contents/MacOS/My App";

    expect(displayCommand(comm, `${comm} --flag`)).toBe("My App --flag");
  });

  it("truncates to about 160 characters", () => {
    const shown = displayCommand("/bin/tool", `/bin/tool ${"word ".repeat(200)}`);

    expect(shown.length).toBeLessThanOrEqual(160);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("redacts a KEY=VALUE argument and stops at it", () => {
    const shown = displayCommand(
      "/usr/bin/env",
      `/usr/bin/env ${assign("FIXTURE", CANARY)} server`,
    );

    expect(shown).toBe("env FIXTURE=<redacted> …");
    expect(shown).not.toContain(CANARY);
  });

  it("does not show a rewritten title's overrun into the environment", () => {
    const shown = displayCommand(
      "/usr/bin/python3",
      `python3: worker ${assign("PATH", "/usr/bin")} ${assign("FIXTURE", CANARY)} ${assign("HOME", "/Users/test")}`,
    );

    expect(shown).toBe("python3 worker PATH=<redacted> …");
    expect(shown).not.toContain(CANARY);
    expect(shown).not.toContain("/Users/test");
  });

  it("strips control characters from the arguments", () => {
    expect(displayCommand("/bin/tool", "/bin/tool one\u0007two")).toBe("tool one two");
  });
});

describe("redact", () => {
  const pieces = (...parts: string[]) => parts.join("");

  it.each<[string, string, string]>([
    ["a flag with a space", pieces("--to", "ken ", CANARY), "--token <redacted>"],
    ["a flag with an equals sign", pieces("--api-k", "ey=", CANARY), "--api-key=<redacted>"],
    ["a named assignment", pieces("pass", "word=", CANARY), "password=<redacted>"],
    [
      "a query parameter",
      pieces("https://x.test/a?to", "ken=", CANARY),
      "https://x.test/a?token=<redacted>",
    ],
    ["a bearer header", pieces("Bear", "er ", CANARY), "Bearer <redacted>"],
    ["a URL credential", pieces("https://user:", CANARY, "@x.test/"), "https://<redacted>@x.test/"],
    ["a prefixed token", pieces("s", "k-", "abcdefghijkl123"), "<redacted>"],
    ["a long hex value", "0123456789abcdef0123456789abcdef", "<redacted>"],
    ["a long mixed value", `${"a1".repeat(30)}`, "<redacted>"],
  ])("hides %s", (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("leaves ordinary paths and flags readable", () => {
    const text =
      "python3 /Users/test/projects/thr_example--leftover-processes/serve.py --port=8000";

    expect(redact(text)).toBe(text);
  });
});

describe("the scan result never carries the environment", () => {
  it("holds no secret from the environment, argv or a rewritten title", () => {
    const secret = assign("FIXTURE_CANARY", CANARY);

    const processes: ObservedProcess[] = withMemory(
      classify([
        {
          pid: 10,
          ppid: 1,
          comm: "/usr/bin/node",
          command: `/usr/bin/node app.js ${secret}`,
          environment: `${secret} ${TAG}`,
        },
        { pid: 11, ppid: 10, comm: "/usr/bin/python3", command: `python3: worker ${secret}` },
      ]),
      new Map([[10, 1000]]),
    );

    expect(processes).toHaveLength(2);
    expect(JSON.stringify(processes)).not.toContain(CANARY);
  });
});

describe("daemonDataDir", () => {
  it("derives the data directory from the plugin's host data path", () => {
    expect(daemonDataDir("/Users/test/.omnyo/plugins/leftover-processes/host-data")).toBe(
      "/Users/test/.omnyo",
    );
  });

  it("refuses a path of any other form", () => {
    expect(daemonDataDir("/tmp/somewhere")).toBeNull();
  });
});
