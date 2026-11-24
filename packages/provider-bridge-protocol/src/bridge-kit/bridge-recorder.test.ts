import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  BRIDGE_RECORDING_PROCESS_SCOPE,
  createBridgeRecorder,
  createRecordingLineSplitter,
  type BridgeRecordingEntry,
} from "./bridge-recorder.js";

function recordingFixture() {
  const dir = mkdtempSync(join(tmpdir(), "omnyo-bridge-recorder-"));
  const recorder = createBridgeRecorder({ dir });
  onTestFinished(() => {
    recorder.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const readLane = (scope: string, direction: string): BridgeRecordingEntry[] =>
    readFileSync(join(dir, scope, `${direction}.ndjson`), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as BridgeRecordingEntry);

  return { dir, readLane, recorder };
}

describe("bridge recorder", () => {
  it("routes responses to the scope of the request they answer", () => {
    const { dir, readLane, recorder } = recordingFixture();

    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }),
    );
    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "thread/start",
        params: { threadId: "thr_a" },
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "br-7",
        method: "interaction/request",
        params: { threadId: "thr_a" },
      }),
    );
    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "br-7",
        result: { decision: "allow" },
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { providerThreadId: "p" },
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: { threadId: "thr_a", deltas: [] },
      }),
    );
    recorder.close();

    expect(readdirSync(dir).sort()).toEqual([
      BRIDGE_RECORDING_PROCESS_SCOPE,
      "thr_a",
    ]);
    expect(
      readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "runtime→bridge").map(
        (entry) => JSON.parse(entry.line).method,
      ),
    ).toEqual(["initialize"]);
    expect(
      readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "bridge→runtime").map(
        (entry) => JSON.parse(entry.line).id,
      ),
    ).toEqual([1]);
    expect(
      readLane("thr_a", "runtime→bridge").map(
        (entry) => JSON.parse(entry.line).id,
      ),
    ).toEqual([2, "br-7"]);
    const outbound = readLane("thr_a", "bridge→runtime");
    expect(outbound.map((entry) => JSON.parse(entry.line).id)).toEqual([
      "br-7",
      2,
      undefined,
    ]);

    const all = [
      ...readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "runtime→bridge"),
      ...readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "bridge→runtime"),
      ...readLane("thr_a", "runtime→bridge"),
      ...outbound,
    ]
      .sort((left, right) => left.seq - right.seq)
      .map((entry) => entry.seq);

    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("tees a child's stdout and stdin writes as provider lanes", () => {
    const { readLane, recorder } = recordingFixture();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    recorder.recordChildIo({ stdin, stdout }, { threadId: "thr_b" });

    stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    stdout.write('{"jsonrpc":"2.0",');
    stdout.write(
      '"id":1,"result":{}}\n{"jsonrpc":"2.0","method":"turn/started"}\n',
    );
    recorder.close();

    expect(
      readLane("thr_b", "bridge→provider").map((entry) => entry.line),
    ).toEqual(['{"jsonrpc":"2.0","id":1,"method":"initialize"}']);
    expect(
      readLane("thr_b", "provider→bridge").map((entry) => entry.line),
    ).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","method":"turn/started"}',
    ]);
  });

  it("drops an oversized line instead of holding it", () => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter((line) => lines.push(line), 8);
    splitter.push("short\n");
    splitter.push("this line is far too long");
    splitter.push(" and keeps going\nafter\n");
    expect(lines).toEqual(["short", "after"]);
  });

  it("keeps a line exactly at the cap and counts multi-byte characters per line", () => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter((line) => lines.push(line), 8);
    splitter.push("1234");
    splitter.push("5678\n");
    splitter.push("1234");
    splitter.push("56789");
    splitter.push("\n");
    splitter.push("\u00e9\u00e9");
    splitter.push("\u00e9\u00e9\n");
    splitter.push("\u00e9\u00e9");
    splitter.push("\u00e9\u00e9\u00e9");
    splitter.push("\n");
    splitter.push("ok\n");
    expect(lines).toEqual(["12345678", "\u00e9".repeat(4), "ok"]);
  });

  it("measures each chunk once instead of the whole pending line", () => {
    const spy = vi.spyOn(Buffer, "byteLength");

    try {
      const lines: string[] = [];

      const splitter = createRecordingLineSplitter(
        (line) => lines.push(line),
        1024 * 1024,
      );

      for (let index = 0; index < 200; index += 1) {
        splitter.push("x".repeat(1024));
      }

      splitter.push("\n");

      const measuredBytes = spy.mock.calls.reduce(
        (total, [value]) =>
          total + (typeof value === "string" ? value.length : 0),
        0,
      );

      expect(lines).toEqual(["x".repeat(200 * 1024)]);
      expect(measuredBytes).toBeLessThanOrEqual(2 * 200 * 1024);
    } finally {
      spy.mockRestore();
    }
  });
});
