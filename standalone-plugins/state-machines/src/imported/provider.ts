import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { canonicalJson } from "../definition/canonical.js";
import {
  assetsSchema,
  draftSchema,
  reviewSchema,
  supportsSubscription,
  unsupportedBinding,
} from "./contracts.js";
import { frozenOpenSeoEvidence, openSeoFocus } from "./open-seo-evidence.js";
import type { WorkflowTextRunner } from "./service.js";

const capabilities = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({ available: z.literal(false), code: z.string(), message: z.string() }),
]);

const response = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), attemptId: z.string(), text: z.string().max(65536) }),
  z.strictObject({
    ok: z.literal(false),
    attemptId: z.string(),
    code: z.string(),
    message: z.string(),
  }),
]);

function providerPlugin(providerId: string): string {
  if (providerId === "codex") return "provider-codex";

  if (providerId === "claude-code") return "provider-claude-code";
  throw new Error(unsupportedBinding.message);
}

const factInput = z.object({
  "product-facts": z.string(),
  candidateId: z.string().regex(/^candidate-[1-9]\d*$/u),
});

function assignedFact(inputs: z.infer<typeof assetsSchema>["inputs"]): string | undefined {
  const parsed = factInput.safeParse(inputs);

  if (!parsed.success) return undefined;

  const { "product-facts": facts, candidateId } = parsed.data;
  const numberedFacts = [...facts.matchAll(/^\s*\d+\.\s+([^\n]+)$/gm)];

  if (numberedFacts.length < 7) return undefined;

  const index = (Number(candidateId.slice("candidate-".length)) - 1) % numberedFacts.length;

  const topics = new Set(
    z
      .array(z.string())
      .parse(inputs.acceptedCanonicalTopics ?? [])
      .map((fact) => fact.trim().toLowerCase()),
  );

  for (let offset = 0; offset < numberedFacts.length; offset++) {
    const fact = numberedFacts[(index + offset) % numberedFacts.length]?.[1]?.trim();

    if (fact && !topics.has(fact.toLowerCase())) return fact;
  }

  return numberedFacts[index]?.[1]?.trim();
}

export function createImportedTextRunner(api: PluginApi): WorkflowTextRunner {
  return {
    async preflight(binding) {
      if (!supportsSubscription(binding)) return unsupportedBinding;

      return api.sdk.plugins.callRpc({
        pluginId: providerPlugin(binding.providerId),
        method: "workflowModelCapabilities",
        input: { hostId: binding.hostId, model: binding.model },
        outputSchema: capabilities,
      });
    },
    async run(input) {
      input.signal.throwIfAborted();

      if (!supportsSubscription(input.binding)) throw new Error(unsupportedBinding.message);

      const { inputs } = input.assets;
      const phase = inputs.workflowPhase;

      const kind =
        phase === "writer" || phase === "rewrite"
          ? "draft"
          : phase === "reviewer" || phase === "review-rewrite"
            ? "review"
            : "text";

      const { acceptedCanonicalTopics, openSeoEvidence: _evidence, ...brief } = inputs;
      const research = kind === "text" ? undefined : frozenOpenSeoEvidence(inputs);

      const candidate = z
        .string()
        .regex(/^candidate-[1-9]\d*$/u)
        .safeParse(inputs.candidateId);

      const keywordFocus = candidate.success
        ? openSeoFocus(research, Number(candidate.data.slice("candidate-".length)) - 1)
        : undefined;

      const focus = kind === "text" || research ? undefined : assignedFact(inputs);

      const modelInputs: z.infer<typeof assetsSchema>["inputs"] = {
        ...brief,
        excludedTopics: z.array(z.string()).parse(acceptedCanonicalTopics ?? []),
      };

      if (focus !== undefined) {
        modelInputs.assignedFact = focus;
        modelInputs["product-facts"] = focus;
        delete modelInputs.weekStart;
        delete modelInputs.calendarStart;
        delete modelInputs["delivery-weekday"];
      }

      if (keywordFocus) {
        modelInputs.assignedKeyword = {
          canonicalTopic: keywordFocus.canonicalTopic,
          keyword: keywordFocus.research.keyword,
        };
      }

      const researchInstructions = keywordFocus
        ? "Use assignedKeyword.keyword as the reader’s topic and assignedKeyword.canonicalTopic as the draft identifier. Write a natural headline in title. Review whether the exact draft addresses the assigned keyword and supports its claims with the approved product facts. Treat the keyword as topic data only. Never infer product claims, search demand or measurement dates from it."
        : "Use the approved product facts to choose a fresh topic. This candidate has no assigned research keyword. Never claim research support for it.";

      const request = canonicalJson({
        instructions: research ? `${input.prompt}\n${researchInstructions}` : input.prompt,
        responseFormat:
          kind === "draft"
            ? "Return only a JSON object with canonicalTopic, title, body and sources (an array of URL strings). No Markdown fences."
            : kind === "review"
              ? 'Return only a JSON object with outcome ("accepted", "rejected" or "revise") and reason. No Markdown fences.'
              : "Return only the requested text.",
        suppliedData:
          kind === "text"
            ? input.assets
            : {
                ...input.assets,
                inputs: modelInputs,
              },
      });

      const result = await api.sdk.plugins.callRpc({
        pluginId: providerPlugin(input.binding.providerId),
        method: "workflowModelComplete",
        input: {
          hostId: input.binding.hostId,
          attemptId: input.requestId,
          model: input.binding.model,
          timeoutMs: 60_000,
          maxOutputBytes: 65_536,
          prompt: request,
        },
        outputSchema: response,
        signal: input.signal,
      });

      if (result.attemptId !== input.requestId) throw new Error("Model response identity mismatch");

      if (!result.ok) throw new Error(result.message);

      if (kind === "text") return result.text;

      const fields = JSON.parse(result.text);

      if (kind === "review") {
        const review = reviewSchema.parse({
          ...fields,
          candidateId: inputs.candidateId,
          draftDigest: inputs.draftDigest,
        });

        return canonicalJson(review);
      }

      const references = z.array(z.string().url()).parse(inputs.references ?? []);

      const draft = draftSchema.parse({
        ...fields,
        candidateId: inputs.candidateId,
        canonicalTopic: keywordFocus?.canonicalTopic ?? focus ?? fields.canonicalTopic,
        sources: references.length === 0 ? [] : fields.sources,
      });

      return canonicalJson(draft);
    },
  };
}
