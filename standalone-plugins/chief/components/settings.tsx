import { useCallback, useState, type ReactNode } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_usePluginId,
  useRpc,
  useSdk,
  useSettings,
} from "@omnyo/plugin-sdk/app";
import { CHIEF_PLUGIN_ID, type rpcContract } from "../lib/contract.ts";
import { NO_AGENT_TEXT, PROVIDERS_HREF, plural } from "./chief-logic.ts";
import { Button } from "./ui/button.tsx";
import { useChiefChanged } from "./use-chief-changed.ts";
import { errorText, useLoaded } from "./use-loaded.ts";

const DEFAULT_AGENT = "Personal project's default";

const RULES_HREF = `/plugins/${CHIEF_PLUGIN_ID}/home/rules`;

const REASONING = "medium";

type AgentKeys =
  | { provider: "chiefProvider"; model: "chiefModel" }
  | {
      provider: "judgeProvider";
      model: "judgeModel";
    };

const TALK_KEYS: AgentKeys = { provider: "chiefProvider", model: "chiefModel" };

const SUGGEST_KEYS: AgentKeys = { provider: "judgeProvider", model: "judgeModel" };

function Row({ name, detail, children }: { name: string; detail: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function settingText(values: Record<string, string | number | boolean> | undefined, key: string) {
  const value = values?.[key];

  return value === undefined ? "" : String(value);
}

function AgentRow({ name, keys }: { name: string; keys: AgentKeys }) {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const { values } = useSettings();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = settingText(values, keys.provider);
  const model = settingText(values, keys.model);

  const write = (nextProvider: string, nextModel: string) => {
    setError(null);
    sdk.plugins
      .updateSettings({
        pluginId,
        values: { [keys.provider]: nextProvider, [keys.model]: nextModel },
      })
      .then(
        () => setEditing(false),
        (failure: Error) => setError(errorText(failure)),
      );
  };

  const detail =
    error ?? (provider === "" ? DEFAULT_AGENT : model === "" ? provider : `${provider} · ${model}`);

  return (
    <Row name={name} detail={detail}>
      {editing ? (
        <ProviderModelPicker
          align="end"
          value={{ providerId: provider, model, reasoningLevel: REASONING }}
          onChange={(next) => write(next.providerId, next.model)}
        />
      ) : (
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          Change
        </Button>
      )}
      {provider === "" ? null : (
        <Button variant="ghost" size="sm" onClick={() => write("", "")}>
          Use default
        </Button>
      )}
    </Row>
  );
}

export function ChiefSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const loadDeck = useCallback(() => rpc.call("deck"), [rpc]);
  const loadRules = useCallback(() => rpc.call("rules.list"), [rpc]);
  const deck = useLoaded(loadDeck, null);
  const rules = useLoaded(loadRules, null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { refresh: refreshDeck } = deck;
  const { refresh: refreshRules } = rules;

  const refreshAll = useCallback(() => {
    refreshDeck();
    refreshRules();
  }, [refreshDeck, refreshRules]);

  useChiefChanged(refreshAll);

  const run = <T,>(call: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    call()
      .then(refreshAll, (failure: Error) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };

  const view = deck.value;

  if (view === null)
    return deck.error === null ? null : (
      <div role="alert" className="flex items-center gap-3 text-sm">
        <span>Couldn&apos;t load the Chief.</span>
        <Button variant="outline" size="sm" onClick={refreshAll}>
          Try again
        </Button>
      </div>
    );

  const on = view.suggestions === "on";
  const ruleCount = rules.value?.rules.filter((rule) => rule.state === "adopted").length ?? null;

  return (
    <div className="flex flex-col">
      <Row
        name="Answer suggestions"
        detail={
          <>
            {on ? "On" : "Off"} · Uses your {view.agent.label ?? "coding agent"} account to suggest
            answers across all projects.
            <br />
            {view.agent.ready ? (
              "Turning this off also stops the Chief answering for you."
            ) : (
              <>
                {NO_AGENT_TEXT}{" "}
                <a href={PROVIDERS_HREF} className="text-foreground underline underline-offset-2">
                  Connect an agent
                </a>
              </>
            )}
          </>
        }
      >
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => run(() => rpc.call("suggestions.set", { value: on ? "off" : "on" }))}
        >
          {on ? "Turn off" : "Turn on"}
        </Button>
      </Row>
      <AgentRow name="Agent for Talk" keys={TALK_KEYS} />
      <AgentRow name="Agent for suggestions" keys={SUGGEST_KEYS} />
      {!view.delegation.supported ? (
        <Row name="Answering for you" detail="Answering for you needs a newer Omnyo.">
          {null}
        </Row>
      ) : view.delegation.paused ? (
        <Row name="Answering for you" detail="Paused">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => run(() => rpc.call("resume"))}
          >
            Resume…
          </Button>
        </Row>
      ) : view.canAnswerForMe ? (
        <Row name="Answering for you" detail="On for the rules you made.">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => run(() => rpc.call("pause"))}
          >
            Pause
          </Button>
        </Row>
      ) : (
        <Row name="Answering for you" detail="Only after you make a rule.">
          {null}
        </Row>
      )}
      <Row name="Rules" detail={ruleCount === null ? "…" : plural(ruleCount, "rule", "rules")}>
        <Button asChild variant="outline" size="sm">
          <a href={RULES_HREF}>Open</a>
        </Button>
      </Row>
      {error === null ? null : (
        <p role="alert" className="m-0 pt-2 text-xs text-destructive-text">
          {error}
        </p>
      )}
    </div>
  );
}
