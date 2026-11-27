import { createHash } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import type { z } from "zod";
import { curatedEntries, curatedPackArtifact, loadCuratedFiles } from "./curated-artifacts.ts";
import { catalogReviewInput, catalogSelection, curatedEntrySchema } from "./curated-contract.ts";
import { createCuratedReferences } from "./curated-references.ts";
import { inspectDeclarations } from "./invocation.ts";
import { createPackService } from "./pack-service.ts";

function approvedContext(
  entry: (typeof curatedEntries)[number],
  files: Awaited<ReturnType<typeof loadCuratedFiles>>,
) {
  const skill = files.find((file) => file.path === "SKILL.md");

  if (!skill) throw new Error("The curated skill is missing SKILL.md.");

  const digest = createHash("sha256").update(skill.content).digest("hex");

  if (digest !== entry.useOnceReview?.skillSha256)
    throw new Error("The skill instructions do not match the approved one-time version.");

  const declarations = inspectDeclarations(skill.content, {
    status: "absent",
    path: "agents/openai.yaml",
  });

  if (!declarations.claude.userInvocable.value)
    throw new Error("This skill does not permit direct invocation. Install it instead.");

  const notice = files.find((file) => file.path === entry.notice.path);

  if (!notice || notice.content !== entry.notice.content)
    throw new Error("The skill's license notice does not match its approved source.");

  const context = `${skill.content}\n\n---\nSource: ${entry.sourceUrl}\nLicense notice:\n\n${notice.content}`;

  return { context, digest: createHash("sha256").update(context).digest("hex") };
}

export function createCuratedService(
  api: PluginApi,
  packs = createPackService(api),
  catalog = { entries: curatedEntries, loadFiles: loadCuratedFiles },
) {
  const entries = catalog.entries.map((entry) =>
    curatedEntrySchema.parse({
      id: entry.id,
      name: entry.name,
      publisher: entry.publisher,
      description: entry.description,
      sourceUrl: entry.sourceUrl,
      license: entry.license,
      useOnce: entry.useOnce,
    }),
  );

  const generation = createHash("sha256").update(JSON.stringify(catalog.entries)).digest("hex");
  const references = createCuratedReferences(api.storage.database());

  function select(value: z.infer<typeof catalogSelection>) {
    const input = catalogSelection.parse(value);

    if (input.generation !== generation)
      throw new Error(
        "The skill catalog was updated. Refresh the catalog and select the skill again.",
      );

    const entry = catalog.entries.find((item) => item.id === input.id);

    if (!entry) throw new Error("This skill is no longer in the catalog. Refresh the catalog.");

    return entry;
  }

  return {
    get() {
      return { generation, entries };
    },
    async prepare(value: z.infer<typeof catalogSelection>) {
      const entry = select(value);

      if (!entry.useOnce || !entry.useOnceReview)
        throw new Error("This skill requires installation. Review its files and install it first.");

      const files = await catalog.loadFiles(entry);
      const { context, digest } = approvedContext(entry, files);

      return references.prepare(entry.id, context, digest);
    },
    async review(value: z.infer<typeof catalogReviewInput>) {
      const input = catalogReviewInput.parse(value);
      const entry = select({ id: input.id, generation: input.generation });
      const files = await catalog.loadFiles(entry);

      const artifact = curatedPackArtifact(entry, files);

      const reviewed = await packs.reviewArtifact(
        { projectId: input.projectId, environmentId: input.environmentId },
        artifact,
      );

      return {
        ...reviewed,
        useOnceReference: entry.useOnce
          ? references.lookup(entry.id, approvedContext(entry, files).digest)
          : null,
      };
    },
    confirm: packs.confirm,
    resolve: references.resolve,
  };
}
