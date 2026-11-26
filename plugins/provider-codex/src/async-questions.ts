import type { PluginApi, PluginThreadEventPayloads } from "@omnyo/plugin-sdk";
import {
  CODEX_ASYNC_QUESTION_EXTENSION_KIND,
  codexAsyncQuestionStateSchema,
  type CodexAsyncQuestion,
  type CodexAsyncQuestionState,
} from "./extension-kinds.js";
import {
  CODEX_ASYNC_QUESTION_RENDERER_ID,
  asyncQuestionResponseSchema,
  formatAsyncQuestionAnswer,
} from "./async-question-form.js";
import { truncateCodePoints } from "./mcp-elicitation.js";

const CODEX_PROVIDER_ID = "codex";

const QUESTION_TIMEOUT_MS = 60 * 60 * 1000;

const EVENT_PAGE_SIZE = 100;

const RECHECK_INTERVAL_MS = 1000;

const MAX_QUESTIONS_PER_OPEN = 10;

const MAX_OPTIONS = 8;

const MAX_PROMPT_LENGTH = 2000;

const MAX_LABEL_LENGTH = 120;

const MAX_CONTEXT_LENGTH = 4096;

type ChatThread =
  PluginThreadEventPayloads["experimental_thread.events"]["thread"];

type AttentionCommand = Parameters<
  PluginApi["sdk"]["experimental_attention"]["command"]
>[0]["command"];

type NativeQuestion = Extract<
  AttentionCommand,
  { action: "open" }
>["questions"][number];

