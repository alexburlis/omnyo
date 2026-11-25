import { usePluginResource } from "./plugin-resource";
import { useInboxSnapshot } from "@/hooks/queries/use-inbox-snapshot";
import { useThreadGroupActions } from "@/hooks/useThreadGroupActions";
import { setChatSelection, useChatSelection } from "./chat-selection";
import { useProjectSidebarItems } from "./plugin-project-sidebar-items";
import { PluginImagePreview } from "@/components/plugin/PluginImagePreview";
import { PluginResponsiveDrawerShell } from "@/components/plugin/PluginResponsiveDrawerShell";
import { useThreadInitialLoadPending } from "@/components/thread/ThreadInitialLoad";
import { threadIndicators } from "@omnyo/domain";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { ProjectIcon } from "@/components/sidebar/ProjectFace";
import { Icon } from "@omnyo/shared-ui/icon";
import type { PluginSdkApp } from "@omnyo/plugin-sdk";
import { PluginDiff } from "@/components/plugin/PluginDiff";
import { PluginBranchPicker } from "@/components/plugin/PluginBranchPicker";
import {
  usePluginBranches,
  usePluginCheckoutState,
} from "@/components/plugin/usePluginBranchPickerState";
import { LazyPluginNewThreadComposer } from "@/components/plugin/LazyPluginNewThreadComposer";
import { VoiceInputTextarea } from "@/components/promptbox/VoiceInputTextarea";
import { LazyPluginProviderModelPicker } from "@/components/plugin/LazyPluginProviderModelPicker";
import { LazyPluginMarkdown } from "@/components/plugin/LazyPluginMarkdown";
import { PluginPermissionModePicker } from "@/components/plugin/PluginPermissionModePicker";
import { PluginSourceCode } from "@/components/plugin/PluginSourceCode";
import { LazyPluginThreadChat } from "@/components/plugin/LazyPluginThreadChat";
import { PluginThreadTitle } from "@/components/plugin/PluginThreadTitle";
import { ThreadStatusGlyph } from "@/components/thread/ThreadStatusGlyph";
import { PluginUrlLink } from "@/components/plugin/PluginUrlLink";
import { ExperimentalFileLink } from "@/components/plugin/ExperimentalFileLink";
import { usePluginId } from "@/components/plugin/plugin-context";
import { useQuestionFormHost } from "@omnyo/shared-ui/question-form-host";
import { definePluginApp } from "./plugin-app-definition";
import {
  experimental_useAppContext,
  experimental_useVisibleAppContext,
  experimental_useAppNavigate,
  useComposer,
  useComposers,
  useComposerView,
  useEnvironmentProviders,
  useProviders,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  experimental_useThreadBootstrapData,
  useThreadWork,
  useSdk,
  useSettings,
  experimental_useAppPanel,
  experimental_useActionHistory,
  experimental_useFixedTabTarget,
} from "./plugin-sdk-hooks";
import {
  useSidebarThreadActions,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadPullRequest,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  useSidebarThreadShortcut,
  useSidebarThreads,
} from "./plugin-sidebar-hooks";
import {
  useSidebarSplitLayout,
  useSidebarThreadSplit,
} from "./plugin-sidebar-split";
import { experimental_THREAD_ACTION_GROUPS } from "@omnyo/plugin-sdk";
import {
  ThreadActionsContextMenu,
  ThreadActionsMenu,
} from "@/components/thread/ThreadActionsMenu";
import { useThreadActions } from "@/lib/thread-actions/thread-actions-context";
import {
  useThreadActionEntries,
  useThreadActionRegistrationInfos,
} from "./thread-actions/thread-action-registry";
import { useCodeTheme } from "./plugin-code-theme";
import { copyToClipboard } from "./clipboard";
import { getNativeFileResolver } from "./native-files";
import {
  ThreadMergeBasePicker,
  useThreadGit,
} from "@/views/thread-detail/ThreadGitContext";

function useArchiveEnvironmentThreads(): (
  environmentId: string,
) => Promise<void> {
  return useThreadActions().archiveEnvironmentThreads;
}

export const pluginSdkAppImplementation = {
  usePluginResource,
  experimental_useProjectSidebarItems: useProjectSidebarItems,
  experimental_useInitialLoadPending: useThreadInitialLoadPending,
  definePluginApp,
  experimental_Icon: Icon,
  experimental_ProviderIcon: ProviderIcon,
  experimental_ProjectIcon: ProjectIcon,
  experimental_useAppContext: experimental_useAppContext,
  experimental_useVisibleAppContext,
  experimental_usePluginId: usePluginId,
  experimental_useQuestionFormHost: useQuestionFormHost,
  experimental_useAppNavigate: experimental_useAppNavigate,
  experimental_useAppPanel,
  experimental_useActionHistory,
  experimental_useFixedTabTarget,
  useComposer,
  useComposers,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  experimental_useThreadBootstrapData,
  experimental_useThreadWork: useThreadWork,
  experimental_useInboxSnapshot: useInboxSnapshot,
  useSettings,
  ThreadChat: LazyPluginThreadChat,
  experimental_ResponsiveDrawerShell: PluginResponsiveDrawerShell,
  Markdown: LazyPluginMarkdown,
  experimental_ImagePreview: PluginImagePreview,
  experimental_FileLink: ExperimentalFileLink,
  UrlLink: PluginUrlLink,
  experimental_NewThreadComposer: LazyPluginNewThreadComposer,
  experimental_VoiceInputTextarea: VoiceInputTextarea,
  experimental_ProviderModelPicker: LazyPluginProviderModelPicker,
  experimental_PermissionModePicker: PluginPermissionModePicker,
  experimental_BranchPicker: PluginBranchPicker,
  experimental_useBranches: usePluginBranches,
  experimental_useCheckoutState: usePluginCheckoutState,
  experimental_useThreadGit: useThreadGit,
  experimental_ThreadMergeBasePicker: ThreadMergeBasePicker,
  experimental_SourceCode: PluginSourceCode,
  experimental_Diff: PluginDiff,
  experimental_useSidebarThreads: useSidebarThreads,
  experimental_useChatSelection: useChatSelection,
  experimental_setChatSelection: setChatSelection,
  experimental_useThreadGroupActions: useThreadGroupActions,
  experimental_useSidebarThreadActions: useSidebarThreadActions,
  experimental_useThreadActions: useThreadActionEntries,
  experimental_useArchiveEnvironmentThreads: useArchiveEnvironmentThreads,
  experimental_useThreadActionRegistrations: useThreadActionRegistrationInfos,
  experimental_ThreadActionsMenu: ThreadActionsMenu,
  experimental_ThreadActionsContextMenu: ThreadActionsContextMenu,
  experimental_THREAD_ACTION_GROUPS,
  experimental_useSidebarThreadPullRequest: useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit: useSidebarThreadSplit,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  useSidebarSplitLayout,
  useSidebarThreadShortcut,
  ThreadTitle: PluginThreadTitle,
  experimental_ThreadStatusGlyph: ThreadStatusGlyph,
  experimental_ThreadAttention: NativeThreadAttention,
  experimental_threadIndicators: threadIndicators,
  useEnvironmentProviders,
  useSdk,
  experimental_useProviders: useProviders,
  experimental_useCodeTheme: useCodeTheme,
  experimental_copyToClipboard: copyToClipboard,
  experimental_getNativeFileResolver: getNativeFileResolver,
} satisfies PluginSdkApp;

import { NativeThreadAttention } from "@/components/thread/user-questions/NativeThreadAttention";
