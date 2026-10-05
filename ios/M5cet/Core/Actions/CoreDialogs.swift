// The app's own small dialogs where Android used an AlertDialog (Parts.changePin,
// duressChanged, askWipe, pickRecipients, RoomEdit.ask, forward's room / person
// lists, AccountDialogs): UIAlertController on the window's top view controller,
// SwiftUI for a multiple choice. Texts are the design's. The privacy cover
// (ScreenPrivacy) keeps them out of the app switcher like the rest of the app.

import SwiftUI
import UIKit

@MainActor
enum CoreDialogs {
    /// Presented over the active window's top view controller (tests: nil — every dialog answers "cancelled").
    static var presenter: () -> UIViewController? = {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        guard var top = (scene?.keyWindow ?? scene?.windows.first)?.rootViewController else { return nil }
        while let next = top.presentedViewController { top = next }
        return top
    }

    /// A question with a yes (destructive when it erases something) and a no. True for yes.
    static func confirm(title: String, message: String, yes: String, no: String, destructive: Bool = false) async -> Bool {
        guard let vc = presenter() else { return false }
        return await withCheckedContinuation { c in
            let a = UIAlertController(title: title.isEmpty ? nil : title, message: message.isEmpty ? nil : message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: no, style: .cancel) { _ in c.resume(returning: false) })
            a.addAction(UIAlertAction(title: yes, style: destructive ? .destructive : .default) { _ in c.resume(returning: true) })
            vc.present(a, animated: true)
        }
    }

    /// A notice with one button.
    static func notice(title: String, message: String, ok: String = "OK", extra: (String, @MainActor () -> Void)? = nil) async {
        guard let vc = presenter() else { return }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let a = UIAlertController(title: title.isEmpty ? nil : title, message: message, preferredStyle: .alert)
            if let extra { a.addAction(UIAlertAction(title: extra.0, style: .default) { _ in extra.1(); c.resume() }) }
            a.addAction(UIAlertAction(title: ok, style: .cancel) { _ in c.resume() })
            vc.present(a, animated: true)
        }
    }

    struct Field {
        var placeholder: String
        var secure = false
        var numeric = false
    }

    /// Text fields (PINs: secure + numeric); nil when cancelled.
    static func inputs(title: String, message: String = "", fields: [Field], ok: String, cancel: String) async -> [String]? {
        guard let vc = presenter() else { return nil }
        return await withCheckedContinuation { c in
            let a = UIAlertController(title: title, message: message.isEmpty ? nil : message, preferredStyle: .alert)
            for f in fields {
                a.addTextField { t in
                    t.placeholder = f.placeholder
                    t.isSecureTextEntry = f.secure
                    t.keyboardType = f.numeric ? .numberPad : .default
                    t.textContentType = f.secure ? .oneTimeCode : nil
                    t.autocorrectionType = .no
                }
            }
            a.addAction(UIAlertAction(title: cancel, style: .cancel) { _ in c.resume(returning: nil) })
            a.addAction(UIAlertAction(title: ok, style: .default) { [weak a] _ in c.resume(returning: (a?.textFields ?? []).map { $0.text ?? "" }) })
            vc.present(a, animated: true)
        }
    }

    /// One of a list (Android setItems); nil when cancelled.
    static func choose(title: String, items: [String], cancel: String) async -> Int? {
        guard let vc = presenter(), !items.isEmpty else { return nil }
        return await withCheckedContinuation { c in
            let a = UIAlertController(title: title, message: nil, preferredStyle: .alert)
            for (i, item) in items.enumerated() { a.addAction(UIAlertAction(title: item, style: .default) { _ in c.resume(returning: i) }) }
            a.addAction(UIAlertAction(title: cancel, style: .cancel) { _ in c.resume(returning: nil) })
            vc.present(a, animated: true)
        }
    }

    /// Several of a list (Android setMultiChoiceItems) with an extra "everyone" button: the chosen indexes, [] for
    /// everyone, nil when cancelled.
    static func chooseMany(title: String, items: [String], chosen: Set<Int>, ok: String, everyone: String, cancel: String) async -> [Int]? {
        guard let vc = presenter(), !items.isEmpty else { return nil }
        return await withCheckedContinuation { c in
            var done = false
            let finish: @MainActor ([Int]?) -> Void = { r in
                guard !done else { return }
                done = true
                vc.dismiss(animated: true)
                c.resume(returning: r)
            }
            let host = UIHostingController(rootView: MultiChoice(title: title, items: items, chosen: chosen, ok: ok, everyone: everyone, cancel: cancel, done: finish))
            host.modalPresentationStyle = .formSheet
            host.sheetPresentationController?.detents = [.medium(), .large()]
            host.presentationController?.delegate = DismissWatcher.shared
            DismissWatcher.shared.onDismiss = { finish(nil) }
            vc.present(host, animated: true)
        }
    }

    private struct MultiChoice: View {
        let title: String
        let items: [String]
        @State var chosen: Set<Int>
        let ok: String, everyone: String, cancel: String
        let done: @MainActor ([Int]?) -> Void

        init(title: String, items: [String], chosen: Set<Int>, ok: String, everyone: String, cancel: String, done: @escaping @MainActor ([Int]?) -> Void) {
            self.title = title; self.items = items; _chosen = State(initialValue: chosen); self.ok = ok; self.everyone = everyone; self.cancel = cancel; self.done = done
        }

        var body: some View {
            NavigationStack {
                List(items.indices, id: \.self) { i in
                    Button {
                        if chosen.contains(i) { chosen.remove(i) } else { chosen.insert(i) }
                    } label: {
                        HStack {
                            Text(items[i]).foregroundStyle(.primary)
                            Spacer()
                            if chosen.contains(i) { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                    }
                }
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(cancel) { done(nil) } }
                    ToolbarItem(placement: .confirmationAction) { Button(ok) { done(chosen.sorted()) } }
                    ToolbarItem(placement: .bottomBar) { Button(everyone) { done([]) } }
                }
            }
        }
    }

    /// A swipe-down of the multiple choice counts as cancel.
    private final class DismissWatcher: NSObject, UIAdaptivePresentationControllerDelegate {
        static let shared = DismissWatcher()
        var onDismiss: (@MainActor () -> Void)?
        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            MainActor.assumeIsolated { onDismiss?(); onDismiss = nil }
        }
    }
}
