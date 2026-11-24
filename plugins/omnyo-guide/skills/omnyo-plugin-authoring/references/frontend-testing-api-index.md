# Frontend testing API symbol index

Use the app entrypoint for `app.tsx` tests.
Use the host entrypoint for host-worker tests.
Read `testing.md` for examples and fidelity limits.

## `@omnyo/plugin-sdk/testing/app`

- `RpcCall`
- `SdkCall`
- `PluginSdkTestFakes`
- `NavigateCall`
- `ExperimentalFixedTabOpenCall`
- `ComposerLog`
- `ExperimentalTestActionHistory` — `slot.inspection.experimental_actionHistory`:
  `undoLabels` and `redoLabels`, oldest first, and `undo()` and `redo()`, which
  replay the newest entry the way Cmd+Z and Cmd+Shift+Z do
- `ThreadGroupActionCall` — a recorded group, rename, ungroup, or move call in
  `slot.inspection.experimental_threadGroupActionCalls`
- `SidebarActionCall` — deprecated, runtime-only for older plugins' tests of
  `experimental_useSidebarThreadActions`
- `TestThreadActionsResolver` — what `renderSlot` `options.threadActions` returns for
  `experimental_useThreadActions(thread)` and the fake thread menus; receives
  the caller's `requestRename`
- `installTestPluginRuntime`
- `CapturedPluginApp`
- `PluginAppSource`
- `loadPluginApp`
- `ContentScriptTestMountOptions`
- `ContentScriptThreadRowStatusCall`
- `MountedPluginContentScripts`
- `mountPluginContentScripts`
- `PluginRpcTestHandlers`
- `RenderSlotOptions`
- `RenderedSlotBehaviorDrivers`
- `RenderedSlotInspectionState`
- `RenderedSlotLifecycleControls`
- `RenderedSlot`
- `renderSlot`

## `@omnyo/plugin-sdk/testing/host`

- `ExperimentalHostHarnessSignal`
- `ExperimentalCreateHostEntryHarnessOptions`
- `ExperimentalHostEntryHarness`
- `experimental_createHostEntryHarness`
