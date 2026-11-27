import {
  experimental_PermissionModePicker as PermissionModePicker,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useProviders as useProviders,
  type ExperimentalProviderModelPickerRouting,
} from "@omnyo/plugin-sdk/app";
import { useEffect, useState } from "react";

import type { Execution, PermissionMode } from "../data/contract.js";
import { Button } from "../primitives.js";

export function routingFor(
  environmentId: string | null,
): ExperimentalProviderModelPickerRouting | undefined {
  return environmentId === null ? undefined : { kind: "environment", environmentId };
}

export function ModelField({
  value,
  environmentId,
  disabled,
  error,
  onCommit,
}: {
  value: Execution | null;
  environmentId: string | null;
  disabled: boolean;
  error: string | null;
  onCommit(value: Execution): void;
}) {
  const [candidate, setCandidate] = useState<Execution | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const providers = useProviders();
  const routing = routingFor(environmentId);

  const begin = () => {
    setSeedError(null);

    const provider = providers.providers.find((item) => item.available);

    if (provider === undefined) {
      setSeedError(
        providers.status === "loading"
          ? "Loading providers…"
          : "No available provider on this machine.",
      );

      return;
    }

    setCandidate({ providerId: provider.id, model: "", reasoningLevel: "" });
  };

  useEffect(() => {
    if (value !== null) setCandidate(null);
  }, [value]);

  if (value !== null && candidate === null)
    return (
      <div className="stm-field">
        <span className="stm-field-label">Model</span>
        <ProviderModelPicker
          value={value}
          onChange={onCommit}
          routing={routing}
          disabled={disabled}
        />
      </div>
    );

  if (candidate !== null)
    return (
      <div className="stm-field">
        <span className="stm-field-label">Model</span>
        <ProviderModelPicker
          value={candidate}
          onChange={setCandidate}
          routing={routing}
          disabled={disabled}
        />
        <div className="stm-row stm-row--tight">
          <Button
            variant="primary"
            disabled={candidate.model.length === 0 || disabled}
            onClick={() => onCommit(candidate)}
          >
            Use this model
          </Button>
          <Button variant="ghost" onClick={() => setCandidate(null)}>
            Cancel
          </Button>
        </div>
        <p className="stm-field-hint">No model is chosen until you confirm one.</p>
      </div>
    );

  return (
    <div className={`stm-field${error ? " stm-field--error" : ""}`}>
      <span className="stm-field-label">Model</span>
      <Button disabled={disabled} onClick={begin}>
        Choose a model
      </Button>
      {seedError !== null ? (
        <p className="stm-field-error">{seedError}</p>
      ) : error === null ? null : (
        <p className="stm-field-error">{error}</p>
      )}
    </div>
  );
}

export function PermissionField({
  value,
  providerId,
  environmentId,
  disabled,
  onCommit,
}: {
  value: PermissionMode;
  providerId: string | null;
  environmentId: string | null;
  disabled: boolean;
  onCommit(value: PermissionMode): void;
}) {
  if (providerId === null)
    return (
      <div className="stm-field">
        <span className="stm-field-label">Permission mode</span>
        <p className="stm-field-hint">Choose a model first.</p>
      </div>
    );

  return (
    <div className="stm-field">
      <span className="stm-field-label">Permission mode</span>
      <PermissionModePicker
        providerId={providerId}
        value={value}
        onChange={onCommit}
        routing={routingFor(environmentId)}
        disabled={disabled}
        align="start"
      />
    </div>
  );
}
