# Physical iOS timeline-windowing acceptance

This standalone app loads a static, credential-free fixture that imports the
production `BottomAnchoredScrollBody` and renders its rows unwindowed, as the
production timeline does since windowing was removed on 7 November 2026. The
baseline and candidate launch modes below now render identically; they remain
only so existing XCTest cases keep their launch arguments.
Its custom `bbfixture:` scheme reads only the app-bundled Vite output. The app
starts no service, contacts no network host, and uses no conversation data.

The fixture seeds 500 deterministic mixed-height rows in two synthetic threads.
XCTest performs native touch flicks, queues prepend/image-resize/append changes
after touch-up, switches thread during deceleration, and exercises focus and
WebKit text selection. The collector sends numeric frame tuples only:
`[elapsedMs, scrollTop, mountedRows, anchorOrdinal, anchorOffsetPx,
threadIndex, phase, totalRows, visibleRows, resizedAboveViewportOrdinal,
queuedActionState, selectedRowOrdinal]`.
`phase` is 0 during touch, 1 after touch-up while scrolling, 2 after observed
WebKit `scrollend` plus quiet, and 3 after the no-`scrollend` quiet fallback.
The last value is `-1` until the fixture resizes a realized image above the
viewport. `queuedActionState` is 0 before a fixture touch-end, 1 when a scroll
touch-end arrives without an armed action, 2 when an armed action's end target
is outside the scroll root, 3 when it is inside fixture controls, 4 when a
queued mutation is consumed, and 5 when a queued thread switch is consumed.
`selectedRowOrdinal` is `-1` unless an active text range is anchored in a
connected synthetic row; otherwise it identifies that row. Each report also
includes the native device model, iOS version, and WebKit user agent. XCTest
retains the numeric report attachment per run.

The default launch is the baseline: production iOS detection remains active and
the existing guard should leave all 500 rows mounted. The candidate launch
argument masks only the iPhone/iPad/iPod token in `navigator.userAgent` before
the production component initializes. It exercises the production virtualized
path in the same physical WKWebView engine and keeps native touch input, but it
does not prove that a production iOS build should remove its guard. That decision
still requires a production candidate, matched repeated physical runs, stable
anchors, momentum comparison against baseline variation, and accessibility
inspection. Keep the production guard until that proof passes.

The prepend/resize/append, thread-switch, and text-selection XCTest cases use
the masked candidate path by default. Set the XCTest runner environment value
`OMNYO_IOS_WINDOWING_INTERACTION_MODE=baseline` to run those same cases with the
real iOS user agent and current unwindowed guard. Set it to `candidate` or leave
it unset for the masked diagnostic. This setting does not change the separate
baseline flick or focus-pin cases.

## Existing signing boundary

The project uses Manual signing with the existing Omnyo development team
`Z7T4C33A35` and wildcard development profile
`acb1c791-ca59-4d54-b985-458ead7b6c3b`. Both unique acceptance bundle identifiers
fit that profile, which includes the designated physical iPhone 14 Pro Max. It
does not modify app identifiers, profiles, accounts, or provisioning. Do not
pass `-allowProvisioningUpdates`; stop if this exact local profile is missing
or no longer covers both targets. The parent has confirmed that the exact phone
is dedicated to testing and has no installed `app.getbb.mobile` app.

## Parent-owned build and physical run

The parent owns Vite/Xcode execution, device UI, `.xcresult` review, and cleanup.
Run commands from the repository root only after the parent chooses a retained
scratch directory and confirms the existing signing profile is available:

```sh
pnpm --dir apps/app exec vite build \
  --config ../mobile/script/ios-performance-acceptance/vite.config.mts
xcodegen generate \
  --spec apps/mobile/script/ios-performance-acceptance/project.yml \
  --project "$IOS_WINDOWING_RUN_ROOT"
ln -s "$PWD/apps/mobile/script/ios-performance-acceptance/FixtureDist" \
  "$IOS_WINDOWING_RUN_ROOT/FixtureDist"
xcodebuild build-for-testing \
  -project "$IOS_WINDOWING_RUN_ROOT/OmnyoTimelineWindowingAcceptance.xcodeproj" \
  -scheme OmnyoTimelineWindowingAcceptance \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$IOS_WINDOWING_RUN_ROOT/build" \
  DEVELOPMENT_TEAM=Z7T4C33A35
xcodebuild test \
  -project "$IOS_WINDOWING_RUN_ROOT/OmnyoTimelineWindowingAcceptance.xcodeproj" \
  -scheme OmnyoTimelineWindowingAcceptance \
  -destination "platform=iOS,id=$IOS_DEVICE_ID" \
  -derivedDataPath "$IOS_WINDOWING_RUN_ROOT/build" \
  -resultBundlePath "$IOS_WINDOWING_RUN_ROOT/acceptance.xcresult" \
  -only-testing:OmnyoTimelineWindowingAcceptanceUITests/TimelineWindowingAcceptanceTests/testBaselineCapturesPhysicalFlickWithExistingIOSGuard
```

There is no simulator substitution for native momentum proof. The candidate
probe is diagnostic only: compare it with repeated baseline runs on the same
physical device and viewport, inspect every numeric trace and selection result,
and keep the production guard if anchor drift, travel loss, or accessibility
regression appears. The current harness does not establish VoiceOver speech,
bottom-pinned append behavior, or nested detail-scroll windowing; those remain
separate proof limits.
