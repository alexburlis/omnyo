import { ApiError } from "../../errors.js";
import { createAsyncTtlMemo } from "../lib/async-ttl-memo.js";
import type {
  RegistryPagination,
  RegistryRanking,
  RegistrySkill,
  RegistrySkillDetail,
  RegistrySkillFile,
  RegistrySkillsPage,
} from "@omnyo/server-contract";
import {
  githubRepoForSource,
  hasLoadableSkillContent,
  isApiSkill,
  isRecord,
  parsePublicDetailSkill,
  parsePublicDirectorySkills,
  parsePublicSkillMarkdown,
  parseRegistryDetailFiles,
  parseRegistrySkillId,
  hasUnsafePathSegment,
  REGISTRY_DETAIL_FILE_SIZE_LIMIT,
  REGISTRY_SKILL_NAME_PATTERN,
  registrySkillUrl,
  SKILLS_BASE_URL,
  type SkillsApiPage,
} from "./registry-parse.js";

const MAX_SEARCH_RESULTS = 200;

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;

const DEFAULT_RETRY_AFTER_SECONDS = 30;

const GITHUB_SKILL_PATH_CACHE_TTL_MS = 30 * 60 * 1000;

const GITHUB_REPOSITORY_STARS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const GITHUB_REPOSITORY_STARS_FAILURE_TTL_MS = 5 * 60 * 1000;

const REGISTRY_ENTRY_CACHE_TTL_MS = 30 * 60 * 1000;

const REGISTRY_DETAIL_CACHE_TTL_MS = 30 * 60 * 1000;

const REGISTRY_FETCH_TIMEOUT_MS = 10_000;

const registryDetailCache = new Map<
  string,
  { detail: RegistrySkillDetail; expiresAt: number }
>();

const registryEntryMemo = createAsyncTtlMemo<string, RegistrySkill>({
  ttlMs: REGISTRY_ENTRY_CACHE_TTL_MS,
});

const githubSkillPathMemo = createAsyncTtlMemo<string, string[]>({
  ttlMs: GITHUB_SKILL_PATH_CACHE_TTL_MS,
});

const githubRepositoryStarsCache = new Map<
  string,
  { stars: number | null; expiresAt: number }
>();

const githubRepositoryStarsRequests = new Map<string, Promise<number | null>>();

function registryFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  });
}

function responseCacheTtl(response: Response): number {
  const cacheControl = response.headers.get("cache-control") ?? "";

  if (/\b(?:no-cache|no-store|private)\b/iu.test(cacheControl)) return 0;
  const maxAge = Number(cacheControl.match(/\bmax-age=(\d+)\b/iu)?.[1]);

  if (!Number.isFinite(maxAge)) return SEARCH_CACHE_TTL_MS;
  const age = Number(response.headers.get("age")) || 0;

  return Math.min(SEARCH_CACHE_TTL_MS, Math.max(0, (maxAge - age) * 1000));
}

function rateLimited(retryAfterSeconds: number): ApiError {
  return new ApiError(
    429,
    "skills_registry_rate_limited",
    "skills.sh is rate limiting searches",
    {
      retryable: true,
      details: { retryAfterSeconds },
    },
  );
}

function throwSearchStatus(response: Response, authenticated: boolean): void {
  if (response.ok) return;

  if (response.status === 429) {
    const header = response.headers.get("retry-after")?.trim();

    const seconds =
      header && /^\d+$/u.test(header)
        ? Number(header)
        : Math.ceil((Date.parse(header ?? "") - Date.now()) / 1000);

    throw rateLimited(
      Number.isFinite(seconds)
        ? Math.max(1, seconds)
        : DEFAULT_RETRY_AFTER_SECONDS,
    );
  }

  if (authenticated && (response.status === 401 || response.status === 403)) {
    throw new ApiError(
      502,
      "skills_registry_auth_rejected",
      "skills.sh rejected the coordinator credential",
    );
  }

  throw new ApiError(
    503,
    "skills_registry_unavailable",
    "skills.sh is unavailable",
    true,
  );
}

