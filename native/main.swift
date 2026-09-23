// Lantern — native macOS host.
//
// Owns a WKWebView in a real NSWindow and runs the Python server as a child
// process, so quitting the app stops the server. No browser is involved.
//
//   swiftc -O main.swift -o Lantern -framework Cocoa -framework WebKit

import Cocoa
import WebKit

// ─────────────────────────────── helpers ───────────────────────────────

let dataDir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let dir = base.appendingPathComponent("Lantern")
    // carry a pre-rename "Slate" folder over rather than starting empty
    let legacy = base.appendingPathComponent("Slate")
    if !FileManager.default.fileExists(atPath: dir.path),
       FileManager.default.fileExists(atPath: legacy.path) {
        try? FileManager.default.moveItem(at: legacy, to: dir)
    }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}()

func note(_ message: String) {
    FileHandle.standardError.write(("[lantern] " + message + "\n").data(using: .utf8)!)
}

/// Is something accepting connections on this local port?
func portOpen(_ port: UInt16) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    var tv = timeval(tv_sec: 0, tv_usec: 300_000)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    let ok = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
        }
    }
    return ok
}

func findPython() -> String? {
    let candidates = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
        "/usr/bin/python3",                 // always present with the CLT
    ]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}

/// Theme the user last chose, so the window background matches on first paint.
func savedThemeIsDark() -> Bool {
    guard let data = try? Data(contentsOf: dataDir.appendingPathComponent("settings.json")),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let theme = obj["theme"] as? String
    else { return true }
    if theme == "light" { return false }
    if theme == "system" {
        let style = UserDefaults.standard.string(forKey: "AppleInterfaceStyle")
        return style?.lowercased().contains("dark") ?? false
    }
    return true
}

func usesOllama() -> Bool {
    guard let data = try? Data(contentsOf: dataDir.appendingPathComponent("settings.json")),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return true }
    return (obj["backend"] as? String) != "openai"
}

