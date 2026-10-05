// 6.7 (audit N18) — port of android/…/ui/parts/SecureDialog.java. On Android a
// dialog is a window of its own and must take the app's FLAG_SECURE, or it shows
// up in screenshots, recordings and the recent-apps thumbnail. iOS forbids no
// screenshot (docs/ios-architecture.md § 5); its substitute, ScreenPrivacy, covers
// the app's windows in the app switcher and while the screen is recorded or
// mirrored. So a dialog with secrets (a safety number, the message details, the
// profile's fields) is presented INSIDE the app's own window — a sheet or an alert
// of its view controller — never a window of its own, and the cover hides it too.

import M5Design
import SwiftUI
import UIKit

@MainActor
enum SecureDialog {
    enum Detent { case medium, large }

    /// An alert's button (AlertDialog's positive / negative / neutral).
    struct Action {
        enum Role { case normal, cancel, destructive }
        let label: String
        var role: Role = .normal
        var run: (@MainActor () -> Void)?

        init(label: String, role: Role = .normal, run: (@MainActor () -> Void)? = nil) {
            self.label = label
            self.role = role
            self.run = run
        }
    }

    /// The window's view controller that is on top now (where a dialog is presented).
    static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first,
              let window = scene.keyWindow ?? scene.windows.first(where: { $0.windowLevel == .normal && !$0.isHidden }),
              var top = window.rootViewController else { return nil }
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }

    /// An alert in the app's window (AlertDialog with a message and buttons).
    static func alert(host: DesignHost?, title: String?, message: String, actions: [Action]) {
        guard let top = topController() else { return }
        let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
        for x in actions {
            let style: UIAlertAction.Style = x.role == .cancel ? .cancel : x.role == .destructive ? .destructive : .default
            let run = x.run
            a.addAction(UIAlertAction(title: x.label, style: style) { _ in MainActor.assumeIsolated { run?() } })
        }
        if let host { a.overrideUserInterfaceStyle = host.isDark ? .dark : .light }
        top.present(a, animated: true)
    }

    /// A SwiftUI dialog as a sheet of the app's window (from the bottom on iPhone, a card on iPad), in the
    /// window's tone, with the host in its environment and `\.peopleClose` to close it. Returns its controller.
    @discardableResult
    static func present<V: View>(_ view: V, host: DesignHost, detents: [Detent] = [.medium, .large]) -> UIViewController? {
        guard let top = topController() else { return nil }
        let box = CloseBox()
        let surface = host.renderContext().color("@surface", .white).uiColor
        let root = view
            .environment(host)
            .environment(\.peopleClose, { box.close() })
            .environment(\.designTextScale, DesignTextScale.factor(DynamicTypeSize(UIApplication.shared.preferredContentSizeCategory) ?? .large))
        let vc = UIHostingController(rootView: root)
        box.controller = vc
        vc.view.backgroundColor = surface
        vc.overrideUserInterfaceStyle = host.isDark ? .dark : .light
        vc.modalPresentationStyle = .pageSheet
        if let sheet = vc.sheetPresentationController {
            sheet.detents = detents.map { $0 == .medium ? .medium() : .large() }
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 24
            sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        }
        top.present(vc, animated: !host.reducedMotion)
        return vc
    }

    @MainActor
    private final class CloseBox {
        weak var controller: UIViewController?
        func close() { controller?.dismiss(animated: true) }
    }
}

private struct PeopleCloseKey: EnvironmentKey {
    static let defaultValue: @MainActor @Sendable () -> Void = {}
}

extension EnvironmentValues {
    /// Closes the dialog SecureDialog presented this view in.
    var peopleClose: @MainActor @Sendable () -> Void {
        get { self[PeopleCloseKey.self] }
        set { self[PeopleCloseKey.self] = newValue }
    }
}
