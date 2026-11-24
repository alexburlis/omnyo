import UIKit
import WebKit

final class AcceptanceViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate
{
  private let candidateWindowing: Bool
  private let fixtureHandler = FixtureSchemeHandler()
  private let reportLabel = UILabel()
  private let diagnosticLabel = UILabel()
  private var resizeObserverWarningCount = 0
  private var fatalFixtureError: String?
  private var webView: WKWebView!
  private var webKitUserAgent = "unavailable"
  private var fixtureLoadFailed = false
  private var pressureAXSuppressionCount = 0
  private var pressureAXRestorationCount = 0
  private var pressureProgress: [[String: Any]] = []

  private static let fixtureDiagnosticsScript = """
    (() => {
      const report = (detail) => {
        window.webkit?.messageHandlers?.metrics?.postMessage({
          status: "fixture-error",
          detail: String(detail).slice(0, 240)
        });
      };
      window.addEventListener("error", (event) => {
        const target = event.target;
        if (target instanceof HTMLScriptElement || target instanceof HTMLLinkElement) {
          const resource = (target.src || target.href || "").split("/").pop()?.split("?")[0];
          report(`resource-load-failed:${resource || "unknown"}`);
          return;
        }
        const source = event.filename ? event.filename.split("/").pop() : "";
        report(`javascript-error:${event.message || "unknown"}${source ? `:${source}` : ""}`);
      }, true);
      window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        const detail = reason && typeof reason === "object" && "message" in reason
          ? `${reason.name || "Error"}:${reason.message}`
          : String(reason);
        report(`unhandled-rejection:${detail}`);
      });
    })();
    """

