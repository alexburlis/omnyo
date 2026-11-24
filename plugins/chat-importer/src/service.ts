import type {
  NativeChatSummary,
  NativeProviderId,
  ProjectRootHint,
  ScanDropReason,
  ScanOutput,
} from "./host-contract.js";
import type {
  ChatStatus,
  PlannedProject,
  PreviewChat,
  PreviewCounts,
  PreviewHost,
  PreviewOutput,
  TargetProject,
} from "./contract.js";

export const PROVIDER_LABELS: Record<NativeProviderId, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};

export const DROP_REASON_LABELS: Record<ScanDropReason, string> = {
  "older-than-window": "last message is older than the window",
  "omnyo-session": "run by Omnyo",
  "scripted-session": "scripted runs, not chats",
  "subagent-session": "subagent logs",
  "no-user-message": "no message from you",
  unreadable: "could not be read",
};

const MINUTE_MS = 60_000;

const HOUR_MS = 60 * MINUTE_MS;

const DAY_MS = 24 * HOUR_MS;

export function formatRelativeTime(timeMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - timeMs);

  if (elapsed < MINUTE_MS) return "just now";

  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;

  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;

  const days = Math.floor(elapsed / DAY_MS);

  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function projectLabel(project: TargetProject): string {
  return project.kind === "existing"
    ? project.name
    : `New project · ${project.name}`;
}

export interface NativeSessionClaim {
  sourceProviderThreadId: string;
  threadId: string;
  via: "import" | "identity";
}

export type ClaimIndex = Record<
  NativeProviderId,
  ReadonlyMap<string, NativeSessionClaim>
>;

export interface ProjectSourceRecord {
  type: string;
  hostId: string;
  path: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  sources: readonly ProjectSourceRecord[];
}

export interface HostContext {
  homeDir: string;
  roots: ScanOutput["roots"];
}

export interface ChatLocation {
  cwd: string;
  realCwd: string | null;
  projectRoot: ProjectRootHint | null;
}

export interface ChatStatusPlan {
  status: ChatStatus;
  reason: string | null;
  threadId: string | null;
}

const STATUS_REASONS: Record<Exclude<ChatStatus, "ready">, string> = {
  "omnyo-chat": "This chat already runs in Omnyo.",
  "already-imported": "Already imported.",
  "folder-missing": "Its folder no longer exists on this machine.",
  "not-a-project-folder": "Not in a project folder.",
  "cwd-mismatch":
    "Its folder changed while the chat ran, so it can't be continued here.",
};

const COPY_OF_OMNYO_CHAT_REASON = "This chat is a copy of a chat in Omnyo.";

export const PROJECTS_CHANGED_REASON =
  "Your projects changed since the chats were listed. List them again and retry.";

const OMNYO_DATA_SEGMENTS = new Set([".omnyo", ".omnyo-dev"]);

interface NormalizedPath {
  key: string;
  segments: readonly string[];
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\");
}

function normalizePath(path: string): NormalizedPath {
  const windows = isWindowsPath(path);
  const slashed = windows ? path.replaceAll("\\", "/") : path;
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/u, "") : slashed;
  const key = windows ? trimmed.toLowerCase() : trimmed;

  return { key, segments: key.split("/").filter((part) => part.length > 0) };
}

export function pathContains(parent: string, child: string): boolean {
  const outer = normalizePath(parent).segments;
  const inner = normalizePath(child).segments;

  if (outer.length > inner.length) return false;

  return outer.every((segment, index) => inner[index] === segment);
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left).key === normalizePath(right).key;
}

function isFilesystemRoot(path: string): boolean {
  return normalizePath(path).segments.length <= (isWindowsPath(path) ? 1 : 0);
}

export function pathBasename(path: string): string {
  const normalized = isWindowsPath(path) ? path.replaceAll("\\", "/") : path;
  const parts = normalized.split("/").filter((part) => part.length > 0);

  return parts.at(-1) ?? path;
}

export function isExcludedFolder(path: string, context: HostContext): boolean {
  if (isFilesystemRoot(path) || samePath(path, context.homeDir)) return true;

  if (
    normalizePath(path).segments.some((segment) =>
      OMNYO_DATA_SEGMENTS.has(segment),
    )
  ) {
    return true;
  }

  return [context.roots.codex, context.roots.claude].some(
    (root) => root !== null && pathContains(root, path),
  );
}

