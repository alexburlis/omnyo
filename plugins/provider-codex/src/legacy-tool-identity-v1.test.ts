import { expect, it } from "vitest";
import {
  createCodexEventTranslationState,
  setCodexInjectedTools,
  translateCodexEventToDeltas,
} from "./delta-translation.js";

it("projects a finite recorded tool identity only for a current registered tool and preserves the raw event", () => {
  const event = {
    jsonrpc: "2.0",
    method: "item/started",
    params: {
      threadId: "original-provider-thread",
      turnId: "original-turn",
      startedAtMs: 0,
      item: {
        type: "dynamicToolCall",
        id: "original-call",
        namespace: null,
        tool: "bb_workflow_run",
        arguments: { value: "User bb_workflow_run remains verbatim" },
        status: "inProgress",
        contentItems: null,
        success: null,
        durationMs: null,
      },
    },
  };

  const before = JSON.stringify(event);
  const state = createCodexEventTranslationState();
  setCodexInjectedTools(state, [{ name: "omnyo_workflow_run" }]);
  expect(translateCodexEventToDeltas(event, state)).toContainEqual(
    expect.objectContaining({
      kind: "item.open",
      key: { providerItemId: "original-call" },
      item: expect.objectContaining({
        tool: "omnyo_workflow_run",
        server: "omnyo",
      }),
    }),
  );
  setCodexInjectedTools(state, []);
  expect(translateCodexEventToDeltas(event, state)).toContainEqual(
    expect.objectContaining({
      kind: "item.open",
      item: expect.objectContaining({ tool: "bb_workflow_run" }),
    }),
  );
  expect(JSON.stringify(event)).toBe(before);
});
