import { createContext, useContext, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { sidebarThreadLifecyclesAtom } from "../preferences/atoms.js";
import {
  experimental_useSidebarThreads,
  type PluginSidebarProject,
  type PluginSidebarSection,
  type PluginSidebarThread,
  type PluginSidebarThreadGroup,
  type PluginSidebarThreadsState,
} from "@omnyo/plugin-sdk/app";
import { groupUnderHandoffHead, handoffChainHeads } from "./handoff-groups.js";
import type { SidebarThread } from "./sidebar-thread.js";
import { sidebarThreadLifecycle } from "./sidebar-thread-lifecycle.js";

export interface SidebarProject {
  id: string;
  name: string;
  href: string;
  settingsHref: string;
  isPersonal: boolean;
  threads: SidebarThread[];
  shelvedThreads: SidebarThread[];
}

export interface SidebarHost {
  id: string;
  name: string;
}

export interface SidebarData {
  status: PluginSidebarThreadsState["status"];
  sections: readonly PluginSidebarSection[];
  projects: SidebarProject[];
  personalProject: SidebarProject | null;
  hostsById: ReadonlyMap<string, SidebarHost>;
}

function sameElements<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }

  return true;
}

function sameHosts(
  left: ReadonlyMap<string, SidebarHost>,
  right: ReadonlyMap<string, SidebarHost>,
): boolean {
  if (left.size !== right.size) return false;

  for (const [id, host] of left) {
    const other = right.get(id);

    if (other === undefined || other.name !== host.name) return false;
  }

  return true;
}

function sameProjectShape(
  previous: SidebarProject,
  project: PluginSidebarProject,
): boolean {
  return (
    previous.id === project.id &&
    previous.name === project.name &&
    previous.href === project.href &&
    previous.settingsHref === project.settingsHref &&
    previous.isPersonal === project.isPersonal
  );
}

const EMPTY_THREADS: SidebarThread[] = [];

const EMPTY_HOSTS: readonly SidebarHost[] = [];

const EMPTY_CHAT_GROUPS: readonly PluginSidebarThreadGroup[] = [];

function addToProjectBucket(
  buckets: Map<string, SidebarThread[]>,
  thread: SidebarThread,
): void {
  const bucket = buckets.get(thread.projectId);

  if (bucket === undefined) {
    buckets.set(thread.projectId, [thread]);
  } else {
    bucket.push(thread);
  }
}

const ownedForksBySource = new WeakMap<SidebarThread, SidebarThread>();

function nestOwnedFork(thread: SidebarThread): SidebarThread {
  if (
    thread.originKind !== "fork" ||
    thread.parentThreadId !== null ||
    thread.lifecycleOwnerThreadId === null
  ) {
    return thread;
  }

  const cached = ownedForksBySource.get(thread);

  if (cached !== undefined) return cached;

  const nested = { ...thread, parentThreadId: thread.lifecycleOwnerThreadId };
  ownedForksBySource.set(thread, nested);

  return nested;
}

function keepIfUnchanged(
  previous: SidebarThread[] | undefined,
  next: SidebarThread[],
): SidebarThread[] {
  return previous !== undefined && sameElements(previous, next)
    ? previous
    : next;
}

