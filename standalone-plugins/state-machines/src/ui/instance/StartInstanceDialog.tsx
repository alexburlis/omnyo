import { useEffect, useId, useMemo, useState } from "react";

import { errorFromCatch, newRequestId, type SmError, useSmClient } from "../data/client.js";
import type { JsonObject, JsonValue } from "../data/contract.js";
import { useEnvironments, useVersion, useVersions } from "../data/hooks.js";
import { useQueryStore } from "../data/query.js";
import { Button, Dialog, ErrorAlert, Field, Skeleton } from "../primitives.js";
import { useGo } from "../shell.js";

function valueText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";

  if (Array.isArray(value) || value instanceof Object) return JSON.stringify(value);

  return String(value);
}

export function StartInstanceDialog({
  machineId,
  projectId,
  initialVersionId,
  onClose,
}: {
  machineId: string;
  projectId: string | null;
  initialVersionId: string | null;
  onClose(): void;
}) {
  const client = useSmClient();
  const store = useQueryStore();
  const go = useGo();
  const versions = useVersions(machineId);
  const environments = useEnvironments(projectId);
  const latest = [...(versions.data ?? [])].sort((a, b) => b.number - a.number)[0];
  const [versionId, setVersionId] = useState<string | null>(initialVersionId);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [error, setError] = useState<SmError | null>(null);
  const [pending, setPending] = useState(false);
  const [requestId] = useState(newRequestId);
  const versionField = useId();
  const environmentField = useId();
  const chosenVersion = versionId ?? latest?.versionId ?? null;
  const version = useVersion(machineId, chosenVersion);
  const definition = version.data?.definition;

  useEffect(() => {
    if (versionId === null && latest !== undefined) setVersionId(latest.versionId);
  }, [latest, versionId]);

  const properties = useMemo(
    () => Object.entries(definition?.contextSchema.properties ?? {}),
    [definition],
  );

  const externalWrite = (definition?.states ?? []).filter(
    (state) =>
      (state.kind === "agent" || state.kind === "command") && state.effect === "external-write",
  );

  const context = (): JsonObject => {
    const base: JsonObject = { ...definition?.initialContext };

    for (const [key, schema] of properties) {
      const text = overrides[key];

      if (text === undefined) continue;

      if (schema.type === "number" || schema.type === "integer") base[key] = Number(text);
      else if (schema.type === "boolean") base[key] = text === "true";
      else if (schema.type === "string") base[key] = text;
    }

    return base;
  };

  const start = async () => {
    if (chosenVersion === null || environmentId === null) return;

    setPending(true);
    setError(null);

    try {
      const created = await client.call("sm_instance_start", {
        machineId,
        versionId: chosenVersion,
        environmentId,
        context: context(),
        requestId,
      });

      store.refetchMatching("machines:");
      store.refetchMatching(`instances:${machineId}`);
      onClose();
      go({
        screen: "instance",
        machineId,
        instanceId: created.instanceId,
        view: "graph",
        selection: null,
      });
    } catch (caught) {
      setError(errorFromCatch(caught instanceof Error ? caught : null));
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Start instance"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={chosenVersion === null || environmentId === null}
            disabledReason="Choose a version and an environment."
            pending={pending}
            onClick={() => void start()}
          >
            Start
          </Button>
        </>
      }
    >
      {versions.data === undefined ? <Skeleton rows={2} /> : null}
      {versions.error === null ? null : (
        <ErrorAlert error={versions.error} onRetry={versions.refetch} />
      )}
      {versions.data !== undefined ? (
        <Field label="Version" htmlFor={versionField}>
          <select
            id={versionField}
            className="stm-input"
            value={chosenVersion ?? ""}
            onChange={(event) => setVersionId(event.target.value)}
          >
            {[...versions.data]
              .sort((a, b) => b.number - a.number)
              .map((item) => (
                <option key={item.versionId} value={item.versionId}>
                  v{item.number}
                  {item.versionId === latest?.versionId ? " (latest)" : ""}
                </option>
              ))}
          </select>
        </Field>
      ) : null}
      <Field
        label="Environment"
        htmlFor={environmentField}
        hint="Steps without their own environment run here."
        error={error?.code === "ENVIRONMENT_LIFETIME_UNSUPPORTED" ? error.message : null}
      >
        <select
          id={environmentField}
          className="stm-input"
          value={environmentId ?? ""}
          onChange={(event) =>
            setEnvironmentId(event.target.value.length > 0 ? event.target.value : null)
          }
        >
          <option value="">
            {environments.data === undefined ? "Loading environments…" : "Choose an environment"}
          </option>
          {(environments.data ?? []).map((environment) => (
            <option
              key={environment.environmentId}
              value={environment.environmentId}
              disabled={!environment.available}
            >
              {environment.label}
              {environment.available ? "" : " (offline)"}
              {environment.persistent ? "" : " (may be retired)"}
            </option>
          ))}
        </select>
      </Field>
      {properties.length > 0 ? (
        <fieldset className="stm-field">
          <legend className="stm-field-label">Initial context</legend>
          {properties.map(([key, schema]) => (
            <label key={key} className="stm-context-input">
              <span className="stm-mono stm-text-sm">{key}</span>
              <input
                className="stm-input"
                value={overrides[key] ?? valueText(definition?.initialContext[key])}
                onChange={(event) =>
                  setOverrides((current) => ({ ...current, [key]: event.target.value }))
                }
                disabled={schema.type === "object" || schema.type === "array"}
              />
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="stm-text-sm stm-text-muted">
        Starting creates a chat for this run in the machine's project. Step chats nest under it, and
        its decisions open there, so they reach your Inbox.
      </p>
      {externalWrite.length > 0 ? (
        <div className="stm-field">
          <span className="stm-field-label">Authority</span>
          <ul className="stm-list">
            {externalWrite.map((state) => (
              <li key={state.id} className="stm-text-sm">
                {state.title}: will stop and ask. Verifiable approval isn't available yet.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error === null || error.code === "ENVIRONMENT_LIFETIME_UNSUPPORTED" ? null : (
        <ErrorAlert error={error} />
      )}
    </Dialog>
  );
}
