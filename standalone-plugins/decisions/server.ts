import { posix, win32 } from "node:path";
import { defineRpcContract, type PluginApi, type PluginCliContext } from "@omnyo/plugin-sdk";
import { z } from "zod";

/* ----------------------------------------------------------- model -- */

const LIMITS = {
  key: 24,
  question: 300,
  context: 2000,
  optionLabel: 120,
  optionDescription: 300,
  minOptions: 2,
  maxOptions: 8,
  perCall: 10,
  openPerThread: 20,
  answerText: 2000,
} as const;

const optionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  recommended: z.boolean(),
});

export type DecisionOption = z.infer<typeof optionSchema>;

const answerSchema = z.object({
  optionIds: z.array(z.string()),
  text: z.string().nullable(),
});

export type DecisionAnswer = z.infer<typeof answerSchema>;

const DECISION_KINDS = ["choice", "text"] as const;

const DECISION_STATES = ["open", "answered", "skipped", "withdrawn"] as const;

const decisionSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  key: z.string().nullable(),
  question: z.string(),
  context: z.string().nullable(),
  kind: z.enum(DECISION_KINDS),
  multiSelect: z.boolean(),
  allowText: z.boolean(),
  options: z.array(optionSchema),
  state: z.enum(DECISION_STATES),
  answer: answerSchema.nullable(),
  createdAt: z.number(),
  answeredAt: z.number().nullable(),
  revision: z.number().int().min(1),
});

export type Decision = z.infer<typeof decisionSchema>;

const groupSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  projectName: z.string(),
  decisions: z.array(decisionSchema),
});

export type DecisionGroup = z.infer<typeof groupSchema>;

const answerInputSchema = z.object({
  decisionId: z.string().min(1),
  revision: z.number().int().min(1),
  optionIds: z.array(z.string().min(1)).max(LIMITS.maxOptions),
  text: z.string().max(LIMITS.answerText).nullable(),
});

export type AnswerInput = z.infer<typeof answerInputSchema>;

/* -------------------------------------------------------- contract -- */

export const rpcContract = defineRpcContract({
  /** Every chat with open decisions and its count: the sidebar marker's read. */
  open_index: {
    input: z.null(),
    output: z.object({
      threads: z.array(z.object({ threadId: z.string(), count: z.number() })),
    }),
  },
  /** One chat's open decisions, in the order the agent opened them. */
  thread_decisions: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ decisions: z.array(decisionSchema) }),
  },
  /** Every chat's open decisions with live titles: the Decisions page. */
  overview: {
    input: z.null(),
    output: z.object({ groups: z.array(groupSchema), error: z.string().nullable() }),
  },
  /** Answer one or more open decisions of one chat and deliver the answers. */
  answer: {
    input: z.object({
      threadId: z.string().min(1),
      answers: z.array(answerInputSchema).min(1).max(LIMITS.openPerThread),
    }),
    output: z.object({
      answered: z.number(),
      delivery: z.enum(["sent", "queued"]),
    }),
  },
  /** Dismiss one question silently, without messaging or granting approval. */
  skip: {
    input: z.object({ threadId: z.string().min(1), decisionId: z.string().min(1) }),
    output: z.object({ skipped: z.number() }),
  },
});

const CHANGED = "decisions-changed";

/** A stored row, parsed where it leaves SQLite. */
const decisionRowSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  key: z.string().nullable(),
  question: z.string(),
  context: z.string().nullable(),
  kind: z.string(),
  multi_select: z.number(),
  allow_text: z.number(),
  options_json: z.string(),
  state: z.string(),
  answer_json: z.string().nullable(),
  created_at: z.number(),
  answered_at: z.number().nullable(),
  withdrawn_at: z.number().nullable(),
  position: z.number(),
  revision: z.number().int().min(1),
});

type DecisionRow = z.infer<typeof decisionRowSchema>;

/** What the SDK throws for a thread the server reports as gone. */
const notFoundSchema = z.object({ status: z.literal(404) });

class DecisionsError extends Error {}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function isThreadGone(cause: unknown): boolean {
  return notFoundSchema.safeParse(cause).success;
}

/** Stored JSON is ours, but parse it at the boundary like anything else. */
function parseOptions(json: string): DecisionOption[] {
  const parsed = z.array(optionSchema).safeParse(JSON.parse(json));

  return parsed.success ? parsed.data : [];
}

function parseAnswer(json: string | null): DecisionAnswer | null {
  if (json === null) return null;
  const parsed = answerSchema.safeParse(JSON.parse(json));

  return parsed.success ? parsed.data : null;
}

