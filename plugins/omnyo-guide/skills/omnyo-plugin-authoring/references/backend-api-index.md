# Backend API symbol index

Use this index to check backend, host, AI-service, and test imports.
Read the detailed backend references for behavior, fields, and examples.
Read the installed declarations for exact current signatures.

## `@omnyo/plugin-sdk`

- `PLUGIN_CLI_OUTPUT_MAX_BYTES`
- `defineRpcContract`
- `experimental_defineHostEntry`
- `defineCli`
- `cliCommand`
- `PluginCliError`
- `experimental_pluginPackageJsonSchemaV1` — core's zod schema for a plugin's
  `package.json`; parse unknown package metadata with it before reading its
  `omnyo` declarations. It accepts canonical metadata and the original V1
  fields, and rejects conflicting or malformed metadata and engine
  requirements
- `experimental_AppContext`
- `experimental_AppNavigate`
- `PluginApi`
- `ExperimentalPluginSettingSection` — the title and optional description of a
  settings group, supplied through a descriptor's `experimental_section`.
  Fields with the same title render together after ungrouped fields; repeat
  the same description for every field in that group.
- `CodeOverflowMode`
- `ComposerCustomization`
- `ComposerPlusMenuItem`
- `ComposerSendMenuItem`
- `ComposerRichTextSpec`
- `ComposerDraft`
- `ComposerMention`
- `ComposerInsertPart`
- `ComposerInsertOptions`
- `DiffProps`
- `DiffViewMode`
- `ExperimentalAppPanel`
- `ExperimentalAppPanelSurface`
- `ExperimentalDesktopBrowserAcquireInput`
- `ExperimentalDesktopBrowserCreateInput`
- `ExperimentalDesktopBrowserLease`
- `ExperimentalDesktopBrowserScope`
- `ExperimentalDesktopRendererProfileInput` — host, instance, generation, and duration
- `ExperimentalDesktopRendererProfile` — bounded renderer hotspot sample counts
- `ExperimentalDesktopBrowsersArea`
- `ExperimentalDiffFileContent`
- `ExperimentalDiffFullFileContents`
- `ExperimentalFileLinkProps`
- `ExperimentalFileLocation`
- `ExperimentalFileOpenOptions`
- `ExperimentalFixedTabTargetContract`
- `ExperimentalFixedTabTargetState`
- `ExperimentalHostCallOptions`
- `ExperimentalHostClient`
- `ExperimentalHostEntry`
- `ExperimentalHostPaths`
- `ExperimentalHostRpcContext`
- `ExperimentalHostRpcHandlers`
- `ExperimentalHostSignalContract`
- `ExperimentalHostSignalEvent`
- `ExperimentalHostSignals`
- `ExperimentalHostWatchChange`
- `ExperimentalHostWatchChangeType`
- `ExperimentalHostWatchEvent`
- `ExperimentalHostWatchListener`
- `ExperimentalHostWatchOptions`
- `ExperimentalHostWatchSubscription`
- `ExperimentalHostWorkerLease`
- `ExperimentalImagePreviewProps` — host raster lightbox props; see the
  frontend API index for authenticated object URL ownership
- `ExperimentalLiveFileTarget`
- `ExperimentalOpenFixedTabOptions`
- `ExperimentalPermissionModePickerProps`
- `ExperimentalPluginFixedTabReference`
- `ExperimentalPluginRpcCaller`
- `ExperimentalPluginRpcHandlerContext`
- `ExperimentalPluginRpcHandlersWithContext`
- `ExperimentalPluginErrorReport`
- `ExperimentalPluginWebSocket`
- `ExperimentalPluginWebSocketContext`
- `ExperimentalPluginWebSocketHandler`
- `ExperimentalPluginWebSocketHandlers`
- `ExperimentalProviderModelPickerProps`
- `ExperimentalProviderModelPickerRouting`
- `ExperimentalProviderModelPickerValue`
- `ExperimentalProjectIconProps` — decorative project mark props; see the
  frontend API index
- `ExperimentalThreadBootstrapData` — the shared conversation plugin-read
  result union; see the frontend API index for freshness semantics
