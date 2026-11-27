import { useId, type ComponentType } from "react";
import type { ModelDefaults, ModelRole, ModelSelection } from "../../contract";
import { operationKey } from "./operations";
import "./style.css";

export type ModelPickerComponent = ComponentType<{
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
  disabled?: boolean;
  align?: "center" | "end" | "start";
}>;

const roles: Array<{ role: ModelRole; label: string; hint: string }> = [
  { role: "solver", label: "Solve", hint: "Single issues and automatic solves" },
  { role: "coordinator", label: "Solve all", hint: "Project investigations and their batches" },
  { role: "reviewer", label: "Review", hint: "Independent check before a fix is submitted" },
];

export function modelLabel(selection: ModelSelection) {
  return selection.model + " · " + selection.reasoningLevel;
}

export function ModelDefaultsBar({
  models,
  Picker,
  pending,
  onSave,
}: {
  models: ModelDefaults;
  Picker: ModelPickerComponent;
  pending: (key: string) => boolean;
  onSave: (role: ModelRole, selection: ModelSelection) => void;
}) {
  const labelPrefix = useId();

  return (
    <section className="sentry-models" aria-label="Default models">
      {roles.map(({ role, label, hint }) => {
        const labelId = labelPrefix + role;
        const saving = pending(operationKey.model(role));

        return (
          <div
            className="sentry-model"
            key={role}
            role="group"
            aria-labelledby={labelId}
            aria-description={hint}
          >
            <span className="sentry-eyebrow" id={labelId} title={hint}>
              {label}
            </span>
            <Picker
              value={models[role]}
              disabled={saving}
              onChange={(selection) => {
                const previous = models[role];

                if (
                  !saving &&
                  selection.providerId &&
                  selection.model &&
                  (selection.providerId !== previous.providerId ||
                    selection.model !== previous.model ||
                    selection.reasoningLevel !== previous.reasoningLevel ||
                    selection.serviceTier !== previous.serviceTier)
                )
                  onSave(role, selection);
              }}
            />
            <span className={saving ? "sentry-model-status" : "sentry-sr-only"} role="status">
              {saving ? "Saving…" : ""}
            </span>
          </div>
        );
      })}
    </section>
  );
}
