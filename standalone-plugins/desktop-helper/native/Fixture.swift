import AppKit

@MainActor
final class Fixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var clicks = 0

    private func emit(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let window = NSWindow(contentRect: NSRect(x: 180, y: 240, width: 560, height: 280), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Omnyo Desktop Helper Synthetic Fixture"
        window.isReleasedWhenClosed = false
        let title = NSTextField(labelWithString: "Synthetic Desktop Helper target")
        title.frame = NSRect(x: 32, y: 205, width: 480, height: 28)
        title.font = NSFont.systemFont(ofSize: 20, weight: .semibold)
        let button = NSButton(title: "Desktop Helper synthetic target", target: self, action: #selector(clicked))
        button.frame = NSRect(x: 120, y: 100, width: 320, height: 44)
        button.bezelStyle = .rounded
        window.contentView?.addSubview(title)
        window.contentView?.addSubview(button)
        window.orderFrontRegardless()
        self.window = window
        let point = window.convertPoint(toScreen: NSPoint(x: button.frame.midX, y: button.frame.midY))
        let height = NSScreen.screens.first?.frame.height ?? 0
        emit(["protocol": 1, "event": "fixture", "pid": getpid(), "windowId": window.windowNumber,
              "x": point.x, "y": height - point.y, "title": window.title])
        DispatchQueue.global(qos: .utility).async {
            while !FileHandle.standardInput.availableData.isEmpty {}
            DispatchQueue.main.async { self.stop() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 55) { self.stop() }
    }

    @objc private func clicked() {
        clicks += 1
        emit(["protocol": 1, "event": "click", "count": clicks])
    }

    private func stop() {
        window?.orderOut(nil)
        window?.close()
        window = nil
        emit(["protocol": 1, "event": "cleanup", "window": false])
        NSApp.terminate(nil)
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let fixture = Fixture()
    application.delegate = fixture
    application.run()
}
