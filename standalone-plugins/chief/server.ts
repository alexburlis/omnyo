import {
  cliCommand,
  defineCli,
  type PluginApi,
  type PluginCliBooleanOption,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./lib/contract.ts";
import { MIGRATIONS, fromDriver } from "./lib/db.ts";
import { ruleChangeSchema } from "./lib/delegation.ts";
import { triageSubmissionSchema } from "./lib/inputs.ts";
import { proposalSubmissionSchema } from "./lib/rules.ts";
import { Chief, SuggestionsOffError, type ChiefSettings } from "./lib/service.ts";

const TOOLS = { triage: "chief_triage", distill: "chief_propose_rules", told: "chief_rule_told" };

const CHANGE_KINDS = new Set([
  "work-changed",
  "status-changed",
  "interactions-changed",
  "thread-created",
  "thread-deleted",
  "archived-changed",
]);

const FULL_READ_MS = 60_000;

const CHANGED_CHANNEL = "chief.changed";

const PUBLISH_DEBOUNCE_MS = 500;

const json = { type: "boolean", description: "Emit JSON" } satisfies PluginCliBooleanOption;

interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const output = <T extends object>(value: T, asJson: boolean, text: string): CliResult => ({
  exitCode: 0,
  stdout: asJson ? JSON.stringify(value) : text,
});

const refuse = (message: string): CliResult => ({ exitCode: 1, stderr: message });

async function attempt(run: () => Promise<CliResult> | CliResult): Promise<CliResult> {
  try {
    return await run();
  } catch (cause) {
    return refuse(cause instanceof Error ? cause.message : String(cause));
  }
}

export default async function plugin(api: PluginApi) {
  const settings = api.settings.define({
    chiefProvider: {
      type: "string",
      label: "Agent for the Chief's chat (empty: the Personal project's default)",
      default: "",
    },
    chiefModel: { type: "string", label: "Model for the Chief's chat", default: "" },
    judgeProvider: {
      type: "string",
      label: "Agent for suggested answers (empty: the Personal project's default)",
      default: "",
    },
    judgeModel: { type: "string", label: "Model for suggested answers", default: "" },
  });

  let values: ChiefSettings = await settings.get();

  settings.onChange((next) => {
    values = next;
  });

  const database = api.storage.database();

  api.storage.migrate(database, MIGRATIONS);
  const db = fromDriver(database);
  let publishTimer: ReturnType<typeof setTimeout> | null = null;

  const changed = () => {
    if (publishTimer !== null) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      api.realtime.publish(CHANGED_CHANNEL, null);
    }, PUBLISH_DEBOUNCE_MS);
    publishTimer.unref?.();
  };

  api.onDispose(() => {
    if (publishTimer !== null) clearTimeout(publishTimer);
  });

  const chief = new Chief(api, db, () => values, {
    writeSetting: async (key, value) => {
      values = await settings.experimental_set({ [key]: value });
    },
    changed,
  });

  await chief.judges.recover();
  chief.recoverEvalJobs();
  api.onDispose(() => chief.judges.dispose());

  api.agents.registerTool({
    name: TOOLS.triage,
    description:
      "Submit the Chief's triage verdicts. Only the Chief's own judge chats can use this tool.",
    parameters: triageSubmissionSchema,
    execute: (input, ctx) => {
      if (!chief.judges.accepts(ctx.threadId, ["triage", "eval"]))
        return {
          content: [{ type: "text", text: "Only Chief judge chats can submit verdicts." }],
          isError: true,
        };
      chief.judges.submit(ctx.threadId, input);

      return "Recorded. Stop now.";
    },
  });

  api.agents.registerTool({
    name: TOOLS.distill,
    description:
      "Submit proposed rules. Only the Chief's own distillation chats can use this tool.",
    parameters: proposalSubmissionSchema,
    execute: (input, ctx) => {
      if (!chief.judges.accepts(ctx.threadId, ["distill"]))
        return {
          content: [{ type: "text", text: "Only Chief distillation chats can propose rules." }],
          isError: true,
        };
      chief.judges.submit(ctx.threadId, input);

      return "Recorded. Stop now.";
    },
  });

  api.agents.registerTool({
    name: TOOLS.told,
    description:
      "Record a lasting preference the owner stated in the Chief's chat. It becomes a candidate rule; the owner adopts it by answering the Make this a rule? question.",
    parameters: z.object({
      cue: z.string().trim().min(8).max(300),
      action: z.string().trim().min(3).max(300),
      project: z.string().trim().min(1).max(200).nullable(),
      label: z
        .string()
        .trim()
        .min(1)
        .max(24)
        .describe('The topic in one or two words, for example "1Password" or "release builds"'),
    }),
    execute: async (input, ctx) => {
      try {
        const rule = await chief.told(
          ctx.threadId,
          input.cue,
          input.action,
          input.project,
          input.label,
        );

        return `Recorded candidate ${rule.id}. The owner can adopt it from the Make this a rule? question.`;
      } catch (cause) {
        return {
          content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
          isError: true,
        };
      }
    },
  });

  api.agents.configure((ctx) => chief.configure(ctx, TOOLS));

  api.events.on("thread.failed", ({ thread, error }) => {
    if (chief.judges.isJudge(thread.id))
      chief.judges.fail(thread.id, `The judge's run failed: ${error ?? "no error was reported"}.`);
  });

  api.events.on("interaction.pending", ({ thread }) => {
    if (chief.judges.isJudge(thread.id))
      chief.judges.fail(thread.id, "The judge asked for a permission, which judges never get.");
  });

  api.rpc.register(rpcContract, {
    deck: () => chief.deck(),
    "outcome.record": async (input) => ({ id: await chief.recordOutcome(input) }),
    snooze: ({ cardKey, until }) => {
      chief.snooze(cardKey, until);

      return { ok: true as const };
    },
    unsnooze: ({ cardKey, until }) => {
      chief.unsnooze(cardKey, until);

      return { ok: true as const };
    },
    "thread.triage": ({ threadId }) => chief.threadTriage(threadId),
    start: async () => ({ threadId: await chief.start() }),
    status: () =>
      chief.status().catch(() => ({
        dot: null,
        toDecide: 0,
        saved: 0,
        paused: false,
        error: true,
      })),
    "suggestions.set": ({ value }) => ({ suggestions: chief.setSuggestions(value) }),
    pause: () => {
      chief.pause();

      return { paused: true as const };
    },
    resume: async () => ({ questionId: await chief.requestResume() }),
    "hint.seen": () => {
      chief.markHintSeen();

      return { ok: true as const };
    },
    "delegation.answerNow": async ({ id }) => ({ state: await chief.answerNow(id) }),
    "home.repair": async () => ({ threadId: await chief.start() }),
    "suggestions.retry": () => {
      chief.retrySuggestions();

      return { ok: true as const };
    },
    "rules.list": () => ({ rules: chief.ruleViews() }),
    "rules.change": ({ id, change }) => ({ rule: chief.changeRule(id, change) }),
    "delegation.list": async () => ({ items: await chief.delegations() }),
    "delegation.undo": async ({ id }) => ({ state: await chief.undo(id) }),
  });

  api.cli.register(
    defineCli({
      name: "chief",
      summary: "The Chief: what your chats need from you, suggested answers and rules",
      commands: {
        suggestions: cliCommand({
          summary: "Turn suggested answers on or off: suggestions on|off",
          positionals: [{ name: "value", required: true, description: "on or off" }],
          options: { json },
          async run(input) {
            const value = input.positionals.value;

            if (value !== "on" && value !== "off") return refuse("Use: omnyo chief suggestions on|off");
            const suggestions = chief.setSuggestions(value);

            return output(
              { suggestions },
              input.options.json === true,
              `Suggested answers are ${suggestions}.`,
            );
          },
        }),
        start: cliCommand({
          summary: "Repair the Chief's chat: recreate it if it is missing or broken",
          options: { json },
          async run(input) {
            return attempt(async () => {
              const threadId = await chief.start();

              return output(
                { threadId },
                input.options.json === true,
                `Chief chat: @thread:${threadId}`,
              );
            });
          },
        }),
        status: cliCommand({
          summary: "Show triage, delegation and rule status",
          options: { json },
          async run(input) {
            return attempt(async () => {
              const deck = await chief.deck();
              const rules = chief.ruleViews();

              const openSuggestionFailures = deck.cards.flatMap((card) =>
                card.steps.filter((step) => step.verdict === null && step.triageError !== null),
              ).length;

              const value = {
                chiefThreadId: deck.chiefThreadId,
                home: deck.home,
                suggestions: deck.suggestions,
                toDecide: deck.toDecide,
                cards: deck.cards.length,
                saved: deck.saved,
                triage: { ...deck.triage, openFailures: openSuggestionFailures },
                delegation: deck.delegation,
                rules: {
                  candidates: rules.filter((rule) => rule.state === "candidate").length,
                  adopted: rules.filter((rule) => rule.state === "adopted").length,
                },
              };

              return output(
                value,
                input.options.json === true,
                `Chief chat: @thread:${value.chiefThreadId ?? "missing"} (${value.home}). Suggested answers: ${value.suggestions}. ${value.toDecide} to decide, ${value.saved} saved for later. Suggestions: ${value.triage.pending} reading, ${openSuggestionFailures} failed on open cards (${value.triage.failed} in stored history). Rules: ${value.rules.adopted} adopted, ${value.rules.candidates} offered. Answering for you: ${value.delegation.paused ? "paused" : value.delegation.supported ? "available" : "needs a newer Omnyo"}.`,
              );
            });
          },
        }),
        brief: cliCommand({
          summary: "Summarize what needs the owner now",
          options: { json },
          async run(input) {
            return attempt(async () => {
              const deck = await chief.deck();

              const lines = deck.cards.slice(0, 12).map((card) => {
                const top = card.steps[0]?.verdict;

                return `- ${card.title} (${card.project}): ${card.text}${top ? ` → suggests ${top.recommendation.join(", ") || "none"} (${top.confidence})` : ""}`;
              });

              return output(
                deck,
                input.options.json === true,
                [
                  `${deck.toDecide} to decide; ${deck.saved} saved for later.`,
                  ...lines,
                ].join("\n"),
              );
            });
          },
        }),
        eval: cliCommand({
          summary:
            "Replay exported answers: eval start --dataset FILE --split YYYY-MM-DD, or eval status ID",
          positionals: [
            { name: "action", required: true, description: "start or status" },
            { name: "id", required: false, description: "Evaluation id for status" },
          ],
          options: {
            json,
            dataset: { type: "string", description: "Export from scripts/baseline.mjs --export" },
            split: { type: "string", description: "First held-out day, YYYY-MM-DD" },
          },
          async run(input) {
            return attempt(async () => {
              if (input.positionals.action === "status") {
                const id = input.positionals.id;

                if (!id) return refuse("Pass the evaluation id.");
                const status = chief.evalStatus(id);

                return output(status, input.options.json === true, JSON.stringify(status, null, 2));
              }

              const dataset = input.options.dataset;
              const split = input.options.split;

              if (!dataset || !split) return refuse("Pass --dataset FILE and --split YYYY-MM-DD.");
              const id = chief.startEval(dataset, split);

              return output(
                { id },
                input.options.json === true,
                `Started ${id}. Check: omnyo chief eval status ${id}`,
              );
            });
          },
        }),
        history: cliCommand({
          summary: "Import exported owner answers as earlier answers the judges can see",
          options: {
            json,
            dataset: { type: "string", description: "Export from scripts/baseline.mjs --export" },
          },
          async run(input) {
            return attempt(async () => {
              const dataset = input.options.dataset;

              if (!dataset) return refuse("Pass --dataset FILE.");
              const imported = chief.importHistory(dataset);

              return output(
                { imported },
                input.options.json === true,
                `Imported ${imported} owner answers.`,
              );
            });
          },
        }),
        rules: cliCommand({
          summary:
            "List rules, or reduce one: rules lower RULE_ID ask|veto|optional, rules retire RULE_ID",
          positionals: [
            { name: "action", required: false, description: "list (default), lower or retire" },
            { name: "id", required: false, description: "Rule id for lower or retire" },
            { name: "to", required: false, description: "For lower: ask, veto or optional" },
          ],
          options: { json },
          async run(input) {
            return attempt(() => {
              const action = input.positionals.action ?? "list";

              if (action === "list") {
                const rules = chief.ruleViews();

                return output(
                  { rules },
                  input.options.json === true,
                  rules
                    .map(
                      (rule) =>
                        `${rule.id} v${rule.version} ${rule.state} ${rule.level}${rule.required ? "+required" : ""}: when ${rule.cue}: ${rule.action}`,
                    )
                    .join("\n") || "No rules yet.",
                );
              }

              const id = input.positionals.id;

              if (!id) return refuse("Pass the rule id.");

              const change = ruleChangeSchema.safeParse(
                action === "retire" ? "retire" : action === "lower" ? input.positionals.to : null,
              );

              if (!change.success || (action === "lower" && change.data === "retire"))
                return refuse("Use: rules lower RULE_ID ask|veto|optional, or rules retire RULE_ID.");
              const rule = chief.changeRule(id, change.data);

              return output(
                { rule },
                input.options.json === true,
                `${rule.id} v${rule.version} ${rule.state} ${rule.level}${rule.required ? "+required" : ""}.`,
              );
            });
          },
        }),
        distill: cliCommand({
          summary:
            "Offer rules from recent owner answers, at most once every 20 hours (--force runs it now; needs suggested answers on)",
          options: {
            json,
            force: { type: "boolean", description: "Run now even if it ran in the last 20 hours" },
          },
          async run(input) {
            return attempt(async () => {
              if (chief.suggestions() !== "on") throw new SuggestionsOffError();

              const created =
                input.options.force === true ? await chief.distill() : await chief.distillDaily();

              if (created === null)
                return output(
                  { created: [], skipped: true },
                  input.options.json === true,
                  "Skipped: the daily rule check already ran in the last 20 hours.",
                );

              return output(
                { created: created.map((rule) => rule.id), skipped: false },
                input.options.json === true,
                created.length === 0
                  ? "No new rules offered."
                  : `Offered ${created.length} rules; see Make this a rule? on the Chief page.`,
              );
            });
          },
        }),
        pause: cliCommand({
          summary: "Pause answering for you now",
          options: { json },
          async run(input) {
            chief.pause();

            return output(
              { paused: true },
              input.options.json === true,
              "Paused. The Chief only suggests.",
            );
          },
        }),
        resume: cliCommand({
          summary: "Ask the owner whether the Chief may answer for them again",
          options: { json },
          async run(input) {
            return attempt(async () => {
              const questionId = await chief.requestResume();

              return output(
                { questionId },
                input.options.json === true,
                "Asked on the Chief page. Answering resumes only after the owner says yes.",
              );
            });
          },
        }),
        delegations: cliCommand({
          summary: "List answers the Chief gave for the owner",
          options: { json },
          async run(input) {
            return attempt(async () => {
              const items = await chief.delegations();

              return output(
                { items },
                input.options.json === true,
                items
                  .map(
                    (item) =>
                      `${item.state} ${item.title}: ${item.answer.join(", ")} (rule ${item.ruleId})`,
                  )
                  .join("\n") || "Nothing decided for you yet.",
              );
            });
          },
        }),
      },
    }),
  );

  api.background.schedule("chief-daily-rules", "15 9 * * *", async () => {
    await chief.distillDaily();
  });

  api.background.service("chief", {
    async start(signal) {
      let reconciling = false;

      const reconcile = () => {
        if (reconciling) return;
        reconciling = true;
        void chief
          .reconcileRuleQuestions()
          .catch((cause) => api.log.warn(`Rule questions: ${String(cause)}`))
          .finally(() => {
            reconciling = false;
          });
      };

      const stopChanges = api.sdk.subscribe({
        event: "thread:changed",
        callback: ({ id, changes }) => {
          if (!changes.some((change) => CHANGE_KINDS.has(change))) return;
          chief.requestTriage();
          changed();

          if (id === undefined || id === chief.chiefThreadId()) reconcile();
        },
      });

      const stopConnection = api.sdk.subscribe({
        event: "realtime:connection",
        callback: ({ state }) => {
          if (state === "connected") chief.requestTriage();
        },
      });

      const tick = setInterval(() => {
        void chief.keepHomeAlive();
        chief.requestTriage();
        reconcile();
        void chief.delegate().catch((cause) => api.log.warn(`Delegation: ${String(cause)}`));
      }, FULL_READ_MS);

      tick.unref?.();

      try {
        await chief
          .ensureHome()
          .catch((cause) => api.log.warn(`The Chief's chat: ${String(cause)}`));
        chief.requestTriage();
        reconcile();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        stopChanges();
        stopConnection();
        clearInterval(tick);
      }
    },
  });
}
