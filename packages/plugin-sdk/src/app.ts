import { threadIndicators } from "@omnyo/domain";
import type { PluginSdkApp } from "./app-contract.js";

export type * from "./app-contract.js";

export type * from "./json-value.js";

export type {
  PluginRpcCallArgs,
  PluginRpcContract,
  PluginRpcError,
  PluginRpcErrorCode,
  PluginRpcHandlers,
  PluginRpcIssuePathSegment,
  PluginRpcMethodContract,
  PluginRpcResult,
  PluginRpcValidationIssue,
  StandardSchemaV1,
  StandardSchemaV1InferInput,
  StandardSchemaV1InferOutput,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./rpc-contract.js";

/**
 * `@omnyo/plugin-sdk/app` — typed facade over the Omnyo app's plugin runtime.
 *
 * This module's runtime is never bundled into plugins: `omnyo plugin build`
 * swaps the specifier for a shim reading
 * `globalThis.__omnyoPluginRuntime.pluginSdkApp` (which the Omnyo app fills with
 * its real implementation before importing any plugin bundle). Code importing
 * this package directly (plugin unit tests, tooling) gets stable forwarders
 * instead: each export looks the runtime up when it is called or rendered,
 * not when this module loads, so it does not matter whether a test imports
 * its components before or after installing a runtime. Calling a hook or
 * rendering a component with no runtime installed throws.
 *
 * Shared hooks and host components, including experimental_Icon. The generic
 * host-provided UI kit was removed 2026-07-03,
 * plugin design §5.5: other components are vendored shadcn-style source from the
 * Omnyo registry (`npx shadcn add ./vendor/omnyo-ui/<name>.json`); `toast` comes from
 * `import { toast } from "sonner"` (runtime-shimmed to the host toaster).
 */

interface PluginRuntimeReact {
  createElement(type: unknown, props: unknown): unknown;
}

interface PluginRuntimeHost {
  __omnyoPluginRuntime?: { pluginSdkApp?: unknown; react?: PluginRuntimeReact };
}

type RuntimeFunctionName = {
  [Name in keyof PluginSdkApp]: PluginSdkApp[Name] extends (
    ...args: never[]
  ) => unknown
    ? Name
    : never;
}[keyof PluginSdkApp];

function runtimeHost(): PluginRuntimeHost["__omnyoPluginRuntime"] {
  return (globalThis as PluginRuntimeHost).__omnyoPluginRuntime;
}

// The global is the genuinely unknowable boundary here: the host app
// guarantees the shape via its own `satisfies PluginSdkApp` check.
function installedApp(): Partial<PluginSdkApp> | undefined {
  return runtimeHost()?.pluginSdkApp as Partial<PluginSdkApp> | undefined;
}

function runtimeMember<Name extends keyof PluginSdkApp>(
  name: Name,
): PluginSdkApp[Name] {
  const member = installedApp()?.[name] as PluginSdkApp[Name] | undefined;

  if (member === undefined) {
    throw new Error(
      `@omnyo/plugin-sdk/app: ${name} needs the Omnyo app's plugin runtime. In tests, call installTestPluginRuntime() from @omnyo/plugin-sdk/testing/app first.`,
    );
  }

  return member;
}

function runtimeFunction<Name extends RuntimeFunctionName>(
  name: Name,
): PluginSdkApp[Name] {
  const forward = (...args: unknown[]) =>
    (runtimeMember(name) as (...args: unknown[]) => unknown)(...args);

  return forward as PluginSdkApp[Name];
}

function runtimeComponent<Name extends keyof PluginSdkApp>(
  name: Name,
): PluginSdkApp[Name] {
  function RuntimeComponent(props: object): unknown {
    const react = runtimeHost()?.react;

    if (react === undefined) {
      throw new Error(
        `@omnyo/plugin-sdk/app: ${name} needs React on the Omnyo plugin runtime. In tests, call installTestPluginRuntime() from @omnyo/plugin-sdk/testing/app first.`,
      );
    }

    return react.createElement(runtimeMember(name), props);
  }

  RuntimeComponent.displayName = name;

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  return RuntimeComponent as unknown as PluginSdkApp[Name];
}

export const experimental_Icon = runtimeComponent("experimental_Icon");

export const experimental_ProviderIcon = runtimeComponent(
  "experimental_ProviderIcon",
);

export const experimental_ProjectIcon = runtimeComponent(
  "experimental_ProjectIcon",
);

// A definition is a frozen, branded object; building one needs no runtime,
// so a plugin's app.tsx can load before a test installs one.
export const definePluginApp: PluginSdkApp["definePluginApp"] = (setup) => {
  const app = installedApp();

  if (app?.definePluginApp !== undefined) return app.definePluginApp(setup);

  if (typeof setup !== "function") {
    throw new Error("definePluginApp expects a setup function");
  }

  return Object.freeze({ __omnyoPluginApp: true as const, setup });
};

export const ThreadChat = runtimeComponent("ThreadChat");

export const experimental_ResponsiveDrawerShell = runtimeComponent(
  "experimental_ResponsiveDrawerShell",
);

export const Markdown = runtimeComponent("Markdown");

export const experimental_ImagePreview = runtimeComponent(
  "experimental_ImagePreview",
);

export const experimental_FileLink = runtimeComponent("experimental_FileLink");

export const UrlLink = runtimeComponent("UrlLink");

export const experimental_NewThreadComposer = runtimeComponent(
  "experimental_NewThreadComposer",
);

export const experimental_VoiceInputTextarea = runtimeComponent(
  "experimental_VoiceInputTextarea",
);

export const experimental_ProviderModelPicker = runtimeComponent(
  "experimental_ProviderModelPicker",
);

export const experimental_PermissionModePicker = runtimeComponent(
  "experimental_PermissionModePicker",
);

export const experimental_BranchPicker = runtimeComponent(
  "experimental_BranchPicker",
);

export const experimental_useBranches = runtimeFunction(
  "experimental_useBranches",
);

export const experimental_useCheckoutState = runtimeFunction(
  "experimental_useCheckoutState",
);

export const experimental_useThreadGit = runtimeFunction(
  "experimental_useThreadGit",
);

export const experimental_ThreadMergeBasePicker = runtimeComponent(
  "experimental_ThreadMergeBasePicker",
);

// Host-owned code rendering (experimental — see docs/api_to_audit.md).
export const experimental_SourceCode = runtimeComponent(
  "experimental_SourceCode",
);

export const experimental_Diff = runtimeComponent("experimental_Diff");

export const experimental_useInitialLoadPending = runtimeFunction(
  "experimental_useInitialLoadPending",
);

export const useRpc = runtimeFunction("useRpc");

export const experimental_useThreadBootstrapData = runtimeFunction(
  "experimental_useThreadBootstrapData",
);

export const useRealtime = runtimeFunction("useRealtime");

export const useRealtimeConnectionState = runtimeFunction(
  "useRealtimeConnectionState",
);

export const useSettings = runtimeFunction("useSettings");

export const experimental_useVisibleAppContext = runtimeFunction(
  "experimental_useVisibleAppContext",
);

export const experimental_useAppContext = runtimeFunction(
  "experimental_useAppContext",
);

export const experimental_usePluginId = runtimeFunction(
  "experimental_usePluginId",
);

export const experimental_useQuestionFormHost = runtimeFunction(
  "experimental_useQuestionFormHost",
);

export const experimental_useAppNavigate = runtimeFunction(
  "experimental_useAppNavigate",
);

export const experimental_useAppPanel = runtimeFunction(
  "experimental_useAppPanel",
);

export const experimental_useActionHistory = runtimeFunction(
  "experimental_useActionHistory",
);

export const experimental_useFixedTabTarget = runtimeFunction(
  "experimental_useFixedTabTarget",
);

export const useComposer = runtimeFunction("useComposer");

export const useComposers = runtimeFunction("useComposers");

export const experimental_useInboxSnapshot = runtimeFunction(
  "experimental_useInboxSnapshot",
);

export const experimental_useThreadWork = runtimeFunction(
  "experimental_useThreadWork",
);

/** @internal Superseded by `useComposer()`; kept for plugins built against older SDKs. */
export const useComposerView = runtimeFunction("useComposerView");

// Sidebar surfaces for plugins that replace the thread list (experimental —
// see docs/api_to_audit.md).
export const experimental_useSidebarThreads = runtimeFunction(
  "experimental_useSidebarThreads",
);

export const experimental_useChatSelection = runtimeFunction(
  "experimental_useChatSelection",
);

export const experimental_setChatSelection = runtimeFunction(
  "experimental_setChatSelection",
);

export const experimental_useThreadGroupActions = runtimeFunction(
  "experimental_useThreadGroupActions",
);

/** @internal Superseded by the thread action registry, `useSdk().threads`, and `experimental_useAppNavigate()`; kept for plugins built against older SDKs. */
export const experimental_useSidebarThreadActions = runtimeFunction(
  "experimental_useSidebarThreadActions",
);

export const experimental_useThreadActions = runtimeFunction(
  "experimental_useThreadActions",
);

export const experimental_useArchiveEnvironmentThreads = runtimeFunction(
  "experimental_useArchiveEnvironmentThreads",
);

export const experimental_useThreadActionRegistrations = runtimeFunction(
  "experimental_useThreadActionRegistrations",
);

export const experimental_ThreadActionsMenu = runtimeComponent(
  "experimental_ThreadActionsMenu",
);

export const experimental_ThreadActionsContextMenu = runtimeComponent(
  "experimental_ThreadActionsContextMenu",
);

export { experimental_THREAD_ACTION_GROUPS } from "./thread-action-groups.js";

export const experimental_useSidebarThreadPullRequest = runtimeFunction(
  "experimental_useSidebarThreadPullRequest",
);

export const experimental_useSidebarThreadSplit = runtimeFunction(
  "experimental_useSidebarThreadSplit",
);

export const useSidebarThreadDraft = runtimeFunction("useSidebarThreadDraft");

export const useSidebarThreadDraftIds = runtimeFunction(
  "useSidebarThreadDraftIds",
);

export const useSidebarThreadRowStatus = runtimeFunction(
  "useSidebarThreadRowStatus",
);

export const useSidebarThreadRowStatuses = runtimeFunction(
  "useSidebarThreadRowStatuses",
);

export const useSidebarSplitLayout = runtimeFunction("useSidebarSplitLayout");

export const useSidebarThreadShortcut = runtimeFunction(
  "useSidebarThreadShortcut",
);

export const ThreadTitle = runtimeComponent("ThreadTitle");

export const experimental_ThreadStatusGlyph = runtimeComponent(
  "experimental_ThreadStatusGlyph",
);

export const useEnvironmentProviders = runtimeFunction(
  "useEnvironmentProviders",
);

// Omnyo's public API client bound to the calling plugin.
export const useSdk = runtimeFunction("useSdk");

// The provider directory (experimental — see docs/api_to_audit.md).
export const experimental_useProviders = runtimeFunction(
  "experimental_useProviders",
);

// The live code theme, for plugins that render code with their own engine
// (experimental — see docs/api_to_audit.md).
export const experimental_useCodeTheme = runtimeFunction(
  "experimental_useCodeTheme",
);

// Omnyo's clipboard writer, the one Omnyo's own copy actions use (experimental —
// see docs/api_to_audit.md).
export const experimental_copyToClipboard = runtimeFunction(
  "experimental_copyToClipboard",
);

export const experimental_getNativeFileResolver = runtimeFunction(
  "experimental_getNativeFileResolver",
);

export const experimental_ThreadAttention = runtimeComponent(
  "experimental_ThreadAttention",
);

export const experimental_threadIndicators = threadIndicators;

export const experimental_useProjectSidebarItems = runtimeFunction(
  "experimental_useProjectSidebarItems",
);
