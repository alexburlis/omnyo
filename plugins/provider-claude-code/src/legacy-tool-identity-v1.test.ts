import { expect, it } from "vitest";
import { classifyClaudeToolUse } from "./tool-classification.js";

it("projects a finite V1 transcript identity only when the current tool is registered", () => {
  const raw = { value: "User bb_workflow_result remains verbatim" };
  const before = JSON.stringify(raw);

  const args = {
    toolName: "mcp__bb-bridge__bb_workflow_result",
    toolUseId: "original-call",
    input: raw,
    sandboxEnabled: false,
  };

  const current = new Map([
    ["omnyo_workflow_result", { name: "omnyo_workflow_result" }],
  ]);

  expect(
    classifyClaudeToolUse({ ...args, injectedTools: current }).shape,
  ).toMatchObject({
    type: "tool",
    tool: "omnyo_workflow_result",
    server: "omnyo",
    args: raw,
  });
  expect(
    classifyClaudeToolUse({ ...args, injectedTools: new Map() }).shape,
  ).toMatchObject({ tool: "bb_workflow_result", server: "bb-bridge" });
  expect(
    classifyClaudeToolUse({
      ...args,
      toolName: "mcp__foreign__bb_workflow_result",
      injectedTools: current,
    }).shape,
  ).toMatchObject({ tool: "bb_workflow_result", server: "foreign" });
  expect(
    classifyClaudeToolUse({
      ...args,
      toolName: "mcp__bb-bridge__bb_custom",
      injectedTools: current,
    }).shape,
  ).toMatchObject({ tool: "bb_custom", server: "bb-bridge" });
  expect(JSON.stringify(raw)).toBe(before);
});
