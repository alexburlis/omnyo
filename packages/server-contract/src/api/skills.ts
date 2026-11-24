import { z } from "zod";

export const registrySkillSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  skillId: z.string().min(1),
  name: z.string().min(1),
  installs: z.number().int().nonnegative(),
  stars: z.number().int().nonnegative().nullable(),
  installUrl: z.string().url().nullable(),
  url: z.string().url(),
  topic: z.string().nullable(),
  summary: z.string().nullable(),
});

export type RegistrySkill = z.infer<typeof registrySkillSchema>;

export const registryPaginationSchema = z.object({
  page: z.number().int().nonnegative(),
  perPage: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export type RegistryPagination = z.infer<typeof registryPaginationSchema>;

export const registryRankingSchema = z.enum(["trending", "all-time"]);

export type RegistryRanking = z.infer<typeof registryRankingSchema>;

export const registrySearchCoverageSchema = z.enum([
  "semantic",
  "catalog-names",
  "leaderboard-names",
]);

export const registrySkillsPageSchema = z.object({
  skills: z.array(registrySkillSchema),
  pagination: registryPaginationSchema,
  ranking: registryRankingSchema,
  coverage: registrySearchCoverageSchema.optional(),
});

export type RegistrySkillsPage = z.infer<typeof registrySkillsPageSchema>;

export const registryRepositoryStarsSchema = z.object({
  stars: z.number().int().nonnegative(),
});

export type RegistryRepositoryStars = z.infer<
  typeof registryRepositoryStarsSchema
>;

export const registrySkillFileSchema = z.object({
  path: z.string().min(1),
  contents: z.string(),
});

export type RegistrySkillFile = z.infer<typeof registrySkillFileSchema>;

export const registrySkillDetailSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  skillId: z.string().min(1),
  hash: z.string().nullable(),
  files: z.array(registrySkillFileSchema).nullable(),
});

export type RegistrySkillDetail = z.infer<typeof registrySkillDetailSchema>;

export const REGISTRY_ENTRY_BATCH_LIMIT = 200;

export const registrySkillEntriesRequestSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(REGISTRY_ENTRY_BATCH_LIMIT),
  })
  .strict();

export const registrySkillEntriesResponseSchema = z.object({
  entries: z.array(registrySkillSchema),
});

export type RegistrySkillEntriesResponse = z.infer<
  typeof registrySkillEntriesResponseSchema
>;

export const registrySkillInstallRequestSchema = z
  .object({
    registrySkillId: z.string().min(1),
  })
  .strict();

export const registrySkillDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const registrySkillCommitRequestSchema =
  registrySkillInstallRequestSchema.extend({
    treeDigest: registrySkillDigestSchema,
  });

export const registrySkillInstalledSchema = z.object({
  installed: z.boolean(),
});

export const registrySkillStageFileRequestSchema =
  registrySkillCommitRequestSchema.extend({ path: z.string().min(1) });

export const registrySkillStageSchema = z.object({
  registrySkillId: z.string().min(1),
  source: z.string().min(1),
  skillId: z.string().min(1),
  destination: z.literal("omnyo-user"),
  expiresAt: z.number().int().nonnegative(),
  treeDigest: registrySkillDigestSchema,
  files: z.array(
    z.object({
      path: z.string().min(1),
      size: z.number().int().nonnegative(),
      sha256: registrySkillDigestSchema,
    }),
  ),
  skillMarkdown: z.string(),
  license: z.string().nullable(),
  licenseFiles: z.array(z.string()),
  conflict: z.string().nullable(),
});

export type RegistrySkillStage = z.infer<typeof registrySkillStageSchema>;

export const registrySkillInstallResponseSchema = z.object({
  ok: z.literal(true),
  filePath: z.string().min(1),
  treeDigest: registrySkillDigestSchema.optional(),
});

export type RegistrySkillInstallResponse = z.infer<
  typeof registrySkillInstallResponseSchema
>;
