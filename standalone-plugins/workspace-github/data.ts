import { z } from "zod";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  experimental_useAppNavigate,
  useRealtime,
  useRpc,
  type PluginRpcResult,
} from "@omnyo/plugin-sdk/app";
import { toast } from "sonner";
import type { Item } from "./app-logic.js";
import type { githubRpcContract } from "./server.js";
import { ReadModels } from "./read-models.js";

export type IssueDetail = PluginRpcResult<(typeof githubRpcContract)["getIssue"]>["issue"];

export type PullDetail = PluginRpcResult<(typeof githubRpcContract)["getPull"]>["pull"];

export type PullCheck = PullDetail["checks"][number];

export type ReviewThread = PullDetail["reviewThreads"][number];

export type PullFile = PullDetail["files"][number];

export type Status = PluginRpcResult<(typeof githubRpcContract)["status"]>;

export type RepoInfo = Status["repos"][number];

export type LinksMap = PluginRpcResult<(typeof githubRpcContract)["listLinks"]>["links"];

export type ThreadLink = LinksMap[string][number];

export const pullModels = new ReadModels<PullDetail>(32, 4 * 1024 * 1024, 30_000);

export const issueModels = new ReadModels<IssueDetail>(32, 2 * 1024 * 1024, 30_000);

export const statusModels = new ReadModels<Status>(1, 256 * 1024);

export const errorText = z
  .unknown()
  .transform((error) => (error instanceof Error ? error.message : String(error))).parse;

export function useReadModel<Value>(
  models: ReadModels<Value>,
  key: string,
  load: () => Promise<Value>,
) {
  const subscribe = useCallback(
    (listener: () => void) => models.subscribe(key, listener),
    [models, key],
  );

  const snapshot = useSyncExternalStore(subscribe, () => models.getSnapshot(key));

  useEffect(() => {
    void models.refresh(key, load);
  }, [models, key, load]);
  const invalidate = useCallback(() => models.invalidate(key), [models, key]);
  useRealtime("data-changed", invalidate);

  return { ...snapshot, reload: invalidate };
}

export function relativeTime(iso: string): string {
  const then = Date.parse(iso);

  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);

  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;

  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;

  return `${Math.floor(seconds / 86400)}d ago`;
}

export function absoluteTime(iso: string): string {
  const then = Date.parse(iso);

  if (Number.isNaN(then)) return "";

  return new Date(then).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function useItems(model: ReadModels<Item[]>) {
  const rpc = useRpc<typeof githubRpcContract>();

  const load = useCallback(
    async () => (await rpc.call("listItems", { includeBody: false })).items,
    [rpc],
  );

  const { value, error, reload } = useReadModel(model, "all", load);

  return { items: value, error, reload };
}

export function useLinks() {
  const rpc = useRpc<typeof githubRpcContract>();
  const [links, setLinks] = useState<LinksMap>({});
  const [failed, setFailed] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("listLinks").then(
      (result) => {
        setLinks(result.links);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("links-changed", refetch);

  return { links, failed };
}

export function useSpawn() {
  const rpc = useRpc<typeof githubRpcContract>();
  const navigate = experimental_useAppNavigate();
  const [spawningKey, setSpawningKey] = useState<string | null>(null);

  const spawn = useCallback(
    (kind: "issue" | "pr", repo: string, number: number) => {
      setSpawningKey(`${kind}:${repo}#${number}`);
      rpc
        .call(kind === "issue" ? "startWork" : "startReview", { repo, number })
        .then((result) => {
          navigate.toThread(result.threadId);
        })
        .catch((error) => toast.error(errorText(error)))
        .finally(() => setSpawningKey(null));
    },
    [rpc, navigate],
  );

  return { spawn, spawningKey };
}

let viewerLogin: string | null = null;

export function useViewer() {
  const rpc = useRpc<typeof githubRpcContract>();
  const [login, setLogin] = useState<string | null>(viewerLogin);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (viewerLogin !== null) return;
    rpc.call("viewer").then(
      (result) => {
        viewerLogin = result.login;
        setLogin(result.login);
      },
      () => setFailed(true),
    );
  }, [rpc]);

  return { login, failed };
}

export function useStatus() {
  const rpc = useRpc<typeof githubRpcContract>();
  const fetchStatus = useCallback(() => rpc.call("status"), [rpc]);
  const { value: status, error } = useReadModel(statusModels, "status", fetchStatus);

  return { status, error };
}

export function useIssueMutations() {
  const rpc = useRpc<typeof githubRpcContract>();

  const setAssignees = useCallback(
    (repo: string, number: number, assignees: string[]) =>
      rpc.call("setAssignees", { repo, number, assignees }),
    [rpc],
  );

  const setLabels = useCallback(
    (repo: string, number: number, labels: string[]) =>
      rpc.call("setLabels", { repo, number, labels }),
    [rpc],
  );

  return { setAssignees, setLabels };
}

type RefreshState = { syncing: boolean; failure: string | null };

let refreshState: RefreshState = { syncing: false, failure: null };

const refreshListeners = new Set<() => void>();

function setRefreshState(next: RefreshState): void {
  refreshState = next;

  for (const listener of refreshListeners) listener();
}

function subscribeRefresh(listener: () => void) {
  refreshListeners.add(listener);

  return () => refreshListeners.delete(listener);
}

export function useGithubRefresh() {
  const rpc = useRpc<typeof githubRpcContract>();
  const state = useSyncExternalStore(subscribeRefresh, () => refreshState);

  const refresh = useCallback(() => {
    if (refreshState.syncing) return;
    setRefreshState({ syncing: true, failure: null });
    rpc
      .call("refresh")
      .then(() => {
        pullModels.invalidate();
        statusModels.invalidate();
        setRefreshState({ syncing: false, failure: null });
      })
      .catch((error) => {
        const failure = errorText(error);
        setRefreshState({ syncing: false, failure });
        toast.error(`GitHub refresh failed: ${failure}`);
      });
  }, [rpc]);

  return { ...state, refresh };
}