function searchError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof Error && error.name === "TimeoutError") {
    return new ApiError(
      504,
      "skills_registry_timeout",
      "skills.sh did not respond in time",
      true,
    );
  }

  return new ApiError(
    503,
    "skills_registry_unavailable",
    "skills.sh is unavailable",
    true,
  );
}

async function fetchRegistryJson(
  url: URL,
  strict: boolean,
): Promise<SkillsApiPage | null> {
  const token = process.env.VERCEL_OIDC_TOKEN;

  if (!token) return null;

  const response = await registryFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (strict) throwSearchStatus(response, true);

  if (!response.ok) return null;

  const body: unknown = await response.json().catch((error: unknown) => {
    if (strict) throw error;

    return null;
  });

  if (!isRecord(body) || !Array.isArray(body.data)) {
    if (strict) throw searchError(null);

    return null;
  }

  const skills = body.data.filter(isApiSkill);
  const pagination = isRecord(body.pagination) ? body.pagination : null;

  const total =
    pagination && typeof pagination.total === "number"
      ? pagination.total
      : typeof body.count === "number"
        ? body.count
        : skills.length;

  const hasMore =
    pagination && typeof pagination.hasMore === "boolean"
      ? pagination.hasMore
      : false;

  return {
    skills,
    total,
    hasMore,
    cacheTtlMs: responseCacheTtl(response),
    searchType:
      body.searchType === "semantic" || body.searchType === "fuzzy"
        ? body.searchType
        : null,
  };
}

async function fetchCliRegistrySearch(query: string): Promise<SkillsApiPage> {
  const url = new URL("https://skills.sh/api/search");
  url.search = new URLSearchParams({ q: query, limit: "10" }).toString();

  const response = await registryFetch(url);
  throwSearchStatus(response, false);
  const body: unknown = await response.json();

  if (!isRecord(body) || !Array.isArray(body.skills)) throw searchError(null);

  const skills = body.skills.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.source !== "string" ||
      typeof entry.skillId !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.installs !== "number" ||
      !Number.isSafeInteger(entry.installs) ||
      entry.installs < 0 ||
      !REGISTRY_SKILL_NAME_PATTERN.test(entry.skillId) ||
      entry.id !== `${entry.source}/${entry.skillId}`
    )
      return [];

    const repo = githubRepoForSource(entry.source);

    if (repo === null) return [];

    return [
      {
        id: entry.id,
        source: entry.source,
        slug: entry.skillId,
        name: entry.name,
        installs: entry.installs,
        installUrl: `https://github.com/${repo}`,
        url: registrySkillUrl(entry.id),
      },
    ];
  });

  return {
    skills,
    total: skills.length,
    hasMore: false,
    cacheTtlMs: responseCacheTtl(response),
    searchType:
      body.searchType === "semantic" || body.searchType === "fuzzy"
        ? body.searchType
        : null,
  };
}

async function fetchAuthenticatedRegistryDetail(
  source: string,
  skillId: string,
): Promise<RegistrySkillDetail | null> {
  const token = process.env.VERCEL_OIDC_TOKEN;

  if (!token) return null;

  if (hasUnsafePathSegment(source) || hasUnsafePathSegment(skillId)) {
    throw new ApiError(
      400,
      "invalid_registry_source",
      "Invalid registry source",
    );
  }

  const id = `${source}/${skillId}`;

  const url = new URL(
    `/api/v1/skills/${id
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`,
    SKILLS_BASE_URL,
  );

  const response = await registryFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);

  if (!isRecord(body)) return null;
  const files = parseRegistryDetailFiles(body.files);

  if (body.files !== null && files === null) return null;

  return {
    id,
    source,
    skillId,
    hash: typeof body.hash === "string" ? body.hash : null,
    files,
  };
}

async function fetchGithubMarkdown(
  repo: string,
  filePath: string,
): Promise<RegistrySkillFile[] | null> {
  try {
    const encodedPath = filePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    const response = await registryFetch(
      `https://raw.githubusercontent.com/${repo}/HEAD/${encodedPath}`,
      { headers: { "user-agent": "omnyo-skills-registry" } },
    );

    if (!response.ok) return null;
    const contents = await response.text();

    return contents.length <= REGISTRY_DETAIL_FILE_SIZE_LIMIT
      ? [{ path: "SKILL.md", contents }]
      : null;
  } catch {
    return null;
  }
}

