import { expect, it } from "vitest";
import { runFirstPartyRecordedConformance } from "@omnyo/provider-bridge-protocol/testing";

it("reproduces every recorded matrix cell", async () => {
  const run = await runFirstPartyRecordedConformance({
    servesProvider: (providerId) => providerId.startsWith("acp-"),
    label: "acp-next",
    bridgeFamily: "acp-next",
  });

  expect(run.cells.length).toBeGreaterThan(0);
  console.info(run.report);
  expect(run.failures).toEqual([]);
}, 240_000);