export function chatStatus(
  summary: NativeChatSummary,
  claim: NativeSessionClaim | undefined,
  context: HostContext,
): ChatStatus {
  if (claim?.via === "identity") return "omnyo-chat";

  if (claim?.via === "import") return "already-imported";

  if (!summary.cwdExists) return "folder-missing";

  if (
    isExcludedFolder(summary.cwd, context) ||
    (summary.realCwd !== null && isExcludedFolder(summary.realCwd, context))
  ) {
    return "not-a-project-folder";
  }

  if (!summary.cwdMatchesStore) return "cwd-mismatch";

  return "ready";
}

export function statusReason(status: ChatStatus): string | null {
  return status === "ready" ? null : STATUS_REASONS[status];
}

export function hostLocalPaths(
  projects: readonly ProjectRecord[],
  hostId: string,
): string[] {
  return [
    ...new Set(
      projects.flatMap((project) =>
        project.sources
          .filter(
            (source) =>
              source.type === "local_path" && source.hostId === hostId,
          )
          .map((source) => source.path),
      ),
    ),
  ];
}

export function plannedProjects(
  projects: readonly ProjectRecord[],
  hostId: string,
  realPaths: ReadonlyMap<string, string | null>,
): PlannedProject[] {
  return projects.map((project) => {
    const paths: string[] = [];

    for (const path of hostLocalPaths([project], hostId)) {
      paths.push(path);
      const realPath = realPaths.get(path) ?? null;

      if (realPath !== null && !samePath(realPath, path)) paths.push(realPath);
    }

    return { id: project.id, name: project.name, paths };
  });
}

export function mainRepositoryPaths(chats: readonly ChatLocation[]): string[] {
  return [
    ...new Set(
      chats.flatMap((chat) =>
        chat.projectRoot?.kind === "git-worktree" &&
        chat.projectRoot.mainRepositoryPath !== null
          ? [chat.projectRoot.mainRepositoryPath]
          : [],
      ),
    ),
  ];
}

export function withRealMainRepository<Chat extends ChatLocation>(
  chat: Chat,
  realPaths: ReadonlyMap<string, string | null>,
): Chat {
  const root = chat.projectRoot;

  if (root?.kind !== "git-worktree" || root.mainRepositoryPath === null)
    return chat;
  const realPath = realPaths.get(root.mainRepositoryPath) ?? null;

  return realPath === null || samePath(realPath, root.mainRepositoryPath)
    ? chat
    : { ...chat, projectRoot: { ...root, mainRepositoryPath: realPath } };
}

function repositoryBoundary(chat: ChatLocation): string | null {
  const root = chat.projectRoot;

  return root === null || root.kind === "folder" ? null : root.path;
}

function longestContainingProject(
  path: string,
  projects: readonly PlannedProject[],
  boundary: string | null,
): PlannedProject | null {
  let best: { project: PlannedProject; depth: number } | null = null;

  for (const project of projects) {
    for (const sourcePath of project.paths) {
      if (!pathContains(sourcePath, path)) continue;

      if (boundary !== null && !pathContains(boundary, sourcePath)) continue;
      const depth = normalizePath(sourcePath).segments.length;

      if (best === null || depth > best.depth) best = { project, depth };
    }
  }

  return best?.project ?? null;
}

export function matchExistingProject(
  chat: ChatLocation,
  projects: readonly PlannedProject[],
): PlannedProject | null {
  const boundary = repositoryBoundary(chat);
  const direct = longestContainingProject(chat.cwd, projects, boundary);

  if (direct !== null) return direct;

  if (chat.realCwd !== null && !samePath(chat.realCwd, chat.cwd)) {
    const real = longestContainingProject(chat.realCwd, projects, boundary);

    if (real !== null) return real;
  }

  const root = chat.projectRoot;

  if (root?.kind === "git-worktree" && root.mainRepositoryPath !== null) {
    return longestContainingProject(
      root.mainRepositoryPath,
      projects,
      root.mainRepositoryPath,
    );
  }

  return null;
}

function proposedProjectPath(chat: ChatLocation, context: HostContext): string {
  const root = chat.projectRoot;
  const folder = chat.realCwd ?? chat.cwd;

  const candidate =
    root === null
      ? folder
      : root.kind === "git-worktree" && root.mainRepositoryPath !== null
        ? root.mainRepositoryPath
        : root.path;

  return isExcludedFolder(candidate, context) ? folder : candidate;
}

interface Proposal {
  name: string;
  path: string;
}

export class ProjectPlanner {
  private readonly usedNames: Set<string>;
  private readonly proposals = new Map<string, Proposal>();

