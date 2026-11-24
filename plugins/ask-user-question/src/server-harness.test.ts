import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createFakePluginHost,
  type FakePluginHost,
  makePluginAgentConfigurationContext,
} from "@omnyo/plugin-sdk/testing";
import plugin, { TOOL_NAME } from "./server.js";
import { TOO_FEW_OPTIONS_MESSAGE } from "./tool-definition.js";
import { toolInputSchema } from "./contracts.js";

async function createHost(): Promise<FakePluginHost> {
  const host = createFakePluginHost({ pluginId: "ask-user-question" });
  host.harness.sdk.stub("experimental_attention.adopt", () => ({
    ok: true,
    imported: false,
  }));
  await plugin(host.api as unknown as Parameters<typeof plugin>[0]);

  return host;
}

function configurationContext(
  providerId: string,
  supportsNativeUserQuestion = false,
) {
  return makePluginAgentConfigurationContext({
    provider: {
      id: providerId,
      capabilities: { supportsNativeUserQuestion },
    },
  });
}

const questions = [
  {
    question: "Which database should we use?",
    header: "Database",
    multiSelect: false,
    options: [
      {
        label: "Postgres (Recommended)",
        description: "Relational, needs a server.",
        preview: "CREATE TABLE users (id uuid primary key);",
      },
      { label: "SQLite", description: "Embedded, zero setup." },
    ],
  },
];

async function resultText(
  result: Awaited<ReturnType<FakePluginHost["harness"]["callAgentTool"]>>,
): Promise<string> {
  if (typeof result === "string") return result;
  const [part] = result.content;

  if (part?.type !== "text") throw new Error("expected a text result");

  return part.text;
}

