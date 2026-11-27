import type { Card, CardChange } from "../contract.ts";

export function compareCards(before: Card, after: Card): CardChange[] {
  const changes: CardChange[] = [];
  const value = (entry: string | undefined) => entry ?? null;

  const add = (field: string, label: string, previous: string | null, current: string | null) => {
    if (previous !== current) changes.push({ field, label, before: previous, after: current });
  };

  add("goal", "Goal", value(before.goal), value(after.goal));
  add("headline", "Now", before.headline, after.headline);
  add(
    "sidebarSummary",
    "Sidebar outcome",
    value(before.sidebarSummary),
    value(after.sidebarSummary),
  );
  add("status", "Status", before.status, after.status);
  add("phase", "Phase", before.phase, after.phase);
  add("blocker", "Blocker", value(before.blocker), value(after.blocker));
  add("next", "Next", value(before.next), value(after.next));

  const previousFacts = new Map(before.facts.map((fact) => [fact.label, fact.value]));
  const currentFacts = new Map(after.facts.map((fact) => [fact.label, fact.value]));

  for (const label of new Set([...previousFacts.keys(), ...currentFacts.keys()]))
    add("facts", label, previousFacts.get(label) ?? null, currentFacts.get(label) ?? null);

  const previousDeliverables = new Map(
    before.deliverables.map((entry) => [entry.title, entry.href]),
  );

  const currentDeliverables = new Map(after.deliverables.map((entry) => [entry.title, entry.href]));

  for (const title of new Set([...previousDeliverables.keys(), ...currentDeliverables.keys()]))
    add(
      "deliverables",
      title,
      previousDeliverables.get(title) ?? null,
      currentDeliverables.get(title) ?? null,
    );

  const previousProof = new Set(before.proof.map((entry) => entry.claim));
  const currentProof = new Set(after.proof.map((entry) => entry.claim));

  for (const claim of new Set([...previousProof, ...currentProof]))
    add(
      "proof",
      claim,
      previousProof.has(claim) ? claim : null,
      currentProof.has(claim) ? claim : null,
    );

  return changes;
}