  init(candidateWindowing: Bool) {
    self.candidateWindowing = candidateWindowing
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is unavailable")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground

    let contentController = WKUserContentController()
    contentController.add(self, name: "metrics")
    contentController.addUserScript(
      WKUserScript(
        source: Self.fixtureDiagnosticsScript,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
      )
    )
    if candidateWindowing {
      contentController.addUserScript(
        WKUserScript(
          source: """
            (() => {
              const original = navigator.userAgent;
              Object.defineProperty(navigator, "userAgent", {
                configurable: true,
                get: () => original.replace(/\\b(?:iPhone|iPad|iPod)\\b/g, "Mobile")
              });
            })();
            """,
          injectionTime: .atDocumentStart,
          forMainFrameOnly: true
        )
      )
    }

    let configuration = WKWebViewConfiguration()
    configuration.userContentController = contentController
    configuration.setURLSchemeHandler(fixtureHandler, forURLScheme: "bbfixture")
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.scrollView.isScrollEnabled = true
    webView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(webView)

    reportLabel.translatesAutoresizingMaskIntoConstraints = false
    reportLabel.font = .systemFont(ofSize: 10)
    reportLabel.textColor = .secondaryLabel
    reportLabel.text = "Loading fixture"
    reportLabel.isAccessibilityElement = true
    reportLabel.accessibilityIdentifier = "metrics-report"
    reportLabel.accessibilityValue = "fixture-loading"
    view.addSubview(reportLabel)

    diagnosticLabel.translatesAutoresizingMaskIntoConstraints = false
    diagnosticLabel.font = .systemFont(ofSize: 10)
    diagnosticLabel.textColor = .secondaryLabel
    diagnosticLabel.isAccessibilityElement = true
    diagnosticLabel.accessibilityIdentifier = "fixture-diagnostics"
    updateDiagnosticLabel()
    view.addSubview(diagnosticLabel)

    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: reportLabel.topAnchor),
      reportLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
      reportLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
      reportLabel.bottomAnchor.constraint(equalTo: diagnosticLabel.topAnchor),
      reportLabel.heightAnchor.constraint(equalToConstant: 16),
      diagnosticLabel.leadingAnchor.constraint(equalTo: reportLabel.leadingAnchor),
      diagnosticLabel.trailingAnchor.constraint(equalTo: reportLabel.trailingAnchor),
      diagnosticLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      diagnosticLabel.heightAnchor.constraint(equalToConstant: 16),
    ])

    let arguments = ProcessInfo.processInfo.arguments
    if arguments.contains("--instant-history-bundled") {
      let scenario = arguments.contains("--instant-history-pressure") ? "&scenario=pressure" : ""
      webView.load(
        URLRequest(url: URL(string: "bbfixture://local/index.html?native=1\(scenario)")!))
    } else if let index = arguments.firstIndex(of: "--instant-history-url"),
      arguments.indices.contains(index + 1),
      let url = URL(string: arguments[index + 1]),
      url.scheme == "http", url.host == "127.0.0.1", url.port != nil
    {
      webView.load(URLRequest(url: url))
    } else {
      webView.load(URLRequest(url: URL(string: "bbfixture://local/index.html")!))
    }
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    guard
      message.name == "metrics",
      let body = message.body as? [String: Any]
    else {
      return
    }

    if body["status"] as? String == "fixture-error" {
      reportFixtureLoadError(body["detail"] as? String ?? "JavaScript resource failed")
      return
    }

    if body["status"] as? String == "instant-history",
      var historyReport = body["report"] as? [String: Any]
    {
      if ProcessInfo.processInfo.arguments.contains("--instant-history-pressure"),
        let stage = historyReport["stage"] as? String
      {
        let shouldHide = ["pressure-loading", "pressure-settling", "pressure-verifying"].contains(
          stage)
        if shouldHide {
          pressureProgress.append(historyReport)
        }
        if webView.accessibilityElementsHidden != shouldHide {
          webView.accessibilityElementsHidden = shouldHide
          if shouldHide {
            pressureAXSuppressionCount += 1
          } else {
            pressureAXRestorationCount += 1
          }
        }
        historyReport["nativeObservation"] = [
          "webViewAXHidden": webView.accessibilityElementsHidden,
          "suppressionCount": pressureAXSuppressionCount,
          "restorationCount": pressureAXRestorationCount,
          "systemVersion": UIDevice.current.systemVersion,
          "progress": pressureProgress,
        ]
      }
      guard
        let data = try? JSONSerialization.data(
          withJSONObject: historyReport, options: [.sortedKeys]),
        data.count <= 128 * 1024,
        let value = String(data: data, encoding: .utf8)
      else {
        reportFixtureLoadError("invalid-history-metrics")
        return
      }
      DispatchQueue.main.async { self.reportLabel.accessibilityValue = value }
      return
    }

    guard
      let run = body["run"] as? NSNumber,
      let rawSamples = body["samples"] as? [[NSNumber]],
      rawSamples.allSatisfy({
        $0.count == 12 && $0.allSatisfy { $0.doubleValue.isFinite }
      })
    else {
      DispatchQueue.main.async { self.reportLabel.accessibilityValue = "invalid-metrics" }
      return
    }

    let report: [String: Any] = [
      "metadata": [
        "deviceModel": UIDevice.current.model,
        "iosVersion": UIDevice.current.systemVersion,
        "webKitUserAgent": webKitUserAgent,
      ],
      "run": run,
      "samples": rawSamples,
    ]
    guard
      let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]),
      let value = String(data: data, encoding: .utf8)
    else {
      DispatchQueue.main.async { self.reportLabel.accessibilityValue = "invalid" }
      return
    }
    DispatchQueue.main.async { self.reportLabel.accessibilityValue = value }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.evaluateJavaScript(
      "navigator.userAgent"
    ) { [weak self] value, error in
      guard let self else { return }
      if let error {
        self.reportFixtureLoadError("document-probe-failed:\(error.localizedDescription)")
        return
      }
      guard let userAgent = value as? String else {
        self.reportFixtureLoadError("document-probe-returned-invalid-state")
        return
      }
      self.webKitUserAgent = userAgent
      guard !self.fixtureLoadFailed else { return }
      self.reportLabel.text = "Fixture document loaded"
      self.reportLabel.accessibilityValue = "fixture-document-loaded"
    }
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    reportFixtureLoadError("navigation-failed:\(error.localizedDescription)")
  }

  func webView(
    _ webView: WKWebView,
    didFail navigation: WKNavigation!,
    withError error: Error
  ) {
    reportFixtureLoadError("navigation-failed:\(error.localizedDescription)")
  }

  private func reportFixtureLoadError(_ detail: String) {
    let boundedDetail = String(detail.prefix(240)).replacingOccurrences(of: "\n", with: " ")
    if boundedDetail.hasPrefix(
      "javascript-error:ResizeObserver loop completed with undelivered notifications.")
    {
      resizeObserverWarningCount += 1
      DispatchQueue.main.async { self.updateDiagnosticLabel() }
      return
    }
    fixtureLoadFailed = true
    fatalFixtureError = boundedDetail
    DispatchQueue.main.async {
      self.updateDiagnosticLabel()
    }
  }

  private func updateDiagnosticLabel() {
    let report: [String: Any] = [
      "resizeObserverWarningCount": resizeObserverWarningCount,
      "fatalError": fatalFixtureError.map { $0 as Any } ?? NSNull(),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]),
      let value = String(data: data, encoding: .utf8)
    {
      diagnosticLabel.accessibilityValue = value
    }
    diagnosticLabel.text =
      fatalFixtureError.map { "Fixture error: \($0)" }
      ?? (resizeObserverWarningCount > 0
        ? "ResizeObserver loop completed with undelivered notifications. (\(resizeObserverWarningCount))"
        : "No fixture diagnostics")
  }
}
