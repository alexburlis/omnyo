import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  PluginAgentConfiguration,
  PluginAgentConfigurationContext,
  PluginApi,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import { buildDeck } from "./cards.ts";
import type {
  AgentView,
  DeckView,
  DelegatedView,
  HomeState,
  OutcomeInput,
  RuleView,
  SidebarStatus,
  StatusLine,
  Suggestions,
  ThreadDelegation,
} from "./contract.ts";
import { many, one, readState, stringList, writeState, type Sql } from "./db.ts";
import {
  VETO_DELAY_MS,
  autoAllowed,
  delegationGuard,
  delegatedStateSchema,
  undoTarget,
  type DelegatedState,
  type RuleChange,
  type RuleLevel,
} from "./delegation.ts";
import {
  DISTILL_INSTRUCTIONS,
  JUDGE_INSTRUCTIONS,
  acceptVerdicts,
  itemKey,
  judgePrompt,
  triageSubmissionSchema,
  verdictSchema,
  type JudgeItem,
  type PriorOutcome,
  type Verdict,
} from "./inputs.ts";
import { Judges, judgeKindSchema, type ChiefHome } from "./judge.ts";
import { datasetSchema, localMidnight, replay, type AnswerEntry, type Judge } from "./replay.ts";
import { planRuleAnswer, untriaged } from "./plan.ts";
import { Rules, sameRule, type RelatedRule, type RuleRecord } from "./rules.ts";
import {
  Names,
  readInbox,
  readQuestions,
  suggestedReply,
  toOpenQuestion,
  type QuestionPayload,
} from "./sources.ts";

export interface ChiefSettings {
  chiefProvider: string;
  chiefModel: string;
  judgeProvider: string;
  judgeModel: string;
}

export type ChiefSettingKey = keyof ChiefSettings;

export const V1_SETTINGS: ChiefSettings = {
  chiefProvider: "claude-code",
  chiefModel: "claude-opus-5-5",
  judgeProvider: "claude-code",
  judgeModel: "claude-sonnet-5-5",
};

export interface ChiefOptions {
  writeSetting(key: ChiefSettingKey, value: string): Promise<void>;
  changed(): void;
}

interface ResolvedAgent {
  providerId: string | null;
  model: string | null;
}

const SETTING_KEYS: readonly ChiefSettingKey[] = [
  "chiefProvider",
  "chiefModel",
  "judgeProvider",
  "judgeModel",
];

interface AgentFields {
  providerId?: string;
  model?: string;
}

function agentFields(agent: ResolvedAgent): AgentFields {
  const fields: AgentFields = {};

  if (agent.providerId !== null) fields.providerId = agent.providerId;

  if (agent.model !== null) fields.model = agent.model;

  return fields;
}

const optionPairsSchema = z.array(z.object({ value: z.string(), label: z.string() }));

const judgeMarkerSchema = z.object({ role: z.literal("judge"), kind: judgeKindSchema });

const progressSchema = z.object({ stage: z.string(), done: z.number(), total: z.number() });

export interface EvalStatus {
  id: string;
  status: string;
  progress: z.infer<typeof progressSchema>;
  result: z.infer<ReturnType<typeof z.json>> | null;
  error: string | null;
}

const CHIEF_KEY = "chief.threadId";

const CORE_SUPPORT_KEY = "core.delegable";

const TRIAGE_RETRY_MS = 15 * 60_000;

const TRIAGE_ATTEMPTS = 3;

const PAUSED_KEY = "delegation.paused";

const RESUME_KEY = "delegation.resumeQuestion";

const TRIAGE_WINDOW_MS = 30_000;

const DISTILL_WINDOW_MS = 7 * 24 * 60 * 60_000;

const DISTILL_GAP_MS = 20 * 60 * 60_000;

const SUGGESTIONS_KEY = "suggestions";

const HINT_KEY = "hint.swipe";

const MIGRATION_KEY = "migration.v2";

const HOME_IDLE_KEY = "home.idleCreated";

const MIGRATION_NOTE_MS = 3 * 24 * 60 * 60_000;

const FRESH_INSTALL = "fresh";

const DISTILL_LAST_KEY = "distill.lastRun";

const RULES_TAB_KEY = "tabs.rules";

const PERSONAL_PROJECT = "proj_personal";

const ANSWERED_CARD_MS = 10 * 60_000;

const suggestionsValueSchema = z.enum(["undecided", "off", "on"]);

const notFoundSchema = z.object({ status: z.literal(404) });

export class SuggestionsOffError extends Error {
  constructor() {
    super("Suggested answers are off. Turn them on first: omnyo chief suggestions on");
  }
}

export const CHIEF_INSTRUCTIONS = `You are the Chief in Omnyo: the owner talks to you on the Chief page, where every question and stuck chat across all projects is listed. Brief the owner on what is waiting with \`omnyo chief brief\`, explain a card when asked, and record any lasting preference the owner states with the chief_rule_told tool. Recording creates a candidate only; it comes back at once as a "Make this a rule?" question, and only the owner's answer adopts it. Never adopt, raise or resume anything yourself, and never answer questions in other chats. "Make this a rule?", "Keep this rule?" and resume questions in this chat are handled by the plugin; acknowledge them briefly. Say "chat", not "thread".`;

const TOLD_INSTRUCTIONS =
  "Use chief_rule_told only for a lasting preference the owner stated in this chat.";

function scopeText(project: string | null): string {
  return project === null ? "All projects" : `In ${project}`;
}

const LEVEL_SHORT: Record<RuleLevel, string> = {
  ask: "suggest only",
  veto: "answers after a 10-min veto",
  auto: "answers at once",
};

export function clause(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/u, "");

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function rulePrompt(rule: Pick<RuleRecord, "cue" | "action">): string {
  return `When: ${clause(rule.cue)}\nDo: ${clause(rule.action)}`;
}

interface RuleOption {
  value: string;
  label: string;
  description: null;
  recommended: false;
  preview: null;
}

interface RuleQuestion {
  prompt: string;
  context: string;
  shortLabel: string;
  options: RuleOption[];
}

