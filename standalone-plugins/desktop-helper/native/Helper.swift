import AppKit
import ApplicationServices
import Carbon
import ScreenCaptureKit
import Security

struct FixtureTarget: Decodable {
    let pid: Int32
    let windowId: UInt32
    let x: Double
    let y: Double
}

struct Request: Decodable {
    let `protocol`: Int
    let id: String
    let command: String
    let permission: String?
    let fixture: FixtureTarget?
}

@MainActor
final class Helper: NSObject, NSApplicationDelegate {
    private var panel: NSPanel?
    private var hotkey: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var finished = false
    private var captureRevision = 0
    private var capturePending: String?
    private let outputDirectory: URL?

    init(outputDirectory: URL?) {
        self.outputDirectory = outputDirectory
    }

    func emit(_ event: String, id: String? = nil, _ fields: [String: Any] = [:]) {
        var message = fields
        message["protocol"] = 1
        message["event"] = event
        if let id { message["id"] = id }
        guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    private func console() -> [String: Any] {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
            return ["active": false, "uid": getuid(), "reason": "no-console-session"]
        }
        let sessionUid = session[kCGSessionUserIDKey as String] as? UInt32
        let active = (session[kCGSessionOnConsoleKey as String] as? Bool == true)
            && (session[kCGSessionLoginDoneKey as String] as? Bool == true)
            && sessionUid == getuid()
        return ["active": active, "uid": getuid(), "consoleUid": sessionUid.map(Int.init) ?? -1]
    }

    private func identity() -> [String: Any] {
        var code: SecCode?
        var staticCode: SecStaticCode?
        var information: CFDictionary?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let info = information as? [String: Any] else {
            return ["verified": false]
        }
        return ["verified": true,
                "bundleId": info[kSecCodeInfoIdentifier as String] as? String ?? "",
                "teamId": info[kSecCodeInfoTeamIdentifier as String] as? String ?? ""]
    }

