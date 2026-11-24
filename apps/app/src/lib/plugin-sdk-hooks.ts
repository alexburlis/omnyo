import type { ComposerDraftSnapshot } from "@omnyo/plugin-sdk";
import {
  beginThreadInitialLoad,
  useThreadInitialLoad,
  useThreadInitialLoadPending,
} from "@/components/thread/ThreadInitialLoad";
import { subscribeComposerSubmitted } from "./composer-submissions";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import type {
  ExperimentalThreadBootstrapData,
  experimental_AppContext,
  experimental_AppNavigate,
  ComposerView,
  PluginComposerApi,
  PluginComposerScope,
  PluginComposerTextEffect,
  ExperimentalComposerSuggestion,
  PluginRealtimeConnectionState,
  PluginRpcContract,
  PluginRpcClient,
  experimental_PluginBrowserSdk,
  PluginEnvironmentProvider,
  PluginEnvironmentProvidersState,
  PluginProvidersState,
  PluginSettingsState,
  ExperimentalAppPanel,
  ExperimentalActionHistory,
  ExperimentalFixedTabTargetState,
  ExperimentalPluginFixedTabReference,
  JsonValue,
} from "@omnyo/plugin-sdk";
import { jsonValueSchema } from "@omnyo/domain";
import {
  PluginSlotOwnershipContext,
  usePluginId,
} from "@/components/plugin/plugin-context";
import { usePluginThreadPanelOpenHandler } from "@/components/plugin/plugin-thread-panel-navigation";
import {
  composerScopeIdentity,
  useOptionalPluginComposerView,
  usePluginComposerHost,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import {
  getComposerEditorBridges,
  subscribeComposerEditorBridge,
  subscribeComposerEditorBridges,
  useComposerEditorBridge,
} from "@/lib/composer-editor-registry";
import { createComposerHandleBinding } from "@omnyo/plugin-sdk/internal/composer-handle";
import {
  composerHandleController,
  listedComposerHandles,
  type ComposerSource,
} from "@/lib/plugin-composer-handle";
import { OmnyoHttpError, sdk } from "@/lib/sdk";
import { getPluginBoundSdk } from "@/lib/plugin-bound-sdk";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { requestComposerFocus } from "@/lib/composer-focus-requests";
import { setComposerTextEffect } from "@/lib/composer-text-effects";
import {
  parseComposerSuggestion,
  setComposerSuggestion,
} from "@/lib/composer-suggestions";
import { createKeyedListeners } from "@/lib/keyed-listeners";
import { useActionHistory } from "@/components/layout/ActionHistoryProvider";
import { replayStep } from "@/lib/action-history-replay";
import {
  usePromptDraftController,
  usePromptDraftSnapshot,
  type PromptDraftController,
  type PromptDraftScope,
} from "@/hooks/usePromptDraftStorage";
import { emptyPromptDraftState, isPromptDraftEmpty } from "@omnyo/client-core";
import {
  AUTOMATIONS_PLUGIN_ID,
  getPluginPanelRoutePath,
  getProjectComposeRoutePath,
  getRootComposeRoutePath,
  getThreadRoutePath,
  AUTOMATION_EDIT_ROUTE_PATH,
} from "@/lib/route-paths";
import { getPluginSlotSnapshot } from "@/lib/plugin-slots";
import {
  getWorkflowGraphPath,
  hasWorkflowsPanel,
  isStateMachinesPanel,
} from "@/lib/workflow-panel-routes";
import { useRouteState } from "@/hooks/useRouteState";
import { useStore } from "jotai";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { lookupCachedThread } from "@/lib/thread-cache-resolution";
import { useVisibleAppContext } from "./visible-app-context";
import { useChatOpenHaptic } from "./visible-chat-haptics";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { openThreadInSplit } from "@/lib/split-layout/openThreadInSplit";
import { useServerConnectionState } from "@/hooks/useServerConnectionState";
import { wsManager } from "@/lib/ws";
import { pluginSdkSettingsQueryKey } from "@/hooks/queries/query-keys";
import {
  prefetchThreadOpen,
  useThread,
  useThreadPluginBootstrap,
} from "@/hooks/queries/thread-queries";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { normalizeExperimentalFileOpenOptions } from "@/lib/live-file-navigation";
import {
  getPluginFixedTabOwnerId,
  useAppFixedTabTarget,
} from "@/lib/app-fixed-tab-navigation";

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

const subscribeToNoComposerSelection = () => () => {};

const getNoComposerSelection = () => null;

export function isAutomationEditRoutePath(pathname: string): boolean {
  return (
    matchPath({ path: AUTOMATION_EDIT_ROUTE_PATH, end: true }, pathname) !==
    null
  );
}

function serializePluginRpcInput(value: unknown): string {
  const ancestors = new Set<object>();

  function assertJson(current: unknown, path: string): void {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }

    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`rpc input at ${path} contains a non-finite number`);
      }

      return;
    }

    if (typeof current !== "object") {
      throw new Error(`rpc input at ${path} is not a JSON value`);
    }

    if (ancestors.has(current)) {
      throw new Error(`rpc input at ${path} is cyclic`);
    }

    ancestors.add(current);

    try {
      if (Array.isArray(current)) {
        current.forEach((item, index) => assertJson(item, `${path}[${index}]`));

        return;
      }

      const prototype = Object.getPrototypeOf(current) as object | null;

      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`rpc input at ${path} must be a plain JSON object`);
      }

      for (const key of Reflect.ownKeys(current)) {
        if (typeof key === "symbol") {
          throw new Error(`rpc input at ${path} contains a symbol key`);
        }
      }

      for (const [key, child] of Object.entries(current)) {
        assertJson(child, `${path}.${key}`);
      }
    } finally {
      ancestors.delete(current);
    }
  }

  assertJson(value, "$input");

  return JSON.stringify(value);
}

