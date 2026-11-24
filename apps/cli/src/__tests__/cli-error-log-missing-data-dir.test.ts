import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCliErrorLogEntry,
  formatCliErrorLogPath,
} from "../cli-error-log.js";

const failure = {
  at: "2026-11-07T00:00:00.000Z",
  cliVersion: "0.0.0-test",
  code: "http_502",
  command: "server maintenance status",
  exitCode: 1,
  threadId: null,
  token: null,
};

describe("cli error log data dir ownership", () => {
  let parent: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "omnyo-cli-error-owner-"));
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("never creates a data dir that has not been adopted yet", () => {
    const missing = join(parent, "not-yet-adopted");
    appendCliErrorLogEntry(failure, {
      OMNYO_DATA_DIR: missing,
      OMNYO_CLI_ERROR_LOG: "1",
    });
    expect(() => statSync(missing)).toThrow();
  });

  it("still records into an existing data dir without a logs folder", () => {
    appendCliErrorLogEntry(failure, {
      OMNYO_DATA_DIR: parent,
      OMNYO_CLI_ERROR_LOG: "1",
    });
    const logPath = formatCliErrorLogPath({ dataDir: parent });
    expect(JSON.parse(readFileSync(logPath, "utf8").trim()).code).toBe(
      "http_502",
    );
  });
});
