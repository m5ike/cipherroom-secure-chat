// The tools' own sheets over whatever the window shows (Android: an
// AlertDialog of the activity): a running command's question (FnAskView), and
// a function's file — saved through the system's export to Files (Android:
// Downloads) or opened in Quick Look. The file is written to the app's
// temporary directory with complete file protection and deleted when the
// sheet goes; nothing stays in the app.

import M5Core
import M5Design
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

@MainActor
final class ToolsSheets: FnPresenting {
    /// The view controller sheets go over: the key window's top one.
    static func top() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.flatMap(\.windows).first
        var vc = window?.rootViewController
        while let p = vc?.presentedViewController, !p.isBeingDismissed { vc = p }
        return vc
    }

    func ask(_ i: FnRun.Interaction, title: String, look: ToolsLook?, answer: @escaping (JSON?) -> Void) -> any FnAskHandle {
        let handle = AskHandle()
        guard let look, let top = Self.top() else {
            // Nowhere to ask (no window): cancelled, as a dismissed dialog would be.
            answer(nil)
            return handle
        }
        let view = FnAskView(interaction: i, fallbackTitle: title, look: look, answer: answer)
        let vc = UIHostingController(rootView: view)
        vc.overrideUserInterfaceStyle = look.dark ? .dark : .light
        vc.view.backgroundColor = UIColor(look.color("@surface"))
        if let sheet = vc.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        handle.vc = vc
        top.present(vc, animated: true)
        return handle
    }

    @MainActor
    private final class AskHandle: FnAskHandle {
        weak var vc: UIViewController?
        func dismiss() { vc?.dismiss(animated: true) }
    }

    // MARK: files

    private var exporting: Exporter?
    private var previewing: Previewer?

    func file(name: String, mime: String, data: Data, open: Bool, host: DesignHost?) {
        let safe = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "m5-\(Millis.now)" : Self.safeName(name)
        let url: URL
        do {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fn-files-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            url = dir.appendingPathComponent(safe)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            host?.flash(title: "", text: host?.translator.t("file.failed") ?? "", level: .error)
            return
        }
        guard let top = Self.top() else { Self.discard(url); return }
        if open {
            let p = Previewer(url: url) { [weak self] in self?.previewing = nil }
            previewing = p
            let ql = QLPreviewController()
            ql.dataSource = p
            ql.delegate = p
            top.present(ql, animated: true)
            return
        }
        let e = Exporter(url: url) { [weak self, weak host] saved in
            if saved { host?.flash(title: "", text: host?.translator.t("file.saved") ?? "", level: .success) }
            self?.exporting = nil
        }
        exporting = e
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = e
        top.present(picker, animated: true)
    }

    /// A file name without path separators or control characters.
    static func safeName(_ name: String) -> String {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.map { u -> Character in
            u == "/" || u == "\\" || u == ":" || u.properties.generalCategory == .control ? "_" : Character(u)
        }
        let s = String(cleaned)
        return s.hasPrefix(".") ? "_" + s.dropFirst() : String(s.prefix(120))
    }

    static func discard(_ url: URL) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

    @MainActor
    private final class Exporter: NSObject, UIDocumentPickerDelegate {
        let url: URL
        let done: (Bool) -> Void
        init(url: URL, done: @escaping (Bool) -> Void) { self.url = url; self.done = done }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { ToolsSheets.discard(url); done(true) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { ToolsSheets.discard(url); done(false) }
    }

    @MainActor
    private final class Previewer: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
        let url: URL
        let done: () -> Void
        init(url: URL, done: @escaping () -> Void) { self.url = url; self.done = done }
        nonisolated func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        nonisolated func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { url as NSURL }
        nonisolated func previewControllerDidDismiss(_ controller: QLPreviewController) {
            MainActor.assumeIsolated {
                ToolsSheets.discard(url)
                done()
            }
        }
    }
}
