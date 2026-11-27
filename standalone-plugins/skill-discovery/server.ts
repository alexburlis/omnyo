import { cliCommand, defineCli, type PluginApi, type PluginCliContext } from "@omnyo/plugin-sdk";
import { buildCatalogue, filterCatalogue } from "./catalogue";
import { libraryCommands } from "./library-cli";
import { type Workspace } from "./library-contract";
import { addPackCollection, exportCollection, getInstalledPackSources } from "./library-packs";
import { libraryRpc } from "./library-rpc";
import { promptCommands } from "./prompt-cli";
import { createPromptService } from "./prompt-service";
import { promptLibraryRpcContract } from "./prompt-contract";
import { createLibraryStore } from "./library-store";
import { createPackService } from "./pack-service";
import { inspectSource, selectSource, usesSkillApi } from "./invocation";
import { curatedCommands } from "./curated-cli";
import { curatedMentionProviderId, curatedRpc } from "./curated-contract";
import { createCuratedService } from "./curated-service";
import { curatedEntries } from "./curated-artifacts";
import { marketplaceRpc } from "./marketplace-contract";
import { matchReviewedSkills, readMarketplace } from "./marketplace-service";

interface WorkspaceOptions {
  project?: string;
  environment?: string;
}

async function resolveWorkspace(api: PluginApi, options: WorkspaceOptions, ctx: PluginCliContext) {
  let projectId = options.project ?? ctx.projectId;
  let environmentId = options.environment ?? null;

  if (projectId === undefined) {
    const projects = await api.sdk.projects.list({ includePersonal: true, signal: ctx.signal });
    projectId = projects.find((project) => project.kind === "personal")?.id;
  }

  if (projectId === undefined) throw new Error("No project available. Pass --project <id>.");

  if (ctx.threadId !== undefined && options.environment === undefined) {
    const thread = await api.sdk.threads.get({ threadId: ctx.threadId, signal: ctx.signal });

    if (thread.projectId === projectId) environmentId = thread.environmentId;
  }

  return { projectId, environmentId };
}

