import {
  registrySkillCommitRequestSchema,
  registrySkillDetailSchema,
  registrySkillEntriesRequestSchema,
  registrySkillEntriesResponseSchema,
  registrySkillFileSchema,
  registrySkillInstalledSchema,
  registrySkillInstallRequestSchema,
  registrySkillInstallResponseSchema,
  registryRepositoryStarsSchema,
  registrySkillStageFileRequestSchema,
  registrySkillStageSchema,
  registrySkillSchema,
  registrySkillsPageSchema,
  type DeleteSkillRequest,
  type RegistryRepositoryStars,
  type RegistrySkill,
  type RegistrySkillDetail,
  type RegistrySkillEntriesResponse,
  type RegistrySkillFile,
  type RegistrySkillInstallResponse,
  type RegistrySkillStage,
  type RegistrySkillsPage,
  type SkillContentResponse,
  type SkillFilesResponse,
  type SkillListResponse,
} from "@omnyo/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface SkillWorkspaceArgs {
  projectId: string;
  environmentId: string | null;
}

export interface SkillListArgs extends SkillWorkspaceArgs {
  hostId?: string;
  signal?: AbortSignal;
}

export interface SkillIdentityArgs extends SkillListArgs {
  skillId: string;
}

export interface SkillContentArgs extends SkillIdentityArgs {
  path: string;
}

export interface SkillUpdateArgs extends SkillWorkspaceArgs {
  skillId: string;
  content: string;
  revision: string;
}

export interface SkillDeleteArgs extends SkillWorkspaceArgs {
  skillId: string;
}

export interface AbortableArgs {
  signal?: AbortSignal;
}

export interface RegistrySkillsSearchArgs extends AbortableArgs {
  query?: string;
  page?: number;
  perPage?: number;
}

export interface RegistrySkillIdArgs extends AbortableArgs {
  registrySkillId: string;
}

export interface RegistrySkillEntriesArgs extends AbortableArgs {
  registrySkillIds: readonly string[];
}

export interface RegistrySkillSourceArgs extends AbortableArgs {
  source: string;
  skillId: string;
}

export interface RegistryRepositoryArgs extends AbortableArgs {
  source: string;
}

export interface RegistrySkillInstallArgs {
  registrySkillId: string;
  treeDigest?: string;
}

export interface RegistrySkillReviewArgs extends RegistrySkillIdArgs {
  treeDigest: string;
}

export interface RegistrySkillReviewFileArgs extends RegistrySkillReviewArgs {
  path: string;
}

export interface SkillsRegistryArea {
  commit(args: RegistrySkillReviewArgs): Promise<RegistrySkillInstallResponse>;
  detail(args: RegistrySkillSourceArgs): Promise<RegistrySkillDetail>;
  discardStage(args: RegistrySkillReviewArgs): Promise<void>;
  entries(
    args: RegistrySkillEntriesArgs,
  ): Promise<RegistrySkillEntriesResponse>;
  get(args: RegistrySkillIdArgs): Promise<RegistrySkill>;
  install(
    args: RegistrySkillInstallArgs,
  ): Promise<RegistrySkillInstallResponse>;
  isInstalled(args: RegistrySkillReviewArgs): Promise<boolean>;
  repositoryStars(
    args: RegistryRepositoryArgs,
  ): Promise<RegistryRepositoryStars>;
  search(args?: RegistrySkillsSearchArgs): Promise<RegistrySkillsPage>;
  stage(args: RegistrySkillIdArgs): Promise<RegistrySkillStage>;
  stageFile(args: RegistrySkillReviewFileArgs): Promise<RegistrySkillFile>;
}

export interface SkillsArea {
  getContent(args: SkillContentArgs): Promise<SkillContentResponse>;
  list(args: SkillListArgs): Promise<SkillListResponse>;
  listFiles(args: SkillIdentityArgs): Promise<SkillFilesResponse>;
  registry: SkillsRegistryArea;
  remove(args: SkillDeleteArgs): Promise<{ deletedPath: string }>;
  update(
    args: SkillUpdateArgs,
  ): Promise<{ filePath: string; revision: string }>;
}

