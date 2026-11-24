import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerProofCommand } from "../../commands/thread/proof.js";

describe("omnyo thread proof", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerProofCommand(program.command("thread"), () => "http://server");

  it("batches exact commands and selected event sequences through the shared API", async () => {
    const response = {
      threadId: "thread-1",
      proofs: [
        { status: "ambiguous" },
        {
          status: "matched",
          execution: {
            eventSeq: 15,
            command: "pnpm test",
            cwd: "/fixture",
            status: "failed",
            exitCode: 1,
            excerpt: "Failed check",
          },
        },
      ],
    };

    const post = vi.fn(async () => response);
    stubServerApi({ "v1.threads.:id.command-proofs.$post": post });
    await runCommand(
      [
        "thread",
        "proof",
        "thread-1",
        "--command",
        "pnpm test",
        "--event-seq",
        "15",
        "--json",
      ],
      register,
    );
    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-1" },
      json: {
        selectors: [
          { kind: "command", command: "pnpm test" },
          { kind: "event", eventSeq: 15 },
        ],
      },
    });
    expect(
      JSON.parse(collectLogLines(vi.mocked(console.log)).join("\n")),
    ).toEqual(response);
  });
  it("reports an empty lookup as existence validation", async () => {
    stubServerApi({
      "v1.threads.:id.command-proofs.$post": vi.fn(async () => ({
        threadId: "thread-1",
        proofs: [],
      })),
    });
    await runCommand(["thread", "proof", "thread-1"], register);
    expect(collectLogLines(vi.mocked(console.log))).toContain("Chat exists.");
  });
});