export async function callPluginRpc(
  fetchImpl: FetchLike,
  pluginId: string,
  method: string,
  input?: unknown,
): Promise<unknown> {
  const serializedInput = serializePluginRpcInput(input ?? null);

  const response = await fetchImpl(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(method)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serializedInput,
    },
  ).catch((cause) => {
    const error =
      cause instanceof Error
        ? cause
        : new Error("Plugin request failed", { cause });

    Reflect.set(error, "status", null);
    Reflect.set(error, "stage", "transport");

    throw error;
  });

  const body = (await response.json().catch((cause) => {
    const error = new Error(
      `rpc "${method}" failed (HTTP ${response.status})`,
      { cause },
    );

    Reflect.set(error, "status", response.status);
    Reflect.set(error, "stage", response.ok ? "response" : "http");
    Reflect.set(error, "code", "invalid_json");

    throw error;
  })) as {
    ok?: unknown;
    result?: unknown;
    error?: unknown;
  } | null;

  if (!response.ok || body?.ok !== true) {
    const structured =
      typeof body?.error === "object" && body.error !== null
        ? body.error
        : null;

    const message =
      structured !== null &&
      typeof Reflect.get(structured, "message") === "string"
        ? String(Reflect.get(structured, "message"))
        : typeof body?.error === "string"
          ? body.error
          : `rpc "${method}" failed (HTTP ${response.status})`;

    const error = new Error(message);

    Reflect.set(error, "status", response.status);
    Reflect.set(error, "stage", response.ok ? "response" : "http");

    if (structured !== null) {
      const code = Reflect.get(structured, "code");
      const issues = Reflect.get(structured, "issues");

      if (typeof code === "string") Reflect.set(error, "code", code);

      if (Array.isArray(issues)) Reflect.set(error, "issues", issues);
    }

    throw error;
  }

  return body.result;
}