function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    threadId: row.thread_id,
    key: row.key,
    question: row.question,
    context: row.context,
    kind: row.kind === "text" ? "text" : "choice",
    multiSelect: row.multi_select === 1,
    allowText: row.allow_text === 1,
    options: parseOptions(row.options_json),
    state: z.enum(DECISION_STATES).parse(row.state),
    answer: parseAnswer(row.answer_json),
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    revision: row.revision,
  };
}

/** "D1 · Which tabs?" — the key leads when the agent gave one. */
function label(decision: Pick<Decision, "key" | "question">): string {
  return decision.key === null ? decision.question : `${decision.key} · ${decision.question}`;
}

export default async function plugin(api: PluginApi) {
  await api.sdk.experimental_attention.adopt({ pluginId: "decisions" });

  type NativeQuestion = Awaited<
    ReturnType<PluginApi["sdk"]["experimental_attention"]["snapshot"]>
  >["questions"][number];

  function legacyRow(row: NativeQuestion): DecisionRow {
    return {
      id: row.id,
      thread_id: row.threadId,
      key: row.question.key,
      question: row.question.prompt,
      context: row.question.context,
      kind: row.question.options.length === 0 ? "text" : "choice",
      multi_select: row.question.multiSelect ? 1 : 0,
      allow_text: row.question.allowFreeText ? 1 : 0,
      options_json: JSON.stringify(
        row.question.options.map((option) => ({
          id: option.value,
          label: option.label,
          description: option.description,
          recommended: option.recommended,
        })),
      ),
      state: row.state,
      answer_json:
        row.answer === null
          ? null
          : JSON.stringify({ optionIds: row.answer.selected, text: row.answer.freeText ?? null }),
      created_at: row.createdAt,
      answered_at: row.state === "answered" ? row.updatedAt : null,
      withdrawn_at: row.state === "withdrawn" ? row.updatedAt : null,
      position: row.createdAt,
      revision: row.revision,
    };
  }

  async function readOpen(threadId: string): Promise<DecisionRow[]> {
    return (await api.sdk.experimental_attention.snapshot()).questions
      .filter((row) => row.threadId === threadId)
      .map(legacyRow);
  }

  async function readRecent(threadId: string, limit: number): Promise<DecisionRow[]> {
    return (await api.sdk.experimental_attention.history({ threadId })).questions
      .slice(-limit)
      .reverse()
      .map(legacyRow);
  }

  async function readById(id: string, threadId?: string): Promise<DecisionRow | undefined> {
    const snapshot =
      threadId === undefined
        ? await api.sdk.experimental_attention.snapshot()
        : await api.sdk.experimental_attention.history({ threadId });

    const question = snapshot.questions.find((row) => row.id === id);

    return question === undefined ? undefined : legacyRow(question);
  }

  async function openIndex(): Promise<Array<{ threadId: string; count: number }>> {
    const counts = new Map<string, number>();

    for (const row of (await api.sdk.experimental_attention.snapshot()).questions)
      counts.set(row.threadId, (counts.get(row.threadId) ?? 0) + 1);

    return [...counts].map(([threadId, count]) => ({ threadId, count }));
  }

  function publish(): void {
    api.realtime.publish(CHANGED, null);
  }

  /* ------------------------------------------------------- threads -- */

  type Thread = Awaited<ReturnType<PluginApi["sdk"]["threads"]["get"]>>;

  function threadTitle(thread: Thread): string {
    return thread.title ?? thread.titleFallback ?? thread.id;
  }

  /** A chat that can take decisions: exists, visible, not archived or deleted. */
  async function requireLiveThread(threadId: string): Promise<Thread> {
    let thread: Thread;

    try {
      thread = await api.sdk.threads.get({ threadId });
    } catch (cause) {
      throw new DecisionsError(`No chat with id ${threadId} (${errorText(cause)}).`);
    }

    if (thread.deletedAt !== null) throw new DecisionsError(`Chat ${threadId} has been deleted.`);

    if (thread.archivedAt !== null) throw new DecisionsError(`Chat ${threadId} is archived.`);

    if (thread.visibility === "hidden") {
      throw new DecisionsError(
        `Chat ${threadId} is a hidden worker chat. The user never sees it, so decisions belong in the visible chat that spawned it.`,
      );
    }

    return thread;
  }

  /* ------------------------------------------------------ opening -- */

  type NewDecision = {
    key: string | null;
    question: string;
    context: string | null;
    options: Array<{ label: string; description: string | null; recommended: boolean }>;
    multiSelect: boolean;
    allowText: boolean;
  };

  function validateNew(input: NewDecision): void {
    if (input.options.length === 1) {
      throw new DecisionsError(
        `"${input.question}" has one option. Give at least ${LIMITS.minOptions}, or none for a free-text decision.`,
      );
    }

    const labels = new Set<string>();

    for (const option of input.options) {
      const normalized = option.label.toLowerCase();

      if (labels.has(normalized)) {
        throw new DecisionsError(`"${input.question}" lists the option "${option.label}" twice.`);
      }

      labels.add(normalized);
    }

    if (input.multiSelect && input.options.length === 0) {
      throw new DecisionsError(`"${input.question}" is multi-select but has no options.`);
    }

    if (input.options.filter((option) => option.recommended).length > 1) {
      throw new DecisionsError(`"${input.question}" marks more than one option recommended.`);
    }
  }

  async function openDecisions(threadId: string, inputs: NewDecision[]): Promise<Decision[]> {
    await requireLiveThread(threadId);

    for (const input of inputs) validateNew(input);

    const result = await api.sdk.experimental_attention.command({
      threadId,
      command: {
        action: "open",
        questions: inputs.map((input) => ({
          key: input.key,
          prompt: input.question,
          context: input.context,
          shortLabel: input.key ?? "Question",
          mode: "optional",
          multiSelect: input.multiSelect,
          allowFreeText: input.options.length === 0 || input.allowText,
          additiveNotes: true,
          options: input.options.map((option, index) => ({
            value: String.fromCharCode(97 + index),
            label: option.label,
            description: option.description,
            preview: null,
            recommended: option.recommended,
          })),
        })),
      },
    });

    publish();

    return result.questions.map((row) => toDecision(legacyRow(row)));
  }

  /* ------------------------------------------------------ updating -- */

  async function updateDecision(
    threadId: string,
    reference: string,
    changes: z.infer<typeof decisionPatchInput>,
  ): Promise<Decision> {
    await requireLiveThread(threadId);

    const row =
      (await readById(reference, threadId)) ??
      (await readOpen(threadId)).find((item) => item.key === reference);

    if (row === undefined || row.thread_id !== threadId || row.state !== "open")
      throw new DecisionsError(`No open decision ${reference} in this chat.`);

    if (Object.keys(changes).length === 0)
      throw new DecisionsError("Supply at least one field to change.");

    const current = (await api.sdk.experimental_attention.history({ threadId })).questions.find(
      (question) => question.id === row.id,
    );

    if (!current) throw new DecisionsError("Question not found");

    const options =
      changes.options === undefined
        ? current.question.options
        : changes.options.map((option, index) => ({
            value: String.fromCharCode(97 + index),
            label: option.label,
            description: option.description ?? null,
            preview: null,
            recommended: option.recommended ?? false,
          }));

    const result = await api.sdk.experimental_attention.command({
      threadId,
      command: {
        action: "update",
        id: row.id,
        revision: row.revision,
        question: {
          ...current.question,
          prompt: changes.question ?? current.question.prompt,
          context: changes.context === undefined ? current.question.context : changes.context,
          options,
          multiSelect: changes.multiSelect ?? current.question.multiSelect,
          allowFreeText:
            options.length === 0 || (changes.allowText ?? current.question.allowFreeText),
        },
      },
    });

    publish();
    const updated = result.questions[0];

    if (!updated) throw new DecisionsError("Question update returned no record");

    return toDecision(legacyRow(updated));
  }

  /* ----------------------------------------------------- answering -- */

  async function answerDecisions(
    threadId: string,
    inputs: AnswerInput[],
  ): Promise<{ answered: number; delivery: "sent" | "queued" }> {
    await requireLiveThread(threadId);
    const seen = new Set<string>();
    const validated = [];

    for (const input of inputs) {
      if (seen.has(input.decisionId)) throw new DecisionsError("A question is answered twice");
      seen.add(input.decisionId);
      const row = await readById(input.decisionId, threadId);

      if (!row || row.thread_id !== threadId || row.revision !== input.revision)
        throw new DecisionsError("The question changed; review it before answering");
      const decision = toDecision(row);
      const selected = [...new Set(input.optionIds)];

      if (selected.some((id) => !decision.options.some((option) => option.id === id)))
        throw new DecisionsError("Unknown question option");

      if (!decision.multiSelect && selected.length > 1)
        throw new DecisionsError("Choose one option");
      const text = input.text?.trim() ?? "";

      if (text && !decision.allowText)
        throw new DecisionsError("This question accepts choices only");

      if (selected.length === 0 && text === "") throw new DecisionsError("Supply an answer");

      type NativeAnswer = NonNullable<NativeQuestion["answer"]>;

      const answer: NativeAnswer = { selected };

      if (text !== "") answer.freeText = text;
      validated.push({
        action: "answer" as const,
        id: decision.id,
        revision: input.revision,
        answer,
      });
    }

    for (const command of validated)
      await api.sdk.experimental_attention.command({ threadId, command });
    publish();

    return { answered: inputs.length, delivery: "queued" };
  }

  async function skipDecision(threadId: string, decisionId: string) {
    const row = await readById(decisionId, threadId);

    if (!row || row.thread_id !== threadId) throw new DecisionsError("Question not found");
    await api.sdk.experimental_attention.command({
      threadId,
      command: { action: "skip", id: row.id, revision: row.revision },
    });
    publish();

    return { skipped: 1 };
  }

  /* ---------------------------------------------------- withdrawing -- */

  async function withdrawDecisions(threadId: string, refs: string[] | "all") {
    const open = (await readOpen(threadId)).map(toDecision);
    const unknown: string[] = [];

    const targets =
      refs === "all"
        ? open
        : refs.flatMap((ref) => {
            const match = open.find((decision) => decision.id === ref || decision.key === ref);

            if (match === undefined) {
              unknown.push(ref);

              return [];
            }

            return [match];
          });

    for (const decision of targets)
      await api.sdk.experimental_attention.command({
        threadId,
        command: { action: "withdraw", id: decision.id, revision: decision.revision },
      });
    publish();

    return { withdrawn: targets, unknown };
  }

  /* ------------------------------------------------------ overview -- */

  async function readOverview(): Promise<{ groups: DecisionGroup[]; error: string | null }> {
    const index = await openIndex();
    const names = new Map<string, string>();

    try {
      for (const project of await api.sdk.projects.list()) names.set(project.id, project.name);
    } catch {
      // Project names are decoration; the groups stand without them.
    }

    const groups: DecisionGroup[] = [];
    let error: string | null = null;

    for (const { threadId } of index) {
      let thread: Thread;

      try {
        thread = await api.sdk.threads.get({ threadId });
      } catch (cause) {
        if (isThreadGone(cause)) {
          continue;
        }

        error ??= errorText(cause);
        continue;
      }

      if (thread.deletedAt !== null || thread.archivedAt !== null) {
        continue;
      }

      groups.push({
        threadId,
        title: threadTitle(thread),
        projectName: names.get(thread.projectId) ?? "",
        decisions: (await readOpen(threadId)).map(toDecision),
      });
    }

    return { groups, error };
  }

  /* ----------------------------------------------------------- rpc -- */

  api.rpc.register(rpcContract, {
    open_index: async () => ({ threads: await openIndex() }),
    thread_decisions: async ({ threadId }) => ({
      decisions: (await readOpen(threadId)).map(toDecision),
    }),
    overview: () => readOverview(),
    answer: ({ threadId, answers }) => answerDecisions(threadId, answers),
    skip: ({ threadId, decisionId }) => skipDecision(threadId, decisionId),
  });

  /* -------------------------------------------------------- agents -- */

  const optionInput = z.object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.optionLabel)
      .describe("What the user picks. Short and self-explanatory."),
    description: z
      .string()
      .trim()
      .max(LIMITS.optionDescription)
      .optional()
      .describe("The consequence of picking it: what changes, what it costs."),
    recommended: z
      .boolean()
      .optional()
      .describe("Mark your recommendation. At most one option per decision."),
  });

  const decisionInput = z.object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.key)
      .optional()
      .describe('A short handle the user and you can refer to, such as "D1".'),
    question: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.question)
      .describe("One question, answerable on its own."),
    context: z
      .string()
      .trim()
      .max(LIMITS.context)
      .optional()
      .describe(
        "The tradeoff and the default you are proceeding with. For a required answer, name the exact action it blocks. Keep it short.",
      ),
    options: z
      .array(optionInput)
      .max(LIMITS.maxOptions)
      .optional()
      .describe(
        `${LIMITS.minOptions}–${LIMITS.maxOptions} choices. Omit for a free-text decision answered in the user's own words.`,
      ),
    multiSelect: z.boolean().optional().describe("Allow more than one choice."),
    allowText: z
      .boolean()
      .optional()
      .describe(
        "Show a free-text field beside the choices for a note or an answer of the user's own. Defaults to true.",
      ),
  });

  const decisionPatchInput = decisionInput
    .omit({ key: true })
    .partial()
    .extend({
      context: decisionInput.shape.context.unwrap().nullable().optional(),
    })
    .strict();

  api.agents.registerTool({
    name: "decisions_open",
    description:
      "Ask for user input only when it materially helps and you cannot resolve it from the request, code, docs or a sensible default. Decisions appear above the composer; they do not block work. Proceed with a stated reversible default and treat later answers as steering. Skip silently dismisses a decision without approval. Defaults to your chat.",
    instructions:
      'Be autonomous first. Resolve routine choices from the request, code, docs and sensible defaults; do not ask just because several options exist. Open decisions only for input that materially changes the outcome and cannot reasonably be settled yourself. State your recommendation and the reversible default you are proceeding with in `context`, then continue the task, including work affected by that default. Do not stop or end a turn merely to wait for an optional answer. Stop only the specific action that requires missing authority, essential unavailable information/access, or an unsafe or irreversible guess; keep doing all other authorized work. Batch needed questions with decisions_open. Answers arrive as "Question answered": treat them as steering of the current task and adjust completed work if needed. Update a changed pending question with decisions_update; withdraw only when user input no longer matters. Skip/dismiss is silent and grants no answer or approval. Do not reopen a dismissed question unless the user asks; check decisions_list when you need its current state.',
    presentation: {
      label: {
        pending: "Opening decisions for the user",
        completed: "Opened decisions for the user",
      },
      icon: { glyph: "decisions/signpost" },
    },
    parameters: z.object({
      decisions: z.array(decisionInput).min(1).max(LIMITS.perCall),
      thread: z
        .string()
        .optional()
        .describe(
          "Chat id. Omit for your own chat; pass one only when the user asked you to open decisions in another chat.",
        ),
    }),
    execute: async (params, ctx) => {
      try {
        const threadId = resolveThreadId(params.thread, ctx.threadId);

        const created = await openDecisions(
          threadId,
          params.decisions.map((decision) => ({
            key: decision.key ?? null,
            question: decision.question,
            context: decision.context ?? null,
            options: (decision.options ?? []).map((option) => ({
              label: option.label,
              description: option.description ?? null,
              recommended: option.recommended ?? false,
            })),
            multiSelect: decision.multiSelect ?? false,
            allowText: decision.allowText ?? true,
          })),
        );

        return [
          `Opened ${plural(created.length, "decision", "decisions")}${threadId === ctx.threadId ? "" : ` in chat ${threadId}`}:`,
          ...created.map((decision) => `  - ${decision.id}  ${label(decision)}`),
          "",
          'Continue the task with your stated reversible defaults; do not wait for optional answers or ask again in prose. Later "Question answered" messages steer ongoing work. Only missing required authority, essential information/access or an unsafe irreversible guess blocks its specific action. Skip/dismiss closes a question silently.',
        ].join("\n");
      } catch (cause) {
        return { content: [{ type: "text" as const, text: errorText(cause) }], isError: true };
      }
    },
  });

  api.agents.registerTool({
    name: "decisions_update",
    description:
      "Update an open decision by id or key as work progresses. Keep its identity and panel position; change only the supplied question, context, options or input settings. Continue working with your stated default. Closed decisions stay closed. Defaults to your chat.",
    presentation: {
      label: { pending: "Updating decision", completed: "Updated decision" },
      icon: { glyph: "decisions/signpost" },
    },
    parameters: z.object({
      id: z.string().trim().min(1).describe("The open decision id or key in this chat."),
      changes: decisionPatchInput.describe(
        "Fields to change. Omitted fields stay unchanged; context: null clears context. Options replace the choices.",
      ),
      thread: z.string().optional().describe("Chat id. Omit for your own chat."),
    }),
    execute: async (params, ctx) => {
      try {
        const decision = await updateDecision(
          resolveThreadId(params.thread, ctx.threadId),
          params.id,
          params.changes,
        );

        return `Updated ${decision.id} (revision ${decision.revision}): ${label(decision)}. Continue the task with your stated default; any later answer is steering.`;
      } catch (cause) {
        return { content: [{ type: "text" as const, text: errorText(cause) }], isError: true };
      }
    },
  });

  api.agents.registerTool({
    name: "decisions_list",
    description:
      "List this chat's decisions: the ones still open, and the recent answered, skipped or withdrawn ones with their answers. Defaults to the chat you are running in.",
    presentation: {
      label: { pending: "Reading decisions", completed: "Read decisions" },
      icon: { glyph: "decisions/signpost" },
    },
    parameters: z.object({
      thread: z.string().optional().describe("Chat id. Omit for your own chat."),
    }),
    execute: async (params, ctx) => {
      try {
        const threadId = resolveThreadId(params.thread, ctx.threadId);
        const rows = (await readRecent(threadId, 50)).map(toDecision);

        if (rows.length === 0) return "This chat has no decisions.";

        return rows.map(formatDecision).join("\n\n");
      } catch (cause) {
        return { content: [{ type: "text" as const, text: errorText(cause) }], isError: true };
      }
    },
  });

  api.agents.registerTool({
    name: "decisions_withdraw",
    description:
      "Withdraw open decisions that no longer need the user — you settled them yourself, or the work changed. They leave the composer panel and stop counting toward the sidebar marker. Defaults to the chat you are running in.",
    presentation: {
      label: { pending: "Withdrawing decisions", completed: "Withdrew decisions" },
      icon: { glyph: "decisions/signpost" },
    },
    parameters: z.object({
      ids: z
        .array(z.string().trim().min(1))
        .max(LIMITS.openPerThread)
        .optional()
        .describe("Decision ids or keys to withdraw."),
      all: z.boolean().optional().describe("Withdraw every open decision in the chat."),
      thread: z.string().optional().describe("Chat id. Omit for your own chat."),
    }),
    execute: async (params, ctx) => {
      try {
        const threadId = resolveThreadId(params.thread, ctx.threadId);

        if (params.all !== true && (params.ids === undefined || params.ids.length === 0)) {
          throw new DecisionsError(
            "Name the decisions to withdraw with `ids`, or pass `all: true`.",
          );
        }

        const result = await withdrawDecisions(
          threadId,
          params.all === true ? "all" : (params.ids ?? []),
        );

        const lines = [
          result.withdrawn.length === 0
            ? "No open decision was withdrawn."
            : `Withdrew ${plural(result.withdrawn.length, "decision", "decisions")}: ${result.withdrawn.map(label).join("; ")}.`,
        ];

        if (result.unknown.length > 0) {
          lines.push(`Not open in this chat: ${result.unknown.join(", ")}.`);
        }

        return lines.join("\n");
      } catch (cause) {
        return { content: [{ type: "text" as const, text: errorText(cause) }], isError: true };
      }
    },
  });

  /* ----------------------------------------------------------- cli -- */

  function resolveThreadId(reference: string | undefined, contextThreadId?: string): string {
    const trimmed = reference?.trim() ?? "";

    if (trimmed === "" || trimmed === ".") {
      if (contextThreadId === undefined || contextThreadId === "") {
        throw new DecisionsError("No chat in context — name the chat id instead of `.`.");
      }

      return contextThreadId;
    }

    return trimmed;
  }

  function formatDecision(decision: Decision): string {
    const lines = [`${decision.id}  [${decision.state}]  ${label(decision)}`];

    for (const option of decision.options) {
      const chosen = decision.answer?.optionIds.includes(option.id) === true;
      lines.push(
        `  ${chosen ? "(x)" : "( )"} ${option.id}. ${option.label}${option.recommended ? "  (recommended)" : ""}`,
      );
    }

    if (decision.kind === "text") lines.push("  free-text answer");

    if (decision.answer?.text !== null && decision.answer?.text !== undefined) {
      lines.push(`  answer: ${decision.answer.text}`);
    }

    return lines.join("\n");
  }

  /** `--flag value`, `--flag=value` and repeated flags; the rest is positional. */
  function parseArgs(argv: string[]) {
    const positional: string[] = [];
    const flags = new Map<string, string[]>();
    let json = false;

    const add = (name: string, value: string) => {
      flags.set(name, [...(flags.get(name) ?? []), value]);
    };

    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];

      if (arg === undefined) continue;

      if (arg === "--json") {
        json = true;
        continue;
      }

      if (!arg.startsWith("--")) {
        positional.push(arg);
        continue;
      }

      const body = arg.slice(2);
      const equals = body.indexOf("=");

      if (equals >= 0) {
        add(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }

      const next = argv[index + 1];

      if (next === undefined || next.startsWith("--")) {
        add(body, "");
        continue;
      }

      add(body, next);
      index += 1;
    }

    return { positional, flags, json };
  }

  /** CLI paths belong to the invoking machine, which may differ from the server. */
  async function readJsonFile<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    ctx: PluginCliContext,
    machine?: string,
  ): Promise<z.output<Schema>> {
    let hostId = machine;

    if (hostId === undefined && ctx.threadId !== undefined) {
      const thread = await api.sdk.threads.get({ threadId: ctx.threadId });

      if (thread.environmentId === null) {
        throw new DecisionsError(
          "This chat has no environment. Pass --machine <host-id> for the JSON file.",
        );
      }

      const environment = await api.sdk.environments.get({ environmentId: thread.environmentId });
      hostId = environment.hostId;
    }

    if (hostId === undefined || hostId.trim() === "") {
      throw new DecisionsError(
        "No invoking machine in context. Pass --machine <host-id> for the JSON file.",
      );
    }

    const paths =
      /^[a-z]:[\\/]|^\\\\/i.test(path) || /^[a-z]:[\\/]|^\\\\/i.test(ctx.cwd ?? "") ? win32 : posix;

    if (!paths.isAbsolute(path) && ctx.cwd === undefined) {
      throw new DecisionsError(
        "Use an absolute JSON path when no invoking directory is available.",
      );
    }

    const filePath = paths.isAbsolute(path) ? path : paths.resolve(ctx.cwd ?? "", path);

    try {
      const file = await api.sdk.files.read({
        hostId,
        path: filePath,
        rootPath: paths.dirname(filePath),
        signal: ctx.signal,
      });

      if (file.contentEncoding === "base64")
        throw new DecisionsError("Expected a UTF-8 JSON file.");

      return schema.parse(JSON.parse(file.content));
    } catch (cause) {
      throw new DecisionsError(`Could not read ${path} as JSON (${errorText(cause)}).`);
    }
  }

  /** The tool's decisions, from a JSON file: what `omnyo decisions open` reads. */
  async function readDecisionsFile(
    path: string,
    ctx: PluginCliContext,
    machine?: string,
  ): Promise<NewDecision[]> {
    const list = z.array(decisionInput).min(1).max(LIMITS.perCall);

    const parsed = await readJsonFile(
      path,
      z.union([list, z.object({ decisions: list })]),
      ctx,
      machine,
    );

    const decisions = Array.isArray(parsed) ? parsed : parsed.decisions;

    return decisions.map((decision) => ({
      key: decision.key ?? null,
      question: decision.question,
      context: decision.context ?? null,
      options: (decision.options ?? []).map((option) => ({
        label: option.label,
        description: option.description ?? null,
        recommended: option.recommended ?? false,
      })),
      multiSelect: decision.multiSelect ?? false,
      allowText: decision.allowText ?? true,
    }));
  }

  const usage = [
    "Usage:",
    "  omnyo decisions open [<chat-id>|.] --file <decisions.json> [--json]",
    "  omnyo decisions update <decision-id|key> --file <changes.json> [--chat <chat-id>|.] [--json]",
    "  omnyo decisions list [--json]                         every chat with open decisions",
    "  omnyo decisions show [<chat-id>|.] [--json]           one chat's decisions, open and recent",
    '  omnyo decisions answer <decision-id> [--choice <option-id|label>]... [--text "<answer or note>"] [--json]',
    "  omnyo decisions skip <decision-id> [--json]         dismiss silently without answering or approving",
    "  omnyo decisions withdraw <decision-id|key>... [--chat <chat-id>|.] [--json]",
    "",
    "Agents open decisions with the decisions_open tool. The user answers them in",
    "the panel pinned above the chat's composer, or here with `answer`.",
    "Agents continue with their stated defaults; answers steer ongoing work.",
    "JSON files are read on the invoking machine; add --machine <host-id> without a chat context.",
  ].join("\n");

  api.cli.register({
    name: "decisions",
    summary: "See and answer the decisions agents opened for you",
    commands: [
      {
        name: "open",
        summary:
          "Open decisions in a chat from a JSON file (the decisions_open shape), for sessions without the tool",
        usage: "omnyo decisions open [<chat-id>|.] --file <decisions.json> [--json]",
      },
      {
        name: "update",
        summary:
          "Update an open decision in place from a JSON patch; keep working with the stated default",
        usage:
          "omnyo decisions update <decision-id|key> --file <changes.json> [--chat <chat-id>|.] [--machine <host-id>] [--json]",
      },
      {
        name: "list",
        summary: "Every chat with open decisions",
        usage: "omnyo decisions list [--json]",
      },
      {
        name: "show",
        summary: "One chat's decisions, open and recent",
        usage: "omnyo decisions show [<chat-id>|.] [--json]",
      },
      {
        name: "answer",
        summary: "Answer one decision and deliver it to the chat's agent",
        usage:
          'omnyo decisions answer <decision-id> [--choice <option-id|label>]... [--text "<answer or note>"] [--json]',
      },
      {
        name: "skip",
        summary: "Dismiss one decision silently without messaging the agent or granting approval",
        usage: "omnyo decisions skip <decision-id> [--json]",
      },
      {
        name: "withdraw",
        summary: "Withdraw open decisions that are no longer needed",
        usage: "omnyo decisions withdraw <decision-id|key>... [--chat <chat-id>|.] [--json]",
      },
    ],
    async run(argv, ctx) {
      const { positional, flags, json } = parseArgs(argv);
      const [command, ...rest] = positional;

      const reply = <Value>(value: Value, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };

          case "open": {
            const threadId = resolveThreadId(rest[0], ctx.threadId);
            const file = flags.get("file")?.[0]?.trim() ?? "";

            if (file === "")
              throw new DecisionsError("Pass the decisions with --file <path.json>.");

            const created = await openDecisions(
              threadId,
              await readDecisionsFile(file, ctx, flags.get("machine")?.[0]),
            );

            return reply(
              { threadId, decisions: created },
              [
                `Opened ${plural(created.length, "decision", "decisions")} in chat ${threadId}:`,
                ...created.map((decision) => `  - ${decision.id}  ${label(decision)}`),
                "Continue with your stated reversible defaults; later answers steer ongoing work.",
              ].join("\n"),
            );
          }

          case "update": {
            const threadId = resolveThreadId(flags.get("chat")?.[0], ctx.threadId);
            const reference = rest[0]?.trim() ?? "";
            const file = flags.get("file")?.[0]?.trim() ?? "";

            if (reference === "")
              throw new DecisionsError("Name the open decision id or key to update.");

            if (file === "")
              throw new DecisionsError("Pass the changes with --file <changes.json>.");

            const changes = await readJsonFile(
              file,
              decisionPatchInput,
              ctx,
              flags.get("machine")?.[0],
            );

            const decision = await updateDecision(threadId, reference, changes);

            return reply(
              { threadId, decision },
              `Updated ${decision.id} (revision ${decision.revision}): ${label(decision)}. Continue with your stated default.`,
            );
          }

          case "list": {
            const overview = await readOverview();

            const text =
              overview.groups.length === 0
                ? "No open decisions."
                : overview.groups
                    .map((group) =>
                      [
                        `${group.title}  [${group.threadId}]${group.projectName === "" ? "" : ` · ${group.projectName}`}`,
                        ...group.decisions.map(
                          (decision) => `  - ${decision.id}  ${label(decision)}`,
                        ),
                      ].join("\n"),
                    )
                    .join("\n\n");

            const note =
              overview.error === null ? "" : `\n(Some chats could not be read: ${overview.error})`;

            return reply(overview, text + note);
          }

          case "show": {
            const threadId = resolveThreadId(rest[0], ctx.threadId);
            const decisions = (await readRecent(threadId, 50)).map(toDecision);

            return reply(
              { threadId, decisions },
              decisions.length === 0
                ? "This chat has no decisions."
                : decisions.map(formatDecision).join("\n\n"),
            );
          }

          case "answer": {
            const decisionId = rest[0]?.trim() ?? "";

            if (decisionId === "") throw new DecisionsError("Name the decision id to answer.");
            const row = await readById(decisionId);

            if (row === undefined) throw new DecisionsError(`No decision ${decisionId}.`);
            const decision = toDecision(row);

            const optionIds = (flags.get("choice") ?? []).map((choice) => {
              const wanted = choice.trim().toLowerCase();

              const match = decision.options.find(
                (option) => option.id === wanted || option.label.toLowerCase() === wanted,
              );

              if (match === undefined) {
                throw new DecisionsError(`"${label(decision)}" has no option "${choice}".`);
              }

              return match.id;
            });

            const text = (flags.get("text") ?? []).join("\n").trim();

            const result = await answerDecisions(decision.threadId, [
              {
                decisionId,
                revision: decision.revision,
                optionIds,
                text: text === "" ? null : text,
              },
            ]);

            return reply(
              { decisionId, ...result },
              `Answered "${label(decision)}" — ${result.delivery === "sent" ? "delivered to the chat" : "queued for the chat"}.`,
            );
          }

          case "skip": {
            const decisionId = rest[0]?.trim() ?? "";

            if (decisionId === "") throw new DecisionsError("Name the decision id to skip.");
            const row = await readById(decisionId);

            if (row === undefined) throw new DecisionsError(`No decision ${decisionId}.`);
            const result = await skipDecision(row.thread_id, decisionId);

            return reply(
              { decisionId, ...result },
              `Skipped "${label(toDecision(row))}" without answering.`,
            );
          }

          case "withdraw": {
            const threadId = resolveThreadId(flags.get("chat")?.[0], ctx.threadId);
            const refs = rest.map((ref) => ref.trim()).filter((ref) => ref !== "");

            if (refs.length === 0) throw new DecisionsError("Name the decisions to withdraw.");
            const result = await withdrawDecisions(threadId, refs);

            return reply(
              {
                threadId,
                withdrawn: result.withdrawn.map((decision) => decision.id),
                unknown: result.unknown,
              },
              [
                `Withdrew ${plural(result.withdrawn.length, "decision", "decisions")}.`,
                ...(result.unknown.length > 0
                  ? [`Not open in that chat: ${result.unknown.join(", ")}.`]
                  : []),
              ].join("\n"),
            );
          }
        }

        return { exitCode: 1, stderr: usage };
      } catch (cause) {
        return { exitCode: 1, stderr: errorText(cause) };
      }
    },
  });
}
