import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { PluginRpcHandlers } from "@omnyo/plugin-sdk";
import {
  chatOwns,
  discover,
  isPathWithin,
  withCleanupPriority,
  inspectRepo,
  inspectCleanupRepo,
  inspectCleanupTarget,
  inspectSidebarRepo,
  inspectWorktreeStorage,
  measureRepoWorktreeStorage,
  diffFiles,
  fileDiff,
  purgeWorktree,
  deleteBranch,
  type Repo,
  type SidebarRepo,
} from "./git.js";
import { runCleanup } from "./cleanup.js";
import { planCleanup, type CleanupItem } from "./cleanup-plan.js";
import {
  ownerRpcContract as rpcContract,
  sidebarRepository,
} from "./contract.js";
import type { OwnerMetadata, WorktreePublish } from "./host-contract.js";

export function createWorktreeService(
  readMetadata: () => Promise<OwnerMetadata>,
  publish: WorktreePublish,
): PluginRpcHandlers<typeof rpcContract> & {
  invalidateReads(): void;
} {
  const confirmations = new Map<
    string,
    {
      projectId: string;
      repo: string;
      path: string;
      head: string;
      base: string;
      expires: number;
    }
  >();

  const branchConfirmations = new Map<
    string,
    {
      projectId: string;
      repo: string;
      branch: string;
      head: string;
      base: string;
      expires: number;
    }
  >();

  const bulkConfirmations = new Map<
    string,
    {
      items: CleanupItem[];
      expires: number;
    }
  >();

  let mutating = false;

  async function mutation<T>(run: () => Promise<T>) {
    if (mutating) throw new Error("Cleanup is already running");
    mutating = true;

    try {
      return await run();
    } finally {
      mutating = false;
      invalidateReads();
      publish("git-changed", {});
    }
  }

  const inspections = new Map<string, Promise<Repo>>();

  type SharedReadScope = {
    inventory: Promise<Awaited<ReturnType<typeof buildCatalog>>>;
    inspections: Map<string, Promise<Repo>>;
    readers: number;
  };

  let activeReadScope: SharedReadScope | null = null;

  function invalidateReads() {
    inspections.clear();
    activeReadScope = null;
    catalogFlight = null;
    sidebarFlights.clear();
    summaryFlight = null;
  }

  function acquireReadScope() {
    if (!activeReadScope)
      activeReadScope = {
        inventory: catalog(),
        inspections: new Map(inspections),
        readers: 0,
      };
    activeReadScope.readers++;

    return activeReadScope;
  }

  function releaseReadScope(scope: SharedReadScope) {
    if (--scope.readers !== 0) return;
    scope.inspections.clear();

    if (activeReadScope === scope) activeReadScope = null;
  }

  function readRepo(repo: string, scope = activeReadScope) {
    const reads = scope?.inspections ?? inspections;
    let inspection = reads.get(repo);

    if (!inspection) {
      inspection = inspectRepo(
        repo,
        [...protectedPaths],
        false,
        chatTargets,
      ).finally(() => {
        if (!scope && reads.get(repo) === inspection) reads.delete(repo);
      });
      reads.set(repo, inspection);
    }

    return inspection;
  }

  const knownRepos = new Map<string, Set<string>>();

  let catalogFlight: Promise<Awaited<ReturnType<typeof buildCatalog>>> | null =
    null;

  let protectedPaths: string[] = [];
  let chatTargets: ReadonlySet<string> = new Set();

  async function metadata() {
    const {
      hostId,
      projects,
      environments,
      chatTargets: currentTargets,
    } = await readMetadata();

    const allSources = projects.flatMap((project) =>
      project.sources.flatMap((source) =>
        source.hostId === hostId ? [source.path] : [],
      ),
    );

    const paths = [
      ...allSources,
      ...environments.flatMap((e) =>
        e.path && e.status !== "destroyed" ? [e.path] : [],
      ),
    ];

    const canonical = new Map(
      await Promise.all(
        [...new Set(paths)].map(async (path) => {
          try {
            return [path, await realpath(path)] as const;
          } catch {
            return [path, resolve(path)] as const;
          }
        }),
      ),
    );

    protectedPaths = [...new Set(paths.map((path) => canonical.get(path)!))];
    chatTargets = new Set(currentTargets);

    const ownedProjects = projects.map((project) => ({
      id: project.id,
      name: project.name,
      roots: [
        ...project.sources.flatMap((source) =>
          source.hostId === hostId ? [canonical.get(source.path)!] : [],
        ),
        ...environments.flatMap((e) =>
          e.projectId === project.id &&
          e.isGitRepo &&
          e.path &&
          e.status !== "destroyed"
            ? [canonical.get(e.path)!]
            : [],
        ),
      ],
    }));

    const projectRoots = new Set(
      allSources.map((path) => canonical.get(path)!),
    );

    const inactiveEnvironmentRoots = new Set<string>();
    const protectedEnvironmentRoots = new Set<string>();

    for (const environment of environments) {
      if (!environment.path || environment.status === "destroyed") continue;
      const path = canonical.get(environment.path)!;

      if (
        !currentTargets ||
        projectRoots.has(path) ||
        !["ready", "error"].includes(environment.status) ||
        chatOwns(environment.path, chatTargets) ||
        chatOwns(path, chatTargets)
      )
        protectedEnvironmentRoots.add(path);
      else inactiveEnvironmentRoots.add(path);
    }

    for (const path of protectedEnvironmentRoots)
      inactiveEnvironmentRoots.delete(path);

    return {
      projects: ownedProjects,
      protection: protectedPaths,
      chatTargets,
      projectRoots,
      inactiveEnvironmentRoots,
    };
  }

  async function buildCatalog(projectIds?: ReadonlySet<string>) {
    const { projects, projectRoots, inactiveEnvironmentRoots } =
      await metadata();

    const selected = projectIds
      ? projects.filter((project) => projectIds.has(project.id))
      : projects;

    const roots = [...new Set(selected.flatMap((project) => project.roots))];

    const found = await discover(
      roots,
      (repo) => {
        const candidates = projects.flatMap((project) =>
          project.roots.flatMap((root) =>
            isPathWithin(root, repo)
              ? [{ project, specificity: root.length }]
              : [],
          ),
        );

        candidates.sort((a, b) => b.specificity - a.specificity);
        const owner = candidates[0]?.project;

        if (!owner || (projectIds && !projectIds.has(owner.id))) return;
        let allowed = knownRepos.get(owner.id);

        if (!allowed) {
          allowed = new Set();
          knownRepos.set(owner.id, allowed);
        }

        allowed.add(repo);
        publish("repository-found", {
          projectId: owner.id,
          projectName: owner.name,
          path: repo,
        });
      },
      { projectRoots, inactiveEnvironmentRoots },
    );

    const result = selected.map((project) => ({
      id: project.id,
      name: project.name,
      repos: Array<string>(),
    }));

    for (const repo of found.repos) {
      const owners = projects.flatMap((project) =>
        project.roots.flatMap((root) =>
          isPathWithin(root, repo)
            ? [{ id: project.id, specificity: root.length }]
            : [],
        ),
      );

      owners.sort((a, b) => b.specificity - a.specificity);
      const owner = result.find((project) => project.id === owners[0]?.id);

      if (owner) owner.repos.push(repo);
    }

    for (const project of result)
      knownRepos.set(project.id, new Set(project.repos));

    const projectErrors = Object.fromEntries(
      projects.map((project) => [
        project.id,
        found.errors.filter((error) =>
          project.roots.some(
            (root) =>
              error.startsWith(`${root}:`) || error.startsWith(`${root}${sep}`),
          ),
        ),
      ]),
    );

    return {
      projects: result.filter((project) => project.repos.length > 0),
      errors: found.errors,
      projectErrors,
      missingInactiveEnvironments: found.missingInactive.flatMap((path) =>
        selected
          .filter((project) => project.roots.includes(path))
          .map(({ id }) => ({ projectId: id, path })),
      ),
    };
  }

  async function catalog() {
    if (!catalogFlight) {
      const flight = buildCatalog().finally(() => {
        if (catalogFlight === flight) catalogFlight = null;
      });

      catalogFlight = flight;
    }

    return catalogFlight;
  }

  async function ownedRepositories(
    scopes: {
      projectId: string;
      repo: string;
    }[],
  ) {
    const { projects, protection, chatTargets } = await metadata();
    const allowed = new Set<string>();
    await Promise.all(
      scopes.map(async ({ projectId, repo }) => {
        const path = await realpath(repo).catch(() => resolve(repo));

        const owners = projects
          .flatMap((project) =>
            project.roots.flatMap((root) =>
              isPathWithin(root, path)
                ? [{ id: project.id, specificity: root.length }]
                : [],
            ),
          )
          .sort((a, b) => b.specificity - a.specificity);

        if (owners[0]?.id === projectId)
          allowed.add(JSON.stringify([projectId, repo]));
      }),
    );

    return { allowed, protection, chatTargets };
  }

  async function authorizedRepo(
    projectId: string,
    repo: string,
    fresh = false,
  ) {
    const known = knownRepos.get(projectId)?.has(repo);

    if (!known) {
      const project = (await readMetadata()).projects.find(
        (project) => project.id === projectId,
      );

      if (!project?.repositories?.includes(repo))
        throw new Error("Refresh the repository inventory before continuing");
    }

    if (fresh || !known) {
      const { allowed, protection, chatTargets } = await ownedRepositories([
        { projectId, repo },
      ]);

      if (!allowed.has(JSON.stringify([projectId, repo])))
        throw new Error(
          "Repository no longer belongs to this project. Rescan before continuing.",
        );

      return { protectedPaths: protection, chatTargets };
    }

    return { protectedPaths, chatTargets };
  }

  async function inventory() {
    if (mutating) throw new Error("Cleanup is already running");
    const catalogue = await catalog();

    const scopes = catalogue.projects.flatMap((project) =>
      project.repos.map((path) => ({
        projectId: project.id,
        projectName: project.name,
        path,
      })),
    );

    const entries: {
      projectId: string;
      projectName: string;
      path: string;
      repo: Repo | null;
      error: string | null;
    }[] = [];

    let cursor = 0;
    const protection = [...protectedPaths];

    async function reader() {
      while (cursor < scopes.length) {
        const index = cursor++;
        const scope = scopes[index];

        try {
          entries[index] = {
            ...scope,
            repo: await inspectRepo(scope.path, protection, true, chatTargets),
            error: null,
          };
        } catch (error) {
          entries[index] = {
            ...scope,
            repo: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    await Promise.all([reader(), reader(), reader(), reader()]);

    return {
      entries,
      issues: catalogue.errors,
      missingInactiveEnvironments: catalogue.missingInactiveEnvironments,
      scannedAt: new Date().toISOString(),
    };
  }

  async function scan(projectId: string) {
    const inventory = await catalog();

    const found = {
      repos: inventory.projects.find((p) => p.id === projectId)?.repos ?? [],
      errors: inventory.errors,
    };

    const repos: Repo[] = [];

    for (const path of found.repos) {
      try {
        repos.push(await inspectRepo(path, protectedPaths, true, chatTargets));
      } catch (error) {
        found.errors.push(
          `${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { repos, errors: found.errors, scannedAt: new Date().toISOString() };
  }

  async function readSidebar(projectIds: string[]) {
    const scope = activeReadScope ? acquireReadScope() : null;

    try {
      const inventory = await (scope?.inventory ??
        buildCatalog(new Set(projectIds)));

      const projects = [...new Set(projectIds)].map<{
        id: string;
        repos: SidebarRepo[];
        errors: string[];
      }>((id) => ({ id, repos: [], errors: [] }));

      const scopes = projects.flatMap((project) =>
        (
          inventory.projects.find((candidate) => candidate.id === project.id)
            ?.repos ?? []
        ).map((repo) => ({ project, repo })),
      );

      let cursor = 0;

      async function reader() {
        while (cursor < scopes.length) {
          const { project, repo } = scopes[cursor++];

          try {
            project.repos.push(
              scope
                ? sidebarRepository.parse(await readRepo(repo, scope))
                : await inspectSidebarRepo(repo),
            );
          } catch (error) {
            project.errors.push(
              `${repo}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      await Promise.all([reader(), reader(), reader(), reader()]);

      for (const project of projects)
        project.errors.push(...(inventory.projectErrors[project.id] ?? []));

      return { projects, checkedAt: new Date().toISOString() };
    } finally {
      if (scope) releaseReadScope(scope);
    }
  }

  const sidebarFlights = new Map<
    string,
    Promise<Awaited<ReturnType<typeof readSidebar>>>
  >();

  async function inspectCleanupCatalog(shareInspections = false) {
    const readScope = shareInspections ? acquireReadScope() : null;

    try {
      const inventory = await (readScope?.inventory ?? catalog());
      const issues = [...inventory.errors];

      const scopes = inventory.projects.flatMap((project) =>
        project.repos.map((repo) => ({
          projectId: project.id,
          projectName: project.name,
          path: repo,
        })),
      );

      const inspected: {
        projectId: string;
        projectName: string;
        repo: Repo;
      }[] = [];

      let cursor = 0;

      async function worker() {
        while (cursor < scopes.length) {
          const scope = scopes[cursor++];

          try {
            const repo = await (shareInspections
              ? readRepo(scope.path, readScope)
              : inspectCleanupRepo(scope.path, protectedPaths, chatTargets));

            inspected.push({
              ...scope,
              repo: await measureRepoWorktreeStorage(
                repo,
                repo.worktrees
                  .filter((worktree) => worktree.purgeReady)
                  .map((worktree) => worktree.path),
              ),
            });
          } catch (error) {
            issues.push(
              `${scope.path}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      await Promise.all([worker(), worker(), worker(), worker()]);

      return { items: planCleanup(inspected), issues };
    } finally {
      if (readScope) releaseReadScope(readScope);
    }
  }

  let summaryFlight: Promise<{
    folders: number;
    estimatedBytes: number;
    unknownFolders: number;
    checkedAt: string;
    issues: string[];
  }> | null = null;

  async function executeCleanup(items: CleanupItem[], token: string) {
    const scopes = [
      ...new Map(
        items.map((item) => [
          JSON.stringify([item.projectId, item.repo]),
          { projectId: item.projectId, repo: item.repo },
        ]),
      ).values(),
    ];

    const { allowed, protection, chatTargets } =
      await ownedRepositories(scopes);

    return runCleanup(
      items,
      (item) => {
        if (!allowed.has(JSON.stringify([item.projectId, item.repo])))
          throw new Error(
            "Repository no longer belongs to this project. Rescan before continuing.",
          );

        return protection;
      },
      (done) =>
        publish("cleanup-progress", { token, done, total: items.length }),
      chatTargets,
    );
  }

  function cleanupSummary() {
    if (mutating)
      throw new Error(
        "Cleanup is running. Refresh the storage estimate when it finishes.",
      );

    if (!summaryFlight)
      summaryFlight = inspectCleanupCatalog(true)
        .then(({ items, issues }) => {
          const folders = items.filter((item) => item.kind === "folder");

          return {
            folders: folders.length,
            estimatedBytes: folders.reduce(
              (sum, item) => sum + (item.estimatedBytes ?? 0),
              0,
            ),
            unknownFolders: folders.filter(
              (item) => item.estimatedBytes === null,
            ).length,
            checkedAt: new Date().toISOString(),
            issues,
          };
        })
        .finally(() => {
          if (summaryFlight === flight) summaryFlight = null;
        });
    const flight = summaryFlight;

    return flight;
  }

  return {
    invalidateReads,
    inventory: () => inventory(),
    cleanSaved: ({ token, items }) =>
      withCleanupPriority(() => mutation(() => executeCleanup(items, token))),
    catalog: () => activeReadScope?.inventory ?? catalog(),
    cleanupSummary: () => cleanupSummary(),
    inspect: async ({ projectId, repo }) => {
      await authorizedRepo(projectId, repo);

      return readRepo(repo);
    },
    storage: async ({ projectId, repo }) => {
      await authorizedRepo(projectId, repo);

      return inspectWorktreeStorage(repo);
    },
    sidebar: ({ projectIds }) => {
      const ids = [...new Set(projectIds)].sort();
      const key = JSON.stringify(ids);
      let flight = sidebarFlights.get(key);

      if (!flight) {
        flight = readSidebar(ids).finally(() => {
          if (sidebarFlights.get(key) === flight) sidebarFlights.delete(key);
        });
        sidebarFlights.set(key, flight);
      }

      return flight;
    },
    projects: async () =>
      (await readMetadata()).projects.map((p) => ({
        id: p.id,
        name: p.name,
      })),
    scan: ({ projectId }) => scan(projectId),
    files: async (q) => {
      await authorizedRepo(q.projectId, q.repo);

      return diffFiles(q.repo, q.target, q.base, q.mode);
    },
    diff: async (q) => {
      await authorizedRepo(q.projectId, q.repo);

      return fileDiff(q.repo, q.target, q.base, q.mode, q.path);
    },
    prepare: (q) =>
      withCleanupPriority(async () => {
        const ctx = await authorizedRepo(q.projectId, q.repo, true);

        const state = await inspectCleanupTarget(
          q.repo,
          ctx.protectedPaths,
          { kind: "folder", name: q.path, measurement: { kind: "preview" } },
          ctx.chatTargets,
        );

        const item = state.worktrees.find((w) => w.path === q.path);

        if (!item?.purgeReady || !item.branch || !item.preserveIn)
          throw new Error("Worktree is not ready to purge");

        for (const [key, value] of confirmations)
          if (value.expires < Date.now()) confirmations.delete(key);
        const token = randomUUID();
        confirmations.set(token, {
          ...q,
          head: item.head,
          base: item.preserveIn,
          expires: Date.now() + 60000,
        });

        return {
          token,
          path: item.path,
          branch: item.branch,
          base: item.preserveIn,
          estimatedBytes: item.storage.reclaimableBytes,
        };
      }),
    prepareBranch: (q) =>
      withCleanupPriority(async () => {
        const ctx = await authorizedRepo(q.projectId, q.repo, true);

        const state = await inspectCleanupTarget(
          q.repo,
          ctx.protectedPaths,
          { kind: "branch", name: q.branch },
          ctx.chatTargets,
        );

        const item = state.branches.find((b) => b.name === q.branch);

        if (!item?.deleteReady || !item.deleteBase)
          throw new Error("Branch is not safe to delete");

        for (const [key, value] of branchConfirmations)
          if (value.expires < Date.now()) branchConfirmations.delete(key);
        const token = randomUUID();
        branchConfirmations.set(token, {
          ...q,
          head: item.head,
          base: item.deleteBase,
          expires: Date.now() + 60000,
        });

        return { token, branch: item.name, base: item.deleteBase };
      }),
    deleteBranch: ({ token }) =>
      withCleanupPriority(async () => {
        const item = branchConfirmations.get(token);
        branchConfirmations.delete(token);

        if (!item || item.expires < Date.now())
          throw new Error("Confirmation expired. Review the branch again.");
        await authorizedRepo(item.projectId, item.repo, true);
        const chatTargets = new Set((await readMetadata()).chatTargets);

        return mutation(() =>
          deleteBranch(
            item.repo,
            item.branch,
            item.head,
            item.base,
            chatTargets,
          ),
        );
      }),
    prepareAll: () =>
      withCleanupPriority(async () => {
        if (mutating) throw new Error("Cleanup is already running");
        const { items, issues } = await inspectCleanupCatalog();

        for (const [key, value] of bulkConfirmations)
          if (value.expires < Date.now()) bulkConfirmations.delete(key);
        const token = randomUUID();
        bulkConfirmations.set(token, {
          items,
          expires: Date.now() + 5 * 60000,
        });

        return { token, items, issues };
      }),
    cleanupAll: ({ token }) =>
      withCleanupPriority(() =>
        mutation(async () => {
          const plan = bulkConfirmations.get(token);
          bulkConfirmations.delete(token);

          if (!plan || plan.expires < Date.now())
            throw new Error("Confirmation expired. Review safe cleanup again.");

          return executeCleanup(plan.items, token);
        }),
      ),
    purge: ({ token }) =>
      withCleanupPriority(async () => {
        const item = confirmations.get(token);
        confirmations.delete(token);

        if (!item || item.expires < Date.now())
          throw new Error("Confirmation expired. Review the worktree again.");
        const ctx = await authorizedRepo(item.projectId, item.repo, true);
        const chatTargets = new Set((await readMetadata()).chatTargets);

        return mutation(() =>
          purgeWorktree(
            item.repo,
            item.path,
            item.head,
            ctx.protectedPaths,
            item.base,
            chatTargets,
          ),
        );
      }),
  };
}