- `ExperimentalVoiceInputTextareaProps`
- `JsonValue`
- `ReadonlyJsonValue` — deep-readonly JSON, e.g. `context.pluginMetadata` values
- `MarkdownProps`
- `NewThreadComposerProps`
- `NewThreadRequest`
- `MessageDispatchHookContext`
- `MessageDispatchHookDecision`
- `PluginDispatchAttemptKind`
- `PluginDispatchEnvironmentIntent`
- `PluginDispatchExecution`
- `PluginDispatchExecutionSources`
- `PluginEnvironments` — `api.experimental_environments`: `register` +
  `recheck` (see backend-events.md, environment providers)
- `PluginServerAccess` — `api.experimental_serverAccess.register`
- `PluginEventSources` — `api.experimental_eventSources.register` (see
  backend-event-sources.md)
- `PluginEventSourceDeclaration` — family, label, key format, examples,
  approval, validate, describe, poll and proof
- `PluginEventSourcePoll` — `everyMs` and the batched `check(targets, context)`
- `PluginEventSourceContext` — the abort signal passed to `check` and `proof`
- `PluginEventSourceFiring` — `{ target, result }` for a target that fired
- `PluginEventSourceProblem` — `{ target, problem }` for a target the source
  cannot check
- `ServerAccessProviderDeclaration`
- `ServerAccessGrant`
- `PluginMachineProviderResource` — non-null JSON persisted by machine checkpoints and lifecycle results
- `PluginMachines` — `api.experimental_machines.register` and bootstrap helper (see backend-machines.md)
- `MachineExecutorRequest` — argv, timeout, signal, optional private stdin
- `MachineExecutor` — transport exec
- `MachineBootstrapRequest` — durable key, optional executor and access selection, report, signal
- `MachineBootstrapApi` — bootstrap
- `PluginMachineProviderDeclaration`
- `PluginMachineValidateDecision`
- `PluginEnvironmentProviderDeclaration`
- `PluginEnvironmentProviderRequirements` — `requires`, e.g.
  `{ gitCheckout: true }`; also `projectCheckout`, `gitRemote` and `projectless`.
  Anything else comes through the declaration's `inputs` validator
- `PluginEnvironmentValidateDecision` — `{ action: "accept" }` or
  `{ action: "refuse", message }`, the message being the caller's error
- `PluginDispatchInput`
- `PluginHookHandler`
- `PluginHookName`
- `PluginHookSignatures`
- `PluginHooks`
- `PluginTurnFailedEvent`
- `ComposerSubmitOptions`
- `ComposerSelection`
- `PluginAgentConfiguration`
- `PluginAgentConfigurationContext`
- `PluginAgentToolContentPart`
- `PluginAgentToolContext`
- `PluginAgentToolRegistrationBase`
- `PluginAgentToolResult`
- `PluginAgentToolSelection`
- `PluginAgents`
- `PluginAiCompleteOptions`
- `PluginAiPrepareOptions`
- `PluginAiServiceDeclaration`
- `PluginAiServiceStatus`
- `PluginAiServices`
- `PluginAiTranscribeOptions`
- `PluginAppBuilder`
- `PluginAppComposer`
- `PluginAppContentScripts`
- `PluginAppDefinition`
- `PluginAppSetup`
- `PluginAppSlots`
- `PluginBackground`
- `PluginSdk` — `api.sdk`; thread plugin metadata calls default `pluginId`
  (see backend-sdk.md)
