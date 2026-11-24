import type { Hono } from "hono";
import {
  registrySkillCommitRequestSchema,
  registrySkillEntriesRequestSchema,
  registrySkillStageFileRequestSchema,
  registrySkillInstallRequestSchema,
  type RegistrySkill,
} from "@omnyo/server-contract";
import { ApiError } from "../errors.js";
import {
  githubRepoForSource,
  hasLoadableSkillContent,
  packageRefForSource,
  parsePageParameter,
  parsePerPageParameter,
  parseRegistrySkillId,
  REGISTRY_SKILL_NAME_PATTERN,
  REGISTRY_SOURCE_PATTERN,
  hasUnsafePathSegment,
} from "../services/skills/registry-parse.js";
import {
  createRegistrySearch,
  fetchRegistryRepositoryStars,
  fetchRegistrySkillDetail,
  resolveRegistrySkillById,
} from "../services/skills/registry-proxy.js";
import { createRegistrySkillInstaller } from "../services/skills/registry-skill-install.js";
import type { AppDeps } from "../types.js";

export function registerSkillsRegistryRoutes(app: Hono, deps: AppDeps): void {
  const search = createRegistrySearch();

  const installer = createRegistrySkillInstaller(deps.config.dataDir, () => {
    deps.logger.warn("Could not remove a staged registry skill");
  });

  async function installSource(id: string) {
    const skill = await proxyUpstream(() => resolveRegistrySkillById(id));

    return {
      packageRef: packageRefForSource(skill.source),
      registrySkillId: skill.id,
      skillId: skill.skillId,
    };
  }

  async function proxyUpstream<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      deps.logger.warn("skills.sh registry fetch failed");
      throw new ApiError(
        503,
        "skills_registry_unavailable",
        "skills.sh is unavailable",
      );
    }
  }

  app.get("/skills-registry", async (context) => {
    const query = context.req.query("q") ?? "";
    const page = parsePageParameter(context.req.query("page"));
    const perPage = parsePerPageParameter(context.req.query("perPage"));

    if (query.trim().length > 100) {
      throw new ApiError(
        400,
        "invalid_request",
        "Search must be at most 100 characters",
      );
    }

    return context.json(
      await proxyUpstream(() =>
        search(query, page, perPage, { publicApi: false }),
      ),
    );
  });

  app.post("/skills-registry/search", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);

    if (
      !body ||
      typeof body !== "object" ||
      !("query" in body) ||
      typeof body.query !== "string" ||
      body.query.trim().length === 0 ||
      body.query.trim().length > 100
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Search must be 1 to 100 characters",
      );
    }

    const page = parsePageParameter(context.req.query("page"));
    const perPage = parsePerPageParameter(context.req.query("perPage"));
    const query = body.query;

    return context.json(
      await proxyUpstream(() => search(query, page, perPage)),
    );
  });

  app.get("/skills-registry/entry", async (context) => {
    const id = context.req.query("id");

    if (id === undefined) {
      throw new ApiError(
        400,
        "invalid_request",
        "Expected a registry skill ID",
      );
    }

    return context.json(
      await proxyUpstream(() => resolveRegistrySkillById(id)),
    );
  });

  app.post("/skills-registry/entries", async (context) => {
    const body = registrySkillEntriesRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );

    if (!body.success) {
      throw new ApiError(400, "invalid_request", "Expected registry skill ids");
    }

    const ids = [...new Set(body.data.ids)];

    const entries = (
      await Promise.all(
        ids.map(async (id): Promise<RegistrySkill | null> => {
          try {
            return await resolveRegistrySkillById(id);
          } catch {
            return null;
          }
        }),
      )
    ).filter((entry): entry is RegistrySkill => entry !== null);

    return context.json({ entries });
  });

  app.get("/skills-registry/repository-stars", async (context) => {
    const source = context.req.query("source");

    if (
      source === undefined ||
      source.length === 0 ||
      source.length > 2_048 ||
      !REGISTRY_SOURCE_PATTERN.test(source) ||
      githubRepoForSource(source) === null
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Expected a valid GitHub repository source",
      );
    }

    const stars = await fetchRegistryRepositoryStars(source);

    if (stars === null) {
      throw new ApiError(
        503,
        "registry_repository_stars_unavailable",
        "GitHub repository stars are unavailable",
      );
    }

    return context.json({ stars });
  });

  app.get("/skills-registry/detail", async (context) => {
    const source = context.req.query("source");
    const skillId = context.req.query("skillId");

    if (
      source === undefined ||
      source.length === 0 ||
      source.length > 2_048 ||
      !REGISTRY_SOURCE_PATTERN.test(source) ||
      hasUnsafePathSegment(source) ||
      skillId === undefined ||
      !REGISTRY_SKILL_NAME_PATTERN.test(skillId)
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Expected a valid source and skillId",
      );
    }

    const detail = await proxyUpstream(() =>
      fetchRegistrySkillDetail(source, skillId),
    );

    if (!hasLoadableSkillContent(detail)) {
      throw new ApiError(
        404,
        "registry_skill_unavailable",
        "Registry skill source is unavailable",
      );
    }

    return context.json(detail);
  });

  app.post("/skills-registry/stage", async (context) => {
    const body = registrySkillInstallRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );

    if (!body.success)
      throw new ApiError(400, "invalid_request", "Expected registrySkillId");

    return context.json(
      await installer.stage(await installSource(body.data.registrySkillId)),
    );
  });

  app.post("/skills-registry/stage/file", async (context) => {
    const body = registrySkillStageFileRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );

    if (!body.success)
      throw new ApiError(
        400,
        "invalid_request",
        "Expected a skill ID, digest and file path",
      );

    const { registrySkillId, treeDigest, path } = body.data;

    return context.json(
      await installer.readFile(registrySkillId, treeDigest, path),
    );
  });

  app.post("/skills-registry/stage/discard", async (context) => {
    const body = registrySkillCommitRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );

    if (!body.success)
      throw new ApiError(
        400,
        "invalid_request",
        "Expected a skill ID and digest",
      );

    await installer.discard(body.data.registrySkillId, body.data.treeDigest);

    return context.body(null, 204);
  });

  app.post("/skills-registry/installed", async (context) => {
    const body = registrySkillCommitRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );

    if (!body.success)
      throw new ApiError(
        400,
        "invalid_request",
        "Expected a skill ID and digest",
      );

    const { registrySkillId, treeDigest } = body.data;
    const { skillId } = parseRegistrySkillId(registrySkillId);

    return context.json({
      installed: await installer.isInstalled(
        skillId,
        registrySkillId,
        treeDigest,
      ),
    });
  });

  app.post("/skills-registry/commit", async (context) => {
    const body = registrySkillCommitRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );

    if (!body.success)
      throw new ApiError(
        400,
        "invalid_request",
        "Expected a skill ID and digest",
      );

    const result = await installer.commit(
      await installSource(body.data.registrySkillId),
      body.data.treeDigest,
    );

    return context.json({ ok: true, ...result });
  });

  app.post("/skills-registry/install", async (context) => {
    const body = registrySkillInstallRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );

    if (!body.success)
      throw new ApiError(400, "invalid_request", "Expected registrySkillId");

    const result = await installer.install(
      await installSource(body.data.registrySkillId),
    );

    return context.json({ ok: true, ...result });
  });
}