// ─────────────────────────────── app ───────────────────────────────

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
                         WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {

    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var port: Int = 0
    private var booted = false
    private var signalSources: [DispatchSourceSignal] = []

    // MARK: launch

    func applicationDidFinishLaunching(_ note: Notification) {
        installSignalHandlers()
        buildMenu()
        buildWindow()
        DispatchQueue.global(qos: .userInitiated).async { self.boot() }
    }

    /// Quitting from the Dock arrives as an Apple Event and runs
    /// applicationWillTerminate, but a bare signal does not — without this a
    /// `kill` or a log-out would leave the Python server orphaned.
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { NSApp.terminate(nil) }
            src.resume()
            signalSources.append(src)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) {
        if let server = server, server.isRunning {
            server.terminate()
            // give it a moment to release the port before we go
            let deadline = Date().addingTimeInterval(2)
            while server.isRunning && Date() < deadline { usleep(50_000) }
        }
    }

    // MARK: window

    func buildWindow() {
        let dark = savedThemeIsDark()
        let bg = dark ? NSColor(srgbRed: 0.055, green: 0.059, blue: 0.075, alpha: 1)
                      : NSColor.white

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // right-click → Inspect Element, handy when tweaking the frontend
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) { webView.underPageBackgroundColor = bg }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Lantern"
        window.minSize = NSSize(width: 560, height: 420)
        window.backgroundColor = bg
        window.delegate = self
        window.contentView = webView
        window.setFrameAutosaveName("LanternMainWindow")
        window.tabbingMode = .disallowed
        if window.frame.origin == .zero { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: boot sequence (off the main thread)

    func boot() {
        guard let python = findPython() else {
            fail("No python3 found.",
                 "Install Apple's command line tools:\n\n    xcode-select --install")
            return
        }
        note("python \(python)")

        if usesOllama() { ensureOllama() }

        guard let resources = Bundle.main.resourceURL else {
            fail("Bundle is malformed.", "Resources folder is missing.")
            return
        }
        let script = resources.appendingPathComponent("app/server.py")
        guard FileManager.default.fileExists(atPath: script.path) else {
            fail("Lantern's server is missing.", "Expected it at:\n\n\(script.path)")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: python)
        proc.arguments = [script.path, "--host", "127.0.0.1", "--port", "0"]
        var env = ProcessInfo.processInfo.environment
        env["LANTERN_DATA"] = dataDir.path
        env["PYTHONUNBUFFERED"] = "1"
        // last-resort cleanup: the server exits on its own if we die without
        // getting the chance to kill it (SIGKILL, crash, log-out)
        env["LANTERN_WATCH_PARENT"] = "1"
        proc.environment = env

        let out = Pipe()
        proc.standardOutput = out
        let logPath = dataDir.appendingPathComponent("lantern.log")
        FileManager.default.createFile(atPath: logPath.path, contents: nil)
        proc.standardError = (try? FileHandle(forWritingTo: logPath)) ?? FileHandle.standardError

        do { try proc.run() } catch {
            fail("Couldn't start Lantern's server.", error.localizedDescription)
            return
        }
        server = proc

        // The server prints LANTERN_PORT=<n> as soon as it is bound.
        var found = 0
        var buffer = Data()
        let handle = out.fileHandleForReading
        let deadline = Date().addingTimeInterval(20)
        while found == 0 && Date() < deadline {
            let chunk = handle.availableData
            if chunk.isEmpty { if !proc.isRunning { break }; continue }
            buffer.append(chunk)
            guard let text = String(data: buffer, encoding: .utf8) else { continue }
            for line in text.split(separator: "\n") where line.hasPrefix("LANTERN_PORT=") {
                found = Int(line.dropFirst("LANTERN_PORT=".count).trimmingCharacters(
                    in: .whitespaces)) ?? 0
            }
        }
        // keep draining so the pipe never fills and blocks the child
        handle.readabilityHandler = { h in _ = h.availableData }

        guard found > 0 else {
            fail("Lantern's server didn't start.",
                 "See the log at:\n\n\(logPath.path)")
            return
        }
        port = found
        note("server on \(found)")

        DispatchQueue.main.async {
            self.booted = true
            self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(found)/")!))
        }
    }

    /// Start Ollama if it isn't already listening. Not fatal — the UI shows a banner.
    func ensureOllama() {
        if portOpen(11434) { return }
        note("starting Ollama")
        if FileManager.default.fileExists(atPath: "/Applications/Ollama.app") {
            let open = Process()
            open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            open.arguments = ["-g", "-a", "Ollama"]
            try? open.run()
        } else if FileManager.default.isExecutableFile(atPath: "/usr/local/bin/ollama") {
            let serve = Process()
            serve.executableURL = URL(fileURLWithPath: "/usr/local/bin/ollama")
            serve.arguments = ["serve"]
            try? serve.run()
        }
        let deadline = Date().addingTimeInterval(12)
        while !portOpen(11434) && Date() < deadline { usleep(400_000) }
    }

    func fail(_ title: String, _ detail: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = title
            alert.informativeText = detail
            alert.addButton(withTitle: "Quit")
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    // MARK: navigation

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // an <a download> or a non-displayable response becomes a file
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let host = url.host ?? ""
        let isLocal = host == "127.0.0.1" || host == "localhost" || url.scheme == "about"
            || url.scheme == "blob" || url.scheme == "data"
        if !isLocal {
            // links in model output belong in the user's real browser
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        showLoadError(error)
    }

    private func showLoadError(_ error: Error) {
        guard booted, (error as NSError).code != NSURLErrorCancelled else { return }
        let alert = NSAlert()
        alert.messageText = "Lantern couldn't load"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "Retry")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn {
            webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
        } else {
            NSApp.terminate(nil)
        }
    }

    // window.open / target=_blank
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: JS dialogs — without these, confirm() silently returns false
    // and prompt() returns nil, which would break rename and every delete.

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Lantern"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Lantern"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Lantern"
        alert.informativeText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
        field.becomeFirstResponder()
    }

    // MARK: file picker — needed for <input type=file> attachments

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // MARK: downloads — makes "Export chat" work

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
                 didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var target = downloads.appendingPathComponent(
            suggestedFilename.isEmpty ? "slate-export.txt" : suggestedFilename)
        // never clobber an existing file
        let base = target.deletingPathExtension().lastPathComponent
        let ext = target.pathExtension
        var n = 2
        while FileManager.default.fileExists(atPath: target.path) {
            let name = ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)"
            target = downloads.appendingPathComponent(name)
            n += 1
        }
        completionHandler(target)
        objc_setAssociatedObject(download, &destinationKey, target.path, .OBJC_ASSOCIATION_RETAIN)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let path = objc_getAssociatedObject(download, &destinationKey) as? String else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func download(_ download: WKDownload, didFailWithError error: Error,
                  resumeData: Data?) {
        let alert = NSAlert()
        alert.messageText = "Export failed"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }

    // MARK: menu
    //
    // Deliberately sparse. The web app already binds ⌘M, ⌘R, ⌘P, ⌘F, ⌘S and ⌘,
    // so those keys are left free rather than stolen by native menu items.

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Lantern", action: #selector(about), keyEquivalent: "")
        appMenu.items.last?.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Lantern", action: #selector(NSApplication.hide(_:)),
                        keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "Hide Others",
                                    action: #selector(NSApplication.hideOtherApplications(_:)),
                                    keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Lantern", action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)),
                     keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        let reload = NSMenuItem(title: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        reload.keyEquivalentModifierMask = [.command, .shift]   // ⌘R belongs to the web app
        reload.target = self
        view.addItem(reload)
        view.addItem(.separator())
        view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        view.items.last?.target = self
        let zoomIn = NSMenuItem(title: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        zoomIn.target = self
        view.addItem(zoomIn)
        let zoomOut = NSMenuItem(title: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        zoomOut.target = self
        view.addItem(zoomOut)
        view.addItem(.separator())
        let full = NSMenuItem(title: "Enter Full Screen",
                              action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        view.addItem(full)
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        // no ⌘M — the web app uses that for the model picker
        windowMenu.addItem(withTitle: "Minimize",
                           action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)),
                           keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    @objc func reloadPage() { webView.reload() }
    @objc func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 2.5) }
    @objc func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
    @objc func zoomReset() { webView.pageZoom = 1.0 }

    @objc func about() {
        let alert = NSAlert()
        alert.messageText = "Lantern"
        alert.informativeText = """
            A lean local chat interface.

            Server: 127.0.0.1:\(port)
            Data: \(dataDir.path)
            """
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Show Data Folder")
        if alert.runModal() == .alertSecondButtonReturn {
            NSWorkspace.shared.activateFileViewerSelecting([dataDir])
        }
    }
}

private var destinationKey: UInt8 = 0

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