function cursorKey(threadId: string): string {
  return `async-question-cursor:${threadId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isChildChat(
  thread: Pick<ChatThread, "parentThreadId" | "originKind">,
): boolean {
  return thread.parentThreadId !== null && thread.originKind === null;
}

function uniqueOptionLabels(options: readonly string[] | null): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];

  for (const option of options ?? []) {
    const label = truncateCodePoints(option.trim(), MAX_LABEL_LENGTH);
    const key = label.toLowerCase();

    if (label.length === 0 || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }

  return labels;
}

function buildNativeQuestion(
  question: CodexAsyncQuestion,
  index: number,
): NativeQuestion {
  const labels = uniqueOptionLabels(question.options);
  const listed = labels.length >= 2 && labels.length <= MAX_OPTIONS;

  return {
    key: null,
    prompt: truncateCodePoints(question.title.trim(), MAX_PROMPT_LENGTH),
    context:
      listed || labels.length === 0
        ? null
        : truncateCodePoints(
            [
              labels.length === 1 ? "Choice:" : "Choices:",
              ...labels.map((label) => `- ${label}`),
            ].join("\n"),
            MAX_CONTEXT_LENGTH,
          ),
    shortLabel: `Question ${index + 1}`,
    mode: "required",
    multiSelect: false,
    allowFreeText: true,
    additiveNotes: true,
    delegable: false,
    options: listed
      ? labels.map((label, optionIndex) => ({
          value: String.fromCharCode(97 + optionIndex),
          label,
          description: null,
          preview: null,
          recommended: false,
        }))
      : [],
  };
}

interface CheckPass {
  again: boolean;
  childChat: boolean;
}

export function registerAsyncQuestions(api: PluginApi): void {
  const checks = new Map<string, { pass: CheckPass; done: Promise<void> }>();
  let disposed = false;
  api.onDispose(() => {
    disposed = true;
  });

  function warn(threadId: string, error: unknown): void {
    api.log.warn(
      `async question handling failed for thread ${threadId}: ${errorMessage(error)}`,
    );
  }

  async function check(threadId: string, childChat: boolean): Promise<void> {
    for (const state of await readNewQuestions(threadId)) {
      const opened = childChat
        ? openNativeQuestions(threadId, state)
        : ask(threadId, state);

      void opened.catch((error: unknown) => warn(threadId, error));
    }
  }

  async function run(threadId: string, pass: CheckPass): Promise<void> {
    try {
      for (;;) {
        pass.again = false;

        try {
          await check(threadId, pass.childChat);
        } catch (error) {
          warn(threadId, error);
          throw error;
        }

        if (!pass.again || disposed) return;
        await new Promise((resolve) =>
          setTimeout(resolve, RECHECK_INTERVAL_MS),
        );

        if (disposed) return;
      }
    } finally {
      checks.delete(threadId);
    }
  }

  function schedule(thread: ChatThread): Promise<void> {
    const childChat = isChildChat(thread);
    const active = checks.get(thread.id);

    if (active !== undefined) {
      active.pass.again = true;
      active.pass.childChat = childChat;

      return active.done;
    }

    const pass = { again: false, childChat };
    const done = run(thread.id, pass);
    checks.set(thread.id, { pass, done });

    return done;
  }

  async function readNewQuestions(
    threadId: string,
  ): Promise<CodexAsyncQuestionState[]> {
    const storedCursor =
      (await api.storage.kv.get<number>(cursorKey(threadId))) ?? 0;

    let cursor = storedCursor;
    const questions: CodexAsyncQuestionState[] = [];

    for (;;) {
      const page = await api.sdk.threads.events.list({
        threadId,
        afterSeq: String(cursor),
        order: "asc",
        limit: String(EVENT_PAGE_SIZE),
        types: ["thread/extensionState/updated"],
      });

      for (const row of page) {
        cursor = Math.max(cursor, row.seq);

        if (
          row.type !== "thread/extensionState/updated" ||
          row.data.kind !== CODEX_ASYNC_QUESTION_EXTENSION_KIND
        )
          continue;
        const state = codexAsyncQuestionStateSchema.safeParse(row.data.payload);

        if (state.success) questions.push(state.data);
      }

      if (page.length < EVENT_PAGE_SIZE) break;
    }

    if (cursor > storedCursor)
      await api.storage.kv.set(cursorKey(threadId), cursor);

    return questions;
  }

  async function openNativeQuestions(
    threadId: string,
    state: CodexAsyncQuestionState,
  ): Promise<void> {
    const questions = state.questions.map((question, index) =>
      buildNativeQuestion(question, index),
    );

    for (
      let start = 0;
      start < questions.length;
      start += MAX_QUESTIONS_PER_OPEN
    ) {
      await api.sdk.experimental_attention.command({
        threadId,
        command: {
          action: "open",
          questions: questions.slice(start, start + MAX_QUESTIONS_PER_OPEN),
        },
      });
    }
  }

  async function ask(
    threadId: string,
    state: CodexAsyncQuestionState,
  ): Promise<void> {
    const result = await api.ui.requestInput({
      threadId,
      rendererId: CODEX_ASYNC_QUESTION_RENDERER_ID,
      title:
        state.questions.length === 1
          ? state.questions[0].title
          : `${state.questions.length} questions`,
      payload: { questions: state.questions },
      timeoutMs: QUESTION_TIMEOUT_MS,
      presentation: {
        label: { pending: "Asking a question", completed: "Asked a question" },
        icon: { glyph: "MessageQuestion" },
      },
      describeSubmission: () => ({ title: "Answered" }),
    });

    if (result.outcome !== "submitted") return;
    const response = asyncQuestionResponseSchema.parse(result.value);
    await api.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [
        {
          type: "text",
          text: formatAsyncQuestionAnswer(state.questions, response),
          mentions: [],
        },
      ],
    });
  }

  api.events.on(
    "experimental_thread.events",
    ({ thread }) => {
      if (thread.providerId !== CODEX_PROVIDER_ID) return;

      return schedule(thread);
    },
    { experimental_eventTypes: ["thread/extensionState/updated"] },
  );

  api.events.on("thread.deleted", ({ thread }) => {
    void api.storage.kv.delete(cursorKey(thread.id));
  });
}
