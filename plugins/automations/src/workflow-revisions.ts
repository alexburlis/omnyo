import type { WorkflowPackageV1 } from "./workflow-package.js";

function compareKeys(
  previous: WorkflowPackageV1,
  candidate: WorkflowPackageV1,
): string[] {
  const left = new Map<string, unknown>([
    ["title", previous.title],
    ["description", previous.description],
    ["trigger", previous.trigger],
    ["flow.kind", previous.flow.kind],
    ["layout", previous.layout],
  ]);

  const right = new Map<string, unknown>([
    ["title", candidate.title],
    ["description", candidate.description],
    ["trigger", candidate.trigger],
    ["flow.kind", candidate.flow.kind],
    ["layout", candidate.layout],
  ]);

  for (const [pkg, fields] of [
    [previous, left],
    [candidate, right],
  ] as const) {
    for (const input of pkg.inputs) fields.set(`inputs.${input.id}`, input);

    for (const skill of pkg.skills) fields.set(`skills.${skill.id}`, skill);
    const flow = pkg.flow;

    if (flow.kind === "graph" && flow.engine === "restricted") {
      fields.set("flow.start", flow.startStepId);

      for (const step of flow.steps) fields.set(`flow.steps.${step.id}`, step);
    } else {
      fields.set("flow.settings", flow);
    }
  }

  return Array.from(new Set([...left.keys(), ...right.keys()])).filter(
    (key) => JSON.stringify(left.get(key)) !== JSON.stringify(right.get(key)),
  );
}

export function compareWorkflowRevision(
  base: WorkflowPackageV1,
  local: WorkflowPackageV1,
  candidate: WorkflowPackageV1,
) {
  const incoming = compareKeys(base, candidate);
  const modified = compareKeys(base, local);
  const conflicts = incoming.filter((key) => modified.includes(key));

  return {
    incoming,
    modified,
    conflicts,
    applyInPlace:
      modified.length === 0 || compareKeys(local, candidate).length === 0,
  };
}
