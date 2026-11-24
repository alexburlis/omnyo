import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const repoRoot = resolve(serverRoot, "../..");

const mutations = {
  "event-polls-proposed": {
    rule: "the poller checks keys of waits that are not live",
    file: "apps/server/src/services/inbox/event-source-runner.ts",
    find: '        eq(threadWaits.status, "live"),',
    replace: "        eq(threadWaits.id, threadWaits.id),",
  },
  "event-lost-wake": {
    rule: "a fired key never meets its waits",
    file: "apps/server/src/services/inbox/event-source-runner.ts",
    find: "    await reportEvent(deps, {",
    replace: "    if (false) await reportEvent(deps, {",
  },
  "event-early-stall": {
    rule: "a failing source stalls its waits after one failure",
    file: "apps/server/src/services/inbox/event-source-runner.ts",
    find: "    if (state.consecutiveFailures >= STALL_AFTER_FAILURES)\n      raiseStalls(deps, {\n        members,\n        what: (member) => source.describe(member.target),",
    replace:
      "    if (state.consecutiveFailures >= 1)\n      raiseStalls(deps, {\n        members,\n        what: (member) => source.describe(member.target),",
  },
  "event-stall-sticks": {
    rule: "a good check leaves the stall mark",
    file: "apps/server/src/services/inbox/event-source-runner.ts",
    find: "    clearStalls(deps, waiting);",
    replace: "    if (false) clearStalls(deps, waiting);",
  },
  "watch-hides-key": {
    rule: "a watch proposal hides what it would check",
    file: "apps/server/src/services/inbox/waits.ts",
    find: 'Omnyo will check ${args.events.filter(eventKeyNeedsApproval).join(" · ")}',
    replace: "Omnyo will check something",
  },
  "watch-skips-approval": {
    rule: "an agent's wait on an owner-approved key goes live",
    file: "apps/server/src/services/inbox/waits.ts",
    find: '        (kind === "report" || args.events.some(eventKeyNeedsApproval)) &&',
    replace: '        kind === "report" &&',
  },
  "goal-hold": {
    rule: "a goal iteration raises a card before its verdict",
    file: "apps/server/src/services/inbox/engine.ts",
    find: "  if (producer !== undefined) {",
    replace: "  if (producer !== undefined && false) {",
  },
  "unmet-surfaces": {
    rule: "an UNMET verdict ends the goal with a card",
    file: "apps/server/src/services/inbox/engine.ts",
    find: '  if (args.verdict === "unmet")',
    replace: '  if (args.verdict === "unmet" && false)',
  },
  "generation-bump": {
    rule: "a re-arm collides with a newer generation of its key",
    file: "apps/server/src/services/inbox/waits.ts",
    find: "          generation: nextKeyGeneration(tx, wait),",
    replace: "          generation: wait.generation + 1,",
  },
  "pause-gate": {
    rule: "the queue drains during a failure pause",
    file: "apps/server/src/services/threads/queued-messages.ts",
    find: "        paused &&\n",
    replace: "        false &&\n",
  },
  "admit-other": {
    rule: "wakes and tells start turns on a paused chat",
    file: "apps/server/src/services/inbox/engine.ts",
    find: '    case "other":\n      return "pause";',
    replace: '    case "other":\n      return "admit";',
  },
  "drop-receipt": {
    rule: "a turn that consumed owner input ends without a receipt",
    file: "apps/server/src/services/inbox/engine.ts",
    find: "  if (running.length > 0) {",
    replace: "  if (running.length > 0 && false) {",
  },
  "silent-wake": {
    rule: "a satisfied wake ends silently",
    file: "apps/server/src/services/inbox/engine.ts",
    find: "    } else if (mark.rearmed || mark.afterWaitId !== null) {",
    replace: "    } else if (true) {",
  },
  "archive-coverage": {
    rule: "Archive hides undisplayed causes",
    file: "apps/server/src/services/inbox/actions.ts",
    find: "  for (const id of outstanding)\n    if (!displayed.includes(id))",
    replace: "  for (const id of outstanding)\n    if (false)",
  },
  "handle-hidden": {
    rule: "an action handles receipts hidden behind +N",
    file: "apps/server/src/services/inbox/actions.ts",
    find: "  for (const id of displayed) if (!outstanding.has(id)) updated();\n\n  return [...displayed];",
    replace:
      "  for (const id of displayed) if (!outstanding.has(id)) updated();\n\n  return [...outstanding];",
  },
  "agent-cancels-owner": {
    rule: "an agent ends a wait the owner owns",
    file: "apps/server/src/services/inbox/waits.ts",
    find: "      if (agent && ownerOwns(wait)) {",
    replace: "      if (false) {",
  },
  "deadline-drops-delivery": {
    rule: "a deadline drops a delivered result",
    file: "apps/server/src/services/inbox/waits.ts",
    find: "        const met = readinessMet(tx, wait);",
    replace: "        const met = false;",
  },
  "archive-clears-shelf": {
    rule: "Archive takes a chat off the Shelf",
    file: "packages/db/src/data/threads.ts",
    find: ".set({ archivedAt: now, updatedAt: now })",
    replace: ".set({ archivedAt: now, shelvedAt: null, updatedAt: now })",
  },
};