- `PluginCli`
- `PluginCliBooleanOption`
- `PluginCliCommand`
- `PluginCliCommandInfo`
- `PluginCliConstraint`
- `PluginCliContext`
- `PluginCliDurationOption`
- `PluginCliDurationUnit`
- `PluginCliEnumOption`
- `PluginCliErrorCode`
- `PluginCliExecutionResult`
- `PluginCliIntegerOption`
- `PluginCliOption`
- `PluginCliOptionValues`
- `PluginCliOutputLimitError`
- `PluginCliPositional`
- `PluginCliPositionalValues`
- `PluginCliRegistration`
- `PluginCliResult`
- `PluginCliRunInput`
- `PluginCliSpec`
- `PluginCliStringOption`
- `PluginCodeThemeData`
- `PluginCodeThemeState`
- `PluginCodeThemeTokenRule`
- `ExperimentalClipboardContent`
- `PluginAppCommands`
- `PluginCommandContext`
- `PluginCommandShortcut`
- `PluginCommandRegistration`
- `ExperimentalComposerCommandRegistration`
- `PluginComposerApi`
- `PluginComposerMention`
- `PluginComposerScope`
- `PluginComposerTextEffect`
- `PluginComposerThreadRowStatus`
- `PluginContentScriptContext`
- `PluginContentScriptDisposer`
- `PluginContentScriptRegistration`
- `PluginDiffRendererProps`
- `PluginDiffRendererRegistration`
- `PluginEvents`
- `PluginFileOpenerProps`
- `PluginFileOpenerRegistration`
- `PluginFileOpenerSource`
- `PluginFixedTabDeclaration`
- `PluginFixedTabRegistration`
- `PluginHomepageSectionProps`
- `PluginHomepageSectionRegistration`
- `PluginHosts`
- `PluginHttp`
- `PluginHttpAuthMode`
- `PluginHttpHandler`
- `PluginInteractionCancelReason`
- `PluginInteractionDescription`
- `PluginInteractionRequest`
- `PluginInteractionResult`
- `PluginKvStorage`
- `PluginLogger`
- `PluginMentionItem`
- `ExperimentalPluginMentionImage`
- `PluginMentionProviderRegistration`
- `PluginMentionSearchContext`
- `PluginMentionTrigger`
- `PluginMessageActionContext`
- `PluginMessageActionRegistration`
- `PluginMessageDirectiveMessage`
- `PluginMessageDirectiveOpenWorkspaceFile`
- `PluginMessageDirectiveProps`
- `ExperimentalCodeFenceRendererProps`
- `PluginMessageDirectiveRegistration`
- `ExperimentalCodeFenceRendererRegistration`
- `ExperimentalCodeFenceStatus`
- `PluginNavPanelProps`
- `PluginNavPanelRegistration`
- `PluginNewThreadPanelActionContext`
- `PluginNewThreadPanelActionRegistration`
- `PluginNewThreadPanelProps`
- `PluginPanelActionOpenOptions`
- `PluginPendingInteractionProps`
- `PluginPendingInteractionRegistration`
- `PluginPendingInteractionView`
- `PluginProviderCapabilities`
- `PluginProviderCompletedTurnDisplay`
- `PluginProviderComposerAction`
- `PluginProviderDeclaration`
- `ExperimentalPluginProviderEnvContext`
- `ExperimentalPluginProviderEnvEntry`
- `ExperimentalPluginProviderEnvHealthContext`
- `ExperimentalPluginProviderEnvHealth`
- `ExperimentalPluginProviderModelNoticeContext`
- `ExperimentalPluginProviderModelNotice`
- `PluginProviderExtensionKindDeclaration`
- `PluginProviderFallbackModel`
- `PluginProviderIconRegistration`
- `PluginProviderMaintenance`
- `PluginProviderModelCatalogScope`
- `PluginProviderNativeRootEntry`
- `PluginProviderNativeRoots`
- `PluginProviderOptionDescriptor`
- `PluginProviderOptionsContext`
- `PluginProviderPermissionMode`
- `PluginProviderReasoningLevel`
- `PluginProviderStrings`
- `PluginProviders`
- `PluginProvidersState`
- `PluginRealtime`
- `PluginRealtimeConnectionState`
- `PluginRowLabels`
- `PluginRowPresentation`
- `PluginRpc`
- `PluginRpcCallArgs`
- `PluginRpcClient`
- `PluginRpcContract`
- `PluginRpcError`
- `PluginRpcErrorCode`
- `PluginRpcHandlers`
- `PluginRpcIssuePathSegment`
- `PluginRpcMethodContract`
- `PluginRpcResult`
- `PluginRpcValidationIssue`
- `PluginSdkApp`
- `PluginSecrets` — `api.experimental_secrets`: vault-sealed string values by
  `/`-separated name (see backend-foundation.md)
