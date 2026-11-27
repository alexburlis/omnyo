import { randomUUID } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  RUN_DECISION_RENDERER_ID,
  runDecisionAnswerSchema,
  type RunDecisionAnswer,
  type RunDecisionPayload,
} from "./contracts/run-decision.js";
import { attentionView } from "./rpc.js";
import type { AttentionItem, StateMachineService } from "./service.js";

const formLifetimeMs = 7 * 24 * 60 * 60 * 1000;

const syncEveryMs = 60_000;

const failureBackoffMs = 5 * 60_000;

type HomeQuestionUi = Pick<PluginApi["ui"], "requestInput">;

type HomeQuestionLog = Pick<PluginApi["log"], "warn">;

type FormDescription = { title: string; detail?: string };

export class HomeQuestions {
  private readonly open = new Map<string, AbortController>();
  private readonly dismissed = new Set<string>();
  private readonly lastErrors = new Map<string, string>();
  private readonly retryAt = new Map<string, number>();
  private scheduled = false;
  private stopped = true;

  constructor(
    private readonly ui: HomeQuestionUi,
    private readonly log: HomeQuestionLog,
    private readonly service: StateMachineService,
    private readonly clock: () => number = Date.now,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    this.stopped = false;
    this.sync();
    const timer = setInterval(() => this.sync(), syncEveryMs);

    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    clearInterval(timer);
    this.stopped = true;

    for (const controller of this.open.values()) controller.abort();
  }

  schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.sync();
    }, 250);
  }

  sync(): void {
    if (this.stopped) return;
    const current = this.service.listHomeAttention();
    const live = new Set(current.map(({ item }) => item.attentionId));

    for (const [attentionId, controller] of this.open)
      if (!live.has(attentionId)) controller.abort();

    for (const attentionId of new Set([...this.dismissed, ...this.retryAt.keys()]))
      if (!live.has(attentionId)) {
        this.dismissed.delete(attentionId);
        this.lastErrors.delete(attentionId);
        this.retryAt.delete(attentionId);
      }

    for (const { item, homeThreadId } of current)
      if (
        !this.open.has(item.attentionId) &&
        !this.dismissed.has(item.attentionId) &&
        (this.retryAt.get(item.attentionId) ?? 0) <= this.clock()
      )
        void this.ask(item, homeThreadId);
  }

  private async ask(item: AttentionItem, homeThreadId: string): Promise<void> {
    const controller = new AbortController();
    this.open.set(item.attentionId, controller);

    try {
      const answer = await this.request(item, homeThreadId, controller.signal);

      if (answer !== null) await this.resolve(item, answer);
    } finally {
      if (this.open.get(item.attentionId) === controller) this.open.delete(item.attentionId);
      this.schedule();
    }
  }

  private async request(
    item: AttentionItem,
    homeThreadId: string,
    signal: AbortSignal,
  ): Promise<RunDecisionAnswer | null> {
    let result: Awaited<ReturnType<HomeQuestionUi["requestInput"]>>;

    try {
      const view = attentionView(this.service, item);
      const label = `${view.machineName}: ${view.title}`;

      const payload: RunDecisionPayload = {
        ...view,
        lastError: this.lastErrors.get(item.attentionId) ?? null,
      };

      result = await this.ui.requestInput(
        {
          threadId: homeThreadId,
          rendererId: RUN_DECISION_RENDERER_ID,
          title: label,
          payload,
          timeoutMs: formLifetimeMs,
          presentation: {
            label: { pending: `Waiting for you: ${label}`, completed: `Decided: ${label}` },
            icon: { glyph: "Workflow" },
          },
          describeSubmission: (value) => {
            const answer = runDecisionAnswerSchema.safeParse(value);

            const decision = answer.success
              ? view.decisions.find((option) => option.name === answer.data.decision)
              : undefined;

            const note = answer.success ? answer.data.evidence.trim() : "";

            const description: FormDescription = {
              title: `Decided: ${decision?.label ?? "an option"}`,
            };

            if (note !== "") description.detail = note;

            return description;
          },
        },
        { signal },
      );
    } catch (error) {
      if (!signal.aborted) {
        this.retryAt.set(item.attentionId, this.clock() + failureBackoffMs);
        this.log.warn(
          `State Machines couldn't open the question for ${item.attentionId} in chat ${homeThreadId}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }

      return null;
    }

    if (result.outcome === "submitted") {
      const answer = runDecisionAnswerSchema.safeParse(result.value);

      if (answer.success) return answer.data;
      this.lastErrors.set(item.attentionId, "That answer was incomplete. Choose again.");

      return null;
    }

    if (result.reason === "user" || result.reason === "thread-deleted")
      this.dismissed.add(item.attentionId);
    else if (result.reason !== "request-aborted")
      this.retryAt.set(item.attentionId, this.clock() + syncEveryMs);

    return null;
  }

  private async resolve(item: AttentionItem, answer: RunDecisionAnswer): Promise<void> {
    try {
      const instance = this.service.inspectInstance({ instanceId: item.instanceId });

      await this.service.resolveAttention({
        instanceId: item.instanceId,
        attentionId: item.attentionId,
        entryId: item.entryId,
        expectedRevision: instance.revision,
        decision: answer.decision,
        evidence: answer.evidence.trim(),
        requestId: `chat-${item.attentionId}-${randomUUID()}`,
      });
      this.lastErrors.delete(item.attentionId);
    } catch (error) {
      this.lastErrors.set(
        item.attentionId,
        error instanceof Error ? error.message : "The decision couldn't be recorded.",
      );
    }
  }
}