const id = process.argv[2];

const mutation = mutations[id];

if (mutation === undefined) {
  console.error(`usage: node mutate.mjs <${Object.keys(mutations).join("|")}>`);
  process.exit(2);
}

const path = resolve(repoRoot, mutation.file);

const original = readFileSync(path, "utf8");

const count = original.split(mutation.find).length - 1;

if (count !== 1) {
  console.error(
    `${id}: expected one match in ${mutation.file}, found ${count}`,
  );
  process.exit(2);
}

const patched = original.replace(mutation.find, mutation.replace);

writeFileSync(path, patched);

function runVitest(file, settings) {
  for (const [key, value] of Object.entries(settings)) process.env[key] = value;

  return spawnSync("npx", ["vitest", "run", file, "--silent=false"], {
    cwd: serverRoot,
    encoding: "utf8",
    timeout: Number(process.env.INBOX_MUTATION_TIMEOUT_MS ?? 55_000),
  });
}

let property;

let scenarios;

let sources;

try {
  property = runVitest("test/inbox/inbox-property.test.ts", {
    INBOX_PROPERTY_WALKS: process.env.INBOX_PROPERTY_WALKS ?? "24",
    INBOX_PROPERTY_LENGTH: process.env.INBOX_PROPERTY_LENGTH ?? "50",
    INBOX_PROPERTY_SEED: process.env.INBOX_PROPERTY_SEED ?? "100",
  });
  scenarios = runVitest("test/inbox/inbox-scenarios.test.ts", {});
  sources = runVitest("test/inbox/inbox-event-sources.test.ts", {});
} finally {
  writeFileSync(path, original);
}

const propertyOutput = `${property.stdout ?? ""}${property.stderr ?? ""}`;

const codes = [
  ...new Set(
    [...propertyOutput.matchAll(/seed \d+ step \d+ (\w+) /g)].map(
      (match) => match[1],
    ),
  ),
];

const scenarioOutput = [scenarios, sources]
  .map((run) => `${run.stdout ?? ""}${run.stderr ?? ""}`)
  .join("\n");

const failedScenarios = [
  ...new Set(
    [...scenarioOutput.matchAll(/×\s+(.+?)\s+\d+ms/g)].map((match) =>
      match[1].trim(),
    ),
  ),
];

const caught = codes.length > 0 || failedScenarios.length > 0;

console.log(
  JSON.stringify({
    mutation: id,
    rule: mutation.rule,
    caught,
    propertyCodes: codes,
    failedScenarios,
  }),
);

process.exit(caught ? 0 : 1);