export default function plugin(api: PluginApi): void {
  const library = createLibraryStore(api);
  const prompts = createPromptService(api, library);
  api.rpc.register(promptLibraryRpcContract, prompts);
  const packs = createPackService(api);
  const curated = createCuratedService(api, packs);

  async function marketplace() {
    const catalog = await readMarketplace();

    return { catalog, reviewedSkills: matchReviewedSkills(catalog, curatedEntries) };
  }

  api.rpc.register(marketplaceRpc, { marketplaceGet: marketplace });

  api.ui.registerMentionProvider({
    id: curatedMentionProviderId,
    label: "Curated skills",
    triggers: ["@"],
    search: () => [],
    resolve: curated.resolve,
  });

  api.rpc.register(curatedRpc, {
    catalogGet: curated.get,
    catalogPrepare: curated.prepare,
    catalogReview: curated.review,
    catalogConfirm: curated.confirm,
  });

  async function checkWorkspace(input: Workspace) {
    if (input.environmentId === null) {
      await api.sdk.projects.get({ projectId: input.projectId });
    } else {
      const environment = await api.sdk.environments.get({ environmentId: input.environmentId });

      if (environment.projectId !== input.projectId)
        throw new Error("The environment does not belong to this project.");
    }
  }

  const owner = {
    async get(input: Workspace) {
      await checkWorkspace(input);

      return library.get(input);
    },
    async apply(input: Parameters<typeof library.apply>[0]) {
      await checkWorkspace(input);

      return library.apply(input);
    },
    async exportPack(input: Parameters<typeof exportCollection>[2]) {
      await checkWorkspace(input);

      return exportCollection(api.sdk.skills, library.get(input), input);
    },
    reviewPack: packs.review,
    async confirmPack(input: Parameters<typeof packs.confirm>[0]) {
      const result = await packs.confirm(input);
      const sources = await getInstalledPackSources(api.sdk.skills, result, result.pack);

      const collectionId = library.registerPack(result, result.digest, (current) =>
        addPackCollection(current, result.pack, sources),
      );

      return { ...result, collectionId };
    },
  };

  api.rpc.register(libraryRpc, {
    libraryGet: owner.get,
    libraryApply: owner.apply,
    packExport: owner.exportPack,
    packReview: owner.reviewPack,
    packConfirm: owner.confirmPack,
  });

  api.cli.register(
    defineCli({
      name: "skill-discovery",
      summary: "Browse the installed skill hierarchy with short descriptions and source variants",
      commands: {
        ...promptCommands(prompts),
        ...curatedCommands(curated, (options, context) => resolveWorkspace(api, options, context)),
        ...libraryCommands(api, owner, (options, context) =>
          resolveWorkspace(api, options, context),
        ),
        list: cliCommand({
          summary: "Search installed skills in the current workspace",
          options: {
            query: {
              type: "string",
              default: "",
              description: "Words to match in names and descriptions",
            },
            category: {
              type: "string",
              default: "",
              description: "Category breadcrumb, for example Development > Web",
            },
            provider: {
              type: "string",
              default: "",
              description: "Exact provider ID; shared selects Omnyo/shared skills",
            },
            scope: {
              type: "string",
              default: "",
              description: "Exact discovery scope, for example provider-user",
            },
            project: {
              type: "string",
              description: "Project ID; defaults to the invoking thread/project, then Personal",
            },
            environment: {
              type: "string",
              description:
                "Exact environment ID; defaults to the invoking thread's matching environment",
            },
            limit: {
              type: "integer",
              min: 1,
              max: 200,
              default: 30,
              description: "Maximum returned skill rows (1-200)",
            },
            json: { type: "boolean", description: "Machine-readable catalogue rows" },
          },
          async run(input, ctx) {
            const options = input.options;
            const { projectId, environmentId } = await resolveWorkspace(api, options, ctx);

            const inventory = await api.sdk.skills.list({
              projectId,
              environmentId,
              signal: ctx.signal,
            });

            const catalogue = buildCatalogue(inventory.skills);

            const filtered = filterCatalogue(
              catalogue,
              options.query,
              options.provider,
              options.scope,
            );

            const category = options.category.toLowerCase();

            const matches =
              category === ""
                ? filtered
                : filtered.filter((entry) =>
                    entry.category.join(" > ").toLowerCase().includes(category),
                  );

            const selected = matches.slice(0, options.limit);

            const entries = selected.map((entry) => ({
              name: entry.name,
              label: entry.label,
              summary: entry.summary,
              category: entry.category,
              providers: entry.providers,
              scopes: entry.scopes,
              sources: entry.sources.map((source) => ({
                id: source.id,
                provider: source.provider,
                scope: source.scope,
                filePath: source.filePath,
              })),
            }));

            if (options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  entries,
                  matched: matches.length,
                  total: catalogue.length,
                  sourceCount: inventory.skills.length,
                  projectId,
                  environmentId,
                }),
              };
            }

            const lines = [
              `${matches.length} matches · ${catalogue.length} skill descriptors · ${inventory.skills.length} source variants`,
            ];

            let previousCategory = "";

            for (const entry of entries) {
              const breadcrumb = entry.category.join(" > ");

              if (breadcrumb !== previousCategory) {
                lines.push("", breadcrumb);
                previousCategory = breadcrumb;
              }

              lines.push(`  ${entry.label} [${entry.name}]`, `    ${entry.summary}`);
            }

            if (selected.length < matches.length)
              lines.push(
                "",
                `Showing ${selected.length}; narrow --query or increase --limit (up to 200).`,
              );

            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        inspect: cliCommand({
          summary: "Inspect one exact source's declared invocation controls",
          description: "Declarations do not establish native enablement or actual model inclusion.",
          options: {
            source: {
              type: "string",
              required: true,
              description: "Opaque source ID returned by list --json",
            },
            project: {
              type: "string",
              description: "Project ID; defaults to the invoking thread/project, then Personal",
            },
            environment: {
              type: "string",
              description:
                "Exact environment ID; defaults to the invoking thread's matching environment",
            },
            json: {
              type: "boolean",
              description: "Machine-readable source identity and declarations",
            },
          },
          async run(input, ctx) {
            const { projectId, environmentId } = await resolveWorkspace(api, input.options, ctx);

            const inventory = await api.sdk.skills.list({
              projectId,
              environmentId,
              signal: ctx.signal,
            });

            const source = selectSource(inventory.skills, input.options.source);
            let hostId: string | undefined;
            let localServer = false;

            if (!usesSkillApi(source)) {
              if (environmentId !== null) {
                const environment = await api.sdk.environments.get({
                  environmentId,
                  signal: ctx.signal,
                });

                if (environment.projectId !== projectId)
                  throw new Error("The selected environment does not belong to this project.");

                hostId = environment.hostId;
              } else {
                const project = await api.sdk.projects.get({ projectId, signal: ctx.signal });
                hostId = project.sources.find((item) => item.isDefault)?.hostId;
                localServer = project.kind === "personal";
              }
            }

            const result = await inspectSource(
              api.sdk,
              source,
              { projectId, environmentId, hostId, localServer },
              ctx.signal,
            );

            if (input.options.json)
              return {
                exitCode: 0,
                stdout: JSON.stringify({ ...result, projectId, environmentId }),
              };

            const { claude, codex } = result.declarations;

            return {
              exitCode: 0,
              stdout: [
                `${result.source.name} [${result.source.id}]`,
                `Source: ${result.source.filePath}`,
                `Provider: ${result.source.provider ?? "shared"}; scope: ${result.source.scope}`,
                `Content SHA-256: ${result.source.contentSha256}`,
                `Claude disable-model-invocation: ${claude.disableModelInvocation.value} (${claude.disableModelInvocation.origin})`,
                `Claude user-invocable: ${claude.userInvocable.value} (${claude.userInvocable.origin})`,
                `Codex allow_implicit_invocation: ${codex.allowImplicitInvocation.value ?? "unknown"} (${codex.allowImplicitInvocation.origin}; policy ${codex.policy.status})`,
                "Effective enablement: unknown; model inclusion: unknown; canonical identity: unknown.",
              ].join("\n"),
            };
          },
        }),
      },
    }),
  );
}