export function buildSidebarData(
  status: PluginSidebarThreadsState["status"],
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
  sections: readonly PluginSidebarSection[],
  hosts: readonly SidebarHost[] = [],
  previous: SidebarData | null = null,
): SidebarData {
  const threadsByProjectId = new Map<string, SidebarThread[]>();
  const shelvedThreadsByProjectId = new Map<string, SidebarThread[]>();
  const hostsById = new Map(hosts.map((host) => [host.id, host]));

  const nestedThreads = threads.map(nestOwnedFork);
  const handoffHeadById = handoffChainHeads(nestedThreads);

  for (const nestedThread of nestedThreads) {
    const thread = groupUnderHandoffHead(
      nestedThread,
      handoffHeadById.get(nestedThread.id),
    );

    addToProjectBucket(
      sidebarThreadLifecycle(thread) === "shelved"
        ? shelvedThreadsByProjectId
        : threadsByProjectId,
      thread,
    );

    if (thread.host !== null && !hostsById.has(thread.host.id)) {
      hostsById.set(thread.host.id, thread.host);
    }
  }

  const previousProjectsById = new Map(
    previous?.projects.map((project) => [project.id, project]) ?? [],
  );

  const groupedProjects = projects.map<SidebarProject>((project) => {
    const before = previousProjectsById.get(project.id);

    const projectThreads = keepIfUnchanged(
      before?.threads,
      threadsByProjectId.get(project.id) ?? EMPTY_THREADS,
    );

    const shelvedThreads = keepIfUnchanged(
      before?.shelvedThreads,
      shelvedThreadsByProjectId.get(project.id) ?? EMPTY_THREADS,
    );

    if (
      before !== undefined &&
      sameProjectShape(before, project) &&
      before.threads === projectThreads &&
      before.shelvedThreads === shelvedThreads
    ) {
      return before;
    }

    return {
      id: project.id,
      name: project.name,
      href: project.href,
      settingsHref: project.settingsHref,
      isPersonal: project.isPersonal,
      threads: projectThreads,
      shelvedThreads,
    };
  });

  const sharedProjects =
    previous !== null && sameElements(previous.projects, groupedProjects)
      ? previous.projects
      : groupedProjects;

  return {
    status,
    sections,
    projects: sharedProjects,
    personalProject:
      sharedProjects.find((project) => project.isPersonal) ?? null,
    hostsById:
      previous !== null && sameHosts(previous.hostsById, hostsById)
        ? previous.hostsById
        : hostsById,
  };
}

interface SidebarDataCacheEntry {
  status: PluginSidebarThreadsState["status"];
  threads: readonly PluginSidebarThread[];
  projects: readonly PluginSidebarProject[];
  sections: readonly PluginSidebarSection[];
  hosts: readonly SidebarHost[];
  data: SidebarData;
}

let sidebarDataCache: SidebarDataCacheEntry | null = null;

export function getSidebarData(state: PluginSidebarThreadsState): SidebarData {
  const cached = sidebarDataCache;
  const hosts = state.experimental_hosts ?? EMPTY_HOSTS;

  if (
    cached !== null &&
    cached.status === state.status &&
    cached.threads === state.threads &&
    cached.projects === state.projects &&
    cached.sections === state.sections &&
    cached.hosts === hosts
  ) {
    return cached.data;
  }

  const data = buildSidebarData(
    state.status,
    state.threads,
    state.projects,
    state.sections,
    hosts,
    cached?.data ?? null,
  );

  sidebarDataCache = {
    status: state.status,
    threads: state.threads,
    projects: state.projects,
    sections: state.sections,
    hosts,
    data,
  };

  return data;
}

export function resetSidebarDataCacheForTest(): void {
  sidebarDataCache = null;
}

export const SidebarProjectNamesContext = createContext<
  ReadonlyMap<string, string>
>(new Map());

type ProjectNameSource = readonly Pick<PluginSidebarProject, "id" | "name">[];

function projectNamesById(projects: ProjectNameSource): Map<string, string> {
  return new Map(projects.map((project) => [project.id, project.name]));
}

function sameProjectNames(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;

  for (const [id, name] of left) {
    if (right.get(id) !== name) return false;
  }

  return true;
}

export function useSidebarProjectNames(
  projects: ProjectNameSource,
): ReadonlyMap<string, string> {
  const [names, setNames] = useState(() => projectNamesById(projects));
  const next = projectNamesById(projects);

  if (sameProjectNames(names, next)) return names;

  setNames(next);

  return next;
}

export function useSidebarProjectName(
  projectId: string | null,
): string | undefined {
  const names = useContext(SidebarProjectNamesContext);

  return projectId === null ? undefined : names.get(projectId);
}

export function useSidebarData() {
  const lifecycles = useAtomValue(sidebarThreadLifecyclesAtom);

  const state = experimental_useSidebarThreads({
    experimental_lifecycles: lifecycles.includes("active")
      ? [...lifecycles, "shelved"]
      : lifecycles,
  });

  const threads = state.threads;

  return useMemo(
    () => ({
      ...getSidebarData({ ...state, threads }),
      archived: state.experimental_archived,
      shelved: state.experimental_shelved,
      chatGroups: state.experimental_groups ?? EMPTY_CHAT_GROUPS,
    }),
    [state, threads],
  );
}

export function useSidebarMachineHosts(
  hostsById: ReadonlyMap<string, SidebarHost>,
): SidebarHost[] {
  return useMemo(() => [...hostsById.values()], [hostsById]);
}
