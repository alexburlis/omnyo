import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerBugCommands } from "../../commands/bug.js";

describe("omnyo bug report", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerBugCommands(program, () => "http://server");

  it("sends the trimmed message and email and prints the reference", async () => {
    const post = vi.fn(async () => ({
      status: "sent" as const,
      reportId: "abc123",
    }));

    stubServerApi({ "v1.system.bug-reports.$post": post });

    await runCommand(
      [
        "bug",
        "report",
        "  The sidebar froze  ",
        "--email",
        "person@example.test",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      json: { message: "The sidebar froze", email: "person@example.test" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Bug report sent. Reference: abc123",
    ]);
  });

  it("prints the sent result as JSON", async () => {
    stubServerApi({
      "v1.system.bug-reports.$post": vi.fn(async () => ({
        status: "sent" as const,
        reportId: "abc123",
      })),
    });

    await runCommand(["bug", "report", "It broke", "--json"], register);

    expect(
      JSON.parse(collectLogPayloads(vi.mocked(console.log)).at(-1) ?? "{}"),
    ).toEqual({ status: "sent", reportId: "abc123" });
  });

  it("fails plainly when crash reports are off instead of claiming success", async () => {
    stubServerApi({
      "v1.system.bug-reports.$post": vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "crash-reports-off" as const,
      })),
    });

    await expect(
      runCommand(["bug", "report", "It broke"], register),
    ).rejects.toThrow("process.exit:1");
    expect(collectLogLines(vi.mocked(console.log))).toEqual([]);
    expect(collectLogLines(vi.mocked(console.error)).join("\n")).toContain(
      "Bug reports are off because Crash reports is off.",
    );
  });

  it("rejects an invalid email before contacting the server", async () => {
    const post = vi.fn();
    stubServerApi({ "v1.system.bug-reports.$post": post });

    await expect(
      runCommand(
        ["bug", "report", "It broke", "--email", "not-an-email"],
        register,
      ),
    ).rejects.toThrow("process.exit:");
    expect(post).not.toHaveBeenCalled();
  });
});
