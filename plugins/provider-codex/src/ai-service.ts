import type { PluginApi, PluginAiServiceStatus } from "@omnyo/plugin-sdk";
import {
  codexAiHostContract,
  type CodexAiFailureCode,
  type CodexAiTextResult,
} from "./ai/host-contract.js";

const CODEX_TEXT_MODELS = ["gpt-6-luna", "gpt-5.6-luna"] as const;

const COMPLETE_TIMEOUT_MS = 5_000;

const HOST_CALL_GRACE_MS = 1_000;

const RETRY_WITH_NEXT_MODEL: ReadonlySet<CodexAiFailureCode> = new Set([
  "rate_limited",
  "service_unavailable",
  "invalid_response",
]);

export function registerCodexAiService(api: PluginApi): void {
  const host = api.hosts.experimental_client({ contract: codexAiHostContract });

  async function primaryHostId(): Promise<string | null> {
    return (await api.sdk.system.config()).primaryHostId;
  }

  async function requirePrimaryHostId(): Promise<string> {
    const hostId = await primaryHostId();

    if (hostId === null) {
      throw new Error("No primary machine is connected");
    }

    return hostId;
  }

  function textOrThrow(result: CodexAiTextResult): string {
    if (result.ok) return result.text;
    throw new Error(result.message);
  }

  api.experimental_aiServices.register({
    id: "codex",
    displayName: "Codex",
    async complete(prompt, { signal }) {
      const hostId = await requirePrimaryHostId();
      let last: CodexAiTextResult | null = null;

      for (const model of CODEX_TEXT_MODELS) {
        last = await host.call(
          "codex.ai.complete",
          { model, prompt, timeoutMs: COMPLETE_TIMEOUT_MS },
          {
            hostId,
            signal,
            timeoutMs: COMPLETE_TIMEOUT_MS + HOST_CALL_GRACE_MS,
          },
        );

        if (last.ok || !RETRY_WITH_NEXT_MODEL.has(last.code)) break;

        if (signal.aborted) break;
      }

      if (last === null) throw new Error("Codex did not answer");

      return textOrThrow(last);
    },
    async status(): Promise<PluginAiServiceStatus> {
      const hostId = await primaryHostId();

      if (hostId === null) {
        return { ready: false, message: "No primary machine is connected" };
      }

      return host.call("codex.ai.status", {}, { hostId, timeoutMs: 5_000 });
    },
  });
}
