import AppKit
import Foundation

// A local review build. It never modifies Zen without an explicit action.
final class InstallerDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let profile = NSTextField(string: "")
    let zen = NSTextField(string: "/Applications/Zen.app")
    let hs = NSButton(checkboxWithTitle: "Configure Hammerspoon global shortcut", target: nil, action: nil)
    let status = NSTextField(wrappingLabelWithString: "Select a Zen profile, then preview the changes.")
    let action = NSPopUpButton()
    var lastPlan: String?
    var planFingerprint: String?
    var previewButton: NSButton!
    var applyButton: NSButton!

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 340), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "LittleZen Installer — Preview"
        window.center()
        let stack = NSStackView()
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "LittleZen Installer")
        title.font = .boldSystemFont(ofSize: 20)
        let explanation = NSTextField(wrappingLabelWithString: "Preview changes before installing, updating, or removing LittleZen. The loader can affect Zen’s code signature.")
        let profileRow = row("Zen profile", profile, #selector(selectProfile))
        let appRow = row("Zen app", zen, #selector(selectApp))
        action.addItems(withTitles: ["Install", "Update", "Remove"])
        action.target = self; action.action = #selector(clearPreview)
        hs.state = .off; hs.target = self; hs.action = #selector(clearPreview)
        profile.target = self; profile.action = #selector(clearPreview)
        zen.target = self; zen.action = #selector(clearPreview)
        previewButton = NSButton(title: "Preview", target: self, action: #selector(preview))
        applyButton = NSButton(title: "Apply", target: self, action: #selector(apply))
        applyButton.isEnabled = false
        let buttons = NSStackView(views: [action, previewButton, applyButton]); buttons.orientation = .horizontal; buttons.spacing = 12
        for view in [title, explanation, profileRow, appRow, hs, buttons, status] { stack.addArrangedSubview(view) }
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 22)])
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func row(_ title: String, _ field: NSTextField, _ selector: Selector) -> NSStackView {
        let label = NSTextField(labelWithString: title); label.widthAnchor.constraint(equalToConstant: 72).isActive = true
        field.widthAnchor.constraint(greaterThanOrEqualToConstant: 390).isActive = true
        let choose = NSButton(title: "Choose…", target: self, action: selector)
        let row = NSStackView(views: [label, field, choose]); row.orientation = .horizontal; row.spacing = 8
        return row
    }
    @objc func selectProfile() { choose(profile, canChooseFiles: false, title: "Choose the Zen profile folder") }
    @objc func selectApp() { choose(zen, canChooseFiles: true, title: "Choose Zen.app") }
    func choose(_ field: NSTextField, canChooseFiles: Bool, title: String) {
        let panel = NSOpenPanel(); panel.title = title; panel.canChooseFiles = canChooseFiles; panel.canChooseDirectories = !canChooseFiles
        panel.treatsFilePackagesAsDirectories = false; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { field.stringValue = url.path; clearPreview() }
    }
    @objc func clearPreview() { lastPlan = nil; planFingerprint = nil; applyButton.isEnabled = false }
    func args(_ apply: Bool) -> [String] {
        let bundleRoot = Bundle.main.resourceURL!
        let cli = bundleRoot.appendingPathComponent("installer/littlezen.py").path
        var a = ["python3", cli, "--profile", profile.stringValue, "--zen-app", zen.stringValue, "--action", action.titleOfSelectedItem!.lowercased()]
        if hs.state == .on && action.indexOfSelectedItem == 0 { a += ["--hammerspoon", NSHomeDirectory() + "/.hammerspoon"] }
        if apply { a += ["--apply", "--ack-bundle-modification", "--expected-plan", planFingerprint ?? ""] }
        return a
    }
    func run(_ apply: Bool, _ done: @escaping (Int32, String) -> Void) {
        let arguments = args(apply)
        previewButton.isEnabled = false; applyButton.isEnabled = false
        status.stringValue = "Checking…"
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process(); let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = arguments
            process.standardOutput = pipe; process.standardError = pipe
            var code: Int32 = -1; var output = ""
            do { try process.run(); let data = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit(); code = process.terminationStatus; output = String(decoding: data, as: UTF8.self) }
            catch { output = error.localizedDescription }
            DispatchQueue.main.async { self.previewButton.isEnabled = true; done(code, output) }
        }
    }
    @objc func preview() {
        clearPreview()
        guard !profile.stringValue.isEmpty else { status.stringValue = "Choose a Zen profile first."; return }
        run(false) { code, output in
            self.status.stringValue = code == 0 ? "Preview ready. Review the proposed changes below." : "Unable to prepare changes."
            let alert = NSAlert(); alert.messageText = code == 0 ? "Proposed changes" : "Cannot prepare changes"; alert.informativeText = output
            alert.addButton(withTitle: "OK"); alert.runModal()
            if code == 0, let data = output.data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let fingerprint = json["plan_fingerprint"] as? String {
                self.lastPlan = self.args(false).joined(separator: "\u{1f}"); self.planFingerprint = fingerprint; self.applyButton.isEnabled = true
            }
        }
    }
    @objc func apply() {
        guard lastPlan == args(false).joined(separator: "\u{1f}") else { clearPreview(); status.stringValue = "Settings changed. Preview again."; return }
        let alert = NSAlert(); alert.messageText = "Apply these changes?"
        alert.informativeText = "The selected Zen app must be closed. Installation may modify its bundle and invalidate its signature. Shared loader files are retained when removing LittleZen."
        alert.addButton(withTitle: "Apply"); alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        run(true) { code, output in
            self.clearPreview(); self.status.stringValue = code == 0 ? "Finished. Restart Zen to load changes." : "No completion was confirmed. Review details."
            let result = NSAlert(); result.messageText = code == 0 ? "Finished" : "Could not complete"; result.informativeText = output
            result.addButton(withTitle: "OK"); result.runModal()
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = InstallerDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
