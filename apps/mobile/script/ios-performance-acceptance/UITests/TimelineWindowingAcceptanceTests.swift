import XCTest

final class TimelineWindowingAcceptanceTests: XCTestCase {
  func testInstantHistoryPhysicalPreflight() throws {
    let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    screenshot.name = "instant-history-preflight-screen"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let identifiers = [
      "me.offlocalhost.paraspeech-ios",
      "me.offlocalhost.paraspeech-ios.automationhost",
      "me.offlocalhost.paraspeech-iosUITests.xctrunner",
      "de.burlis.omnyo.windowingacceptance",
      "app.getbb.mobile",
      "fit.sledge.app",
      "com.apple.springboard",
    ]
    let states = Dictionary(
      uniqueKeysWithValues: identifiers.map { identifier in
        (identifier, XCUIApplication(bundleIdentifier: identifier).state.rawValue)
      })
    let data = try JSONSerialization.data(withJSONObject: states, options: [.sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "instant-history-preflight-states"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testInstantHistoryRetainsViewportWithProductionIOSGuard() throws {
    continueAfterFailure = false
    let foreignAutomation = XCUIApplication(
      bundleIdentifier: "me.offlocalhost.paraspeech-ios.automationhost")
    XCTAssertNotEqual(foreignAutomation.state, .runningForeground)
    guard foreignAutomation.state != .runningForeground else { return }
    let environment = ProcessInfo.processInfo.environment
    let app = XCUIApplication()
    if environment["OMNYO_INSTANT_HISTORY_BUNDLED"] == "1" {
      app.launchArguments.append("--instant-history-bundled")
    } else {
      let url = try XCTUnwrap(environment["OMNYO_INSTANT_HISTORY_URL"])
      app.launchArguments += ["--instant-history-url", url]
    }
    app.launch()
    defer { app.terminate() }
    let webView = app.webViews.firstMatch
    XCTAssertTrue(webView.waitForExistence(timeout: 15))
    let open = webView.buttons["thread-0"]
    XCTAssertTrue(open.waitForExistence(timeout: 20))
    open.tap()
    let load = webView.buttons["Load eight pages"]
    XCTAssertTrue(load.waitForExistence(timeout: 10))
    load.tap()
    let report = app.staticTexts["metrics-report"]
    expectation(
      for: NSPredicate(format: "value CONTAINS %@", "\"stage\":\"loaded\""), evaluatedWith: report)
    waitForExpectations(timeout: 30)
    if environment["OMNYO_INSTANT_HISTORY_BUNDLED"] == "1" {
      webView.buttons["Read oldest loaded page"].tap()
      webView.swipeUp()
    } else {
      webView.swipeDown()
    }
    webView.buttons["Pin visible anchor"].tap()
    expectation(
      for: NSPredicate(format: "value CONTAINS %@", "\"stage\":\"pinned\""), evaluatedWith: report)
    waitForExpectations(timeout: 10)
    let before = try XCTUnwrap(report.value as? String)
    let beforeScreenshot = XCTAttachment(screenshot: app.screenshot())
    beforeScreenshot.name = "instant-history-before-screen"
    beforeScreenshot.lifetime = .keepAlways
    add(beforeScreenshot)
    webView.buttons["Append live message"].tap()
    expectation(
      for: NSPredicate(format: "value CONTAINS %@", "\"stage\":\"appended\""), evaluatedWith: report
    )
    waitForExpectations(timeout: 15)
    let after = try XCTUnwrap(report.value as? String)
    let afterScreenshot = XCTAttachment(screenshot: app.screenshot())
    afterScreenshot.name = "instant-history-after-screen"
    afterScreenshot.lifetime = .keepAlways
    add(afterScreenshot)
    for (name, value) in [("instant-history-before", before), ("instant-history-after", after)] {
      let attachment = XCTAttachment(string: value)
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }
    let diagnostics = try XCTUnwrap(app.staticTexts["fixture-diagnostics"].value as? String)
    let diagnosticAttachment = XCTAttachment(string: diagnostics)
    diagnosticAttachment.name = "instant-history-diagnostics"
    diagnosticAttachment.lifetime = .keepAlways
    add(diagnosticAttachment)
    let diagnosticData = try XCTUnwrap(diagnostics.data(using: .utf8))
    let diagnosticValues = try XCTUnwrap(
      JSONSerialization.jsonObject(with: diagnosticData) as? [String: Any])
    XCTAssertTrue(diagnosticValues["fatalError"] is NSNull)
    let data = try XCTUnwrap(after.data(using: .utf8))
    let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertTrue((decoded["userAgent"] as? String)?.contains("iPhone") == true)
    XCTAssertEqual(decoded["realizedRows"] as? Int, 0)
    XCTAssertEqual(decoded["mountedRows"] as? Int, decoded["rows"] as? Int)
    XCTAssertEqual(decoded["anchorPresent"] as? Bool, true)
    XCTAssertEqual(decoded["rows"] as? Int, 161)
    let anchor = try XCTUnwrap(decoded["anchor"] as? [String: Any])
    let expectedOffset = try XCTUnwrap(anchor["offset"] as? Double)
    let offset = try XCTUnwrap(decoded["anchorOffset"] as? Double)
    XCTAssertLessThanOrEqual(abs(offset - expectedOffset), 2)
  }

  func testInstantHistoryBoundsNativePressureAndRestoresGaps() throws {
    continueAfterFailure = false
    let foreignAutomation = XCUIApplication(
      bundleIdentifier: "me.offlocalhost.paraspeech-ios.automationhost")
    XCTAssertNotEqual(foreignAutomation.state, .runningForeground)
    guard foreignAutomation.state != .runningForeground else { return }
    let app = XCUIApplication()
    app.launchArguments += ["--instant-history-bundled", "--instant-history-pressure"]
    app.launch()
    defer { app.terminate() }
    let webView = app.webViews.firstMatch
    let open = webView.buttons["thread-0"]
    XCTAssertTrue(open.waitForExistence(timeout: 15))
    open.tap()
    let load = webView.buttons["Load eighty older pages"]
    XCTAssertTrue(load.waitForExistence(timeout: 10))
    load.tap()
    let report = app.staticTexts["metrics-report"]
    defer {
      for identifier in ["metrics-report", "fixture-diagnostics"] {
        let value = app.staticTexts[identifier].value as? String ?? "unavailable"
        let attachment = XCTAttachment(string: value)
        attachment.name = "instant-history-pressure-final-\(identifier)"
        attachment.lifetime = .keepAlways
        add(attachment)
      }
    }
    expectation(
      for: NSPredicate(format: "value CONTAINS %@", "\"stage\":\"pressure-loaded\""),
      evaluatedWith: report)
    waitForExpectations(timeout: 40)
    let loaded = try XCTUnwrap(report.value as? String)
    let loadedAttachment = XCTAttachment(string: loaded)
    loadedAttachment.name = "instant-history-pressure-loaded"
    loadedAttachment.lifetime = .keepAlways
    add(loadedAttachment)
    let loadedData = try XCTUnwrap(loaded.data(using: .utf8))
    let loadedValues = try XCTUnwrap(
      JSONSerialization.jsonObject(with: loadedData) as? [String: Any])
    let loadedObservation = try XCTUnwrap(loadedValues["nativeObservation"] as? [String: Any])
    XCTAssertEqual(loadedObservation["webViewAXHidden"] as? Bool, false)
    XCTAssertEqual(loadedObservation["suppressionCount"] as? Int, 1)
    XCTAssertEqual(loadedObservation["restorationCount"] as? Int, 1)
    webView.swipeDown()
    webView.buttons["Verify history traversal"].tap()
    expectation(
      for: NSPredicate(format: "value CONTAINS %@", "\"stage\":\"pressure-complete\""),
      evaluatedWith: report)
    waitForExpectations(timeout: 35)
    let complete = try XCTUnwrap(report.value as? String)
    let completeAttachment = XCTAttachment(string: complete)
    completeAttachment.name = "instant-history-pressure-complete"
    completeAttachment.lifetime = .keepAlways
    add(completeAttachment)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "instant-history-pressure-search-screen"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let diagnostics = try XCTUnwrap(app.staticTexts["fixture-diagnostics"].value as? String)
    let diagnosticAttachment = XCTAttachment(string: diagnostics)
    diagnosticAttachment.name = "instant-history-pressure-diagnostics"
    diagnosticAttachment.lifetime = .keepAlways
    add(diagnosticAttachment)
    let diagnosticData = try XCTUnwrap(diagnostics.data(using: .utf8))
    let diagnosticValues = try XCTUnwrap(
      JSONSerialization.jsonObject(with: diagnosticData) as? [String: Any])
    XCTAssertTrue(diagnosticValues["fatalError"] is NSNull)
    let data = try XCTUnwrap(complete.data(using: .utf8))
    let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertTrue((decoded["userAgent"] as? String)?.contains("iPhone") == true)
    XCTAssertEqual(decoded["realizedRows"] as? Int, 0)
    XCTAssertEqual(decoded["mountedRows"] as? Int, decoded["rows"] as? Int)
    let completeObservation = try XCTUnwrap(decoded["nativeObservation"] as? [String: Any])
    XCTAssertEqual(completeObservation["webViewAXHidden"] as? Bool, false)
    XCTAssertEqual(completeObservation["suppressionCount"] as? Int, 2)
    XCTAssertEqual(completeObservation["restorationCount"] as? Int, 2)
    let points = try XCTUnwrap(decoded["points"] as? [[String: Any]])
    XCTAssertEqual(points.count, 5)
    for point in points {
      let bytes = try XCTUnwrap(point["bytes"] as? Int)
      let largestLeaf = try XCTUnwrap(point["largestLeafBytes"] as? Int)
      XCTAssertLessThanOrEqual(bytes, 8 * 1024 * 1024 + largestLeaf)
      XCTAssertEqual(point["scrolling"] as? Bool, false)
      XCTAssertEqual(point["realizedRows"] as? Int, 0)
    }
    let gestures = try XCTUnwrap(decoded["gestures"] as? [String: Any])
    XCTAssertGreaterThan(try XCTUnwrap(gestures["touchStarts"] as? Int), 0)
    XCTAssertGreaterThan(try XCTUnwrap(gestures["touchEnds"] as? Int), 0)
    XCTAssertGreaterThan(try XCTUnwrap(gestures["activeScrollStates"] as? Int), 0)
    let minimum = try XCTUnwrap(gestures["minimumScrollTop"] as? Double)
    let maximum = try XCTUnwrap(gestures["maximumScrollTop"] as? Double)
    XCTAssertGreaterThan(maximum - minimum, 100)
    let reloads = try XCTUnwrap(decoded["reloads"] as? [[String: Any]])
    XCTAssertEqual(reloads.count, 2)
    for reload in reloads {
      XCTAssertEqual(reload["present"] as? Bool, true)
      let pinned = try XCTUnwrap(reload["pinned"] as? [String: Any])
      let expectedOffset = try XCTUnwrap(pinned["offset"] as? Double)
      let offset = try XCTUnwrap(reload["anchorOffset"] as? Double)
      XCTAssertLessThanOrEqual(abs(offset - expectedOffset), 2)
    }
    let searches = try XCTUnwrap(decoded["searches"] as? [[String: Any]])
    XCTAssertEqual(searches.count, 2)
    XCTAssertTrue(searches.allSatisfy { $0["visible"] as? Bool == true })
    let transport = try XCTUnwrap(loadedValues["transport"] as? [String: Any])
    XCTAssertGreaterThanOrEqual(try XCTUnwrap(transport["olderRequests"] as? Int), 80)
    XCTAssertGreaterThanOrEqual(try XCTUnwrap(transport["olderRows"] as? Int), 1600)
    XCTAssertGreaterThanOrEqual(try XCTUnwrap(transport["distinctOlderRows"] as? Int), 1600)
    XCTAssertGreaterThan(try XCTUnwrap(transport["olderRowBytes"] as? Int), 8 * 1024 * 1024)
    XCTAssertLessThanOrEqual(try XCTUnwrap(transport["minimumOlderSequence"] as? Int), 200)
  }

  private func launchInteractionCase() -> (app: XCUIApplication, mode: String) {
    let mode =
      ProcessInfo.processInfo.environment[
        "OMNYO_IOS_WINDOWING_INTERACTION_MODE"
      ] ?? "candidate"
    XCTAssertTrue(
      mode == "baseline" || mode == "candidate",
      "OMNYO_IOS_WINDOWING_INTERACTION_MODE must be baseline or candidate"
    )
    return (launch(candidate: mode == "candidate"), mode)
  }

  private func launch(candidate: Bool) -> XCUIApplication {
    let app = XCUIApplication()
    if candidate {
      app.launchArguments.append("--candidate-windowing")
    }
    app.launch()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
    XCTAssertTrue(app.webViews.buttons["Prepend older rows"].waitForExistence(timeout: 15))
    return app
  }

  private func reportElement(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: "metrics-report").firstMatch
  }

  private func captureAfterFlick(
    _ app: XCUIApplication,
    attachmentName: String,
    throughClearGutter: Bool = false
  ) throws -> [[NSNumber]] {
    let report = reportElement(app)
    let previousValue = report.value as? String ?? "pending"
    let webView = app.webViews.firstMatch
    if throughClearGutter {
      let start = webView.coordinate(
        withNormalizedOffset: CGVector(dx: 0.98, dy: 0.72)
      )
      let end = webView.coordinate(
        withNormalizedOffset: CGVector(dx: 0.98, dy: 0.2)
      )
      start.press(forDuration: 0.05, thenDragTo: end)
    } else {
      webView.swipeDown()
    }

    let changed = NSPredicate(format: "value != %@ AND value != %@", previousValue, "pending")
    expectation(for: changed, evaluatedWith: report)
    waitForExpectations(timeout: 10)

    let value = try XCTUnwrap(report.value as? String)
    let data = try XCTUnwrap(value.data(using: .utf8))
    let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let metadata = try XCTUnwrap(decoded["metadata"] as? [String: String])
    let samples = try XCTUnwrap(decoded["samples"] as? [[NSNumber]])
    XCTAssertFalse(metadata["deviceModel"]?.isEmpty ?? true)
    XCTAssertFalse(metadata["iosVersion"]?.isEmpty ?? true)
    XCTAssertTrue(metadata["webKitUserAgent"]?.contains("AppleWebKit") ?? false)
    XCTAssertGreaterThan(samples.count, 10)
    XCTAssertTrue(
      samples.allSatisfy { $0.count == 12 && $0.allSatisfy { $0.doubleValue.isFinite } })
    let attachment = XCTAttachment(string: value)
    attachment.name = attachmentName
    attachment.lifetime = .keepAlways
    add(attachment)
    return samples
  }

  private func assertGestureTravel(_ samples: [[NSNumber]]) {
    guard let firstOffset = samples.first?[1].doubleValue,
      let lastOffset = samples.last?[1].doubleValue
    else {
      XCTFail("The frame report has no scroll offsets")
      return
    }
    XCTAssertGreaterThan(abs(lastOffset - firstOffset), 250)
    XCTAssertTrue(samples.contains { $0[6].intValue >= 1 })
  }

  func testBaselineCapturesPhysicalFlickWithExistingIOSGuard() throws {
    let app = launch(candidate: false)
    for repetition in 1...3 {
      let samples = try captureAfterFlick(
        app,
        attachmentName: "baseline-numeric-frames-\(repetition)"
      )
      assertGestureTravel(samples)
      XCTAssertTrue(samples.allSatisfy { $0[2].intValue == 500 })
      XCTAssertTrue(samples.allSatisfy { $0[7].intValue == 500 })
      app.webViews.buttons["Go to bottom"].tap()
    }
  }

  func testCandidateBoundsMountedRowsAndCapturesFlick() throws {
    let app = launch(candidate: true)
    for repetition in 1...3 {
      let samples = try captureAfterFlick(
        app,
        attachmentName: "candidate-numeric-frames-\(repetition)"
      )
      assertGestureTravel(samples)
      XCTAssertTrue(samples.allSatisfy { $0[2].intValue <= $0[8].intValue + 16 })
      XCTAssertTrue(samples.allSatisfy { $0[7].intValue == 500 })
      app.webViews.buttons["Go to bottom"].tap()
    }
  }

  func testPrependResizeAndAppendRunDuringMomentum() throws {
    let (app, mode) = launchInteractionCase()
    app.webViews.buttons["Queue mutations after flick"].tap()
    let samples = try captureAfterFlick(
      app,
      attachmentName: "\(mode)-mutation-numeric-frames"
    )
    assertGestureTravel(samples)
    XCTAssertEqual(samples.first?[5].intValue, 0)
    XCTAssertTrue(samples.contains { $0[10].intValue == 4 })
    XCTAssertEqual(samples.last?[7].intValue, 513)
    XCTAssertTrue(samples.contains { $0[9].intValue >= 0 })
    let settled = samples.suffix(8).filter { $0[6].intValue >= 2 }
    XCTAssertGreaterThanOrEqual(settled.count, 3)
    let settledOffsets = settled.map { $0[4].doubleValue }
    XCTAssertLessThanOrEqual((settledOffsets.max() ?? 0) - (settledOffsets.min() ?? 0), 24)
  }

  func testQueuedCorrectionDoesNotCrossThreadSwitch() throws {
    let (app, mode) = launchInteractionCase()
    app.webViews.buttons["Queue thread switch after flick"].tap()
    let samples = try captureAfterFlick(
      app,
      attachmentName: "\(mode)-thread-switch-numeric-frames"
    )
    assertGestureTravel(samples)
    XCTAssertTrue(samples.contains { $0[10].intValue == 5 })
    XCTAssertTrue(samples.contains { $0[5].intValue == 0 })
    XCTAssertTrue(samples.contains { $0[5].intValue == 1 })
    let threadBSamples = samples.filter { $0[5].intValue == 1 }
    XCTAssertFalse(threadBSamples.isEmpty)
    XCTAssertTrue(threadBSamples.allSatisfy { $0[7].intValue == 500 && $0[9].intValue < 0 })
    app.webViews.buttons["switch thread from B"].tap()
    let returnedSamples = try captureAfterFlick(
      app,
      attachmentName: "\(mode)-returned-thread-a-numeric-frames"
    )
    XCTAssertTrue(
      returnedSamples.allSatisfy { $0[5].intValue == 0 && $0[7].intValue == 512 }
    )
    assertGestureTravel(returnedSamples)
  }

  func testFocusedRowRemainsAccessibleAfterRangeMoves() throws {
    let app = launch(candidate: true)
    let focusControl = app.webViews.buttons["Focus target"]
    XCTAssertTrue(focusControl.waitForExistence(timeout: 5))
    focusControl.tap()
    let focusedTarget = app.webViews.buttons["focus target A"]
    XCTAssertTrue(focusedTarget.waitForExistence(timeout: 5))

    let samples = try captureAfterFlick(app, attachmentName: "focused-row-numeric-frames")
    assertGestureTravel(samples)
    XCTAssertTrue(focusedTarget.exists)
    XCTAssertFalse(focusedTarget.isHittable)
  }

  func testSelectedProseRemainsAccessibleAfterRangeMoves() throws {
    let (app, mode) = launchInteractionCase()
    app.webViews.buttons["Go to selectable prose"].tap()
    let selectableText = app.webViews.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@", "Selectable prose A row 421:")
    ).firstMatch
    XCTAssertTrue(selectableText.waitForExistence(timeout: 5))
    selectableText.press(forDuration: 1.1)
    let copyAction = app.descendants(matching: .any).matching(
      NSPredicate(format: "label == %@", "Copy")
    ).firstMatch
    XCTAssertTrue(copyAction.waitForExistence(timeout: 5))

    let dismissalSamples = try captureAfterFlick(
      app,
      attachmentName: "\(mode)-selection-menu-dismissal-numeric-frames",
      throughClearGutter: true
    )
    XCTAssertTrue(dismissalSamples.contains { $0[11].intValue == 421 })
    let menuDismissed = NSPredicate(format: "exists == false")
    expectation(for: menuDismissed, evaluatedWith: copyAction)
    waitForExpectations(timeout: 5)

    let samples = try captureAfterFlick(
      app,
      attachmentName: "\(mode)-selected-row-numeric-frames",
      throughClearGutter: true
    )
    assertGestureTravel(samples)
    XCTAssertTrue(samples.contains { $0[11].intValue == 421 })
    XCTAssertTrue(selectableText.exists)
    XCTAssertFalse(selectableText.isHittable)
  }
}
