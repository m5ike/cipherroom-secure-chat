// Dialogs of the NFC parts that are not tied to one view (Android: AlertDialog /
// Dialog on the activity) — the connection tag's kind chooser and its code, a
// record's text, the model's sheet: UIKit presentation over the window that is
// in front (the same way the renderer's SharePresenter does it), so a design
// action (nfc.write) or a function's run can ask even when no NFC screen shows.

import SwiftUI
import UIKit

@MainActor
enum NfcPresenter {
    /// The view controller on top of the active window.
    static func top() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first,
              let window = scene.keyWindow ?? scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first,
              var top = window.rootViewController else { return nil }
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }

    /// A SwiftUI view as a sheet from the bottom. `modal`: no swipe to dismiss (the code shown once).
    @discardableResult
    static func sheet<V: View>(_ view: V, modal: Bool = false, large: Bool = false, dark: Bool? = nil,
                               onDismiss: (@MainActor () -> Void)? = nil) -> UIViewController? {
        guard let top = top() else { return nil }
        let vc = UIHostingController(rootView: view)
        vc.modalPresentationStyle = .pageSheet
        vc.isModalInPresentation = modal
        if let dark { vc.overrideUserInterfaceStyle = dark ? .dark : .light }
        if let sheet = vc.sheetPresentationController {
            sheet.detents = large ? [.large()] : [.medium(), .large()]
            sheet.prefersGrabberVisible = !modal
            sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        }
        if let onDismiss {
            let d = DismissWatcher(onDismiss)
            vc.presentationController?.delegate = d
            objc_setAssociatedObject(vc, &DismissWatcher.key, d, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
        top.present(vc, animated: true)
        return vc
    }

    /// A choice (Android AlertDialog.setItems): an action sheet anchored in the window's middle on iPad.
    static func choose(title: String, message: String? = nil, options: [NfcAlertButton], cancel: String, onCancel: (@MainActor () -> Void)? = nil) {
        guard let top = top() else { onCancel?(); return }
        let ac = UIAlertController(title: title, message: message, preferredStyle: .actionSheet)
        for o in options {
            ac.addAction(UIAlertAction(title: o.label, style: o.destructive ? .destructive : .default) { _ in MainActor.assumeIsolated { o.run() } })
        }
        ac.addAction(UIAlertAction(title: cancel, style: .cancel) { _ in MainActor.assumeIsolated { onCancel?() } })
        if let pop = ac.popoverPresentationController {
            pop.sourceView = top.view
            pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        top.present(ac, animated: true)
    }

    /// A message with buttons (Android AlertDialog with positive / neutral / negative).
    static func alert(title: String, message: String, buttons: [NfcAlertButton], close: String) {
        guard let top = top() else { return }
        let ac = UIAlertController(title: title, message: message, preferredStyle: .alert)
        for b in buttons { ac.addAction(UIAlertAction(title: b.label, style: .default) { _ in MainActor.assumeIsolated { b.run() } }) }
        ac.addAction(UIAlertAction(title: close, style: .cancel))
        top.present(ac, animated: true)
    }

    /// ConnTagUi.prepare / showCode: the kind chooser, then (offline) the code once.
    static func connTag(_ flow: NfcConnTagFlow, words: NfcWords, palette: @escaping @MainActor () -> NfcPalette?) {
        if flow.choosing {
            choose(title: words("nfc.v2.kind.title"), options: [
                NfcAlertButton(words("nfc.v2.kind.inv")) { Task { await flow.choose("inv", words: words) } },
                NfcAlertButton(words("nfc.v2.kind.off")) { Task { await flow.choose("off", words: words) } },
            ], cancel: words("nav.close"), onCancel: { flow.cancel() })
            return
        }
        if let code = flow.code, let p = palette() {
            let shown = NfcShownController()
            shown.vc = sheet(NfcCodeView(code: code, words: words, palette: p) {
                shown.vc?.dismiss(animated: true)
                flow.codeDone()
            }, modal: true)
        }
    }
}

/// A button of an alert or a choice.
struct NfcAlertButton {
    let label: String
    var destructive = false
    let run: @MainActor () -> Void

    init(_ label: String, destructive: Bool = false, _ run: @escaping @MainActor () -> Void) {
        self.label = label
        self.destructive = destructive
        self.run = run
    }
}

/// What was presented (to dismiss it from its own button).
@MainActor
final class NfcShownController {
    weak var vc: UIViewController?
}

/// An offline tag's code, shown once (Android ConnTagUi.showCode): big, monospaced, selectable.
struct NfcCodeView: View {
    let code: String
    let words: NfcWords
    let palette: NfcPalette
    let done: @MainActor () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            NfcText(text: words("nfc.v2.code.title"), size: 18, color: palette.fg, bold: true, family: palette.family)
            NfcText(text: code, size: 22, color: palette.fg, bold: true, mono: true, selectable: true)
                .accessibilityIdentifier("nfc.code")
            NfcText(text: words("nfc.v2.code.text"), size: 14, color: palette.muted, family: palette.family)
            NfcPillButton(label: words("nfc.v2.code.done"), icon: "check", primary: true, fill: true, palette: palette, id: "nfc.code.done", action: done)
                .padding(.top, 8)
            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface.ignoresSafeArea())
    }
}

/// Swipe-to-dismiss of a sheet (UIAdaptivePresentationControllerDelegate).
private final class DismissWatcher: NSObject, UIAdaptivePresentationControllerDelegate {
    nonisolated(unsafe) static var key: UInt8 = 0
    private let done: @MainActor () -> Void
    init(_ done: @escaping @MainActor () -> Void) { self.done = done }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        MainActor.assumeIsolated { done() }
    }
}
