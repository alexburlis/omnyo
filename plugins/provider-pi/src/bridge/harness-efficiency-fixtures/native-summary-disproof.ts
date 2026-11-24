import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

const PLACEHOLDER = "[harness-efficiency: older successful tool result elided]";

const RESULT_COUNT = 60;

const RESULT_BYTES = 8193;

const RESERVE_TOKENS = 6144;

function messageText(context: Context): string {
  return [
    context.systemPrompt ?? "",
    ...context.messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.flatMap((block) =>
            block.type === "text" ? [block.text] : [],
          )
        : [message.content],
    ),
  ].join("\n");
}

export async function runNativeSummaryDisproof(
  trigger: "precheck" | "postrun" | "overflow",
  contextWindow: number,
) {
  const scratchDir = mkdtempSync(
    join(tmpdir(), "omnyo-harness-efficiency-pi-"),
  );

  const requestOrder: string[] = [];

  const summaries: {
    exceedsWindow: boolean;
    containsOriginalOldResult: boolean;
    containsPlaceholder: boolean;
    syntheticInputTokens: number;
    outputReserve: number;
  }[] = [];

  const ordinaryRequests: {
    maskedResults: number;
    preservedRecentResults: number;
  }[] = [];

  const compactions: {
    reason: string;
    succeeded: boolean;
    willRetry: boolean;
  }[] = [];

  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;

  let originalResultsUnchanged = false;

  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: RESERVE_TOKENS,
        keepRecentTokens: 1,
      },
      retry: { enabled: false, maxRetries: 0 },
    });

    const masking: ExtensionFactory = (pi) => {
      pi.on("context", (event) => {
        const completed = event.messages.filter(
          (message) => message.role === "toolResult",
        );

        const eligibleIds = new Set(
          completed.slice(0, -8).map((message) => message.toolCallId),
        );

        return {
          messages: event.messages.map((message) => {
            if (
              message.role !== "toolResult" ||
              !eligibleIds.has(message.toolCallId) ||
              message.isError ||
              message.details !== undefined ||
              message.content.some((block) => block.type !== "text")
            ) {
              return message;
            }

            const text = message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n");

            return Buffer.byteLength(text, "utf8") > 8192
              ? {
                  ...message,
                  content: [{ type: "text" as const, text: PLACEHOLDER }],
                }
              : message;
          }),
        };
      });
    };

    const loader = new DefaultResourceLoader({
      cwd: scratchDir,
      agentDir: scratchDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [masking],
    });

    await loader.reload();

    const faux = fauxProvider({
      provider: "harness-efficiency-offline",
      models: [{ id: "synthetic", contextWindow, maxTokens: 8192 }],
    });

    const respond: FauxResponseFactory = (context, options) => {
      const text = messageText(context);

      const isSummary = context.messages.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              block.type === "text" && block.text.startsWith("<conversation>"),
          ),
      );

      if (isSummary) {
        requestOrder.push("summary");

        const syntheticInputTokens = Math.ceil(
          Buffer.byteLength(text, "utf8") / 4,
        );

        const outputReserve = options?.maxTokens ?? 0;

        const exceedsWindow =
          syntheticInputTokens + outputReserve > contextWindow;

        summaries.push({
          exceedsWindow,
          containsOriginalOldResult: text.includes("OLD_RESULT_0:"),
          containsPlaceholder: text.includes(PLACEHOLDER),
          syntheticInputTokens,
          outputReserve,
        });

        if (exceedsWindow) {
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "maximum context length exceeded",
          });
        }

        return fauxAssistantMessage("Bounded native summary.");
      }

      const results = context.messages.filter(
        (message) => message.role === "toolResult",
      );

      requestOrder.push("ordinary");

      ordinaryRequests.push({
        maskedResults: results.filter((message) =>
          message.content.some(
            (block) => block.type === "text" && block.text === PLACEHOLDER,
          ),
        ).length,
        preservedRecentResults: results.filter((message) =>
          message.content.some(
            (block) =>
              block.type === "text" && block.text.length === RESULT_BYTES,
          ),
        ).length,
      });

      return trigger === "overflow"
        ? fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "maximum context length exceeded",
          })
        : fauxAssistantMessage(
            trigger === "postrun" ? "x".repeat(16000) : "done",
          );
    };

    faux.setResponses(Array.from({ length: 4 }, () => respond));

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });

    modelRuntime.registerNativeProvider(faux.provider);
    const model = faux.getModel();
    const manager = SessionManager.inMemory(scratchDir);

    const assistant = (
      input: number,
      content: AssistantMessage["content"],
    ): AssistantMessage => ({
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now() - 60000,
      stopReason: content.some((block) => block.type === "toolCall")
        ? "toolUse"
        : "stop",
      usage: {
        input,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });

    for (let index = 0; index < RESULT_COUNT; index++) {
      manager.appendMessage({
        role: "user",
        content: `step ${index}`,
        timestamp: Date.now() - 60000,
      });
      manager.appendMessage(
        assistant(100, [
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "huge_output",
            arguments: {},
          },
        ]),
      );
      manager.appendMessage({
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "huge_output",
        content: [
          {
            type: "text",
            text: `OLD_RESULT_${index}:`.padEnd(RESULT_BYTES, "x"),
          },
        ],
        isError: false,
        timestamp: Date.now() - 60000,
      });
      manager.appendMessage(
        assistant(100, [{ type: "text", text: "step complete" }]),
      );
    }

    manager.appendMessage(
      assistant(
        trigger === "precheck" ? contextWindow - RESERVE_TOKENS + 1 : 100,
        [{ type: "text", text: "ready" }],
      ),
    );
    ({ session } = await createAgentSession({
      cwd: scratchDir,
      agentDir: scratchDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      modelRuntime,
      model,
      thinkingLevel: "off",
      noTools: "all",
    }));
    session.agent.streamFunction = (requestModel, context, options) =>
      modelRuntime.streamSimple(requestModel, context, {
        ...options,
        cacheRetention: "none",
      });
    await session.bindExtensions({});
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactions.push({
          reason: event.reason,
          succeeded: event.result !== undefined,
          willRetry: event.willRetry,
        });
      }
    });
    await session.prompt("Continue the frozen synthetic task.");

    const results = manager
      .getEntries()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "toolResult"
          ? [entry.message]
          : [],
      );

    originalResultsUnchanged =
      results.length === RESULT_COUNT &&
      results.every(
        (message, index) =>
          message.toolCallId === `call-${index}` &&
          message.content.length === 1 &&
          message.content[0]?.type === "text" &&
          message.content[0].text ===
            `OLD_RESULT_${index}:`.padEnd(RESULT_BYTES, "x"),
      );
  } finally {
    session?.dispose();
    rmSync(scratchDir, { recursive: true, force: true });
  }

  return {
    requestOrder,
    summaries,
    ordinaryRequests,
    compactions,
    originalResultsUnchanged,
    scratchRemoved: !existsSync(scratchDir),
  };
}
