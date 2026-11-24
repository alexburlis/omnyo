import assert from "node:assert/strict";
import { appendFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode, trace, subcommand, ...args] = process.argv.slice(2);

assert.equal(subcommand, "app-server");

assert.equal(process.env.OPENAI_API_KEY, undefined);

assert.equal(process.env.OMNYO_COMPOSER_PREDICTION_CAPABILITY, undefined);

assert.match(process.env.CODEX_HOME, /[\\/]\.codex-omnyo-predictions$/u);

assert.equal(realpathSync(process.cwd()), realpathSync(process.env.HOME));

const overrides = new Map(
  args
    .filter((arg) => arg !== "-c")
    .map((arg) => {
      const equals = arg.indexOf("=");

      return [arg.slice(0, equals), JSON.parse(arg.slice(equals + 1))];
    }),
);

const output = {
  suggestion: "Run the live check.",
  noSuggestionReason: null,
  archiveReadiness: {
    ready: false,
    reason: "Verification remains.",
    waitingOn: null,
    ask: null,
    recap: null,
  },
};

const threadId = "native-thread";

const turnId = "native-turn";

const account = { type: "chatgpt", planType: "pro" };

const quota = {
  ordinaryUsageAllowed: mode !== "unavailable",
  accountId: "fixture-account",
  rateLimits: {
    planType: "pro",
    primary: {
      usedPercent: mode === "exhausted" ? 100 : 25,
      resetsAt: Date.now() / 1000 + (mode === "stale" ? -60 : 60),
      windowDurationMins: 300,
    },
    secondary: null,
    credits:
      mode === "unknown-credits"
        ? null
        : {
            hasCredits: mode === "prepaid",
            unlimited: false,
            balance: mode === "prepaid" ? "1" : "0",
          },
    spendControlReached: false,
    rateLimitReachedType: null,
  },
};

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

const notify = (method, params) => send({ method, params });

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);

  if (!method) continue;
  appendFileSync(trace, method + "\n");
  const respond = (result) => send({ id, result });

  switch (method) {
    case "initialize":
      respond({});
      break;
    case "initialized":
      break;
    case "config/read":
      respond({
        config: {
          model_provider: overrides.get("model_provider"),
          forced_login_method: overrides.get("forced_login_method"),
          cli_auth_credentials_store: overrides.get(
            "cli_auth_credentials_store",
          ),
          chatgpt_base_url: overrides.get("chatgpt_base_url"),
          openai_base_url:
            mode === "endpoint" ? "https://custom.invalid" : null,
          service_tier: overrides.get("service_tier"),
          project_doc_max_bytes: overrides.get("project_doc_max_bytes"),
          mcp_servers: mode === "mcp" ? { fixture: { enabled: true } } : {},
          features: Object.fromEntries(
            [...overrides]
              .filter(([key]) => key.startsWith("features."))
              .map(([key, value]) => [key.slice(9), value]),
          ),
          memories: {
            use_memories: overrides.get("memories.use_memories"),
            generate_memories: overrides.get("memories.generate_memories"),
          },
        },
      });
      break;
    case "account/read":
      assert.equal(params.refreshToken, false);
      respond({
        account: mode === "signed-out" ? null : account,
        requiresOpenaiAuth: true,
      });
      break;
    case "thread/start":
      assert.equal(params.ephemeral, true);
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.sandbox, "read-only");
      assert.deepEqual(params.environments, []);
      assert.match(params.baseInstructions, /untrusted conversation data/u);
      assert.doesNotMatch(params.baseInstructions, /Synthetic user text/u);
      respond({
        thread: { id: threadId },
        model: params.model,
        modelProvider: params.modelProvider,
        instructionSources:
          mode === "instructions" ? ["/fixture/AGENTS.md"] : [],
      });
      break;
    case "account/rateLimits/read":
      if (mode === "changed-account") notify("account/updated", {});
      respond(quota);
      break;
    case "turn/start":
      assert.deepEqual(params.environments, []);
      assert.equal(params.threadId, threadId);
      assert.match(params.input[0].text, /Synthetic user text/u);
      assert.ok(params.outputSchema.required.includes("archiveReadiness"));
      assert.ok(params.outputSchema.required.includes("suggestion"));
      respond({ turn: { id: turnId } });

      if (mode === "wait") break;

      if (mode === "exit") process.exit(0);

      if (mode === "tool") {
        notify("item/started", {
          threadId,
          turnId,
          item: { type: "commandExecution" },
        });
        break;
      }

      if (mode === "server-request") {
        send({
          id: "approval",
          method: "item/commandExecution/requestApproval",
          params: {},
        });
        break;
      }

      notify("item/completed", {
        threadId,
        turnId,
        item: { type: "agentMessage", phase: "commentary", text: "Thinking." },
      });
      notify("item/completed", {
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          phase: "final_answer",
          text: mode === "invalid-output" ? "not-json" : JSON.stringify(output),
        },
      });
      notify("turn/completed", {
        threadId,
        turn: { id: turnId, status: "completed" },
      });
      break;
    default:
      assert.fail("Unexpected Codex request: " + method);
  }
}