- `PluginServerApi`
- `PluginSettingDescriptor`
- `PluginSettingDescriptors`
- `PluginSettingValue`
- `PluginSettings`
- `PluginSettingsHandle`
- `PluginSettingsSectionProps`
- `PluginSettingsSectionRegistration`
- `PluginSettingsState`
- `PluginSettingsValues`
- `PluginSharedPortTunnelIdentity`
- `PluginSidebarFooterActionContext`
- `PluginSidebarFooterActionProps`
- `PluginSidebarFooterActionRegistration`
- `PluginSidebarProject`
- `PluginSidebarPullRequest`
- `PluginSidebarSplitPane`
- `PluginSidebarThread`
- `PluginSidebarThreadActivity`
- `PluginSidebarThreadIndicator`
- `PluginSidebarThreadPullRequestState`
- `PluginSidebarThreadSplit`
- `PluginSidebarThreadsState`
- `PluginSourceCodeRendererProps`
- `PluginSourceCodeRendererRegistration`
- `PluginStatusApi`
- `PluginStorage`
- `PluginTargetedPanelActionOpenOptions`
- `PluginThreadEventHandler`
- `PluginThreadEventName`
- `PluginThreadEventPayloads`
- `PluginThreadHeaderActionProps`
- `PluginThreadHeaderActionRegistration`
- `PluginThreadListProps`
- `PluginThreadListRegistration`
- `PluginThreadPanelActionContext`
- `PluginThreadPanelActionRegistration`
- `PluginThreadPanelProps`
- `PluginThreadViewProps`
- `PluginThreadViewRegistration`
- `PluginTimelineRendererProps`
- `PluginTimelineRendererRegistration`
- `PluginTimelineRendererRow`
- `PluginTimelineRowPresentation`
- `PluginTimelineRowStatus`
- `PluginUi`
- `SourceCodeLineRange`
- `SourceCodeProps`
- `StandardSchemaV1`
- `StandardSchemaV1InferInput`
- `StandardSchemaV1InferOutput`
- `StandardSchemaV1Issue`
- `StandardSchemaV1Result`
- `ThreadChatMessageAction`
- `ThreadChatMessageReference`
- `ThreadChatProps`
- `UrlLinkProps`

## `@omnyo/plugin-sdk/environment-provider`

- `PluginEnvironmentProviderAvailabilityContext` and
  `PluginEnvironmentProviderAvailability` — context and result for a
  declaration's optional `availability` method
- `PluginEnvironmentProviderDefinition` — idempotent long-running `create`
  and `remove`, plus optional `validate`, `availability`,
  `restore`, `inputs` and policy
- `PluginEnvironmentProviderInputsSchema` — the `inputs` type parameter:
  a Standard Schema v1 validator (a zod schema is one), or `undefined` for
  `inputs: null` in `create`
- `PluginEnvironmentProviderPolicy` — `retireGraceMs`, `pathKeys`
- `PluginEnvironmentProviderValidateContext` — the `validate` context
  typed from `requires` and `inputs`, like the create context
- `PluginEnvironmentProviderCreateContext` — facts for a fresh environment,
  including the `suggestedBranchName` core would use
- `PluginEnvironmentProviderRestoreContext` — `restore`'s
  context: the creation inputs plus `previous.environment` and its private
  `previous.resource`
- `PluginEnvironmentProviderCreateResult` — `created` names the path and may
  carry the private, 16 KiB-capped JSON `resource`; the selected machine owns
  the host identity
- `PluginEnvironmentProviderProgress` — durable `step` and `log` updates
- `PluginEnvironmentProviderRemoveContext` — includes the private
  `resource` returned by the launch that made the environment
- `PluginEnvironmentProviderRemoveResult`

## `@omnyo/plugin-sdk/machine-provider`

- `PluginMachineProviderDefinition` — id, display, description, icon, inputs,
  availability, validation, create, optional paired suspend/resume,
  `ephemeral` automatic retirement policy, and remove
- `PluginMachineProviderInputsSchema`
- `PluginMachineProviderAvailability`
- `PluginMachineProviderValidateContext`
- `PluginMachineProviderCreateContext` — async `checkpoint(resource)` after
  preparing enrollment and allocating, before bootstrap; never bundle credentials
- `PluginMachineProviderCreateResult`
- `PluginMachineProviderLifecycleContext` — shared create, suspend and resume
  context with a durable `checkpoint` resource callback
- `PluginMachineProviderProgress`
- `PluginMachineProviderResourceResult`
- `PluginMachineProviderRemoveResult`

## `@omnyo/plugin-sdk/host`

- `experimental_assertStorageAdmission` checks directory capacity before allocation;
  `ExperimentalStorageAdmissionRequest` and `ExperimentalStorageAdmission` describe it.
- `experimental_inspectDirectoryProcesses` checks whether a directory is idle;
  `ExperimentalDirectoryProcessInspector` returns `ExperimentalDirectoryProcessInspection`
  with `idle`, `busy`, or `unknown` status. Unknown is not safe for cleanup.
- `experimental_inspectProcessPrivateTemps` inspects process-owned temporary files;
  `ExperimentalProcessPrivateTempInspectOptions` bounds the inspection.
