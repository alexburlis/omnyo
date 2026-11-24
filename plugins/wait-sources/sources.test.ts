import { describe, expect, it } from "vitest";
import {
  commandOutcome,
  describeHttp,
  fileResult,
  httpResult,
  parseFileTarget,
  parseHostTarget,
  parseHttpTarget,
} from "./sources.js";

describe("http targets", () => {
  it("splits the URL from the text to find at the first #", () => {
    const parsed = parseHttpTarget("https://example.com/status#ready now");

    expect(parsed.ok && parsed.value.url.href).toBe(
      "https://example.com/status",
    );
    expect(parsed.ok && parsed.value.text).toBe("ready now");
    expect(parsed.ok && describeHttp(parsed.value)).toBe(
      'example.com/status shows "ready now"',
    );
  });

  it("refuses other schemes, embedded credentials and empty text", () => {
    expect(parseHttpTarget("ftp://example.com")).toEqual({
      ok: false,
      error: "expected an http or https URL",
    });
    expect(parseHttpTarget("https://alex:pw@example.com")).toEqual({
      ok: false,
      error: "keep credentials out of the URL",
    });
    expect(parseHttpTarget("https://example.com#")).toMatchObject({
      ok: false,
    });
    expect(parseHttpTarget("not a url")).toMatchObject({ ok: false });
  });

  it("fires only on a 2xx answer that contains the text", () => {
    const parsed = parseHttpTarget("https://example.com/#v0.47");

    if (!parsed.ok) throw new Error(parsed.error);

    expect(httpResult(parsed.value, 503, "v0.47")).toBeNull();
    expect(httpResult(parsed.value, 200, "v0.46")).toBeNull();
    expect(httpResult(parsed.value, 200, "running v0.47")).toBe(
      'https://example.com/ answered 200 and contains "v0.47".',
    );
  });
});

describe("machine targets", () => {
  it("reads the machine id before the first colon", () => {
    expect(parseHostTarget("host_1:make check && echo ok", "command")).toEqual({
      ok: true,
      value: { hostId: "host_1", value: "make check && echo ok" },
    });
    expect(parseFileTarget("host_1:C:\\builds\\done.txt")).toMatchObject({
      ok: true,
      value: { hostId: "host_1", value: "C:\\builds\\done.txt" },
    });
  });

  it("refuses relative paths, missing parts and multi-line commands", () => {
    expect(parseFileTarget("host_1:build/done")).toEqual({
      ok: false,
      error: "the path must be absolute",
    });
    expect(parseHostTarget("make check", "command")).toEqual({
      ok: false,
      error: "expected <hostId>:<command>",
    });
    expect(parseHostTarget("host_1:echo a\necho b", "command")).toMatchObject({
      ok: false,
    });
  });

  it("describes an existing path with its kind, size and time", () => {
    expect(
      fileResult(
        { hostId: "host_1", value: "/tmp/out.zip" },
        {
          exists: true,
          kind: "file",
          size: 42,
          modifiedAt: Date.UTC(2026, 9, 30),
        },
      ),
    ).toBe(
      "/tmp/out.zip exists on host_1 (file, 42 bytes, modified 2026-10-30T00:00:00.000Z).",
    );
    expect(
      fileResult(
        { hostId: "host_1", value: "/tmp/out.zip" },
        { exists: false, kind: null, size: null, modifiedAt: null },
      ),
    ).toBeNull();
  });
});

describe("command outcomes", () => {
  const target = { hostId: "host_1", value: "test -f /tmp/done" };

  it("fires on exit 0 with the output and waits on other exits", () => {
    expect(
      commandOutcome(target, {
        exitCode: 0,
        stdout: "done\n",
        timedOut: false,
      }),
    ).toEqual({
      kind: "fired",
      result: "`test -f /tmp/done` succeeded on host_1.\ndone",
    });
    expect(
      commandOutcome(target, { exitCode: 1, stdout: "", timedOut: false }),
    ).toEqual({ kind: "waiting" });
  });

  it("reports a command that cannot run or times out as a problem", () => {
    expect(
      commandOutcome(target, { exitCode: 127, stdout: "", timedOut: false }),
    ).toEqual({
      kind: "problem",
      problem: "the command was not found (exit 127)",
    });
    expect(
      commandOutcome(target, { exitCode: null, stdout: "", timedOut: true }),
    ).toEqual({ kind: "problem", problem: "the command timed out" });
  });
});
