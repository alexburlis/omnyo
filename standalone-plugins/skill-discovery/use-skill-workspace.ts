import { useEffect, useState } from "react";
import {
  experimental_useAppContext,
  experimental_usePluginId,
  useSdk,
  type experimental_PluginBrowserSdk,
} from "@omnyo/plugin-sdk/app";
import { z } from "zod";
import type { InstalledSource } from "./library-view";

type Project = Awaited<ReturnType<experimental_PluginBrowserSdk["projects"]["list"]>>[number];

type Environment = Awaited<
  ReturnType<experimental_PluginBrowserSdk["environments"]["list"]>
>[number];

type Load<T> =
  | { key: string; status: "loading" }
  | { key: string; status: "loaded"; value: T }
  | { key: string; status: "error"; error: string };

const selectionSchema = z.object({
  projectId: z.string().min(1).nullable(),
  environmentId: z.string().min(1).nullable(),
});

function readWorkspace(key: string, projectId: string | null) {
  try {
    const stored = window.localStorage.getItem(key);

    if (stored !== null) {
      const parsed = selectionSchema.safeParse(JSON.parse(stored));

      if (parsed.success && parsed.data.projectId !== null) return parsed.data;
    }
  } catch {
    console.warn("Could not read the saved Skill Library workspace.");
  }

  return { projectId, environmentId: null };
}

export function useSkillWorkspace() {
  const sdk = useSdk();
  const context = experimental_useAppContext();
  const storageKey = `${experimental_usePluginId()}:workspace`;
  const [workspace, setWorkspace] = useState(() => readWorkspace(storageKey, context.projectId));
  const [refresh, setRefresh] = useState(0);
  const [projects, setProjects] = useState<Load<Project[]>>({ key: "", status: "loading" });

  const [environments, setEnvironments] = useState<Load<Environment[]>>({
    key: "",
    status: "loading",
  });

  const [inventory, setInventory] = useState<Load<InstalledSource[]>>({
    key: "",
    status: "loading",
  });

  const key = JSON.stringify([workspace.projectId, workspace.environmentId]);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(workspace));
  }, [storageKey, workspace]);

  useEffect(() => {
    const request = new AbortController();
    setProjects({ key: "", status: "loading" });

    void sdk.projects
      .list({ includePersonal: true, signal: request.signal })
      .then((value) => {
        if (request.signal.aborted) return;
        setProjects({ key: "", status: "loaded", value });
        setWorkspace((current) => {
          if (value.some((project) => project.id === current.projectId)) return current;

          const project =
            value.find((candidate) => candidate.id === context.projectId) ??
            value.find((candidate) => candidate.kind === "personal");

          return { projectId: project?.id ?? null, environmentId: null };
        });
      })
      .catch((cause) => {
        if (!request.signal.aborted)
          setProjects({
            key: "",
            status: "error",
            error: cause instanceof Error ? cause.message : "The request failed. Try again.",
          });
      });

    return () => request.abort();
  }, [context.projectId, sdk, refresh]);

  useEffect(() => {
    const { projectId } = workspace;
    const request = new AbortController();

    if (projectId === null) {
      setEnvironments({ key: "", status: "loaded", value: [] });

      return () => request.abort();
    }

    setEnvironments({ key: projectId, status: "loading" });
    void sdk.environments
      .list({ projectId, signal: request.signal })
      .then((value) => {
        if (!request.signal.aborted) setEnvironments({ key: projectId, status: "loaded", value });
      })
      .catch((cause) => {
        if (!request.signal.aborted)
          setEnvironments({
            key: projectId,
            status: "error",
            error: cause instanceof Error ? cause.message : "The request failed. Try again.",
          });
      });

    return () => request.abort();
  }, [sdk, workspace.projectId, refresh]);

  useEffect(() => {
    const { projectId, environmentId } = workspace;
    const request = new AbortController();

    if (projectId === null) {
      setInventory({ key, status: "loaded", value: [] });

      return () => request.abort();
    }

    setInventory({ key, status: "loading" });
    void sdk.skills
      .list({ projectId, environmentId, signal: request.signal })
      .then((result) => {
        if (!request.signal.aborted) setInventory({ key, status: "loaded", value: result.skills });
      })
      .catch((cause) => {
        if (!request.signal.aborted)
          setInventory({
            key,
            status: "error",
            error: cause instanceof Error ? cause.message : "The request failed. Try again.",
          });
      });

    return () => request.abort();
  }, [sdk, key, workspace.projectId, workspace.environmentId, refresh]);

  const projectList = projects.status === "loaded" ? projects.value : [];

  const environmentList =
    environments.status === "loaded" && environments.key === workspace.projectId
      ? environments.value
      : [];

  const project = projectList.find((candidate) => candidate.id === workspace.projectId);
  const environment = environmentList.find((candidate) => candidate.id === workspace.environmentId);

  const source =
    workspace.environmentId === null
      ? project?.sources.find((candidate) => candidate.isDefault)
      : environment;

  return {
    key,
    workspace,
    setWorkspace,
    project,
    projectList,
    environmentList,
    hostId: source?.hostId,
    rootPath: source?.path ?? null,
    inventory,
    sources: inventory.key === key && inventory.status === "loaded" ? inventory.value : [],
    error:
      projects.status === "error"
        ? projects.error
        : environments.status === "error" && environments.key === workspace.projectId
          ? environments.error
          : inventory.status === "error" && inventory.key === key
            ? inventory.error
            : null,
    loading:
      projects.status === "loading" || inventory.status === "loading" || inventory.key !== key,
    reload: () => setRefresh((value) => value + 1),
  };
}

export type SkillWorkspaceState = ReturnType<typeof useSkillWorkspace>;