export async function fetchPluginSdkSettings(
  fetchImpl: FetchLike,
  pluginId: string,
): Promise<Record<string, string | number | boolean> | null> {
  const response = await fetchImpl(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/settings`,
  );

  if (!response.ok) return null;

  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    values?: unknown;
  } | null;

  if (
    body?.ok !== true ||
    typeof body.values !== "object" ||
    body.values === null
  ) {
    return null;
  }

  const values: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(body.values)) {
    if (
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean"
    ) {
      values[key] = value;
    }
  }

  return values;
}

export function useRpc<
  Contract extends PluginRpcContract = PluginRpcContract,
>(): PluginRpcClient<Contract> {
  const pluginId = usePluginId();
  const initialLoad = useThreadInitialLoad();
  const [pendingCalls] = useState(() => new Set<() => void>());
  useEffect(
    () => () => {
      for (const finish of pendingCalls) finish();
      pendingCalls.clear();
    },
    [initialLoad, pendingCalls, pluginId],
  );

  const client = useMemo(
    () => ({
      call: (method: string, input?: unknown) => {
        const finish = initialLoad?.begin() ?? beginThreadInitialLoad(input);

        pendingCalls.add(finish);

        return callPluginRpc(fetch, pluginId, method, input).finally(() => {
          pendingCalls.delete(finish);
          finish();
        });
      },
    }),
    [initialLoad, pendingCalls, pluginId],
  );

  return client as PluginRpcClient<Contract>;
}

export function useThreadWork(threadId: string | null) {
  return (
    useThread(threadId ?? "", { refetchOnMount: false }).data?.work ?? null
  );
}

export const experimental_useThreadBootstrapData =
  function useThreadBootstrapData(
    threadId: string,
    method: string,
  ): ExperimentalThreadBootstrapData {
    const pluginId = usePluginId();
    const route = useRouteState();

    const bootstrap = useThreadPluginBootstrap(threadId, {
      enabled: false,
    });

    if (bootstrap.isError)
      return {
        status: "error",
        message: "Conversation data could not load.",
        updatedAt: bootstrap.errorUpdatedAt,
      };

    if (!bootstrap.data) return { status: "pending" };

    const entry = bootstrap.data.experimental_pluginData?.find(
      (entry) => entry.pluginId === pluginId && entry.method === method,
    );

    if (!entry) return { status: "unavailable" };

    return entry.outcome.ok
      ? {
          status: "ready",
          result: entry.outcome.result,
          updatedAt: bootstrap.dataUpdatedAt,
          current:
            route.threadId === threadId &&
            bootstrap.dataUpdatedAt >= route.entryStartedAt,
        }
      : {
          status: "error",
          message: entry.outcome.error.message,
          updatedAt: bootstrap.dataUpdatedAt,
        };
  };

export function useRealtime(
  channel: string,
  handler: (payload: unknown) => void,
): void {
  const pluginId = usePluginId();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(
    () =>
      wsManager.onPluginSignal((signal) => {
        if (signal.pluginId !== pluginId || signal.channel !== channel) return;
        handlerRef.current(signal.payload);
      }),
    [pluginId, channel],
  );
}

export function useRealtimeConnectionState(): PluginRealtimeConnectionState {
  return useServerConnectionState();
}

export function useSettings(): PluginSettingsState {
  const pluginId = usePluginId();

  const query = useQuery({
    queryKey: pluginSdkSettingsQueryKey(pluginId),
    queryFn: () => fetchPluginSdkSettings(fetch, pluginId),
    staleTime: 30_000,
  });

  useThreadInitialLoadPending(query.isLoading);

  return {
    values: query.data ?? undefined,
    isLoading: query.isLoading,
  };
}

const EMPTY_PROVIDERS: readonly never[] = [];

export function useProviders(): PluginProvidersState {
  const query = useSystemProviders();
  const providers = query.data;

  return useMemo<PluginProvidersState>(
    () =>
      providers === undefined
        ? {
            status: query.isError ? "error" : "loading",
            providers: EMPTY_PROVIDERS,
          }
        : { status: "ready", providers },
    [providers, query.isError],
  );
}

export function useSdk(): experimental_PluginBrowserSdk {
  const pluginId = usePluginId();
  const queryClient = useQueryClient();

  return getPluginBoundSdk(sdk, pluginId, queryClient);
}

const EMPTY_ENVIRONMENT_PROVIDERS: readonly PluginEnvironmentProvider[] = [];

export function useEnvironmentProviders(): PluginEnvironmentProvidersState {
  const { providers } = useSystemEnvironmentProviders();

  return useMemo<PluginEnvironmentProvidersState>(
    () =>
      providers === undefined
        ? { status: "loading", providers: EMPTY_ENVIRONMENT_PROVIDERS }
        : {
            status: "ready",
            providers: providers.map((provider) => ({
              id: provider.id,
              displayName: provider.displayName,
              description: provider.description,
              icon: provider.icon,
              logoUrl: provider.logoUrl,
              pluginId: provider.pluginId,
              machineProviderId: provider.machineProviderId,
            })),
          },
    [providers],
  );
}

function useExperimentalAppContext(): experimental_AppContext {
  const { projectId, threadId } = useRouteState();

  return useMemo(
    () => ({ projectId: projectId ?? null, threadId: threadId ?? null }),
    [projectId, threadId],
  );
}

function useExperimentalAppNavigate(): experimental_AppNavigate {
  const pluginId = usePluginId();
  const location = useLocation();
  const openThreadPanelHandler = usePluginThreadPanelOpenHandler();
  const navigate = useNavigate();
  const appNavigation = useAppNavigationHost();
  const store = useStore();
  const queryClient = useQueryClient();
  const isCompact = useIsCompactViewport();
  const setRootComposeProjectId = useSetRootComposeProjectId();

  const playChatOpenHaptic = useChatOpenHaptic();

  const toThread = useCallback<experimental_AppNavigate["toThread"]>(
    (threadId, options) => {
      if (
        options &&
        "experimental_userInitiated" in options &&
        options.experimental_userInitiated === true
      ) {
        playChatOpenHaptic(threadId);
      }

      const open = (projectId: string) => {
        store.set(getThreadConversationCollapsedAtom(threadId), false);

        if (options?.split) {
          openThreadInSplit({
            store,
            navigate,
            projectId,
            threadId,
            isCompact,
          });

          return;
        }

        void navigate(getThreadRoutePath({ projectId, threadId }));
      };

      const cached = lookupCachedThread(queryClient, threadId);

      if (cached !== null) {
        open(cached.projectId);

        return;
      }

      void sdk.threads
        .get({ threadId })
        .then((thread) => open(thread.projectId))
        .catch(() => navigate(`/threads/${threadId}`));
    },
    [isCompact, navigate, playChatOpenHaptic, queryClient, store],
  );

  const experimental_prefetchThreadOpen = useCallback<
    experimental_AppNavigate["experimental_prefetchThreadOpen"]
  >((threadId) => prefetchThreadOpen(queryClient, threadId), [queryClient]);

  const toProject = useCallback(
    (projectId: string) => {
      void navigate(getProjectComposeRoutePath(projectId));
    },
    [navigate],
  );

  const toPluginPanel = useCallback(
    (path: string, options?: { subPath?: string; replace?: boolean }) => {
      const panel = { pluginId, path };

      const route =
        isStateMachinesPanel(panel) &&
        hasWorkflowsPanel(getPluginSlotSnapshot().navPanels)
          ? getWorkflowGraphPath(options?.subPath)
          : getPluginPanelRoutePath({ ...panel, subPath: options?.subPath });

      void navigate(route, options?.replace ? { replace: true } : undefined);
    },
    [navigate, pluginId],
  );

  const toCompose = useCallback<experimental_AppNavigate["toCompose"]>(
    (options) => {
      const replacesAutomationEditRoute =
        pluginId === AUTOMATIONS_PLUGIN_ID &&
        isAutomationEditRoutePath(location.pathname);

      if (options?.projectId !== undefined) {
        setRootComposeProjectId(options.projectId);
      }

      const hostId = options?.hostId?.trim() ?? "";
      void navigate(getRootComposeRoutePath(), {
        ...(replacesAutomationEditRoute ? { replace: true } : {}),
        state: {
          focusPrompt: options?.focusPrompt ?? false,
          initialPrompt: options?.initialPrompt ?? "",
          ...(options?.placement !== undefined
            ? { placement: options.placement }
            : {}),
          ...(options?.environmentId !== undefined
            ? { reuseEnvironmentId: options.environmentId }
            : {}),
          ...(hostId.length > 0 ? { newEnvironmentHostId: hostId } : {}),
          ...(replacesAutomationEditRoute
            ? { replaceInitialPrompt: true }
            : {}),
        },
      });
    },
    [location.pathname, navigate, pluginId, setRootComposeProjectId],
  );

  const openThreadPanel = useCallback<
    experimental_AppNavigate["openThreadPanel"]
  >(
    (options) => openThreadPanelHandler?.({ ...options, pluginId }) ?? false,
    [openThreadPanelHandler, pluginId],
  );

  const openUrl = useCallback<experimental_AppNavigate["openUrl"]>(
    (url) => appNavigation.openUrl({ url }),
    [appNavigation],
  );

  const experimental_openFilePreview = useCallback<
    experimental_AppNavigate["experimental_openFilePreview"]
  >(
    (options) => {
      const normalized = normalizeExperimentalFileOpenOptions(options);

      return normalized !== null && appNavigation.openFilePreview(normalized);
    },
    [appNavigation],
  );

  const experimental_openFileExternally = useCallback<
    experimental_AppNavigate["experimental_openFileExternally"]
  >(
    (options) => {
      const normalized = normalizeExperimentalFileOpenOptions(options);

      return (
        normalized !== null && appNavigation.openFileExternally(normalized)
      );
    },
    [appNavigation],
  );

  const experimental_openTerminal = useCallback<
    experimental_AppNavigate["experimental_openTerminal"]
  >(
    async ({ terminalId }) => {
      const session = await sdk.terminals
        .get({ terminalId })
        .catch((error: unknown) => {
          if (error instanceof OmnyoHttpError && error.status === 404)
            return null;
          throw error;
        });

      return session !== null && appNavigation.openTerminal(session);
    },
    [appNavigation],
  );

  return useMemo<experimental_AppNavigate>(
    () => ({
      toThread,
      experimental_prefetchThreadOpen,
      toProject,
      experimental_openProjectCreator: appNavigation.openProjectCreator,
      toPluginPanel,
      toCompose,
      openThreadPanel,
      experimental_openFileExternally,
      experimental_openFilePreview,
      experimental_openTerminal,
      openUrl,
    }),
    [
      toThread,
      experimental_prefetchThreadOpen,
      toProject,
      appNavigation.openProjectCreator,
      toPluginPanel,
      toCompose,
      openThreadPanel,
      experimental_openFileExternally,
      experimental_openFilePreview,
      experimental_openTerminal,
      openUrl,
    ],
  );
}

function useExperimentalAppPanel(): ExperimentalAppPanel {
  const pluginId = usePluginId();
  const appNavigation = useAppNavigationHost();

  const openFixedTab = useCallback<ExperimentalAppPanel["openFixedTab"]>(
    (options) => {
      const targetResult =
        options.target === undefined
          ? null
          : jsonValueSchema.safeParse(options.target);

      if (targetResult !== null && !targetResult.success) return false;

      return appNavigation.openFixedTab({
        surface: options.surface,
        tab: {
          ownerId: getPluginFixedTabOwnerId(pluginId, options.tab.panelId),
          tabId: options.tab.id,
        },
        ...(targetResult?.success === true
          ? { target: targetResult.data }
          : {}),
      });
    },
    [appNavigation, pluginId],
  );

  return useMemo(() => ({ openFixedTab }), [openFixedTab]);
}

function useExperimentalFixedTabTarget<Target extends JsonValue>(
  tab: ExperimentalPluginFixedTabReference<Target>,
): ExperimentalFixedTabTargetState<Target> | null {
  const pluginId = usePluginId();

  const state = useAppFixedTabTarget(
    getPluginFixedTabOwnerId(pluginId, tab.panelId),
    tab.id,
  );

  if (state === null || tab.experimental_target === undefined) return null;

  try {
    if (!tab.experimental_target.validate(state.target)) return null;
  } catch {
    return null;
  }

  return {
    clear: state.clear,
    sequence: state.sequence,
    target: state.target,
  };
}

function useExperimentalActionHistory(): ExperimentalActionHistory {
  const history = useActionHistory();
  useSyncExternalStore(
    history.subscribe,
    history.getVersion,
    history.getVersion,
  );
  const { canUndo, canRedo } = history;

  return useMemo(
    () => ({
      record: (entry) => history.record(entry),
      undo: () => replayStep(history, "undo"),
      redo: () => replayStep(history, "redo"),
      canUndo,
      canRedo,
    }),
    [history, canUndo, canRedo],
  );
}

export {
  useExperimentalActionHistory as experimental_useActionHistory,
  useExperimentalAppContext as experimental_useAppContext,
  useVisibleAppContext as experimental_useVisibleAppContext,
  useExperimentalAppNavigate as experimental_useAppNavigate,
  useExperimentalAppPanel as experimental_useAppPanel,
  useExperimentalFixedTabTarget as experimental_useFixedTabTarget,
};

function createComposerScopeOwnership(scopeKey: string) {
  let active = true;

  return {
    scopeKey,
    activate() {
      active = true;
    },
    invalidate() {
      active = false;
    },
    isActive() {
      return active;
    },
  };
}

let composerVisualOwnerSequence = 0;

type ComposerInputLockListener = () => void;

type ComposerInputLockOwner = string | symbol;

const inputLocksByStorageKey = new Map<
  string,
  Map<ComposerInputLockOwner, string>
>();

const inputLockListeners = createKeyedListeners<string>();

export function getComposerInputLock(storageKey: string | null): boolean {
  if (storageKey === null) return false;

  return (inputLocksByStorageKey.get(storageKey)?.size ?? 0) > 0;
}

function setComposerInputLock(
  storageKey: string | null,
  pluginId: string,
  locked: boolean,
  owner: ComposerInputLockOwner,
): void {
  if (storageKey === null) return;
  const wasLocked = getComposerInputLock(storageKey);
  let owners = inputLocksByStorageKey.get(storageKey);

  if (locked) {
    if (!owners) {
      owners = new Map();
      inputLocksByStorageKey.set(storageKey, owners);
    }

    owners.set(owner, pluginId);
  } else {
    owners?.delete(owner);

    if (owners?.size === 0) inputLocksByStorageKey.delete(storageKey);
  }

  if (getComposerInputLock(storageKey) !== wasLocked) {
    inputLockListeners.notify(storageKey);
  }
}

function subscribeComposerInputLock(
  storageKey: string | null,
  listener: ComposerInputLockListener,
): () => void {
  if (storageKey === null) return () => {};

  return inputLockListeners.subscribe(storageKey, listener);
}

export function useComposerInputLock(storageKey: string | null): boolean {
  const subscribe = useCallback(
    (listener: ComposerInputLockListener) =>
      subscribeComposerInputLock(storageKey, listener),
    [storageKey],
  );

  const getSnapshot = useCallback(
    () => getComposerInputLock(storageKey),
    [storageKey],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

type ComposerDraftSource = Pick<
  PromptDraftController,
  "getCurrent" | "subscribe"
>;

const EMPTY_COMPOSER_DRAFT = emptyPromptDraftState();

const NO_COMPOSER_DRAFT_SOURCE: ComposerDraftSource = {
  getCurrent: () => EMPTY_COMPOSER_DRAFT,
  subscribe: () => () => {},
};

function useComposerDraftSource(
  composerHost: PluginComposerHost | null,
  routeDraft: PromptDraftController,
): ComposerDraftSource {
  const hostGetCurrent = composerHost?.getCurrent;
  const hostSubscribe = composerHost?.subscribeDraft;

  return useMemo(
    () =>
      hostGetCurrent !== undefined && hostSubscribe !== undefined
        ? { getCurrent: hostGetCurrent, subscribe: hostSubscribe }
        : routeDraft,
    [hostGetCurrent, hostSubscribe, routeDraft],
  );
}

export function useComposerView(): ComposerView {
  const providedView = useOptionalPluginComposerView();
  const composerHost = usePluginComposerHost();
  const { projectId, threadId } = useRouteState();

  const routeScope: PromptDraftScope = useMemo(
    () =>
      threadId !== undefined && projectId !== undefined
        ? { kind: "thread", projectId, threadId }
        : { kind: "new-thread" },
    [projectId, threadId],
  );

  const routeDraft = usePromptDraftController(routeScope);
  const draftSource = useComposerDraftSource(composerHost, routeDraft);

  const draft = usePromptDraftSnapshot(
    providedView === undefined ? draftSource : NO_COMPOSER_DRAFT_SOURCE,
  );

  const fallback = useMemo<ComposerView>(
    () => ({
      scope:
        composerHost?.scope ??
        (threadId !== undefined
          ? { kind: "thread", threadId }
          : { kind: "new-thread", projectId: projectId ?? null }),
      layout: "expanded",
      draft: {
        text: draft.text,
        isEmpty: isPromptDraftEmpty(draft),
        attachmentCount: draft.attachments.length,
      },
      run: { isRunning: false, isSubmitting: false },
    }),
    [composerHost?.scope, draft, projectId, threadId],
  );

  return providedView ?? fallback;
}

function useComposerHandle(): {
  composer: PluginComposerApi;
  subscribeChanges: (listener: () => void) => () => void;
} {
  const pluginId = usePluginId();
  const slotOwnershipRegistry = useContext(PluginSlotOwnershipContext);
  const composerHost = usePluginComposerHost();
  const tracksDraft = useRef(false);
  const tracksSelection = useRef(false);
  const { projectId, threadId } = useRouteState();

  const routeScope: PromptDraftScope = useMemo(
    () =>
      threadId !== undefined && projectId !== undefined
        ? { kind: "thread", projectId, threadId }
        : { kind: "new-thread" },
    [projectId, threadId],
  );

  const routeDraft = usePromptDraftController(routeScope);
  const draftSource = useComposerDraftSource(composerHost, routeDraft);

  const draftSnapshot = useCallback(
    () => (tracksDraft.current ? draftSource.getCurrent() : null),
    [draftSource],
  );

  useSyncExternalStore(draftSource.subscribe, draftSnapshot, draftSnapshot);

  const selectionSnapshot = useCallback(
    () =>
      tracksSelection.current ? (composerHost?.getSelection?.() ?? null) : null,
    [composerHost],
  );

  useSyncExternalStore(
    composerHost?.subscribeSelection ?? subscribeToNoComposerSelection,
    selectionSnapshot,
    getNoComposerSelection,
  );
  const textEffectKey = composerHost?.textEffectKey ?? routeDraft.storageKey;
  useComposerEditorBridge(textEffectKey);

  const composerScope = composerHost?.scope;

  const scope: PluginComposerScope = useMemo(
    () =>
      composerScope ??
      (threadId !== undefined
        ? { kind: "thread", threadId }
        : { kind: "new-thread", projectId: projectId ?? null }),
    [composerScope, projectId, threadId],
  );

  const scopeOwnershipKey = [
    pluginId,
    composerScopeIdentity(scope),
    textEffectKey,
  ].join("\u0000");

  const scopeOwnership = useMemo(
    () => createComposerScopeOwnership(scopeOwnershipKey),
    [scopeOwnershipKey],
  );

  const { visualStateOwner, visualStateOwnerOrder } = useMemo(
    () => ({
      visualStateOwner: Symbol(`${pluginId}:${scopeOwnershipKey}`),
      visualStateOwnerOrder: composerVisualOwnerSequence++,
    }),
    [pluginId, scopeOwnershipKey],
  );

  const releaseVisualState = useCallback(() => {
    scopeOwnership.invalidate();
    setComposerTextEffect(textEffectKey, pluginId, null, visualStateOwner);
    setComposerInputLock(textEffectKey, pluginId, false, visualStateOwner);
    setComposerSuggestion(
      textEffectKey,
      pluginId,
      null,
      visualStateOwner,
      visualStateOwnerOrder,
    );
  }, [
    pluginId,
    scopeOwnership,
    textEffectKey,
    visualStateOwner,
    visualStateOwnerOrder,
  ]);

  const registerVisualStateOwner = useCallback(() => {
    slotOwnershipRegistry?.register(visualStateOwner, releaseVisualState);
  }, [releaseVisualState, slotOwnershipRegistry, visualStateOwner]);

  const setTextEffect = useCallback(
    (effect: PluginComposerTextEffect | null) => {
      if (!scopeOwnership.isActive()) return;

      if (effect !== null) registerVisualStateOwner();
      setComposerTextEffect(
        textEffectKey,
        pluginId,
        effect,
        visualStateOwner,
        visualStateOwnerOrder,
      );
    },
    [
      pluginId,
      registerVisualStateOwner,
      scopeOwnership,
      textEffectKey,
      visualStateOwner,
      visualStateOwnerOrder,
    ],
  );

  const setInputLock = useCallback(
    (locked: boolean) => {
      if (!scopeOwnership.isActive()) return;

      if (locked) registerVisualStateOwner();
      setComposerInputLock(textEffectKey, pluginId, locked, visualStateOwner);
    },
    [
      pluginId,
      registerVisualStateOwner,
      scopeOwnership,
      textEffectKey,
      visualStateOwner,
    ],
  );

  const setSuggestion = useCallback(
    (suggestion: ExperimentalComposerSuggestion | null) => {
      const parsed =
        suggestion === null ? null : parseComposerSuggestion(suggestion);

      if (!scopeOwnership.isActive()) return;

      if (parsed !== null) registerVisualStateOwner();
      setComposerSuggestion(
        textEffectKey,
        pluginId,
        parsed,
        visualStateOwner,
        visualStateOwnerOrder,
      );
    },
    [
      pluginId,
      registerVisualStateOwner,
      scopeOwnership,
      textEffectKey,
      visualStateOwner,
      visualStateOwnerOrder,
    ],
  );

  useEffect(() => {
    scopeOwnership.activate();

    return () => {
      releaseVisualState();
      slotOwnershipRegistry?.unregister(visualStateOwner);
    };
  }, [
    releaseVisualState,
    scopeOwnership,
    slotOwnershipRegistry,
    visualStateOwner,
  ]);

  const submissionSubscriptions = useRef(new Set<() => void>());
  useEffect(
    () => () => {
      for (const unsubscribe of submissionSubscriptions.current) unsubscribe();
      submissionSubscriptions.current.clear();
    },
    [],
  );

  const onSubmitted = useCallback(
    (listener: (draft?: ComposerDraftSnapshot) => void) => {
      const unsubscribe = subscribeComposerSubmitted(scope, listener);
      submissionSubscriptions.current.add(unsubscribe);

      return () => {
        unsubscribe();
        submissionSubscriptions.current.delete(unsubscribe);
      };
    },
    [scope],
  );

  const source = useMemo<ComposerSource>(
    () =>
      composerHost ?? {
        scope,
        textEffectKey: routeDraft.storageKey,
        getCurrent: routeDraft.getCurrent,
        setDraft: routeDraft.setDraft,
        focus: () => requestComposerFocus(routeDraft.storageKey),
      },
    [
      composerHost,
      routeDraft.getCurrent,
      routeDraft.setDraft,
      routeDraft.storageKey,
      scope,
    ],
  );

  const controller = useMemo(
    () =>
      composerHandleController(pluginId, source, {
        setTextEffect,
        setInputLock,
        setSuggestion,
        onSubmitted,
      }),
    [onSubmitted, pluginId, setInputLock, setSuggestion, setTextEffect, source],
  );

  const [binding, setBinding] = useState(() =>
    createComposerHandleBinding(textEffectKey, controller),
  );

  let currentBinding = binding;

  if (binding.key !== textEffectKey) {
    currentBinding = createComposerHandleBinding(textEffectKey, controller);
    setBinding(currentBinding);
  }

  currentBinding.update(controller);

  const composer = useMemo(
    () =>
      new Proxy(currentBinding.handle, {
        get(target, property, receiver) {
          if (
            property === "text" ||
            property === "draft" ||
            property === "isEmpty" ||
            property === "attachmentCount"
          ) {
            tracksDraft.current = true;
          }

          if (property === "selection") {
            tracksSelection.current = true;
          }

          return Reflect.get(target, property, receiver);
        },
      }),
    [currentBinding],
  );

  const subscribeDraft = draftSource.subscribe;
  const subscribeSelection = composerHost?.subscribeSelection;

  const subscribeChanges = useCallback(
    (listener: () => void) => {
      const unsubscribes = [
        subscribeDraft(listener),
        ...(subscribeSelection === undefined
          ? []
          : [subscribeSelection(listener)]),
        subscribeComposerEditorBridge(textEffectKey, listener),
      ];

      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [subscribeDraft, subscribeSelection, textEffectKey],
  );

  return { composer, subscribeChanges };
}

export function useComposer(): PluginComposerApi {
  return useComposerHandle().composer;
}

export function useComposerDerivedValue<T>(
  read: (composer: PluginComposerApi) => T,
): { composer: PluginComposerApi; value: T } {
  const { composer, subscribeChanges } = useComposerHandle();
  const getSnapshot = () => read(composer);

  return {
    composer,
    value: useSyncExternalStore(subscribeChanges, getSnapshot, getSnapshot),
  };
}

function createComposerDraftsStore(hosts: readonly PluginComposerHost[]) {
  let snapshot = hosts.map((host) => host.getCurrent());
  let selections = hosts.map((host) => host.getSelection?.() ?? null);

  return {
    subscribe(listener: () => void): () => void {
      const unsubscribes = hosts.flatMap((host) => [
        host.subscribeDraft(listener),
        ...(host.subscribeSelection === undefined
          ? []
          : [host.subscribeSelection(listener)]),
      ]);

      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    getSnapshot() {
      const next = hosts.map((host) => host.getCurrent());
      const nextSelections = hosts.map((host) => host.getSelection?.() ?? null);

      if (
        next.some((draft, index) => draft !== snapshot[index]) ||
        nextSelections.some(
          (selection, index) => selection !== selections[index],
        )
      ) {
        snapshot = next;
        selections = nextSelections;
      }

      return snapshot;
    },
  };
}

export function useComposers(): readonly PluginComposerApi[] {
  const pluginId = usePluginId();

  const bridges = useSyncExternalStore(
    subscribeComposerEditorBridges,
    getComposerEditorBridges,
    getComposerEditorBridges,
  );

  const hosts = useMemo(
    () =>
      bridges
        .filter((bridge) => bridge.pluginCustomizable)
        .map((bridge) => bridge.host),
    [bridges],
  );

  const draftsStore = useMemo(() => createComposerDraftsStore(hosts), [hosts]);
  useSyncExternalStore(
    draftsStore.subscribe,
    draftsStore.getSnapshot,
    draftsStore.getSnapshot,
  );

  return useMemo(
    () => listedComposerHandles(pluginId, hosts),
    [hosts, pluginId],
  );
}