async function fetchGithubSkillMarkdown(
  source: string,
  skillId: string,
): Promise<RegistrySkillFile[] | null> {
  const repo = githubRepoForSource(source);

  if (repo === null) return null;

  const candidatePaths = [
    `skills/${skillId}/SKILL.md`,
    `.agents/skills/${skillId}/SKILL.md`,
    `.claude/skills/${skillId}/SKILL.md`,
    `.github/skills/${skillId}/SKILL.md`,
    `${skillId}/SKILL.md`,
  ];

  const candidates = await Promise.all(
    candidatePaths.map((candidatePath) =>
      fetchGithubMarkdown(repo, candidatePath),
    ),
  );

  const directMatch = candidates.find((candidate) => candidate !== null);

  if (directMatch) return directMatch;

  const repositoryPaths = await fetchGithubSkillPaths(repo).catch(() => null);

  if (repositoryPaths === null) return null;
  const normalizedSkillId = skillId.toLowerCase();

  const nestedPath = repositoryPaths
    .filter((path) => {
      const normalizedPath = path.replaceAll("\\", "/").toLowerCase();

      return (
        normalizedPath === `${normalizedSkillId}/skill.md` ||
        normalizedPath.endsWith(`/${normalizedSkillId}/skill.md`)
      );
    })
    .sort(
      (left, right) =>
        left.split("/").length - right.split("/").length ||
        left.localeCompare(right),
    )[0];

  if (!nestedPath) return null;

  return fetchGithubMarkdown(repo, nestedPath);
}

async function fetchPublicSkillMarkdown(
  source: string,
  skillId: string,
): Promise<RegistrySkillFile[] | null> {
  try {
    const response = await registryFetch(
      registrySkillUrl(`${source}/${skillId}`),
    );

    if (!response.ok) return null;

    return parsePublicSkillMarkdown(await response.text());
  } catch {
    return null;
  }
}

function fetchGithubSkillPaths(repo: string): Promise<string[]> {
  return githubSkillPathMemo.run(repo, async () => {
    const response = await registryFetch(
      `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "omnyo-skills-registry",
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `GitHub tree request failed with HTTP ${response.status}`,
      );
    }

    const body: unknown = await response.json().catch(() => null);

    if (!isRecord(body) || !Array.isArray(body.tree)) {
      throw new Error("GitHub tree response is malformed");
    }

    return body.tree.flatMap((entry) =>
      isRecord(entry) && entry.type === "blob" && typeof entry.path === "string"
        ? [entry.path]
        : [],
    );
  });
}

export async function fetchRegistryRepositoryStars(
  source: string,
): Promise<number | null> {
  const repo = githubRepoForSource(source);

  if (repo === null) return null;
  const cacheKey = repo.toLowerCase();
  const cached = githubRepositoryStarsCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) return cached.stars;

  const inFlight = githubRepositoryStarsRequests.get(cacheKey);

  if (inFlight) return inFlight;

  const cacheStars = (stars: number | null): number | null => {
    githubRepositoryStarsCache.set(cacheKey, {
      stars,
      expiresAt:
        Date.now() +
        (stars === null
          ? GITHUB_REPOSITORY_STARS_FAILURE_TTL_MS
          : GITHUB_REPOSITORY_STARS_CACHE_TTL_MS),
    });

    return stars;
  };

  const request = (async () => {
    try {
      const response = await registryFetch(
        `https://api.github.com/repos/${repo}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "omnyo-skills-registry",
          },
        },
      );

      if (!response.ok) return cacheStars(null);
      const body: unknown = await response.json().catch(() => null);

      if (
        !isRecord(body) ||
        typeof body.stargazers_count !== "number" ||
        !Number.isInteger(body.stargazers_count) ||
        body.stargazers_count < 0
      ) {
        return cacheStars(null);
      }

      return cacheStars(body.stargazers_count);
    } catch {
      return cacheStars(null);
    } finally {
      githubRepositoryStarsRequests.delete(cacheKey);
    }
  })();

  githubRepositoryStarsRequests.set(cacheKey, request);

  return request;
}