  constructor(
    private readonly projects: readonly PlannedProject[],
    private readonly context: HostContext,
  ) {
    this.usedNames = new Set(
      projects.map((project) => project.name.toLocaleLowerCase()),
    );
  }

  target(chat: ChatLocation): TargetProject {
    const planned = this.plan(chat);

    if (planned.register !== null) {
      this.proposals.set(
        normalizePath(planned.register.path).key,
        planned.register,
      );
      this.usedNames.add(planned.register.name.toLocaleLowerCase());
    }

    return planned.target;
  }

  peek(chat: ChatLocation): TargetProject {
    return this.plan(chat).target;
  }

  newProjects(): Proposal[] {
    return [...this.proposals.values()];
  }

  private plan(chat: ChatLocation): {
    target: TargetProject;
    register: Proposal | null;
  } {
    const existing = matchExistingProject(chat, this.projects);

    if (existing !== null) {
      return {
        target: {
          kind: "existing",
          projectId: existing.id,
          name: existing.name,
        },
        register: null,
      };
    }

    const pending = this.pendingProposal(chat);

    if (pending !== null) {
      return { target: { kind: "new", ...pending }, register: null };
    }

    const path = proposedProjectPath(chat, this.context);
    const proposal = { name: this.uniqueName(pathBasename(path)), path };

    return { target: { kind: "new", ...proposal }, register: proposal };
  }

  private pendingProposal(chat: ChatLocation): Proposal | null {
    const pending = [...this.proposals.entries()].map(
      ([key, proposal]): PlannedProject => ({
        id: key,
        name: proposal.name,
        paths: [proposal.path],
      }),
    );

    const match = matchExistingProject(chat, pending);

    return match === null ? null : (this.proposals.get(match.id) ?? null);
  }

  private uniqueName(base: string): string {
    let name = base;

    for (let suffix = 2; this.usedNames.has(name.toLocaleLowerCase()); suffix++)
      name = `${base} ${suffix}`;

    return name;
  }
}

export interface PlannableChat extends ChatLocation {
  key: string;
  status: ChatStatus;
}

export interface ProjectPlan {
  targets: ReadonlyMap<string, TargetProject>;
  newProjects: Proposal[];
}

export function planProjects<Chat extends PlannableChat>(
  chats: readonly Chat[],
  projects: readonly PlannedProject[],
  context: HostContext,
  isSelected: (chat: Chat) => boolean,
): ProjectPlan {
  const planner = new ProjectPlanner(projects, context);
  const targets = new Map<string, TargetProject>();

  for (const chat of chats) {
    if (chat.status !== "ready") continue;
    targets.set(
      chat.key,
      isSelected(chat) ? planner.target(chat) : planner.peek(chat),
    );
  }

  return { targets, newProjects: planner.newProjects() };
}

export function selectionPlan(
  preview: PreviewOutput,
  isSelected: (chat: PreviewChat) => boolean,
): ProjectPlan {
  return planProjects(
    preview.chats,
    preview.projects,
    { homeDir: preview.homeDir, roots: preview.roots },
    isSelected,
  );
}

export type TargetCheck =
  | { kind: "existing"; projectId: string }
  | { kind: "create"; name: string; path: string }
  | { kind: "invalid" };

export function checkTarget(
  chat: ChatLocation,
  target: TargetProject,
  projects: readonly PlannedProject[],
  context: HostContext,
): TargetCheck {
  if (target.kind === "existing") {
    const project = projects.find((entry) => entry.id === target.projectId);

    return project !== undefined &&
      matchExistingProject(chat, [project]) !== null
      ? { kind: "existing", projectId: project.id }
      : { kind: "invalid" };
  }

  const proposal: PlannedProject = {
    id: target.path,
    name: target.name,
    paths: [target.path],
  };

  const fits =
    !isExcludedFolder(target.path, context) &&
    (samePath(target.path, proposedProjectPath(chat, context)) ||
      matchExistingProject(chat, [proposal]) !== null);

  if (!fits) return { kind: "invalid" };

  const holder = matchExistingProject(chat, projects);

  if (holder !== null) {
    return holder.paths.some((path) => samePath(path, target.path))
      ? { kind: "existing", projectId: holder.id }
      : { kind: "invalid" };
  }

  const name = target.name.toLocaleLowerCase();

  const taken = projects.some(
    (project) =>
      project.name.toLocaleLowerCase() === name ||
      project.paths.some((path) => samePath(path, target.path)),
  );

  return taken
    ? { kind: "invalid" }
    : { kind: "create", name: target.name, path: target.path };
}

