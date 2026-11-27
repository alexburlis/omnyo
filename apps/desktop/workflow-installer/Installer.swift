import AppKit
import CryptoKit
import SwiftUI

struct WorkflowInstaller {
  static var minimumVersion: String {
    get throws {
      guard let value = Bundle.main.object(forInfoDictionaryKey: "OmnyoMinimumVersion") as? String,
        PublicRelease.isVersion(value)
      else {
        throw InstallError("This installer is missing its release version.")
      }
      return value
    }
  }
  static let identifier = "dev.omnyo.beta"

  static func run(_ executable: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      throw InstallError("Omnyo could not be verified or unpacked. Try the download again.")
    }
  }

  static func verify(_ app: URL, minimum: String, exact: String? = nil) throws {
    let trust =
      #"anchor apple generic and identifier "dev.omnyo.beta" and certificate leaf[subject.OU] = "Z7T4C33A35" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"#
    try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "=" + trust, app.path])
    guard
      let installed = Bundle(url: app)?.object(forInfoDictionaryKey: "CFBundleShortVersionString")
        as? String,
      installed.compare(minimum, options: .numeric) != .orderedAscending,
      exact == nil || installed == exact
    else {
      throw InstallError("Update your installed copy of Omnyo, then open this installer again.")
    }
  }

  static func prepare(status: @Sendable (String) async -> Void) async throws -> URL {
    let minimum = try minimumVersion
    let files = FileManager.default
    let applications = try files.url(
      for: .applicationDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let target = applications.appendingPathComponent("Omnyo.app")
    let systemApp = URL(fileURLWithPath: "/Applications/Omnyo.app")

    for candidate in [target, systemApp]
    where Bundle(url: candidate)?.bundleIdentifier == identifier {
      await status("Checking your installed copy…")
      try verify(candidate, minimum: minimum)
      return candidate
    }
    guard !files.fileExists(atPath: target.path) else {
      throw InstallError(
        "Another app already uses ~/Applications/Omnyo.app. Move it before installing this copy.")
    }

    await status("Downloading Omnyo for Mac…")
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let (metadata, feedResponse) = try await session.data(from: PublicRelease.feed)
    guard (feedResponse as? HTTPURLResponse)?.statusCode == 200,
      feedResponse.url?.scheme == "https"
    else {
      throw InstallError("The Mac release information is unavailable. Try again.")
    }
    let release = try PublicRelease(metadata, minimum: minimum)
    let (archive, response) = try await session.download(from: release.download)
    defer { try? files.removeItem(at: archive) }
    guard (response as? HTTPURLResponse)?.statusCode == 200,
      response.url?.scheme == "https"
    else {
      throw InstallError("The Mac download is unavailable. Check your connection and try again.")
    }
    await status("Verifying and installing Omnyo…")
    let bytes = try Data(contentsOf: archive, options: .mappedIfSafe)
    guard bytes.count == release.size, Data(SHA512.hash(data: bytes)) == release.digest else {
      throw InstallError("The download did not match the signed release. Try again.")
    }
    let stage = applications.appendingPathComponent(".omnyo-install-" + UUID().uuidString)
    try files.createDirectory(
      at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? files.removeItem(at: stage) }
    try run("/usr/bin/ditto", ["-x", "-k", archive.path, stage.path])
    let app = stage.appendingPathComponent("Omnyo.app")
    try verify(app, minimum: minimum, exact: release.version)
    try run("/usr/sbin/spctl", ["--assess", "--type", "execute", app.path])
    try files.moveItem(at: app, to: target)
    return target
  }
}

private struct RecipientConfiguration: Decodable {
  struct General: Decodable {
    let onboardingCompletedAt: String?
  }
  let generalSettings: General
}

@MainActor
private func waitForWelcome(in app: NSRunningApplication) async throws {
  let config = URL(string: "http://127.0.0.1:47431/api/v1/system/config")!
  let session = URLSession(configuration: .ephemeral)
  defer { session.invalidateAndCancel() }
  let deadline = ContinuousClock.now + .seconds(900)
  while ContinuousClock.now < deadline {
    guard !app.isTerminated else {
      throw InstallError("Omnyo closed before setup finished. Select Try again to continue.")
    }
    let request = URLRequest(
      url: config, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
    do {
      let (data, response) = try await session.data(for: request)
      if (response as? HTTPURLResponse)?.statusCode == 200 {
        let config = try JSONDecoder().decode(RecipientConfiguration.self, from: data)
        if config.generalSettings.onboardingCompletedAt != nil { return }
      }
    } catch let error as URLError
      where [.cannotConnectToHost, .networkConnectionLost, .timedOut].contains(error.code)
    {

    }
    try await Task.sleep(for: .seconds(1))
  }
  throw InstallError("Finish the welcome screen in Omnyo, then select Try again.")
}

struct InstallView: View {
  @State private var busy = false
  @State private var status = ""
  @State private var error = ""
  let workflow: URL

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Label("Omnyo", systemImage: "circle.fill").foregroundStyle(.orange).font(.headline)
      Text("Weekly Content Feed").font(.largeTitle.bold())
      Text(
        "Install Omnyo and open your workflow. You’ll choose a project and review your copy before it runs."
      )
      if !error.isEmpty { Text(error).foregroundStyle(.red).accessibilityLabel(error) }
      if busy {
        HStack {
          ProgressView().controlSize(.small)
          Text(status)
        }
      }
      Button(error.isEmpty ? "Install & open workflow" : "Try again") {
        busy = true
        error = ""
        Task {
          do {
            let app = try await WorkflowInstaller.prepare { message in
              await MainActor.run { status = message }
            }
            status = "Finish setup in Omnyo, or choose Skip setup."
            let running = try await NSWorkspace.shared.openApplication(
              at: app, configuration: .init())
            try await waitForWelcome(in: running)
            status = "Opening Weekly Content Feed…"
            _ = try await NSWorkspace.shared.open(
              [workflow], withApplicationAt: app, configuration: .init())
            NSApplication.shared.terminate(nil)
          } catch {
            self.error = error.localizedDescription
            busy = false
          }
        }
      }.keyboardShortcut(.defaultAction).disabled(busy)
    }
    .padding(32).frame(width: 470)
  }
}

@main
struct WorkflowSetupApp: App {
  var body: some Scene {
    Window("Weekly Content Feed setup", id: "install") {
      if let id = Bundle.main.object(forInfoDictionaryKey: "OmnyoWorkflowID") as? String,
        id.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
        let url = URL(string: "omnyo://workflows/import/" + id)
      {
        InstallView(workflow: url)
      } else {
        Text("This installer is missing its workflow.").padding()
      }
    }.windowResizability(.contentSize)
  }
}