- `experimental_recoverProcessPrivateTemps` uses
  `ExperimentalProcessPrivateTempRecoveryOptions` to bound recovery by time, count,
  and bytes. Both return `ExperimentalProcessPrivateTempInspection` entries.
- `experimental_defineHostEntry`
- `experimental_filterResolvedNativeRoots`
- `experimental_killProcessesWithCwdUnder` — reap processes whose cwd is under
  any of the given directories, before removing them; one process listing per
  call
- `experimental_nativeRootsHostContract`
- `experimental_nativeRootsResolveInputSchema`
- `experimental_nativeRootsResolveOutputSchema`
- `experimental_readProcessIdentity` — a PID's command line and start time,
  to confirm it is still the process you recorded before signalling it
- `experimental_resolveClaudePluginRoots`
- `experimental_resolveVendorPluginRoots`
- `experimental_runVcsProcess`
- `experimental_sanitizeInheritedChildProcessEnv`
- `experimental_spawnPortableOutputProcess`
- `ExperimentalClaudePluginRoots`
- `ExperimentalClaudePluginRootsArgs`
- `ExperimentalDroppedNativeRoot`
- `ExperimentalFilteredNativeRoots`
- `ExperimentalHostEntry`
- `ExperimentalHostPaths`
- `ExperimentalHostRpcContext`
- `ExperimentalHostRpcHandlers`
- `ExperimentalHostSignalContract`
- `ExperimentalHostSignals`
- `ExperimentalHostWatchChange`
- `ExperimentalHostWatchChangeType`
- `ExperimentalHostWatchEvent`
- `ExperimentalHostWatchListener`
- `ExperimentalHostWatchOptions`
- `ExperimentalHostWatchSubscription`
- `ExperimentalHostWorkerLease`
- `ExperimentalNativeRootsHostContract`
- `ExperimentalNativeRootsResolveAnswer`
- `ExperimentalNativeRootsResolveInput`
- `ExperimentalNativeRootsResolveOutput`
- `ExperimentalProcessIdentity`
- `ExperimentalQuestionFormHost`
- `ExperimentalQuestionShortcut`
- `ExperimentalSanitizeInheritedChildProcessEnvArgs`
- `ExperimentalVcsProcessOptions`
- `ExperimentalVcsProcessPriority`
- `ExperimentalVendorPlugin`
- `ExperimentalVendorPluginRoots`
- `ExperimentalVendorPluginRootsArgs`

## `@omnyo/plugin-sdk/testing`

- `ExperimentalFakeWebSocketRouteRecord`
- `ExperimentalFakeWebSocketSession`
- `PluginContextStaleError`
- `createFakePluginHost`
- `createFakeSdk`
- `experimental_scanPublicSdkOnly`
- `experimental_threadIndicatorCases` — shared `{ name, state, expected }`
  contract cases for core, SDK and replacement-list status tests; pair them
  with `experimental_threadIndicators.resolve(state)` from the app entrypoint
- `makeHostResponse`
- `makeMessageDispatchHookContext`
- `makePluginAgentConfigurationContext`
- `makeQueueEntry`
- `makeThreadResponse`
- `makeTurnFailedEvent`
- `CreateFakePluginHostOptions`
- `FakeAgentToolRecord`
- `FakeCliRecord`
- `FakeErrorReport`
- `FakeHttpRouteRecord`
- `FakeLogEntry`
- `FakeLogLevel`
- `FakeMentionProviderRecord`
- `FakePluginBehaviorDrivers`
- `ExperimentalFakeHostRpcCall`
- `FakePluginHarness`
- `FakePluginHost`
- `FakePluginInspectionState`
- `FakePluginLifecycleControls`
- `FakePluginRegistrations`
- `FakeRealtimeSignal`
- `FakeScheduleRecord`
- `FakeSdkCall`
- `FakeSdkHarness`
- `FakeSdkOverrides`
- `FakeServiceRecord`
- `PublicSdkOnlyScan`
- `PublicSdkOnlyScanOptions`
- `PublicSdkOnlyViolation`

## `@omnyo/plugin-sdk/testing/host`

- `experimental_createHostEntryHarness`
- `ExperimentalCreateHostEntryHarnessOptions`
- `ExperimentalHostEntryHarness`
- `ExperimentalHostHarnessSignal`