export async function fetchRegistrySkillDetail(
  source: string,
  skillId: string,
): Promise<RegistrySkillDetail> {
  const id = `${source}/${skillId}`;
  const cached = registryDetailCache.get(id);

  if (cached && cached.expiresAt > Date.now()) return cached.detail;
  const authenticated = await fetchAuthenticatedRegistryDetail(source, skillId);

  const authenticatedIsLoadable =
    authenticated !== null && hasLoadableSkillContent(authenticated);

  const publicFiles = authenticatedIsLoadable
    ? null
    : ((await fetchGithubSkillMarkdown(source, skillId)) ??
      (await fetchPublicSkillMarkdown(source, skillId)));

  const detail = authenticatedIsLoadable
    ? authenticated
    : ({
        id,
        source,
        skillId,
        hash: null,
        files: publicFiles,
      } satisfies RegistrySkillDetail);

  registryDetailCache.set(id, {
    detail,
    expiresAt: Date.now() + REGISTRY_DETAIL_CACHE_TTL_MS,
  });

  return detail;
}

async function fetchPublicDirectoryRecords(
  directoryPath: string,
  strict: boolean,
): Promise<{ skills: RegistrySkill[]; cacheTtlMs: number } | null> {
  try {
    const response = await registryFetch(`${SKILLS_BASE_URL}${directoryPath}`);

    if (strict) throwSearchStatus(response, false);

    if (!response.ok) return null;
    const skills = parsePublicDirectorySkills(await response.text());

    return skills.length === 0
      ? null
      : { skills, cacheTtlMs: responseCacheTtl(response) };
  } catch (error) {
    if (strict) throw searchError(error);

    return null;
  }
}

async function fetchPublicDirectorySkills(
  query: string,
  page: number,
  perPage: number,
  ranking: RegistryRanking,
  strict: boolean,
): Promise<SearchCacheEntry> {
  const trending = ranking === "trending";
  let servedRanking = ranking;

  let records = await fetchPublicDirectoryRecords(
    trending ? "/trending" : "/",
    strict,
  );

  if (records === null && trending) {
    records = await fetchPublicDirectoryRecords("/", false);

    if (records !== null) servedRanking = "all-time";
  }

  if (records === null) {
    throw new ApiError(
      503,
      "skills_registry_unavailable",
      "skills.sh is unavailable",
    );
  }

  const { skills } = records;
  const normalizedQuery = query.trim().toLowerCase();

  const filtered =
    normalizedQuery.length === 0
      ? skills
      : skills.filter(
          (skill) =>
            skill.name.toLowerCase().includes(normalizedQuery) ||
            skill.source.toLowerCase().includes(normalizedQuery),
        );

  const ranked =
    normalizedQuery.length === 0
      ? filtered
      : [...filtered].sort(
          (left, right) =>
            right.installs - left.installs ||
            left.name.localeCompare(right.name),
        );

  const supported = ranked.filter(
    (skill) => githubRepoForSource(skill.source) !== null,
  );

  const start = page * perPage;

  return {
    cacheTtlMs: records.cacheTtlMs,
    page: {
      skills: supported.slice(start, start + perPage),
      pagination: {
        page,
        perPage,
        total: supported.length,
        hasMore: start + perPage < supported.length,
      },
      ranking: servedRanking,
      coverage: "leaderboard-names",
    },
  };
}

interface SearchCacheEntry {
  page: RegistrySkillsPage;
  cacheTtlMs: number;
}

