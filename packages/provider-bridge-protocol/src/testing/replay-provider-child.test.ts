import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps Claude diagnostic forks from consuming a recorded conversation segment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omnyo-replay-diagnostic-"));

  for (const [direction, seq, message] of [
    [
      "bridge→provider",
      1,
      {
        type: "control_request",
        request_id: "recorded",
        request: { subtype: "initialize" },
      },
    ],
    [
      "provider→bridge",
      2,
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "recorded",
          response: { marker: "conversation" },
        },
      },
    ],
  ] as const) {
    writeFileSync(
      join(dir, `${direction}.ndjson`),
      JSON.stringify({
        ts: seq,
        run: 1,
        seq,
        dir: direction,
        line: JSON.stringify(message),
      }) + "\n",
    );
  }

  async function initialize(extraArgs: string[]): Promise<string> {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./replay-provider-child.mjs", import.meta.url)),
        "--recording",
        dir,
        "--dialect",
        "claude-cli",
        "--state",
        dir,
        ...extraArgs,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const closed = once(child, "close");
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });

    try {
      child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: "live",
          request: { subtype: "initialize" },
        }) + "\n",
      );
      await expect.poll(() => output).toContain('"request_id":"live"');

      return output;
    } finally {
      child.kill();
      await closed;
    }
  }

  try {
    expect(
      await initialize(["--fork-session", "--no-session-persistence"]),
    ).not.toContain('"marker":"conversation"');
    expect(await initialize([])).toContain('"marker":"conversation"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("replays the Pi recording envelope on its original fd without rewriting raw input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omnyo-replay-channel-"));
  const providerFile = join(dir, "provider→bridge.ndjson");

  const raw =
    JSON.stringify({
      ts: 2,
      run: 1,
      seq: 2,
      dir: "provider→bridge",
      line: JSON.stringify({
        omnyoChannel: {
          kind: "request",
          id: "opaque-recorded-id",
          method: "probe",
          params: { value: "omnyo-user-value" },
        },
      }),
    }) + "\n";

  writeFileSync(
    join(dir, "bridge→provider.ndjson"),
    JSON.stringify({
      ts: 1,
      run: 1,
      seq: 1,
      dir: "bridge→provider",
      line: JSON.stringify({ id: "bb-1", type: "get_state" }),
    }) + "\n",
  );
  writeFileSync(providerFile, raw);

  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./replay-provider-child.mjs", import.meta.url)),
      "--recording",
      dir,
      "--dialect",
      "pi-rpc",
      "--state",
      dir,
    ],
    { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
  );

  const closed = once(child, "close");
  let channel = "";
  child.stdio[3]?.on("data", (chunk: Buffer) => {
    channel += chunk.toString("utf8");
  });

  try {
    child.stdin?.write(
      JSON.stringify({ id: "rpc-1", type: "get_state" }) + "\n",
    );
    await expect.poll(() => channel).toContain('"id":"opaque-recorded-id"');
    expect(JSON.parse(channel.trim())).toEqual({
      kind: "request",
      id: "opaque-recorded-id",
      method: "probe",
      params: { value: "omnyo-user-value" },
    });
    expect(readFileSync(providerFile, "utf8")).toBe(raw);
  } finally {
    child.kill();
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  { omnyoChannel: null },
  { omnyoChannel: { kind: "request" } },
  { omnyoChannel: { kind: "reply", id: "id" }, extra: true },
])(
  "refuses ambiguous or malformed Pi recording metadata before claiming a segment",
  async (message) => {
    const dir = mkdtempSync(join(tmpdir(), "omnyo-replay-refusal-"));
    const file = join(dir, "provider→bridge.ndjson");

    const raw =
      JSON.stringify({
        ts: 1,
        run: 1,
        seq: 1,
        dir: "provider→bridge",
        line: JSON.stringify(message),
      }) + "\n";

    writeFileSync(file, raw);

    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./replay-provider-child.mjs", import.meta.url)),
        "--recording",
        dir,
        "--dialect",
        "pi-rpc",
        "--state",
        dir,
      ],
      { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
    );

    const closed = once(child, "close");
    let stdout = "";
    let channel = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      channel += chunk.toString("utf8");
    });
    const timeout = setTimeout(() => child.kill(), 1500);

    try {
      const [code, signal] = await closed;
      expect(signal).toBeNull();
      expect(code).not.toBe(0);
      expect(stderr).toMatch(
        /(?:Ambiguous|Malformed) Pi channel recording envelope/,
      );
      expect(stdout).toBe("");
      expect(channel).toBe("");
      expect(existsSync(join(dir, "segment-0"))).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(raw);
    } finally {
      clearTimeout(timeout);
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