    private func status(id: String? = nil) {
        emit("status", id: id, ["pid": ProcessInfo.processInfo.processIdentifier,
                               "parentPid": getppid(), "identity": identity(), "console": console(),
                               "os": ProcessInfo.processInfo.operatingSystemVersionString,
                               "accessibility": AXIsProcessTrusted(),
                               "screenCapture": CGPreflightScreenCaptureAccess(),
                               "panel": panel != nil, "hotkey": hotkey != nil,
                               "observation": false, "capturePending": capturePending != nil])
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        status()
        let owner = self
        DispatchQueue.global(qos: .utility).async {
            var pending = Data()
            while true {
                let bytes = FileHandle.standardInput.availableData
                if bytes.isEmpty {
                    DispatchQueue.main.async { owner.stop(reason: "parent-eof") }
                    return
                }
                pending.append(bytes)
                if pending.count > 8192 {
                    DispatchQueue.main.async { owner.stop(reason: "input-limit") }
                    return
                }
                while let newline = pending.firstIndex(of: 10) {
                    let line = Data(pending[..<newline])
                    pending.removeSubrange(...newline)
                    DispatchQueue.main.async { owner.receive(line) }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 55) { owner.stop(reason: "probe-deadline") }
    }

    private func receive(_ data: Data) {
        guard !finished else { return }
        guard let request = try? JSONDecoder().decode(Request.self, from: data),
              request.protocol == 1, !request.id.isEmpty, request.id.utf8.count <= 128 else {
            emit("error", ["reason": "invalid-request"])
            stop(reason: "invalid-request")
            return
        }
        switch request.command {
        case "status": status(id: request.id)
        case "shutdown": stop(reason: "requested", id: request.id)
        case "request-permissions":
            guard console()["active"] as? Bool == true else {
                emit("error", id: request.id, ["reason": "inactive-console"])
                return
            }
            switch request.permission {
            case "accessibility":
                let granted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
                emit("permission", id: request.id, ["permission": "accessibility", "granted": granted])
            case "screen-capture":
                let granted = CGRequestScreenCaptureAccess()
                emit("permission", id: request.id, ["permission": "screen-capture", "granted": granted])
            default: emit("error", id: request.id, ["reason": "invalid-permission"])
            }
        case "probe":
            guard let target = request.fixture, target.pid > 0, target.windowId > 0,
                  target.x.isFinite, target.y.isFinite else {
                emit("error", id: request.id, ["reason": "synthetic-fixture-required"])
                return
            }
            probe(target, id: request.id)
        default: emit("error", id: request.id, ["reason": "unknown-command"])
        }
    }

    private func preparePanelAndHotkey() -> OSStatus {
        if panel == nil {
            let view = NSTextField(labelWithString: "•")
            view.font = NSFont.systemFont(ofSize: 24)
            view.alignment = .center
            view.textColor = .controlAccentColor
            let overlay = NSPanel(contentRect: NSRect(x: 80, y: 80, width: 32, height: 32),
                                  styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            overlay.isOpaque = false
            overlay.backgroundColor = .clear
            overlay.ignoresMouseEvents = true
            overlay.level = .floating
            overlay.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            overlay.contentView = view
            overlay.orderFrontRegardless()
            panel = overlay
        }
        if hotkey != nil { return noErr }
        var specification = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let handlerStatus = InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
            guard let context else { return OSStatus(eventNotHandledErr) }
            MainActor.assumeIsolated {
                Unmanaged<Helper>.fromOpaque(context).takeUnretainedValue().emit("hotkey")
            }
            return noErr
        }, 1, &specification, Unmanaged.passUnretained(self).toOpaque(), &eventHandler)
        guard handlerStatus == noErr else { return handlerStatus }
        let key = EventHotKeyID(signature: OSType(0x42424448), id: 1)
        return RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), key, GetApplicationEventTarget(), 0, &hotkey)
    }

    private func syntheticElement(_ target: FixtureTarget) -> [String: Any] {
        guard AXIsProcessTrusted() else { return ["status": "needs-accessibility"] }
        var element: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(target.x), Float(target.y), &element)
        guard result == .success, let element else { return ["status": "hit-test-failed", "code": result.rawValue] }
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid == target.pid else { return ["status": "fixture-not-at-point"] }
        var ancestor: AXUIElement? = element
        for _ in 0..<12 {
            guard let current = ancestor else { break }
            var subrole: CFTypeRef?
            AXUIElementCopyAttributeValue(current, kAXSubroleAttribute as CFString, &subrole)
            if subrole as? String == kAXSecureTextFieldSubrole { return ["status": "secure-excluded"] }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success,
                  let parent, CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            ancestor = (parent as! AXUIElement)
        }
        var role: CFTypeRef?
        var title: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
        AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &title)
        let scalars = (title as? String ?? "").unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        let label = String(String(String.UnicodeScalarView(scalars)).prefix(160))
        return ["status": "observed", "role": role as? String ?? "", "label": label, "pid": pid]
    }

    private func probe(_ target: FixtureTarget, id: String) {
        guard capturePending == nil else { emit("error", id: id, ["reason": "probe-already-running"]); return }
        guard console()["active"] as? Bool == true else { emit("error", id: id, ["reason": "inactive-console"]); return }
        let keyStatus = preparePanelAndHotkey()
        let ax = syntheticElement(target)
        guard keyStatus == noErr else {
            emit("probe", id: id, ["status": "hotkey-conflict", "code": keyStatus, "ax": ax, "panel": panel != nil])
            return
        }
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
            emit("probe", id: id, ["status": "needs-permission", "ax": ax, "panel": true, "hotkey": true])
            return
        }
        guard ax["status"] as? String == "observed", let outputDirectory else {
            emit("probe", id: id, ["status": "fixture-or-output-unavailable", "ax": ax])
            return
        }
        captureRevision += 1
        let revision = captureRevision
        capturePending = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            guard self.capturePending == id, self.captureRevision == revision else { return }
            self.capturePending = nil
            self.captureRevision += 1
            self.emit("probe", id: id, ["status": "capture-timeout", "ax": ax])
        }
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                guard let window = content.windows.first(where: { $0.windowID == target.windowId && $0.owningApplication?.processID == target.pid && $0.title == "Omnyo Desktop Helper Synthetic Fixture" }) else {
                    throw ProbeFailure.fixtureUnavailable
                }
                let filter = SCContentFilter(desktopIndependentWindow: window)
                let configuration = SCStreamConfiguration()
                let ratio = min(Double(filter.pointPixelScale), 2048 / max(window.frame.width, window.frame.height))
                configuration.width = max(1, Int(window.frame.width * ratio))
                configuration.height = max(1, Int(window.frame.height * ratio))
                configuration.showsCursor = false
                configuration.capturesAudio = false
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                guard capturePending == id, captureRevision == revision, !finished else { return }
                guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), png.count <= 2 * 1024 * 1024 else { throw ProbeFailure.imageLimit }
                let file = outputDirectory.appendingPathComponent("synthetic-window.png")
                try png.write(to: file, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                capturePending = nil
                emit("probe", id: id, ["status": "captured", "ax": ax, "windowId": window.windowID, "pid": target.pid,
                                       "width": image.width, "height": image.height, "bytes": png.count,
                                       "image": file.path, "panel": true, "hotkey": true])
            } catch {
                guard capturePending == id, captureRevision == revision, !finished else { return }
                capturePending = nil
                emit("probe", id: id, ["status": "capture-failed", "ax": ax, "reason": "synthetic-window-unavailable"])
            }
        }
    }

    func stop(reason: String, id: String? = nil) {
        guard !finished else { return }
        finished = true
        captureRevision += 1
        capturePending = nil
        if let hotkey { UnregisterEventHotKey(hotkey) }
        hotkey = nil
        if let eventHandler { RemoveEventHandler(eventHandler) }
        eventHandler = nil
        panel?.orderOut(nil)
        panel?.close()
        panel = nil
        emit("cleanup", id: id, ["reason": reason, "panel": false, "hotkey": false, "monitors": 0, "capturePending": false])
        NSApp.terminate(nil)
    }
}

enum ProbeFailure: Error {
    case fixtureUnavailable
    case imageLimit
}

let arguments = CommandLine.arguments
var outputDirectory: URL?
if arguments.count == 3, arguments[1] == "--probe-output", arguments[2].hasPrefix("/") {
    var isDirectory: ObjCBool = false
    if FileManager.default.fileExists(atPath: arguments[2], isDirectory: &isDirectory), isDirectory.boolValue {
        outputDirectory = URL(fileURLWithPath: arguments[2], isDirectory: true)
    }
}
MainActor.assumeIsolated {
    let application = NSApplication.shared
    let helper = Helper(outputDirectory: outputDirectory)
    application.delegate = helper
    application.run()
}