async function readRegistrySkills(
  query: string,
  page: number,
  perPage: number,
  publicApi: boolean,
): Promise<SearchCacheEntry> {
  const normalizedQuery = query.trim();

  if (normalizedQuery.length === 1) {
    return fetchPublicDirectorySkills(
      normalizedQuery,
      page,
      perPage,
      "all-time",
      true,
    );
  }

  const isSearch = normalizedQuery.length > 0;

  const ranking: RegistryRanking =
    normalizedQuery.length > 0 ? "all-time" : "trending";

  const apiUrl = new URL(
    normalizedQuery.length > 0 ? "/api/v1/skills/search" : "/api/v1/skills",
    SKILLS_BASE_URL,
  );

  if (normalizedQuery.length > 0) {
    apiUrl.searchParams.set("q", normalizedQuery);
    apiUrl.searchParams.set("limit", String(MAX_SEARCH_RESULTS));
  } else {
    apiUrl.searchParams.set("view", ranking);
    apiUrl.searchParams.set("page", String(page));
    apiUrl.searchParams.set("per_page", String(perPage));
  }

  const authenticated = await fetchRegistryJson(apiUrl, isSearch);

  const apiPage =
    authenticated ??
    (isSearch && publicApi
      ? await fetchCliRegistrySearch(normalizedQuery)
      : null);

  if (apiPage === null) {
    return fetchPublicDirectorySkills(
      normalizedQuery,
      page,
      perPage,
      ranking,
      isSearch,
    );
  }

  const mappedApiSkills = apiPage.skills.map((skill) => ({
    id: skill.id,
    source: skill.source,
    skillId: skill.slug,
    name: skill.name,
    installs: skill.installs,
    stars: null,
    installUrl: skill.installUrl,
    url: skill.url,
    topic: null,
    summary: null,
  }));

  const start = page * perPage;
  const total = isSearch ? mappedApiSkills.length : apiPage.total;

  const pagination: RegistryPagination = {
    page,
    perPage,
    total,
    hasMore: isSearch ? start + perPage < total : apiPage.hasMore,
  };

  return {
    cacheTtlMs: apiPage.cacheTtlMs,
    page: {
      skills: isSearch
        ? mappedApiSkills.slice(start, start + perPage)
        : mappedApiSkills,
      pagination,
      ranking,
      coverage:
        apiPage.searchType === "semantic" ? "semantic" : "catalog-names",
    },
  };
}

export function createRegistrySearch() {
  const memo = createAsyncTtlMemo<string, SearchCacheEntry>({
    maxEntries: 200,
    ttlMs: (entry) => entry.cacheTtlMs,
    expireWhileIdle: true,
  });

  const retryAfter = { authenticated: 0, public: 0, leaderboard: 0 };

  return async (
    query: string,
    page: number,
    perPage: number,
    { publicApi = true }: { publicApi?: boolean } = {},
  ): Promise<RegistrySkillsPage> => {
    const normalizedQuery = query.trim();

    if (!normalizedQuery)
      return (await readRegistrySkills("", page, perPage, false)).page;

    const source =
      normalizedQuery.length === 1
        ? "leaderboard"
        : process.env.VERCEL_OIDC_TOKEN
          ? "authenticated"
          : publicApi
            ? "public"
            : "leaderboard";

    const key = JSON.stringify([
      source,
      normalizedQuery.toLowerCase(),
      page,
      perPage,
    ]);

    const result = await memo.run(key, async () => {
      const remainingMs = retryAfter[source] - Date.now();

      if (remainingMs > 0) throw rateLimited(Math.ceil(remainingMs / 1000));

      try {
        return await readRegistrySkills(
          normalizedQuery,
          page,
          perPage,
          publicApi,
        );
      } catch (error) {
        const sanitized = searchError(error);
        const { details } = sanitized.body;

        if (
          sanitized.status === 429 &&
          isRecord(details) &&
          typeof details.retryAfterSeconds === "number"
        ) {
          retryAfter[source] = Date.now() + details.retryAfterSeconds * 1000;
        }

        throw sanitized;
      }
    });

    return result.page;
  };
}

export async function resolveRegistrySkillById(
  id: string,
): Promise<RegistrySkill> {
  const { source, skillId } = parseRegistrySkillId(id);

  return registryEntryMemo.run(id, async () => {
    const response = await registryFetch(registrySkillUrl(id)).catch(
      (error: unknown) => {
        throw searchError(error);
      },
    );

    if (response.status === 404) {
      throw new ApiError(
        404,
        "registry_skill_not_found",
        "Registry skill not found",
      );
    }

    throwSearchStatus(response, false);

    const entry = parsePublicDetailSkill(
      await response.text().catch((error: unknown) => {
        throw searchError(error);
      }),
      id,
      source,
      skillId,
    );

    if (!entry) {
      throw new ApiError(
        404,
        "registry_skill_not_found",
        "Registry skill not found",
      );
    }

    return entry;
  });
}
