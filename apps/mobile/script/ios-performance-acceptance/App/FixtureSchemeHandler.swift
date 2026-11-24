import Foundation
import WebKit

final class FixtureSchemeHandler: NSObject, WKURLSchemeHandler {
  func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
    guard
      let url = urlSchemeTask.request.url,
      url.scheme == "bbfixture",
      url.host == "local",
      let root = Bundle.main.url(forResource: "FixtureDist", withExtension: nil)
    else {
      urlSchemeTask.didFailWithError(Self.error("Fixture URL is outside the bundled origin"))
      return
    }

    let relativePath = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let resourceName = relativePath.isEmpty ? "index.html" : relativePath
    let resource = root.appendingPathComponent(resourceName).standardizedFileURL
    let allowedPrefix = root.standardizedFileURL.path + "/"
    guard resource.path.hasPrefix(allowedPrefix) else {
      urlSchemeTask.didFailWithError(Self.error("Fixture path escaped its bundle"))
      return
    }

    do {
      let data = try Data(contentsOf: resource)
      let response = URLResponse(
        url: url,
        mimeType: Self.mimeType(for: resource.pathExtension),
        expectedContentLength: data.count,
        textEncodingName: "utf-8"
      )
      urlSchemeTask.didReceive(response)
      urlSchemeTask.didReceive(data)
      urlSchemeTask.didFinish()
    } catch {
      urlSchemeTask.didFailWithError(error)
    }
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

  private static func mimeType(for extensionName: String) -> String {
    switch extensionName.lowercased() {
    case "html": "text/html"
    case "js", "mjs": "text/javascript"
    case "css": "text/css"
    case "svg": "image/svg+xml"
    case "json": "application/json"
    default: "application/octet-stream"
    }
  }

  private static func error(_ description: String) -> NSError {
    NSError(
      domain: "OmnyoTimelineAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
  }
}
