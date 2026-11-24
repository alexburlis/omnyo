import { describe, expect, it } from "vitest";
import { threadScope, type ExtensionKind } from "@omnyo/domain";
import { extractThreadProviderCommands } from "../src/provider-state-extraction.js";
import type { ThreadEventWithMeta } from "../src/build-event-projection.js";

describe("Omnyo provider-state projection", () => {
  it("uses sequence order across old and new known kinds, preserving arbitrary provider identity and payload", () => {
    const state = (
      kind: ExtensionKind,
      seq: number,
      name: string,
    ): ThreadEventWithMeta => ({
      event: {
        type: "thread/extensionState/updated",
        threadId: "stable",
        providerThreadId: "bb-provider-opaque",
        scope: threadScope(),
        kind,
        payload: { commands: [{ name, description: "User bb description" }] },
      },
      meta: { id: `event-${seq}`, seq, createdAt: seq },
    });

    const events = [
      state("bb/provider-commands", 1, "old"),
      state("core/provider-commands", 2, "current"),
      state("bb/provider-commands", 3, "latest"),
      state("bb/unknown", 4, "foreign"),
    ];

    const original = structuredClone(events);
    expect(extractThreadProviderCommands(events)).toEqual([
      {
        name: "latest",
        source: "command",
        origin: "builtin",
        description: "User bb description",
        argumentHint: null,
      },
    ]);
    expect(events).toEqual(original);
    expect(
      extractThreadProviderCommands([state("bb/unknown", 4, "foreign")]),
    ).toBeNull();
  });
});