export function createSkillsArea(args: CreateSdkAreaArgs): SkillsArea {
  const { transport } = args;

  async function requestParsed<T>(
    path: string,
    schema: { parse(value: unknown): T },
    init?: RequestInit,
  ): Promise<T> {
    const baseUrl = transport.baseUrl.replace(/\/$/u, "");

    const response = await transport.resolve(
      transport.fetch(`${baseUrl}${path}`, init),
    );

    return schema.parse(await response.json());
  }

  function jsonPost(body: unknown, signal?: AbortSignal): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    };
  }

  function reviewedSkillBody({
    registrySkillId,
    treeDigest,
  }: RegistrySkillReviewArgs) {
    return registrySkillCommitRequestSchema.parse({
      registrySkillId,
      treeDigest,
    });
  }

  const registry: SkillsRegistryArea = {
    async commit(input) {
      return requestParsed(
        "/api/v1/skills-registry/commit",
        registrySkillInstallResponseSchema,
        jsonPost(reviewedSkillBody(input), input.signal),
      );
    },
    async discardStage(input) {
      const baseUrl = transport.baseUrl.replace(/\/$/u, "");
      await transport.resolve(
        transport.fetch(
          `${baseUrl}/api/v1/skills-registry/stage/discard`,
          jsonPost(reviewedSkillBody(input), input.signal),
        ),
      );
    },
    async detail(input) {
      const query = new URLSearchParams({
        source: input.source,
        skillId: input.skillId,
      });

      return requestParsed(
        `/api/v1/skills-registry/detail?${query.toString()}`,
        registrySkillDetailSchema,
        { signal: input.signal },
      );
    },
    async entries(input) {
      const body = registrySkillEntriesRequestSchema.parse({
        ids: [...input.registrySkillIds],
      });

      return requestParsed(
        "/api/v1/skills-registry/entries",
        registrySkillEntriesResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: input.signal,
        },
      );
    },
    async get(input) {
      const query = new URLSearchParams({ id: input.registrySkillId });

      return requestParsed(
        `/api/v1/skills-registry/entry?${query.toString()}`,
        registrySkillSchema,
        { signal: input.signal },
      );
    },
    async install(input) {
      if (input.treeDigest !== undefined) {
        return registry.commit({
          registrySkillId: input.registrySkillId,
          treeDigest: input.treeDigest,
        });
      }

      return requestParsed(
        "/api/v1/skills-registry/install",
        registrySkillInstallResponseSchema,
        jsonPost(registrySkillInstallRequestSchema.parse(input)),
      );
    },
    async isInstalled(input) {
      const result = await requestParsed(
        "/api/v1/skills-registry/installed",
        registrySkillInstalledSchema,
        jsonPost(reviewedSkillBody(input), input.signal),
      );

      return result.installed;
    },
    async repositoryStars(input) {
      const query = new URLSearchParams({ source: input.source });

      return requestParsed(
        `/api/v1/skills-registry/repository-stars?${query.toString()}`,
        registryRepositoryStarsSchema,
        { signal: input.signal },
      );
    },
    async search(input = {}) {
      const query = new URLSearchParams({
        page: String(input.page ?? 0),
        perPage: String(input.perPage ?? 24),
      });

      const value = input.query?.trim();

      return value
        ? requestParsed(
            `/api/v1/skills-registry/search?${query.toString()}`,
            registrySkillsPageSchema,
            jsonPost({ query: value }, input.signal),
          )
        : requestParsed(
            `/api/v1/skills-registry?${query.toString()}`,
            registrySkillsPageSchema,
            { signal: input.signal },
          );
    },
    async stage({ registrySkillId, signal }) {
      return requestParsed(
        "/api/v1/skills-registry/stage",
        registrySkillStageSchema,
        jsonPost(
          registrySkillInstallRequestSchema.parse({ registrySkillId }),
          signal,
        ),
      );
    },
    async stageFile({ registrySkillId, treeDigest, path, signal }) {
      return requestParsed(
        "/api/v1/skills-registry/stage/file",
        registrySkillFileSchema,
        jsonPost(
          registrySkillStageFileRequestSchema.parse({
            registrySkillId,
            treeDigest,
            path,
          }),
          signal,
        ),
      );
    },
  };

  return {
    async getContent(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.content.$get(
          {
            param: { id: input.projectId },
            query: {
              skillId: input.skillId,
              path: input.path,
              environmentId: input.environmentId ?? "",
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.$get(
          {
            param: { id: input.projectId },
            query: {
              environmentId: input.environmentId ?? "",
              hostId: input.hostId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async listFiles(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.files.$get(
          {
            param: { id: input.projectId },
            query: {
              skillId: input.skillId,
              environmentId: input.environmentId ?? "",
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    registry,
    async remove(input) {
      const body: DeleteSkillRequest = {
        skillId: input.skillId,
        environmentId: input.environmentId,
      };

      return transport.readJson(
        transport.api.v1.projects[":id"].skills.$delete({
          param: { id: input.projectId },
          json: body,
        }),
      );
    },
    async update(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.content.$patch({
          param: { id: input.projectId },
          json: {
            skillId: input.skillId,
            environmentId: input.environmentId,
            content: input.content,
            revision: input.revision,
          },
        }),
      );
    },
  };
}