export function planChatStatus(
  summary: NativeChatSummary,
  claims: ClaimIndex,
  context: HostContext,
): ChatStatusPlan {
  const providerClaims = claims[summary.providerId];
  const claim = providerClaims.get(summary.sourceProviderThreadId);

  const copied =
    claim === undefined && summary.forkedFromProviderThreadId !== null
      ? providerClaims.get(summary.forkedFromProviderThreadId)
      : undefined;

  if (copied !== undefined) {
    return {
      status: "omnyo-chat",
      reason: COPY_OF_OMNYO_CHAT_REASON,
      threadId: copied.threadId,
    };
  }

  const status = chatStatus(summary, claim, context);

  return {
    status,
    reason: statusReason(status),
    threadId:
      status === "omnyo-chat" || status === "already-imported"
        ? (claim?.threadId ?? null)
        : null,
  };
}

export function chatKey(
  providerId: NativeProviderId,
  sourceProviderThreadId: string,
): string {
  return `${providerId}:${sourceProviderThreadId}`;
}

export function claimIndex(
  claims: Record<NativeProviderId, readonly NativeSessionClaim[]>,
): ClaimIndex {
  const index = (list: readonly NativeSessionClaim[]) => {
    const map = new Map<string, NativeSessionClaim>();

    for (const claim of list) {
      const known = map.get(claim.sourceProviderThreadId);

      if (known === undefined || claim.via === "identity")
        map.set(claim.sourceProviderThreadId, claim);
    }

    return map;
  };

  return {
    codex: index(claims.codex),
    "claude-code": index(claims["claude-code"]),
  };
}

export function countChats(chats: readonly PreviewChat[]): PreviewCounts {
  const byProvider = {
    codex: { found: 0, ready: 0 },
    "claude-code": { found: 0, ready: 0 },
  };

  let ready = 0;
  let alreadyImported = 0;

  for (const chat of chats) {
    byProvider[chat.providerId].found++;

    if (chat.status === "ready") {
      ready++;
      byProvider[chat.providerId].ready++;
    } else if (chat.status === "already-imported") {
      alreadyImported++;
    }
  }

  return {
    found: chats.length,
    ready,
    alreadyImported,
    unavailable: chats.length - ready - alreadyImported,
    byProvider,
  };
}

export function buildPreview(args: {
  hostId: string;
  hosts: readonly PreviewHost[];
  days: number;
  nowMs: number;
  scan: ScanOutput;
  claims: ClaimIndex;
  projects: readonly ProjectRecord[];
}): PreviewOutput {
  const context: HostContext = {
    homeDir: args.scan.homeDir,
    roots: args.scan.roots,
  };

  const realPaths = new Map(
    args.scan.resolvedPaths.map((entry) => [entry.path, entry.realPath]),
  );

  const projects = plannedProjects(args.projects, args.hostId, realPaths);

  const sorted = args.scan.chats
    .map((summary) => withRealMainRepository(summary, realPaths))
    .sort(
      (left, right) =>
        right.lastMessageAt - left.lastMessageAt ||
        left.sourceProviderThreadId.localeCompare(right.sourceProviderThreadId),
    );

  const located = sorted.map((summary) => ({
    summary,
    key: chatKey(summary.providerId, summary.sourceProviderThreadId),
    cwd: summary.cwd,
    realCwd: summary.realCwd,
    projectRoot: summary.projectRoot,
    ...planChatStatus(summary, args.claims, context),
  }));

  const plan = planProjects(located, projects, context, () => true);

  const chats = located.map(
    ({ summary, key, status, reason, threadId }): PreviewChat => ({
      key,
      providerId: summary.providerId,
      sourceProviderThreadId: summary.sourceProviderThreadId,
      sourcePath: summary.sourcePath,
      title: summary.title,
      firstPrompt: summary.firstPrompt,
      cwd: summary.cwd,
      realCwd: summary.realCwd,
      projectRoot: summary.projectRoot,
      client: summary.client,
      createdAt: summary.createdAt,
      lastMessageAt: summary.lastMessageAt,
      sizeBytes: summary.sizeBytes,
      status,
      reason,
      threadId,
      project: plan.targets.get(key) ?? null,
    }),
  );

  return {
    hostId: args.hostId,
    hosts: [...args.hosts],
    days: args.days,
    nowMs: args.nowMs,
    cutoffMs: args.nowMs - args.days * 24 * 60 * 60 * 1000,
    homeDir: context.homeDir,
    roots: context.roots,
    projects,
    counts: countChats(chats),
    chats,
    dropped: args.scan.dropped,
    newProjects: plan.newProjects,
  };
}
