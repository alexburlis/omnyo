import { afterEach, expect, it, vi } from "vitest";
import type { PromptInput } from "@omnyo/domain";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type { PluginMentionResolveResult } from "./plugin-service.js";
import { resolvePluginMention } from "./plugin-agent-contributions.js";
import { resolvePluginMentionContextInputs } from "./plugin-mentions.js";

vi.mock("./plugin-agent-contributions.js", () => ({
  resolvePluginMention: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

function input(resources: readonly [string, string][]): PromptInput[] {
  return [
    {
      type: "text",
      text: "Resolve selected resources",
      mentions: resources.map(([pluginId, itemId], index) => ({
        start: index,
        end: index + 1,
        resource: { kind: "plugin", pluginId, itemId, label: itemId },
      })),
    },
  ];
}

const success = (context: string): PluginMentionResolveResult => ({
  ok: true,
  context,
  images: [],
});

it("overlaps three distinct plugins while preserving same-plugin and output order", async () => {
  const resources: [string, string][] = [
    ["a", "a0"],
    ["b", "b0"],
    ["a", "a1"],
    ["c", "c0"],
    ["d", "d0"],
  ];

  const gates = new Map(
    resources.map(([, id]) => [
      id,
      createDeferredPromise<PluginMentionResolveResult>(),
    ]),
  );

  const started: string[] = [];
  vi.mocked(resolvePluginMention).mockImplementation(({ itemId }) => {
    started.push(itemId);
    const gate = gates.get(itemId);

    if (!gate) throw new Error("Missing fixture gate");

    return gate.promise;
  });
  const work = resolvePluginMentionContextInputs(input(resources));

  try {
    await new Promise((done) => setImmediate(done));
    expect(started).toEqual(["a0", "b0", "c0"]);
    gates.get("b0")?.resolve(success("b0"));
    await new Promise((done) => setImmediate(done));
    expect(started).toEqual(["a0", "b0", "c0", "d0"]);
    expect(started).not.toContain("a1");
    gates.get("a0")?.resolve(success("a0"));
    await new Promise((done) => setImmediate(done));
    expect(started).toContain("a1");
  } finally {
    for (const [id, gate] of gates) gate.resolve(success(id));
    await work;
  }

  const output = await work;
  expect(
    output.map((value) =>
      value.type === "text" ? value.text.split("\n\n")[1] : null,
    ),
  ).toEqual(resources.map(([, id]) => id));
});

it("reports the first input-order failure and stops later same-plugin resources", async () => {
  const first = createDeferredPromise<PluginMentionResolveResult>();
  const started: string[] = [];
  vi.mocked(resolvePluginMention).mockImplementation(async ({ itemId }) => {
    started.push(itemId);

    if (itemId === "a0") return first.promise;

    if (itemId === "b0")
      return { ok: false, error: "second plugin failed first" };
    throw new Error("Later same-plugin work must not run");
  });

  const work = resolvePluginMentionContextInputs(
    input([
      ["a", "a0"],
      ["b", "b0"],
      ["a", "a1"],
    ]),
  );

  const failure = expect(work).rejects.toThrow("first resource failed later");

  try {
    await new Promise((done) => setImmediate(done));
    expect(started).toEqual(["a0", "b0"]);
  } finally {
    first.resolve({ ok: false, error: "first resource failed later" });
    await failure;
  }

  expect(started).not.toContain("a1");
});
