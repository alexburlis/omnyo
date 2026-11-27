import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import type { ChatInfo, InboxItem } from "./cards.ts";
import type { OpenQuestion } from "./contract.ts";

const questionPayloadSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  revision: z.number().int(),
  state: z.enum(["open", "answered", "skipped", "withdrawn"]),
  question: z
    .object({
      prompt: z.string(),
      context: z.string().nullable(),
      shortLabel: z.string(),
      mode: z.enum(["required", "optional"]),
      multiSelect: z.boolean(),
      allowFreeText: z.boolean(),
      delegable: z.boolean().optional(),
      options: z.array(
        z.object({
          value: z.string(),
          label: z.string(),
          description: z.string().nullable(),
          recommended: z.boolean(),
        }),
      ),
    })
    .loose(),
  answer: z.object({ selected: z.array(z.string()), freeText: z.string().optional() }).nullable(),
  answeredBy: z.object({ kind: z.string() }).loose().nullable().optional(),
  createdAt: z.number(),
});

export type QuestionPayload = z.infer<typeof questionPayloadSchema>;

export interface QuestionRead {
  questions: QuestionPayload[];
  coreSupportsDelegation: boolean | null;
}

export function readQuestions(raw: readonly unknown[]): QuestionRead {
  const questions: QuestionPayload[] = [];
  let supported = raw.length > 0;

  for (const item of raw) {
    const parsed = questionPayloadSchema.safeParse(item);

    if (!parsed.success) continue;
    questions.push(parsed.data);

    if (parsed.data.question.delegable === undefined) supported = false;
  }

  return { questions, coreSupportsDelegation: questions.length === 0 ? null : supported };
}

export function toOpenQuestion(payload: QuestionPayload): OpenQuestion {
  return {
    id: payload.id,
    threadId: payload.threadId,
    revision: payload.revision,
    mode: payload.question.mode,
    shortLabel: payload.question.shortLabel,
    prompt: payload.question.prompt,
    context: payload.question.context,
    multiSelect: payload.question.multiSelect,
    allowFreeText: payload.question.allowFreeText,
    delegable: payload.question.delegable ?? false,
    options: payload.question.options,
    createdAt: payload.createdAt,
  };
}

export class Names {
  private readonly api: PluginApi;
  private readonly projects = new Map<string, string>();
  private readonly chats = new Map<string, ChatInfo & { projectId: string }>();

  constructor(api: PluginApi) {
    this.api = api;
  }

  async project(projectId: string): Promise<string> {
    const known = this.projects.get(projectId);

    if (known !== undefined) return known;
    const project = await this.api.sdk.projects.get({ projectId });

    this.projects.set(projectId, project.name);

    return project.name;
  }

  async chat(threadId: string): Promise<ChatInfo & { projectId: string }> {
    const known = this.chats.get(threadId);

    if (known !== undefined) return known;
    const thread = await this.api.sdk.threads.get({ threadId });

    const info = {
      title: thread.title ?? "Untitled chat",
      projectId: thread.projectId,
      project: await this.project(thread.projectId),
    };

    this.chats.set(threadId, info);

    return info;
  }

  forget(threadId: string): void {
    this.chats.delete(threadId);
  }
}

export async function readInbox(api: PluginApi, names: Names): Promise<InboxItem[]> {
  const snapshot = await api.sdk.experimental_inbox.snapshot();

  return Promise.all(
    snapshot.inbox.map(async (entry) => ({
      threadId: entry.threadId,
      title: entry.title,
      project: await names.project(entry.projectId),
      state: entry.state,
      reasonKind: entry.reason.kind,
      reasonText: entry.reason.text,
      archiveReady: entry.archiveReady,
      latch: entry.latch,
      since: entry.sortAt,
    })),
  );
}

const predictionSchema = z.object({ text: z.string().nullable(), status: z.string() }).loose();

export async function suggestedReply(api: PluginApi, threadId: string): Promise<string | null> {
  try {
    const prediction = await api.sdk.plugins.callRpc({
      pluginId: "omnyo--composer-predictions",
      method: "state",
      input: { threadId },
      outputSchema: predictionSchema,
    });

    return prediction.status === "ready" ? prediction.text : null;
  } catch {
    return null;
  }
}