function ruleOption(value: string, label: string): RuleOption {
  return { value, label, description: null, recommended: false, preview: null };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

export class Chief {
  readonly judges: Judges;
  readonly rules: Rules;
  private readonly api: PluginApi;
  private readonly db: Sql;
  private readonly settings: () => ChiefSettings;
  private readonly names: Names;
  private readonly instructionCache = new Map<string, string | null>();
  private readonly lastQuestions = new Map<string, QuestionPayload>();
  private coreSupport = false;
  private triageTimer: ReturnType<typeof setTimeout> | null = null;
  private triageRunning = false;
  private lastTriageError: string | null = null;
  private delegating = false;
  private homeWork: Promise<string> | null = null;
  private lastHomeError: string | null = null;

  private readonly options: ChiefOptions;

  constructor(api: PluginApi, db: Sql, settings: () => ChiefSettings, options: ChiefOptions) {
    this.api = api;
    this.db = db;
    this.settings = settings;
    this.options = options;
    this.names = new Names(api);
    this.rules = new Rules(db);
    this.judges = new Judges(
      {
        spawn: async (args) => {
          if (this.suggestions() !== "on") throw new SuggestionsOffError();
          const agent = await this.resolveAgent("judge");

          const thread = await api.sdk.threads.spawn({
            projectId: args.projectId,
            environment: { type: "reuse", environmentId: args.environmentId },
            parentThreadId: args.parentThreadId,
            lifecycleOwnerThreadId: args.parentThreadId,
            visibility: "hidden",
            title: args.title,
            ...agentFields(agent),
            permissionMode: "accept-edits",
            pluginMetadata: { role: "judge", kind: args.kind },
            prompt: args.prompt,
          });

          return thread.id;
        },
        stop: async (threadId) => {
          await api.sdk.threads.stop({ threadId });
        },
        remove: async (threadId) => {
          await api.sdk.threads.delete({ threadId, childThreadsConfirmed: true });
        },
        warn: (message) => api.log.warn(message),
      },
      db,
      () => this.home(),
      () => ({
        providerId: this.settings().judgeProvider,
        model: this.settings().judgeModel,
      }),
    );
  }

  chiefThreadId(): string | null {
    return readState(this.db, CHIEF_KEY);
  }

  paused(): boolean {
    return readState(this.db, PAUSED_KEY) === "1";
  }

  suggestions(): Suggestions {
    const parsed = suggestionsValueSchema.safeParse(readState(this.db, SUGGESTIONS_KEY));

    return parsed.success ? parsed.data : "undecided";
  }

  setSuggestions(value: "on" | "off"): Suggestions {
    writeState(this.db, SUGGESTIONS_KEY, value);

    if (value === "off") {
      if (this.triageTimer !== null) clearTimeout(this.triageTimer);
      this.triageTimer = null;
      this.db
        .prepare(
          "UPDATE delegated_answers SET state = 'cancelled', error = ?, updated_at = ? WHERE state = 'waiting'",
        )
        .run("Suggested answers were turned off before it was sent.", Date.now());
    } else this.requestTriage();

    this.options.changed();

    return value;
  }

  async resolveAgent(kind: "chief" | "judge"): Promise<ResolvedAgent> {
    const settings = this.settings();
    const providerId = kind === "chief" ? settings.chiefProvider : settings.judgeProvider;
    const model = kind === "chief" ? settings.chiefModel : settings.judgeModel;

    if (providerId !== "") return { providerId, model: model === "" ? null : model };

    const defaults = await this.api.sdk.projects
      .defaultExecutionOptions({ projectId: PERSONAL_PROJECT })
      .catch(() => null);

    return { providerId: defaults?.providerId ?? null, model: defaults?.model ?? null };
  }

  async agentView(): Promise<AgentView> {
    const [agent, providers] = await Promise.all([
      this.resolveAgent("judge"),
      this.api.sdk.providers.list().catch(() => []),
    ]);

    const provider =
      agent.providerId === null
        ? providers[0]
        : providers.find((entry) => entry.id === agent.providerId);

    return {
      providerId: provider?.id ?? agent.providerId,
      label: provider?.displayName ?? null,
      ready: provider !== undefined,
    };
  }

  private async homeThread(): Promise<{ state: HomeState; pluginHome: boolean }> {
    const threadId = this.chiefThreadId();

    if (threadId === null) return { state: "missing", pluginHome: false };
    let thread: Awaited<ReturnType<PluginApi["sdk"]["threads"]["get"]>>;

    try {
      thread = await this.api.sdk.threads.get({ threadId });
    } catch (cause) {
      if (notFoundSchema.safeParse(cause).success) return { state: "missing", pluginHome: false };
      throw cause;
    }

    const pluginHome = thread.pluginHome === true;

    if (thread.deletedAt !== null) return { state: "missing", pluginHome };

    if (thread.status === "error" && thread.environmentId === null)
      return { state: "error", pluginHome };

    return { state: thread.environmentId === null ? "starting" : "ready", pluginHome };
  }

  async homeState(): Promise<HomeState> {
    return (await this.homeThread()).state;
  }

  private async createHome(): Promise<string> {
    const status = await this.api.sdk.experimental_server.maintenance.status();
    const hostId = status.runtime.serverHostId;

    if (hostId === null)
      throw new Error("The Chief needs a computer connected to this Omnyo for its chat.");
    const agent = await this.resolveAgent("chief");

    const thread = await this.api.sdk.threads.spawn({
      projectId: PERSONAL_PROJECT,
      environment: {
        type: "provider",
        environmentProviderId: "personal-workspace",
        machine: { type: "existing", hostId },
        inputs: null,
      },
      pinned: true,
      title: "Chief",
      ...agentFields(agent),
      pluginMetadata: { role: "chief" },
      experimental_idle: true,
      experimental_pluginHome: true,
    });

    writeState(this.db, CHIEF_KEY, thread.id);
    writeState(this.db, HOME_IDLE_KEY, thread.id);

    if (readState(this.db, MIGRATION_KEY) === null) writeState(this.db, MIGRATION_KEY, FRESH_INSTALL);
    this.options.changed();

    return thread.id;
  }

  async migrate(): Promise<void> {
    const existing = this.chiefThreadId();

    if (existing === null || readState(this.db, MIGRATION_KEY) !== null) return;
    const current = this.settings();

    for (const key of SETTING_KEYS)
      if (current[key] === "") await this.options.writeSetting(key, V1_SETTINGS[key]);

    if (readState(this.db, SUGGESTIONS_KEY) === null) writeState(this.db, SUGGESTIONS_KEY, "on");

    const home = await this.homeThread();

    if (home.state !== "missing")
      await this.keepHome(existing, home.pluginHome);

    writeState(this.db, MIGRATION_KEY, String(Date.now()));
    this.options.changed();
  }

  private async keepHome(threadId: string, pluginHome: boolean): Promise<string> {
    if (!pluginHome)
      await this.api.sdk.threads.update({ threadId, experimental_pluginHome: true });

    return threadId;
  }

  private once(run: () => Promise<string>): Promise<string> {
    if (this.homeWork !== null) return this.homeWork;

    const work = run().finally(() => {
      this.homeWork = null;
    });

    this.homeWork = work;

    return work;
  }

  ensureHome(): Promise<string> {
    return this.once(async () => {
      await this.migrate();
      const existing = this.chiefThreadId();
      const home = await this.homeThread();

      if (existing !== null && home.state !== "missing")
        return this.keepHome(existing, home.pluginHome);

      return this.createHome();
    });
  }

  start(): Promise<string> {
    return this.once(async () => {
      await this.migrate();
      const existing = this.chiefThreadId();
      const home = await this.homeThread();

      if (existing !== null && (home.state === "ready" || home.state === "starting"))
        return this.keepHome(existing, home.pluginHome);

      if (existing === null || home.state !== "error") return this.createHome();
      const madeIdle = readState(this.db, HOME_IDLE_KEY) === existing;
      const replacement = await this.createHome();

      await this.retireBroken(existing, madeIdle);

      return replacement;
    });
  }

  private async retireBroken(threadId: string, madeIdle: boolean): Promise<void> {
    try {
      if (madeIdle) {
        await this.api.sdk.threads.unpin({ threadId });
        await this.api.sdk.threads.archive({ threadId });
      } else await this.api.sdk.threads.update({ threadId, experimental_pluginHome: false });
    } catch (cause) {
      this.api.log.warn(`The Chief's old chat ${threadId}: ${String(cause)}`);
    }
  }

  async keepHomeAlive(): Promise<void> {
    if (this.homeWork !== null) return;

    try {
      if ((await this.homeState()) === "missing") await this.ensureHome();
      this.lastHomeError = null;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      if (message !== this.lastHomeError) this.api.log.warn(`The Chief's chat: ${message}`);
      this.lastHomeError = message;
    }
  }

  retrySuggestions(): void {
    this.db
      .prepare("UPDATE triage SET attempts = 0, updated_at = 0 WHERE status = 'failed'")
      .run();
    this.lastTriageError = null;
    void this.triage();
    this.options.changed();
  }

  async home(): Promise<ChiefHome> {
    const threadId = this.chiefThreadId();

    if (threadId === null) throw new Error("The Chief's chat is missing: omnyo chief start");
    const thread = await this.api.sdk.threads.get({ threadId });

    if (thread.environmentId === null)
      throw new Error("The Chief needs a computer connected to this Omnyo to suggest answers.");

    return { threadId, projectId: thread.projectId, environmentId: thread.environmentId };
  }

  async openQuestions(): Promise<QuestionPayload[]> {
    const snapshot = await this.api.sdk.experimental_attention.snapshot();
    const read = readQuestions(snapshot.questions);
    const open = read.questions.filter((question) => question.state === "open");

    if (read.coreSupportsDelegation !== null)
      writeState(this.db, CORE_SUPPORT_KEY, read.coreSupportsDelegation ? "1" : "0");

    this.coreSupport = readState(this.db, CORE_SUPPORT_KEY) === "1";
    this.lastQuestions.clear();

    for (const question of open) this.lastQuestions.set(question.id, question);

    return open;
  }

  verdicts(): Map<string, Verdict> {
    const rows = many(
      z.object({ item_key: z.string(), verdict: z.string() }),
      this.db.prepare("SELECT item_key, verdict FROM triage WHERE status = 'done'").all(),
    );

    const verdicts = new Map<string, Verdict>();

    for (const row of rows) {
      const parsed = verdictSchema.safeParse(JSON.parse(row.verdict));

      if (parsed.success) verdicts.set(row.item_key, parsed.data);
    }

    return verdicts;
  }

  triageErrors(): Map<string, string> {
    return new Map(
      many(
        z.object({ item_key: z.string(), error: z.string().nullable() }),
        this.db.prepare("SELECT item_key, error FROM triage WHERE status = 'failed'").all(),
      ).map((row) => [row.item_key, row.error ?? "Triage failed."] as const),
    );
  }

  private snoozedUntil(now: number): Map<string, number> {
    return new Map(
      many(
        z.object({ card_key: z.string(), until: z.number() }),
        this.db.prepare("SELECT card_key, until FROM snoozes WHERE until > ?").all(now),
      ).map((row) => [row.card_key, row.until] as const),
    );
  }

  private offerQuestionIds(): Set<string> {
    const resume = readState(this.db, RESUME_KEY)?.split("@")[0] ?? "";
    const ids = new Set(this.rules.bound().flatMap((rule) => rule.questionId ?? []));

    if (resume !== "") ids.add(resume);

    return ids;
  }

  canAnswerForMe(): boolean {
    return this.rules
      .latest()
      .some((rule) => rule.state === "adopted" && rule.level !== "ask");
  }

  async status(): Promise<SidebarStatus> {
    const now = Date.now();
    const chiefId = this.chiefThreadId();
    const [open, inbox] = await Promise.all([this.openQuestions(), readInbox(this.api, this.names)]);

    const deck = buildDeck({
      questions: open.map(toOpenQuestion),
      inbox,
      chats: new Map(),
      verdicts: new Map(),
      triageErrors: new Map(),
      replies: new Map(),
      snoozedUntil: this.snoozedUntil(now),
      chiefThreadId: chiefId,
      offerQuestionIds: this.offerQuestionIds(),
      showReplies: false,
      now,
    });

    return {
      dot: deck.dot,
      toDecide: deck.toDecide,
      saved: deck.saved,
      paused: this.paused() && this.canAnswerForMe(),
      error: false,
    };
  }

  private sentToday(now: number): number {
    const midnight = new Date(now);

    midnight.setHours(0, 0, 0, 0);

    return (
      one(
        z.object({ count: z.number() }),
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM delegated_answers WHERE state = 'sent' AND updated_at >= ?",
          )
          .get(midnight.getTime()),
      )?.count ?? 0
    );
  }

  private statusLine(home: HomeState, failed: number, now: number): StatusLine | null {
    const suggestions = this.suggestions();

    if (this.paused() && this.canAnswerForMe())
      return { kind: "paused", text: "Paused. The Chief only suggests.", action: "resume" };

    if (suggestions === "on" && failed > 0)
      return {
        kind: "failing",
        text: `Couldn't suggest answers for ${failed} ${failed === 1 ? "question" : "questions"}.`,
        action: "retry",
      };

    if (suggestions === "on" && home !== "ready")
      return {
        kind: "no-computer",
        text: "The Chief needs a computer connected to this Omnyo to suggest answers.",
        action: "retry",
      };

    const migratedAt = Number(readState(this.db, MIGRATION_KEY) ?? "0");

    if (migratedAt > 0 && now - migratedAt < MIGRATION_NOTE_MS)
      return {
        kind: "migration",
        text: "Ask Chief, rules and answer history are in Inbox assistant.",
        action: null,
      };

    const sent = this.sentToday(now);

    return sent === 0
      ? null
      : {
          kind: "summary",
          text: `The Chief answered ${sent} ${sent === 1 ? "question" : "questions"} for you today.`,
          action: "review",
        };
  }

  private takeRate(): DeckView["takeRate"] {
    const rows = many(
      z.object({ chief_recommended: z.string(), chosen: z.string() }),
      this.db
        .prepare(
          "SELECT chief_recommended, chosen FROM outcomes WHERE card_kind = 'question' AND chief_recommended <> '[]' AND chosen <> '[]' ORDER BY at DESC LIMIT 10",
        )
        .all(),
    );

    if (rows.length < 10) return null;

    return {
      used: rows.filter((row) => sameSet(stringList(row.chief_recommended), stringList(row.chosen)))
        .length,
      of: rows.length,
    };
  }

  async deck(): Promise<DeckView> {
    const now = Date.now();
    const chiefId = this.chiefThreadId();
    const suggestions = this.suggestions();

    const [open, inbox, home, agent] = await Promise.all([
      this.openQuestions(),
      readInbox(this.api, this.names),
      this.homeState().catch((): HomeState => "error"),
      this.agentView(),
    ]);

    const questions = open.map(toOpenQuestion);

    const chats = new Map(
      await Promise.all(
        [...new Set(questions.map((question) => question.threadId))].map(
          async (threadId) => [threadId, await this.names.chat(threadId)] as const,
        ),
      ),
    );

    const replies =
      suggestions === "on"
        ? new Map(
            (
              await Promise.all(
                inbox
                  .filter((item) => item.state === "finished" && !item.archiveReady)
                  .slice(0, 20)
                  .map(
                    async (item) =>
                      [item.threadId, await suggestedReply(this.api, item.threadId)] as const,
                  ),
              )
            ).filter((entry): entry is readonly [string, string] => entry[1] !== null),
          )
        : new Map<string, string>();

    const deck = buildDeck({
      questions,
      inbox,
      chats,
      verdicts: suggestions === "on" ? this.verdicts() : new Map(),
      triageErrors: suggestions === "on" ? this.triageErrors() : new Map(),
      replies,
      snoozedUntil: this.snoozedUntil(now),
      chiefThreadId: chiefId,
      offerQuestionIds: this.offerQuestionIds(),
      showReplies: suggestions === "on",
      now,
    });

    this.requestTriage();

    const triage = this.triageStatus();
    const rules = this.rules.latest();

    const candidates = new Map(
      rules
        .filter((rule) => rule.state === "candidate" && rule.questionId !== null)
        .map((rule) => [rule.questionId, rule]),
    );

    const adopted = rules.filter((rule) => rule.state === "adopted");
    const ruleReviews: DeckView["ruleReviews"] = {};

    for (const card of [...deck.cards, ...deck.savedCards.map((item) => item.card)]) {
      const candidate = card.ruleOffer ? candidates.get(card.steps[0]?.question.id) : undefined;

      if (candidate === undefined) continue;

      const applicable = adopted
        .filter((rule) => rule.project === null || rule.project === candidate.project)
        .toSorted(
          (a, b) =>
            Number(b.project === candidate.project) - Number(a.project === candidate.project),
        )
        .map((rule) => ({
          id: rule.id,
          cue: rule.cue,
          action: rule.action,
          scope: scopeText(rule.project),
        }));

      ruleReviews[card.key] = {
        topic: candidate.label ?? clause(candidate.cue),
        scope: scopeText(candidate.project),
        adopted: applicable,
      };
    }

    if (rules.some((rule) => rule.state !== "candidate")) writeState(this.db, RULES_TAB_KEY, "1");

    return {
      cards: deck.cards,
      savedCards: deck.savedCards,
      ruleReviews,
      toDecide: deck.toDecide,
      saved: deck.saved,
      chiefThreadId: chiefId,
      home,
      suggestions,
      agent,
      statusLine: this.statusLine(
        home,
        deck.cards.reduce(
          (count, card) =>
            count + card.steps.filter((step) => step.verdict === null && step.triageError !== null).length,
          0,
        ),
        now,
      ),
      tabs: {
        rules:
          readState(this.db, RULES_TAB_KEY) === "1" || deck.cards.some((card) => card.ruleOffer),
        decided:
          one(
            z.object({ count: z.number() }),
            this.db.prepare("SELECT COUNT(*) AS count FROM delegated_answers").get(),
          )?.count !== 0,
      },
      canAnswerForMe: this.canAnswerForMe(),
      takeRate: this.takeRate(),
      archiveReady: inbox.filter((item) => item.archiveReady).length,
      swipeHintSeen: readState(this.db, HINT_KEY) === "1",
      triage,
      delegation: {
        supported: this.coreSupport,
        paused: this.paused(),
        note: this.coreSupport
          ? null
          : readState(this.db, CORE_SUPPORT_KEY) === null
            ? null
            : "Answering for you needs a newer Omnyo.",
      },
      generatedAt: now,
    };
  }

  markHintSeen(): void {
    writeState(this.db, HINT_KEY, "1");
  }

  triageStatus(): DeckView["triage"] {
    const counts = one(
      z.object({ pending: z.number().nullable(), failed: z.number().nullable() }),
      this.db
        .prepare(
          "SELECT SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed FROM triage",
        )
        .get(),
    );

    const scored = many(
      z.object({ chief_recommended: z.string(), chosen: z.string() }),
      this.db
        .prepare(
          "SELECT chief_recommended, chosen FROM outcomes WHERE card_kind = 'question' AND chief_recommended <> '[]' AND chosen <> '[]'",
        )
        .all(),
    );

    const matched = scored.filter((row) =>
      sameSet(stringList(row.chief_recommended), stringList(row.chosen)),
    ).length;

    const decided = one(
      z.object({ count: z.number() }),
      this.db.prepare("SELECT COUNT(*) AS count FROM delegated_answers WHERE state = 'sent'").get(),
    );

    return {
      pending: counts?.pending ?? 0,
      failed: counts?.failed ?? 0,
      lastError: this.lastTriageError,
      matchRate: scored.length === 0 ? null : Math.round((matched / scored.length) * 1000) / 10,
      decided: decided?.count ?? 0,
    };
  }

  requestTriage(): void {
    if (
      this.suggestions() !== "on" ||
      this.triageTimer !== null ||
      this.triageRunning ||
      this.chiefThreadId() === null
    )
      return;
    this.triageTimer = setTimeout(() => {
      this.triageTimer = null;
      void this.triage();
    }, TRIAGE_WINDOW_MS);
    this.triageTimer.unref?.();
  }

  async triage(): Promise<void> {
    if (this.triageRunning || this.suggestions() !== "on") return;
    this.triageRunning = true;

    try {
      const open = await this.openQuestions();

      const known = new Set(
        many(
          z.object({ item_key: z.string() }),
          this.db
            .prepare(
              "SELECT item_key FROM triage WHERE NOT (status = 'failed' AND updated_at < ? AND attempts < ?)",
            )
            .all(Date.now() - TRIAGE_RETRY_MS, TRIAGE_ATTEMPTS),
        ).map((row) => row.item_key),
      );

      const pending = untriaged(open, known, this.offerQuestionIds());

      if (pending.length === 0) return;

      const items: JudgeItem[] = await Promise.all(
        pending.map(async (question) => {
          const chat = await this.names.chat(question.threadId);
          const open = toOpenQuestion(question);

          return {
            key: itemKey(question.id, question.revision),
            threadId: question.threadId,
            chatTitle: chat.title,
            project: chat.project,
            mode: open.mode,
            shortLabel: open.shortLabel,
            prompt: open.prompt,
            context: open.context,
            multiSelect: open.multiSelect,
            options: open.options,
            createdAt: open.createdAt,
          };
        }),
      );

      const now = Date.now();

      const insert = this.db.prepare(
        `INSERT INTO triage (item_key, question_id, revision, thread_id, status, updated_at, attempts) VALUES (?, ?, ?, ?, 'pending', ?, 1)
         ON CONFLICT (item_key) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at, attempts = triage.attempts + 1`,
      );

      for (const [index, item] of items.entries())
        insert.run(item.key, pending[index].id, pending[index].revision, item.threadId, now);

      const projects = [...new Set(items.map((item) => item.project))];
      const rules = projects.flatMap((project) => this.rules.forTriage(project));
      const unique = [...new Map(rules.map((rule) => [rule.id, rule])).values()];
      const priors = projects.flatMap((project) => this.priors(project));

      try {
        const submitted = triageSubmissionSchema.parse(
          await this.judges.run(
            "triage",
            judgePrompt(items, unique, priors),
            items.map((item) => item.key),
            null,
          ),
        );

        const accepted = acceptVerdicts(items, submitted.verdicts);

        const done = this.db.prepare(
          "UPDATE triage SET status = 'done', verdict = ?, updated_at = ? WHERE item_key = ?",
        );

        const missing = this.db.prepare(
          "UPDATE triage SET status = 'failed', error = ?, updated_at = ? WHERE item_key = ?",
        );

        for (const item of items) {
          const verdict = accepted.get(item.key);

          if (verdict) done.run(JSON.stringify(verdict), Date.now(), item.key);
          else
            missing.run(
              "The judge returned no valid verdict for this question.",
              Date.now(),
              item.key,
            );
        }

        this.lastTriageError = null;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Triage failed.";

        this.lastTriageError = message;

        const failed = this.db.prepare(
          "UPDATE triage SET status = 'failed', error = ?, updated_at = ? WHERE item_key = ?",
        );

        for (const item of items) failed.run(message, Date.now(), item.key);
      }
    } finally {
      this.triageRunning = false;
    }

    await this.delegate();

    if (this.hasUntriaged()) this.requestTriage();
  }

  private hasUntriaged(): boolean {
    const chiefId = this.chiefThreadId();

    return [...this.lastQuestions.values()].some(
      (question) =>
        question.threadId !== chiefId &&
        this.db
          .prepare("SELECT 1 AS found FROM triage WHERE item_key = ?")
          .get(itemKey(question.id, question.revision)) === undefined,
    );
  }

  priors(project: string): PriorOutcome[] {
    const rows = many(
      z.object({
        project: z.string(),
        short_label: z.string().nullable(),
        prompt: z.string().nullable(),
        agent_recommended: z.string(),
        chosen: z.string(),
        free_text: z.string().nullable(),
        at: z.number(),
      }),
      this.db
        .prepare(
          `SELECT project, short_label, prompt, agent_recommended, chosen, free_text, at FROM outcomes
         WHERE project = ? AND card_kind IN ('question', 'history') ORDER BY at DESC LIMIT 50`,
        )
        .all(project),
    );

    return rows.map((row) => ({
      project: row.project,
      shortLabel: row.short_label ?? "Question",
      prompt: row.prompt ?? "",
      agentRecommended: stringList(row.agent_recommended),
      chosen: stringList(row.chosen),
      freeText: row.free_text,
      at: row.at,
    }));
  }

  async recordOutcome(input: OutcomeInput): Promise<string> {
    const id = randomUUID();

    const questions = input.questionIds.flatMap((questionId) => {
      const question = this.lastQuestions.get(questionId);

      return question ? [question] : [];
    });

    const first = questions[0];
    const verdicts = this.verdicts();
    const verdict = first ? (verdicts.get(itemKey(first.id, first.revision)) ?? null) : null;
    const chat = input.threadId ? await this.names.chat(input.threadId).catch(() => null) : null;

    const kind =
      input.threadId !== null && input.threadId === this.chiefThreadId()
        ? "rule-question"
        : input.cardKind;

    this.db
      .prepare(
        `INSERT INTO outcomes (id, card_kind, action, thread_id, question_ids, project, tag, short_label, prompt, options,
          agent_recommended, chief_recommended, chosen, free_text, reason_chip, rule_ids, response_ms, at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        input.action,
        input.threadId,
        JSON.stringify(input.questionIds),
        chat?.project ?? null,
        first?.question.shortLabel ?? null,
        first?.question.prompt ?? null,
        JSON.stringify(
          first?.question.options.map((option) => ({ value: option.value, label: option.label })) ??
            [],
        ),
        JSON.stringify(
          first?.question.options
            .filter((option) => option.recommended)
            .map((option) => option.value) ?? [],
        ),
        JSON.stringify(verdict?.recommendation ?? []),
        JSON.stringify(input.chosen),
        input.freeText,
        input.reasonChip,
        JSON.stringify(verdict?.ruleIds ?? []),
        input.responseMs,
        Date.now(),
      );

    if (verdict && input.chosen.length > 0 && kind === "question")
      for (const ruleId of verdict.ruleIds) {
        if (sameSet(verdict.recommendation, input.chosen))
          this.rules.recordMatch(ruleId, Date.now());
        else this.rules.recordOverride(ruleId, Date.now());
        this.instructionCache.clear();
      }

    return id;
  }

  snooze(cardKey: string, until: number): void {
    this.db
      .prepare(
        "INSERT INTO snoozes (card_key, until) VALUES (?, ?) ON CONFLICT (card_key) DO UPDATE SET until = excluded.until",
      )
      .run(cardKey, until);
    this.options.changed();
  }

  unsnooze(cardKey: string, until: number): void {
    this.db.prepare("DELETE FROM snoozes WHERE card_key = ? AND until = ?").run(cardKey, until);
    this.options.changed();
  }

  private threadDelegations(threadId: string): ThreadDelegation[] {
    const rows = many(
      z.object({
        id: z.string(),
        question_id: z.string(),
        answer: z.string(),
        rule_id: z.string(),
        state: delegatedStateSchema,
        send_at: z.number(),
        updated_at: z.number(),
      }),
      this.db
        .prepare(
          "SELECT id, question_id, answer, rule_id, state, send_at, updated_at FROM delegated_answers WHERE thread_id = ? AND (state IN ('waiting', 'unconfirmed') OR (state = 'sent' AND updated_at >= ?)) ORDER BY updated_at DESC",
        )
        .all(threadId, Date.now() - ANSWERED_CARD_MS),
    );

    return rows.map((row) => ({
      id: row.id,
      questionId: row.question_id,
      answer: stringList(row.answer),
      cue: this.rules.get(row.rule_id)?.action ?? "",
      state: row.state,
      sendAt: row.send_at,
      updatedAt: row.updated_at,
    }));
  }

  async answerNow(id: string): Promise<DelegatedState> {
    this.db
      .prepare(
        "UPDATE delegated_answers SET send_at = ?, updated_at = ? WHERE id = ? AND state = 'waiting'",
      )
      .run(Date.now() - 1, Date.now(), id);
    await this.delegate();

    return (
      one(
        z.object({ state: delegatedStateSchema }),
        this.db.prepare("SELECT state FROM delegated_answers WHERE id = ?").get(id),
      )?.state ?? "cancelled"
    );
  }

  async threadTriage(threadId: string) {
    const suggestions = this.suggestions();

    const [all, agent] = await Promise.all([this.openQuestions(), this.agentView()]);
    const open = all.filter((question) => question.threadId === threadId);
    const verdicts = suggestions === "on" ? this.verdicts() : new Map<string, Verdict>();
    const errors = this.triageErrors();

    return {
      chiefThreadId: this.chiefThreadId(),
      suggestions,
      agent,
      paused: this.paused(),
      delegations: this.threadDelegations(threadId),
      steps: open.map((question) => {
        const key = itemKey(question.id, question.revision);

        return {
          questionId: question.id,
          key,
          verdict: verdicts.get(key) ?? null,
          triageError: suggestions === "on" ? (errors.get(key) ?? null) : null,
        };
      }),
    };
  }

  private ruleView(rule: RuleRecord): RuleView {
    const replayed = this.rules.replayOf(rule.id);

    return {
      id: rule.id,
      version: rule.version,
      cue: rule.cue,
      action: rule.action,
      scope: rule.project === null ? "All projects" : rule.project,
      level: rule.level,
      required: rule.required,
      provenance: rule.provenance,
      state: rule.state,
      ownerAdopted: rule.ownerAdopted,
      matches: rule.matches,
      overrides: rule.overrides,
      precision: replayed.precision,
      evidence: rule.evidence.length,
      updatedAt: rule.updatedAt,
    };
  }

  ruleViews(): RuleView[] {
    return this.rules.latest().map((rule) => this.ruleView(rule));
  }

  changeRule(id: string, change: RuleChange): RuleView {
    const before = this.rules.get(id);
    const after = this.rules.reduce(id, change, Date.now());

    if (after.version !== before?.version) {
      this.db
        .prepare(
          "UPDATE delegated_answers SET state = 'cancelled', error = ?, updated_at = ? WHERE rule_id = ? AND state = 'waiting'",
        )
        .run("The rule was lowered or retired before the veto delay ended.", Date.now(), id);
      this.instructionCache.clear();
    }

    return this.ruleView(after);
  }

  private ruleTopic(rule: RuleRecord): string {
    return (rule.label ?? rule.project ?? "Rule").slice(0, 24);
  }

  private relatedText(related: RelatedRule | null): string | null {
    if (related === null) return null;
    const other = this.rules.get(related.ruleId);

    if (other === null || other.state !== "adopted") return null;
    const name = other.label ?? clause(other.cue).slice(0, 60);

    const relationship = related.relation === "conflicts" ? "Conflicts with" : "Overlaps";

    return `${relationship} your adopted rule “${name}” (${scopeText(other.project).toLowerCase()})
${rulePrompt(other)}`;
  }

  async askAboutRule(rule: RuleRecord, related: RelatedRule | null = null): Promise<void> {
    const replayed = this.rules.replayOf(rule.id);
    const canAnswer = this.suggestions() === "on" && this.coreSupport;
    const atOnce = canAnswer && autoAllowed(replayed.precision, replayed.matches);

    const record =
      rule.provenance === "told"
        ? "You told the Chief"
        : replayed.precision === null || replayed.matches === 0
          ? "Not tested on your past answers"
          : `Matches ${Math.round((replayed.precision * replayed.matches) / 100)} of your last ${replayed.matches} answers`;

    await this.openRuleQuestion(rule, {
      prompt: rulePrompt(rule),
      context: [
        scopeText(rule.project),
        record,
        this.relatedText(related),
        canAnswer ? null : "Answering for you needs suggestions on",
      ]
        .filter((part) => part !== null)
        .join(" · "),
      shortLabel: this.ruleTopic(rule),
      options: [
        ruleOption("ask", "Suggest only"),
        ...(canAnswer
          ? [
              ruleOption("veto", "Answer optional (10-min veto)"),
              ruleOption("veto-required", "Answer required too (10-min veto)"),
            ]
          : []),
        ...(atOnce
          ? [
              ruleOption("auto", "Answer optional at once"),
              ruleOption("auto-required", "Answer required too at once"),
            ]
          : []),
        ruleOption("reject", "Reject"),
      ],
    });
  }

  async askForReview(rule: RuleRecord): Promise<void> {
    const why =
      rule.overrides >= 2
        ? `You answered differently ${rule.overrides} times`
        : "Unused for 30 days";

    await this.openRuleQuestion(rule, {
      prompt: rulePrompt(rule),
      context: [scopeText(rule.project), why, `Now: ${LEVEL_SHORT[rule.level]}${rule.required ? ", required too" : ""}`].join(" · "),
      shortLabel: this.ruleTopic(rule),
      options: [
        ruleOption("keep", "Keep"),
        ...(rule.level === "ask" ? [] : [ruleOption("ask", "Suggest only")]),
        ruleOption("reject", "Retire"),
      ],
    });
  }

  private async openRuleQuestion(rule: RuleRecord, question: RuleQuestion): Promise<void> {
    const chiefId = this.chiefThreadId();

    if (chiefId === null) return;

    const result = await this.api.sdk.experimental_attention.command({
      threadId: chiefId,
      command: {
        action: "open",
        questions: [
          {
            key: null,
            prompt: question.prompt,
            context: question.context,
            shortLabel: question.shortLabel,
            mode: "optional",
            multiSelect: false,
            allowFreeText: false,
            additiveNotes: false,
            delegable: false,
            options: question.options,
          },
        ],
      },
    });

    const opened = result.questions[0];

    if (opened) this.rules.bindQuestion(rule.id, opened.id, opened.revision, Date.now());
  }

  async reconcileRuleQuestions(): Promise<void> {
    const chiefId = this.chiefThreadId();

    if (chiefId === null) return;
    const history = await this.api.sdk.experimental_attention.history({ threadId: chiefId });

    const payloads = new Map(
      readQuestions(history.questions).questions.map(
        (question) => [question.id, question] as const,
      ),
    );

    for (const rule of this.rules.bound()) {
      const plan = planRuleAnswer(
        rule.questionId === null ? undefined : payloads.get(rule.questionId),
      );

      if (plan.kind === "wait") continue;

      if (plan.kind === "unbind") {
        this.rules.settleUnanswered(rule.id, Date.now());
        continue;
      }

      const replayed = this.rules.replayOf(rule.id);

      const result = this.rules.applyAnswer(
        rule.id,
        {
          questionRevision: plan.revision,
          choice: plan.choice,
          ownerAttributed: plan.ownerAttributed,
          coreSupportsAttribution: plan.coreSupportsAttribution,
          precision: replayed.precision,
          replayMatches: replayed.matches,
        },
        Date.now(),
      );

      this.instructionCache.clear();

      if (!result.applied && result.reason === "changed") {
        this.rules.unbindQuestion(rule.id);
        const current = this.rules.get(rule.id);

        if (current?.state === "candidate") await this.askAboutRule(current);
      } else if (!result.applied) {
        this.api.log.warn(`Rule ${rule.id}: ${result.reason} answer ignored.`);
        this.rules.unbindQuestion(rule.id);
      }
    }

    for (const rule of this.rules.needingReview(Date.now())) await this.askForReview(rule);

    await this.reconcileResume(chiefId, payloads);
  }

  private async reconcileResume(
    chiefId: string,
    payloads: Map<string, QuestionPayload>,
  ): Promise<void> {
    const stored = readState(this.db, RESUME_KEY);

    if (stored === null || stored === "") return;
    const [questionId, revision] = stored.split("@");
    const question = payloads.get(questionId ?? "");

    if (question === undefined || question.state === "open") return;
    writeState(this.db, RESUME_KEY, "");

    if (
      question.state === "answered" &&
      question.revision === Number(revision) &&
      question.answer?.selected[0] === "resume" &&
      (question.answeredBy === undefined || question.answeredBy?.kind === "owner")
    )
      writeState(this.db, PAUSED_KEY, "0");
    else
      this.api.log.info(
        `Delegation stays paused; the resume question in ${chiefId} was not approved.`,
      );
  }

  pause(): void {
    writeState(this.db, PAUSED_KEY, "1");
    this.options.changed();
  }

  async requestResume(): Promise<string> {
    const chiefId = this.chiefThreadId();

    if (chiefId === null) throw new Error("The Chief's chat is missing: omnyo chief start");

    const result = await this.api.sdk.experimental_attention.command({
      threadId: chiefId,
      command: {
        action: "open",
        questions: [
          {
            key: null,
            prompt: "Let the Chief answer for you again?",
            context: "Rules you adopted will start answering again.",
            shortLabel: "Resume?",
            mode: "optional",
            multiSelect: false,
            allowFreeText: false,
            additiveNotes: false,
            delegable: false,
            options: [
              {
                value: "resume",
                label: "Yes, resume",
                description: null,
                recommended: false,
                preview: null,
              },
              {
                value: "keep",
                label: "Keep paused",
                description: null,
                recommended: false,
                preview: null,
              },
            ],
          },
        ],
      },
    });

    const opened = result.questions[0];

    if (opened === undefined) throw new Error("The resume question could not be opened.");
    writeState(this.db, RESUME_KEY, `${opened.id}@${opened.revision}`);

    return opened.id;
  }

  async told(
    threadId: string,
    cue: string,
    action: string,
    project: string | null,
    label: string | null,
  ): Promise<RuleRecord> {
    if (threadId !== this.chiefThreadId())
      throw new Error("Only the Chief chat can record preferences.");

    const rule = this.rules.propose(
      { cue, action, project, evidence: [], label, related: null },
      "told",
      Date.now(),
    );

    await this.askAboutRule(rule);

    return rule;
  }

  ownerAnswers(): AnswerEntry[] {
    const rows = many(
      z.object({
        id: z.string(),
        thread_id: z.string().nullable(),
        question_ids: z.string(),
        project: z.string().nullable(),
        short_label: z.string().nullable(),
        prompt: z.string().nullable(),
        options: z.string(),
        agent_recommended: z.string(),
        chosen: z.string(),
        free_text: z.string().nullable(),
        at: z.number(),
      }),
      this.db
        .prepare(
          `SELECT id, thread_id, question_ids, project, short_label, prompt, options, agent_recommended, chosen, free_text, at
         FROM outcomes WHERE card_kind IN ('question', 'history') AND chosen <> '[]'`,
        )
        .all(),
    );

    return rows.flatMap((row) => {
      const options = optionPairsSchema.parse(JSON.parse(row.options));

      const recommended = stringList(row.agent_recommended);
      const questionId = stringList(row.question_ids)[0];

      return questionId === undefined || options.length === 0
        ? []
        : [
            {
              questionId,
              revision: 1,
              threadId: row.thread_id ?? "",
              chatTitle: "",
              project: row.project ?? "",
              mode: "required" as const,
              shortLabel: row.short_label ?? "Question",
              prompt: row.prompt ?? "",
              context: null,
              multiSelect: false,
              options: options.map((option) => ({
                ...option,
                description: null,
                recommended: recommended.includes(option.value),
              })),
              chosen: stringList(row.chosen),
              freeText: row.free_text,
              answeredBy: null,
              createdAt: row.at,
            },
          ];
    });
  }

  judgeFor(jobId: string | null): Judge {
    return (prompt, keys, kind) =>
      this.judges.run(
        kind === "distill" ? "distill" : jobId === null ? "triage" : "eval",
        prompt,
        keys,
        jobId,
      );
  }

  async distillDaily(): Promise<RuleRecord[] | null> {
    const last = Number(readState(this.db, DISTILL_LAST_KEY) ?? "0");

    if (this.suggestions() !== "on" || Date.now() - last < DISTILL_GAP_MS) return null;

    return this.distill();
  }

  async distill(): Promise<RuleRecord[]> {
    if (this.suggestions() !== "on") throw new SuggestionsOffError();
    writeState(this.db, DISTILL_LAST_KEY, String(Date.now()));
    const entries = this.ownerAnswers();

    const report = await replay(
      this.judgeFor(null),
      entries,
      Date.now() - DISTILL_WINDOW_MS,
      () => {},
      { plain: false, existing: this.rules.forDistill() },
    );

    const existing = this.rules.latest();
    const created: RuleRecord[] = [];

    for (const proposal of report.rules) {
      if (existing.some((rule) => rule.state !== "superseded" && sameRule(rule, proposal)))
        continue;

      const rule = this.rules.propose(
        {
          cue: proposal.cue,
          action: proposal.action,
          project: proposal.project,
          evidence: [],
          label: proposal.label,
          related: proposal.related,
        },
        "learned",
        Date.now(),
      );

      this.rules.setReplay(rule.id, proposal.precision, proposal.matches);
      await this.askAboutRule(rule, proposal.related);
      existing.push(rule);
      created.push(rule);
    }

    return created;
  }

  importHistory(path: string): number {
    const dataset = datasetSchema.parse(JSON.parse(readFileSync(path, "utf8")));

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO outcomes (id, card_kind, action, thread_id, question_ids, project, tag, short_label, prompt,
        options, agent_recommended, chief_recommended, chosen, free_text, reason_chip, rule_ids, response_ms, at)
       VALUES (?, 'history', 'history', ?, ?, ?, NULL, ?, ?, ?, ?, '[]', ?, ?, NULL, '[]', NULL, ?)`,
    );

    let count = 0;

    for (const entry of dataset.questions) {
      if (entry.answeredBy !== null && entry.answeredBy.kind !== "owner") continue;
      insert.run(
        `history:${entry.questionId}@${entry.revision}`,
        entry.threadId,
        JSON.stringify([entry.questionId]),
        entry.project,
        entry.shortLabel,
        entry.prompt,
        JSON.stringify(
          entry.options.map((option) => ({ value: option.value, label: option.label })),
        ),
        JSON.stringify(
          entry.options.filter((option) => option.recommended).map((option) => option.value),
        ),
        JSON.stringify(entry.chosen),
        entry.freeText,
        entry.createdAt,
      );
      count += 1;
    }

    return count;
  }

  startEval(path: string, splitDay: string): string {
    if (this.suggestions() !== "on") throw new SuggestionsOffError();
    const dataset = datasetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const id = `eval_${randomUUID().slice(0, 8)}`;
    const split = localMidnight(splitDay);

    this.db
      .prepare(
        "INSERT INTO eval_jobs (id, status, split_at, until_at, progress, created_at) VALUES (?, 'running', ?, ?, ?, ?)",
      )
      .run(
        id,
        split,
        Date.now(),
        JSON.stringify({ stage: "starting", done: 0, total: 0 }),
        Date.now(),
      );

    void (async () => {
      try {
        const report = await replay(
          this.judgeFor(id),
          dataset.questions,
          split,
          (stage, done, total) => {
            this.db
              .prepare("UPDATE eval_jobs SET progress = ? WHERE id = ?")
              .run(JSON.stringify({ stage, done, total }), id);
          },
        );

        this.db
          .prepare(
            "UPDATE eval_jobs SET status = 'complete', result = ?, ended_at = ? WHERE id = ?",
          )
          .run(JSON.stringify(report), Date.now(), id);
        await this.post(
          `Evaluation ${id} finished on ${report.test} held-out answers: asking agent ${report.baseline.matchRate ?? "–"}%, Chief ${report.plain.matchRate ?? "–"}% (coverage ${report.plain.coverage ?? "–"}%), Chief with rules ${report.ruled.matchRate ?? "–"}%. Judge failures: ${report.judgeFailures}.`,
        );
      } catch (cause) {
        this.db
          .prepare("UPDATE eval_jobs SET status = 'failed', error = ?, ended_at = ? WHERE id = ?")
          .run(cause instanceof Error ? cause.message : "Evaluation failed.", Date.now(), id);
      }
    })();

    return id;
  }

  recoverEvalJobs(): void {
    this.db
      .prepare(
        "UPDATE eval_jobs SET status = 'failed', error = 'Interrupted by a plugin restart.', ended_at = ? WHERE status = 'running'",
      )
      .run(Date.now());
  }

  evalStatus(id: string): EvalStatus {
    const row = one(
      z.object({
        status: z.string(),
        progress: z.string(),
        result: z.string().nullable(),
        error: z.string().nullable(),
      }),
      this.db.prepare("SELECT * FROM eval_jobs WHERE id = ?").get(id),
    );

    if (row === undefined) throw new Error(`No evaluation ${id}.`);

    return {
      id,
      status: row.status,
      progress: progressSchema.parse(JSON.parse(row.progress)),
      result: row.result === null ? null : z.json().parse(JSON.parse(row.result)),
      error: row.error,
    };
  }

  private async post(text: string): Promise<void> {
    const chiefId = this.chiefThreadId();

    if (chiefId === null) return;
    await this.api.sdk.threads.send({
      threadId: chiefId,
      mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  async delegate(): Promise<void> {
    if (this.delegating || this.suggestions() !== "on") return;
    this.delegating = true;

    try {
      const chiefId = this.chiefThreadId();
      const open = (await this.openQuestions()).filter((question) => question.threadId !== chiefId);
      const verdicts = this.verdicts();
      const now = Date.now();

      for (const question of open) {
        const key = itemKey(question.id, question.revision);
        const verdict = verdicts.get(key) ?? null;

        const rule =
          verdict?.ruleIds
            .map((ruleId) => this.rules.get(ruleId))
            .find(
              (candidate) =>
                candidate !== null && candidate.state === "adopted" && candidate.level !== "ask",
            ) ?? null;

        if (rule === null || verdict === null) continue;

        const existing = one(
          z.object({ id: z.string(), state: delegatedStateSchema, send_at: z.number() }),
          this.db
            .prepare(
              "SELECT id, state, send_at FROM delegated_answers WHERE question_id = ? AND revision = ?",
            )
            .get(question.id, question.revision),
        );

        if (existing !== undefined && existing.state !== "waiting") continue;

        const guard = delegationGuard({
          coreSupportsDelegation: this.coreSupport,
          paused: this.paused(),
          question: {
            open: true,
            revision: question.revision,
            delegable: question.question.delegable ?? false,
            mode: question.question.mode,
          },
          triagedRevision: question.revision,
          verdict,
          rule: {
            id: rule.id,
            level: rule.level,
            required: rule.required,
            ownerAdopted: rule.ownerAdopted,
            state: rule.state,
          },
          vetoElapsed: existing !== undefined && existing.send_at <= now,
        });

        if (!guard.ok) {
          if (guard.reason === "Waiting for the veto delay." && existing === undefined)
            this.db
              .prepare(
                `INSERT INTO delegated_answers (id, thread_id, question_id, revision, answer, rule_id, rule_version, reason,
                  state, send_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`,
              )
              .run(
                randomUUID(),
                question.threadId,
                question.id,
                question.revision,
                JSON.stringify(verdict.recommendation),
                rule.id,
                rule.version,
                verdict.reason,
                now + VETO_DELAY_MS,
                now,
                now,
              );
          continue;
        }

        await this.sendDelegated(question, verdict, rule, existing?.id ?? null);
      }

      const openKeys = new Set(open.map((question) => itemKey(question.id, question.revision)));

      const waiting = many(
        z.object({ id: z.string(), question_id: z.string(), revision: z.number() }),
        this.db
          .prepare(
            "SELECT id, question_id, revision FROM delegated_answers WHERE state = 'waiting'",
          )
          .all(),
      );

      for (const row of waiting)
        if (!openKeys.has(itemKey(row.question_id, row.revision)))
          this.setDelegated(
            row.id,
            "cancelled",
            "The question closed before the veto delay ended.",
          );
    } finally {
      this.delegating = false;
    }
  }

  private async sendDelegated(
    question: QuestionPayload,
    verdict: Verdict,
    rule: RuleRecord,
    existingId: string | null,
  ): Promise<void> {
    const now = Date.now();
    const id = existingId ?? randomUUID();

    if (existingId === null)
      this.db
        .prepare(
          `INSERT INTO delegated_answers (id, thread_id, question_id, revision, answer, rule_id, rule_version, reason,
            state, send_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?)`,
        )
        .run(
          id,
          question.threadId,
          question.id,
          question.revision,
          JSON.stringify(verdict.recommendation),
          rule.id,
          rule.version,
          verdict.reason,
          now,
          now,
          now,
        );
    else
      this.db
        .prepare(
          "UPDATE delegated_answers SET state = 'unconfirmed', updated_at = ? WHERE id = ? AND state = 'waiting'",
        )
        .run(now, id);

    try {
      const command = {
        action: "answer" as const,
        id: question.id,
        revision: question.revision,
        answer: { selected: verdict.recommendation },
        delegation: { ruleId: rule.id, reason: verdict.reason.slice(0, 200) },
      };

      await this.api.sdk.experimental_attention.command({ threadId: question.threadId, command });
      this.setDelegated(id, "sent", null);
      this.rules.recordMatch(rule.id, Date.now());
    } catch (cause) {
      this.setDelegated(
        id,
        "uncertain",
        cause instanceof Error ? cause.message : "Delivery is uncertain.",
      );
    }
  }

  private setDelegated(id: string, state: DelegatedState, error: string | null): void {
    this.db
      .prepare("UPDATE delegated_answers SET state = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(state, error, Date.now(), id);
  }

  async delegations(): Promise<DelegatedView[]> {
    const rows = many(
      z.object({
        id: z.string(),
        thread_id: z.string(),
        question_id: z.string(),
        answer: z.string(),
        rule_id: z.string(),
        reason: z.string(),
        state: delegatedStateSchema,
        send_at: z.number(),
        updated_at: z.number(),
      }),
      this.db.prepare("SELECT * FROM delegated_answers ORDER BY updated_at DESC LIMIT 30").all(),
    );

    return Promise.all(
      rows.map(async (row) => {
        const chat = await this.names.chat(row.thread_id).catch(() => null);
        const question = this.lastQuestions.get(row.question_id);

        const history = await this.api.sdk.experimental_attention
          .history({ threadId: row.thread_id })
          .catch(() => null);

        const payload = history
          ? readQuestions(history.questions).questions.find((entry) => entry.id === row.question_id)
          : undefined;

        return {
          id: row.id,
          threadId: row.thread_id,
          title: chat?.title ?? "Chat",
          questionId: row.question_id,
          prompt: payload?.question.prompt ?? question?.question.prompt ?? "",
          answer: stringList(row.answer),
          ruleId: row.rule_id,
          cue: this.rules.get(row.rule_id)?.cue ?? "",
          state: row.state,
          sendAt: row.send_at,
          answeredBy: payload?.answeredBy ? JSON.stringify(payload.answeredBy) : null,
          updatedAt: row.updated_at,
        };
      }),
    );
  }

  async undo(id: string): Promise<DelegatedState> {
    const row = one(
      z.object({
        id: z.string(),
        thread_id: z.string(),
        question_id: z.string(),
        answer: z.string(),
        rule_id: z.string(),
        state: delegatedStateSchema,
      }),
      this.db.prepare("SELECT * FROM delegated_answers WHERE id = ?").get(id),
    );

    if (row === undefined) throw new Error(`No delegated answer ${id}.`);
    const target = undoTarget(row.state);

    if (target === null) return row.state;

    if (target === "corrected")
      await this.api.sdk.threads.send({
        threadId: row.thread_id,
        mode: "auto",
        input: [
          {
            type: "text",
            text: `The owner withdrew the answer the Chief gave for them (${stringList(row.answer).join(", ")}) to question ${row.question_id}. Treat that choice as not made; if it still matters, ask again.`,
            mentions: [],
          },
        ],
      });

    this.setDelegated(id, target, null);
    this.rules.recordOverride(row.rule_id, Date.now());
    this.instructionCache.clear();

    return target;
  }

  instructionsFor(project: string): string | null {
    if (!this.instructionCache.has(project))
      this.instructionCache.set(project, this.rules.instructionBlock(project));

    return this.instructionCache.get(project) ?? null;
  }

  configure(
    ctx: PluginAgentConfigurationContext,
    tools: { triage: string; distill: string; told: string },
  ): PluginAgentConfiguration {
    if (ctx.thread.experimental_visibility === "hidden") {
      const marker = judgeMarkerSchema.safeParse(ctx.pluginMetadata);
      const chiefId = this.chiefThreadId();

      if (!marker.success || chiefId === null || ctx.thread.parentThreadId !== chiefId)
        return { tools: [], skills: [] };

      return marker.data.kind === "distill"
        ? { tools: [tools.distill], skills: [], instructions: DISTILL_INSTRUCTIONS }
        : { tools: [tools.triage], skills: [], instructions: JUDGE_INSTRUCTIONS };
    }

    if (ctx.thread.id === this.chiefThreadId())
      return {
        tools: [tools.told],
        skills: [],
        instructions: `${CHIEF_INSTRUCTIONS}\n${TOLD_INSTRUCTIONS}`,
      };

    const block = this.instructionsFor(ctx.project.name);

    return block === null
      ? { tools: [], skills: [] }
      : { tools: [], skills: [], instructions: block };
  }
}