describe("provider gating", () => {
  it.each(["some-plugin-provider"])(
    "withholds the tool from %s, which declares it natively",
    async (providerId) => {
      const host = await createHost();

      const resolved = await host.harness.resolveAgentConfiguration(
        configurationContext(providerId, true),
      );

      expect(resolved.tools).toEqual([]);
    },
  );

  it.each(["codex", "claude-code", "pi", "acp-cursor"])(
    "registers the tool for %s with the schema generated from its input parser",
    async (providerId) => {
      const host = await createHost();

      const resolved = await host.harness.resolveAgentConfiguration(
        configurationContext(providerId),
      );

      expect(resolved.tools).toHaveLength(1);
      const [tool] = resolved.tools;
      expect(tool?.name).toBe(TOOL_NAME);
      expect(tool?.inputSchema).toEqual(
        z.toJSONSchema(toolInputSchema, { io: "input" }),
      );
    },
  );

  it.each([
    { kind: "root", parentThreadId: null, originKind: null, offered: false },
    {
      kind: "side chat",
      parentThreadId: "thr_parent",
      originKind: "fork",
      offered: false,
    },
    {
      kind: "child",
      parentThreadId: "thr_parent",
      originKind: null,
      offered: true,
    },
  ] as const)(
    "offers the tool to a hidden $kind only when its questions reach a parent chat",
    async ({ parentThreadId, originKind, offered }) => {
      const host = await createHost();

      const resolved = await host.harness.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          thread: { experimental_visibility: "hidden", parentThreadId },
          origin: { kind: originKind, pluginId: null },
          provider: {
            id: "claude-code",
            capabilities: { supportsNativeUserQuestion: false },
          },
        }),
      );

      expect(resolved.tools.map((tool) => tool.name)).toEqual(
        offered ? [TOOL_NAME] : [],
      );
    },
  );

  it("offers the tool to child chats so their questions reach the parent chat", async () => {
    const host = await createHost();

    const resolved = await host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { parentThreadId: "thr_parent" },
        provider: {
          id: "claude-code",
          capabilities: { supportsNativeUserQuestion: false },
        },
      }),
    );

    expect(resolved.tools.map((tool) => tool.name)).toEqual([TOOL_NAME]);
  });

  it.each(["codex", "pi", "acp-cursor"])(
    "does not prescribe provider-specific plan tools to %s",
    async (providerId) => {
      const host = await createHost();

      const resolved = await host.harness.resolveAgentConfiguration(
        configurationContext(providerId),
      );

      expect(resolved.tools).toHaveLength(1);
      expect(resolved.tools[0]?.description).not.toMatch(
        /EnterPlanMode|ExitPlanMode/,
      );
    },
  );

  it("advertises multiSelect as optional and defaults it during execution", async () => {
    const host = await createHost();

    const resolved = await host.harness.resolveAgentConfiguration(
      configurationContext("codex"),
    );

    expect(resolved.tools[0]?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["questions"],
      properties: {
        questions: {
          minItems: 1,
          maxItems: 4,
          items: {
            additionalProperties: false,
            required: ["question", "header", "options"],
            properties: {
              question: { minLength: 1, description: expect.any(String) },
              header: { minLength: 1, description: expect.any(String) },
              multiSelect: { type: "boolean", default: false },
              options: {
                minItems: 2,
                maxItems: 4,
                items: {
                  additionalProperties: false,
                  required: ["label", "description"],
                  properties: {
                    label: { minLength: 1, description: expect.any(String) },
                    description: {
                      minLength: 1,
                      description: expect.any(String),
                    },
                    preview: {
                      maxLength: 4096,
                      description: expect.any(String),
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    host.harness.sdk.stub("experimental_attention.command", () => ({
      questions: [],
      callbacks: [],
      cleared: false,
      callbackMarker: null,
      routedToThreadId: null,
    }));
    await host.harness.callAgentTool(TOOL_NAME, {
      questions: [{ ...questions[0], multiSelect: undefined }],
    });
    expect(
      host.harness.sdk.callsTo("experimental_attention.command")[0]?.[0],
    ).toMatchObject({ command: { questions: [{ multiSelect: false }] } });
  });
});

describe("asking a question", () => {
  it.each([
    ["root", { questions, extra: true }],
    [
      "question",
      {
        questions: questions.map((question) => ({ ...question, extra: true })),
      },
    ],
    [
      "option",
      {
        questions: questions.map((question) => ({
          ...question,
          options: question.options.map((option) => ({
            ...option,
            extra: true,
          })),
        })),
      },
    ],
  ])("rejects unknown fields on the %s object", async (_level, input) => {
    const host = await createHost();
    await expect(host.harness.callAgentTool(TOOL_NAME, input)).rejects.toThrow(
      'Unrecognized key: "extra"',
    );
    expect(host.harness.pendingInteractions).toHaveLength(0);
  });

  it.each([0, 1])(
    "rejects %i options with guidance to proceed before opening an interaction",
    async (optionCount) => {
      const host = await createHost();
      await expect(
        host.harness.callAgentTool(TOOL_NAME, {
          questions: [
            {
              ...questions[0],
              options: questions[0]!.options.slice(0, optionCount),
            },
          ],
        }),
      ).rejects.toThrow(TOO_FEW_OPTIONS_MESSAGE);
      expect(host.harness.pendingInteractions).toHaveLength(0);
    },
  );

  it.each(["required", "optional"])(
    "opens %s native questions asynchronously without a second plugin form",
    async (mode) => {
      const host = await createHost();
      host.harness.sdk.stub("experimental_attention.command", () => ({
        questions: [],
        callbacks: [],
        cleared: false,
        callbackMarker: null,
        routedToThreadId: null,
      }));

      const result = await host.harness.callAgentTool(TOOL_NAME, {
        questions,
        mode,
      });

      expect(host.harness.pendingInteractions).toHaveLength(0);
      expect(
        host.harness.sdk.callsTo("experimental_attention.command")[0]?.[0],
      ).toMatchObject({
        command: {
          action: "open",
          questions: [
            { mode, prompt: questions[0]?.question, additiveNotes: true },
          ],
        },
      });
      expect(JSON.parse(await resultText(result))).toMatchObject({
        delivery: "asynchronous",
        instruction: expect.stringContaining(
          "withdraw it with omnyo question command --self",
        ),
      });
    },
  );

  it.each(["required", "optional"])(
    "tells a routed chat that its %s question went to the chat it reports to, not the owner",
    async (mode) => {
      const host = await createHost();
      host.harness.sdk.stub("experimental_attention.command", () => ({
        questions: [],
        callbacks: [],
        cleared: false,
        callbackMarker: null,
        routedToThreadId: "thr_parent",
      }));

      const result = await host.harness.callAgentTool(TOOL_NAME, {
        questions,
        mode,
      });

      const parsed = JSON.parse(await resultText(result));

      expect(parsed).toMatchObject({
        questions: [],
        delivery: "parent-chat",
        parentThreadId: "thr_parent",
        instruction: expect.stringContaining(
          "reports to thr_parent. The question went to that chat, not the owner",
        ),
      });
      expect(parsed.instruction).toContain("arrives as a message in this chat");
      expect(parsed.instruction).not.toMatch(/withdraw|question command/);
    },
  );

  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])(
    "maps delegable %s to an open command marked %s",
    async (delegable, expected) => {
      const host = await createHost();
      host.harness.sdk.stub("experimental_attention.command", () => ({
        questions: [],
        callbacks: [],
        cleared: false,
        callbackMarker: null,
        routedToThreadId: null,
      }));

      await host.harness.callAgentTool(TOOL_NAME, {
        questions: [{ ...questions[0], delegable }],
      });

      expect(
        host.harness.sdk.callsTo("experimental_attention.command")[0]?.[0],
      ).toMatchObject({
        command: { action: "open", questions: [{ delegable: expected }] },
      });
    },
  );

  it("surfaces a native service failure instead of claiming a question was shown", async () => {
    const host = await createHost();
    host.harness.sdk.stub("experimental_attention.command", () => {
      throw new Error("Native question service unavailable");
    });
    await expect(
      host.harness.callAgentTool(TOOL_NAME, { questions }),
    ).rejects.toThrow("Native question service unavailable");
    expect(host.harness.pendingInteractions).toHaveLength(0);
  });

  it("rejects oversized previews before opening an interaction", async () => {
    const host = await createHost();
    const preview = "x".repeat(4096);

    const result = await host.harness.callAgentTool(TOOL_NAME, {
      questions: Array.from({ length: 4 }, (_unused, index) => ({
        question: `Question ${index}?`,
        header: `Q${index}`,
        multiSelect: false,
        options: Array.from({ length: 4 }, (_option, optionIndex) => ({
          label: `Option ${optionIndex}`,
          description: "Detail.",
          preview,
        })),
      })),
    });

    expect(result).toMatchObject({ isError: true });
    expect(await resultText(result)).toContain("too large to display");
    expect(host.harness.pendingInteractions).toHaveLength(0);
  });
});
