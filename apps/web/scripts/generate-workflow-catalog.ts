import { readFile, writeFile } from "node:fs/promises";
import { inspectWorkflowPackage } from "../../../plugins/automations/src/workflow-package.ts";

const source = new URL(
  "../../../plugins/automations/workflow-fixtures/weekly-content-feed.json",
  import.meta.url,
);

const attachment = new URL(
  "../src/workflow-catalog/weekly-content-feed.omnyoworkflow",
  import.meta.url,
);

const metadata = new URL(
  "../src/workflow-catalog/weekly-content-feed.release.json",
  import.meta.url,
);

const args = process.argv.slice(2);

if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error(
    "Usage: pnpm exec tsx apps/web/scripts/generate-workflow-catalog.ts [--check]",
  );
}

const checked = await inspectWorkflowPackage(await readFile(source));

const { flow, trigger } = checked.package;

if (trigger.kind !== "weekly") {
  throw new Error("Weekly Content Feed requires a weekly trigger.");
}

if (flow.kind !== "graph" || flow.engine !== "weekly-content-feed") {
  throw new Error("Weekly Content Feed requires its registered graph engine.");
}

const [hour, minute] = trigger.time.split(":").map(Number);

const release = {
  revision: checked.package.revision,
  sha256: checked.packageDigest,
  candidateBudget: { target: flow.targetCount, limit: flow.maxCandidates },
  schedule: {
    cron: `${minute} ${hour} * * ${trigger.weekday}`,
    tz: trigger.timezone,
  },
  capabilities: checked.capabilities,
  inputs: checked.package.inputs.map(({ id, label, type }) => ({
    id,
    label,
    type,
  })),
};

const metadataBytes = `${JSON.stringify(release, null, 2)}\n`;

if (args[0] === "--check") {
  const [actual, actualMetadata] = await Promise.all([
    readFile(attachment),
    readFile(metadata, "utf8"),
  ]);

  if (
    !actual.equals(Buffer.from(checked.canonicalBytes)) ||
    JSON.stringify(JSON.parse(actualMetadata)) !== JSON.stringify(release)
  ) {
    throw new Error(
      "Weekly Content Feed attachment differs from the validated built-in source. Increment the revision before regenerating a changed release.",
    );
  }
} else {
  await Promise.all([
    writeFile(attachment, checked.canonicalBytes),
    writeFile(metadata, metadataBytes),
  ]);
}

process.stdout.write(
  `${JSON.stringify({
    ...release,
    templateId: checked.package.templateId,
    executionDigest: checked.executionDigest,
    byteLength: checked.canonicalBytes.byteLength,
    trigger: checked.package.trigger,
  })}\n`,
);
