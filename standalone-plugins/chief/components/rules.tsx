import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import { toast } from "sonner";
import type { DeckView, RuleView, rpcContract } from "../lib/contract.ts";
import { levelLine, ruleLowerings, ruleText, usageText, type RuleLowering } from "./chief-logic.ts";
import { Button } from "./ui/button.tsx";
import { Menu, MenuItem } from "./ui/menu.tsx";
import { useChiefChanged } from "./use-chief-changed.ts";
import { errorText, useLoaded } from "./use-loaded.ts";

const LOWERING_LABEL: Record<RuleLowering, string> = {
  optional: "Only optional questions",
  ask: "Only suggest",
  retire: "Retire rule",
};

const LOWERING_EFFECT: Record<RuleLowering, string> = {
  optional: "This rule will answer only optional questions.",
  ask: "This rule will guide chats and suggest answers for you to review.",
  retire: "This rule will stop applying to future questions.",
};

function RuleRow({ rule, onChanged }: { rule: RuleView; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<RuleLowering | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreMenu = useRef(false);
  const lowerings = ruleLowerings(rule);

  useEffect(() => {
    if (choice !== null) cancel.current?.focus();
    else if (restoreMenu.current) {
      restoreMenu.current = false;
      menu.current?.querySelector("button")?.focus();
    }
  }, [choice]);

  const close = () => {
    restoreMenu.current = true;
    setError(null);
    setChoice(null);
  };

  const lower = (change: RuleLowering) => {
    setBusy(true);
    setError(null);
    rpc
      .call("rules.change", { id: rule.id, change })
      .then(
        () => {
          close();
          toast.success(change === "retire" ? "Rule retired." : "Rule updated.");
          onChanged();
        },
        (failure: Error) => setError(errorText(failure)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2.5 border-b border-border py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{ruleText(rule)}</span>
        <span className="text-xs text-muted-foreground">{levelLine(rule)}</span>
        <span className="text-xs text-muted-foreground">{usageText(rule.matches)}</span>
        {error === null ? null : (
          <span role="alert" className="text-xs text-destructive-text">
            {error}
          </span>
        )}
      </div>
      {lowerings.length === 0 ? null : (
        <div ref={menu}>
          <Menu label={`Options for the rule about ${rule.cue}`} restoreFocus={choice === null}>
            {lowerings.map((change) => (
              <MenuItem key={change} disabled={busy} onSelect={() => setChoice(change)}>
                {LOWERING_LABEL[change]}
              </MenuItem>
            ))}
          </Menu>
        </div>
      )}
      {choice === null ? null : (
        <div
          className="col-span-2 flex flex-col gap-2 rounded-md border border-border p-3"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) close();
          }}
        >
          <p className="m-0 text-sm">{LOWERING_EFFECT[choice]}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={cancel} variant="ghost" size="sm" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              variant={choice === "retire" ? "destructive" : "default"}
              size="sm"
              disabled={busy}
              onClick={() => lower(choice)}
            >
              {LOWERING_LABEL[choice]}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function RulesTab({ takeRate }: { takeRate: DeckView["takeRate"] }) {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => rpc.call("rules.list"), [rpc]);
  const { value, error, refresh } = useLoaded(load, null);

  useChiefChanged(refresh);

  const rules =
    value?.rules.filter((rule) => rule.state === "adopted" || rule.state === "retired") ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[600px] flex-col px-4 py-4">
      {error === null || value !== null ? null : (
        <div role="alert" className="flex items-center gap-3 py-8 text-sm">
          <span>Couldn&apos;t load your rules.</span>
          <Button variant="outline" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}
      {value === null ? null : rules.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 py-14 text-center">
          <p className="m-0 text-lead font-semibold">No adopted rules yet</p>
          <p className="m-0 text-sm text-muted-foreground">
            The Chief offers a rule when you answer the same way a few times, or tell it a
            preference in Ask Chief.
          </p>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rules.map((rule) => (
            <RuleRow key={`${rule.id}:${rule.version}`} rule={rule} onChanged={refresh} />
          ))}
        </ul>
      )}
      {takeRate === null || takeRate.of === 0 ? null : (
        <p className="m-0 pt-4 text-xs text-muted-foreground">
          You used the Chief&apos;s suggestion {takeRate.used} of your last {takeRate.of} times.
        </p>
      )}
    </div>
  );
}
