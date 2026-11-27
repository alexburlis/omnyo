import { useEffect, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRpc,
  type ExperimentalProviderModelPickerValue,
} from "@omnyo/plugin-sdk/app";
import { planRpcContract, type PlanDefaults } from "./plan-contract";
import { Button } from "./components/ui/button";

export function PlanSettings() {
  const rpc = useRpc<typeof planRpcContract>();
  const [config, setConfig] = useState<PlanDefaults | null>(null);

  const [selection, setSelection] = useState<ExperimentalProviderModelPickerValue>({
    providerId: "",
    model: "",
    reasoningLevel: "ultra",
    serviceTier: "default",
  });

  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "message"; text: string }
  >({ kind: "idle" });

  useEffect(() => {
    let active = true;

    void rpc
      .call("pursue_plan_defaults", null)
      .then((value) => {
        if (!active) return;
        setConfig(value);

        if (value.kind === "fixed") setSelection(value.selection);
      })
      .catch(() => {
        if (active) setStatus({ kind: "message", text: "Could not load plan execution defaults." });
      });

    return () => {
      active = false;
    };
  }, [rpc]);

  if (config === null)
    return (
      <p role="status">
        {status.kind === "message" ? status.text : "Loading plan execution defaults…"}
      </p>
    );

  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setStatus({ kind: "saving" });

        try {
          const value = config.kind === "fixed" ? { kind: "fixed" as const, selection } : config;
          setConfig(await rpc.call("pursue_plan_save_defaults", value));
          setStatus({ kind: "message", text: "Plan execution defaults saved." });
        } catch {
          setStatus({
            kind: "message",
            text: "Could not save defaults. Choose an available model and try again.",
          });
        }
      }}
    >
      <p className="text-sm text-muted-foreground">
        Execute opens a dedicated run in the plan’s workspace.
      </p>
      <label className="flex flex-col gap-2 text-sm">
        Default execution model
        <select
          aria-label="Default execution model"
          className="rounded-md border border-input bg-background p-2"
          value={config.kind}
          disabled={status.kind === "saving"}
          onChange={(event) =>
            setConfig(
              event.target.value === "fixed"
                ? { kind: "fixed", selection }
                : { kind: "current-chat-ultra" },
            )
          }
        >
          <option value="current-chat-ultra">Current chat model · Ultra when supported</option>
          <option value="fixed">Choose a default model</option>
        </select>
      </label>
      {config.kind === "fixed" ? (
        <ProviderModelPicker
          value={selection}
          onChange={setSelection}
          disabled={status.kind === "saving"}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          Uses the highest supported reasoning level when Ultra is unavailable, at standard speed.
        </p>
      )}
      <Button
        type="submit"
        disabled={
          status.kind === "saving" ||
          (config.kind === "fixed" && (!selection.providerId || !selection.model))
        }
      >
        {status.kind === "saving" ? "Saving…" : "Save plan defaults"}
      </Button>
      {status.kind === "message" ? (
        <p role="status" className="text-sm">
          {status.text}
        </p>
      ) : null}
    </form>
  );
}
