import { createHash } from "node:crypto";
import { type MachineDefinition } from "../contracts/definition.js";
import { canonicalJson } from "./canonical.js";

export const snapshotHash = (definition: MachineDefinition): string =>
  createHash("sha256").update(canonicalJson(definition)).digest("hex");

export function semanticHash(definition: MachineDefinition): string {
  const { layout: _layout, name: _name, description: _description, ...semantic } = definition;

  const states = semantic.states
    .map((state) => {
      const { title: _title, ...rest } = state;

      if (rest.kind === "manual") {
        const { subtitle: _subtitle, prompt: _prompt, decisions, ...manual } = rest;

        return {
          ...manual,
          decisions: decisions.map(
            ({ label: _label, evidencePrompt: _evidencePrompt, ...decision }) => decision,
          ),
        };
      }

      if (rest.kind === "agent" || rest.kind === "command") {
        const { subtitle: _subtitle, annotations: _annotations, ...action } = rest;

        return action;
      }

      if ("subtitle" in rest) {
        const { subtitle: _subtitle, ...other } = rest;

        return other;
      }

      return rest;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return createHash("sha256")
    .update(
      canonicalJson({
        ...semantic,
        states,
        transitions: [...semantic.transitions].sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex");
}
