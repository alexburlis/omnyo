import { basename } from "node:path";
import { cliCommand, type PluginApi, type PluginCliContext } from "@omnyo/plugin-sdk";
import {
  applySchema,
  operationSchema,
  packExportInput,
  type Library,
  type LibraryApply,
  type PackExport,
  type Workspace,
} from "./library-contract.ts";
import {
  packConfirmInput,
  packReviewInput,
  type packConfirmResult,
  type packReviewResult,
} from "./pack.ts";
import type { z } from "zod";
import { skillFileSource } from "./markdown-import.ts";

const workspaceOptions = {
  project: { type: "string", description: "Project ID, otherwise use the invoking project" },
  environment: {
    type: "string",
    description: "Exact environment ID, otherwise use the invoking environment",
  },
} as const;

interface Owner {
  get(workspace: Workspace): Promise<Library>;
  apply(input: LibraryApply): Promise<Library>;
  exportPack(input: PackExport): Promise<{ text: string; digest: string }>;
  reviewPack(input: z.infer<typeof packReviewInput>): Promise<z.infer<typeof packReviewResult>>;
  confirmPack(input: z.infer<typeof packConfirmInput>): Promise<z.infer<typeof packConfirmResult>>;
}

export function libraryCommands(
  api: PluginApi,
  owner: Owner,
  workspaceFor: (
    options: { project?: string; environment?: string },
    context: PluginCliContext,
  ) => Promise<Workspace>,
) {
  return {
    library: cliCommand({
      summary: "List workspace collections, links and saved prompts as JSON",
      options: workspaceOptions,
      async run(input, context) {
        const workspace = await workspaceFor(input.options, context);

        return { exitCode: 0, stdout: JSON.stringify(await owner.get(workspace)) };
      },
    }),
    "library-apply": cliCommand({
      summary: "Apply a collection, link or prompt operation at its current revision",
      options: {
        ...workspaceOptions,
        revision: {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          required: true,
          description: "Revision returned by library",
        },
        operation: { type: "string", required: true, description: "Library operation as JSON" },
      },
      async run(input, context) {
        const workspace = await workspaceFor(input.options, context);

        const value = applySchema.parse({
          ...workspace,
          revision: input.options.revision,
          operation: operationSchema.parse(JSON.parse(input.options.operation)),
        });

        return { exitCode: 0, stdout: JSON.stringify(await owner.apply(value)) };
      },
    }),
    "pack-export": cliCommand({
      summary: "Export a collection and its chosen skill and prompt content to stdout",
      options: {
        ...workspaceOptions,
        collection: { type: "string", required: true, description: "Collection ID" },
        publisher: { type: "string", required: true, description: "Lowercase publisher slug" },
        marketplace: {
          type: "boolean",
          description: "Review a Marketplace skill listing by slug and digest",
        },
        slug: { type: "string", required: true, description: "Lowercase pack slug" },
        version: {
          type: "string",
          required: true,
          description: "Semantic version, for example 1.0.0",
        },
        license: { type: "string", required: true, description: "Pack license" },
      },
      async run(input, context) {
        const workspace = await workspaceFor(input.options, context);
        const { collection, publisher, slug, version, license } = input.options;

        const pack = await owner.exportPack(
          packExportInput.parse({
            ...workspace,
            collectionId: collection,
            publisher,
            slug,
            version,
            license,
          }),
        );

        return { exitCode: 0, stdout: pack.text };
      },
    }),
    "pack-review": cliCommand({
      summary: "Review a Markdown file, skill pack, or pinned marketplace release",
      options: {
        ...workspaceOptions,
        file: {
          type: "string",
          description: "Absolute Markdown or pack path on the selected file host",
        },
        "file-host": {
          type: "string",
          description: "Host ID holding the file; defaults to the coordinator",
        },
        marketplace: {
          type: "boolean",
          description: "Review a Marketplace skill listing by slug and digest",
        },
        slug: { type: "string", description: "Published Omnyo pack slug" },
        digest: { type: "string", description: "Published release SHA-256" },
      },
      async run(input, context) {
        const workspace = await workspaceFor(input.options, context);
        const { file, slug, digest } = input.options;
        const fileHost = input.options["file-host"];

        if (
          (file && (slug || digest || input.options.marketplace)) ||
          (!file && (!slug || !digest || fileHost))
        )
          throw new Error("Provide either --file or both --slug and --digest.");

        if (file) {
          const result = await api.sdk.files.read({
            path: file,
            hostId: fileHost,
            signal: context.signal,
          });

          if (result.contentEncoding !== "utf8")
            throw new Error("Expected a UTF-8 Markdown or skill pack file.");

          const review = await owner.reviewPack(
            packReviewInput.parse({
              ...workspace,
              source: /\.md$/iu.test(file)
                ? skillFileSource(basename(file.replaceAll("\\", "/")), result.content)
                : { kind: "local", text: result.content },
            }),
          );

          return { exitCode: 0, stdout: JSON.stringify(review) };
        }

        const review = await owner.reviewPack(
          packReviewInput.parse({
            ...workspace,
            source: { kind: input.options.marketplace ? "marketplace" : "published", slug, digest },
          }),
        );

        return { exitCode: 0, stdout: JSON.stringify(review) };
      },
    }),
    "pack-confirm": cliCommand({
      summary: "Install the exact reviewed skill pack into its confirmed workspace",
      options: {
        review: {
          type: "string",
          required: true,
          description: "Review ID returned by pack-review",
        },
        digest: { type: "string", required: true, description: "SHA-256 returned by pack-review" },
        yes: { type: "boolean", description: "Confirm the reviewed changes" },
      },
      async run(input) {
        if (!input.options.yes)
          throw new Error("Review the destination and files, then pass --yes to install.");

        const result = await owner.confirmPack(
          packConfirmInput.parse({
            reviewId: input.options.review,
            digest: input.options.digest,
          }),
        );

        return { exitCode: 0, stdout: JSON.stringify(result) };
      },
    }),
  };
}
