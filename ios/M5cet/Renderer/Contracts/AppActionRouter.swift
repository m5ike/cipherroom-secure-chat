// Contract 2 (Renderer/README.md): the design's actions that are not the renderer's
// own — rooms, messages, calls, NFC, the lock, people, the profile… — the rest of
// android/…/ui/Actions.run's switch. Other code registers a handler per action name;
// DesignHost.perform hands every DesignAction it does not draw itself to the router.
// An action nobody handles is logged (never its argument) and ignored: no crash,
// no fake success.

import M5Design
import os

/// What a handler gets besides the action: the window's host and the element the action came from.
@MainActor
struct ActionContext {
    /// The window whose design ran the action (navigation, flash, sheets, $form, refresh).
    let host: DesignHost
    /// The element (its RenderNode id) — an anchor for a menu or a popover; nil for library steps of the app's code.
    let source: ActionSource?
}

@MainActor
final class AppActionRouter {
    typealias Handler = @MainActor (DesignAction, ActionContext) -> Void

    private var handlers: [String: Handler] = [:]
    private var settingObservers: [@MainActor (String, DesignHost) -> Void] = []
    private var linkHandlers: [@MainActor (DeepLink, DesignHost) -> Bool] = []
    static let log = Logger(subsystem: "cz.m5cet.app", category: "actions")

    /// Handles these actions (design names: "room.switch", "message.send"…). A later registration replaces an earlier one.
    func register(_ names: [String], handler: @escaping Handler) {
        for n in names { handlers[n] = handler }
    }

    func unregister(_ names: [String]) { for n in names { handlers[n] = nil } }

    func handles(_ name: String) -> Bool { handlers[name] != nil }

    var registered: [String] { handlers.keys.sorted() }

    /// Runs the handler of the action; false (and a log line) when nobody handles it.
    @discardableResult
    func dispatch(_ action: DesignAction, context: ActionContext) -> Bool {
        let name = action.name
        guard let handler = handlers[name] else {
            // The name only: an argument may carry a message's text (the log may reach the console).
            Self.log.notice("unhandled action \(name, privacy: .public)")
            return false
        }
        handler(action, context)
        return true
    }

    // MARK: side effects of settings (MainActivity.settingChanged)

    /// A setting changed (setting.set / toggle, a bound switch, the settings list): permissions, services…
    func onSettingChanged(_ observer: @escaping @MainActor (String, DesignHost) -> Void) { settingObservers.append(observer) }

    func settingChanged(_ key: String, host: DesignHost) { for o in settingObservers { o(key, host) } }

    // MARK: m5cet:// links (MainActivity.handleIntent → Forms.enrollLink)

    /// A link of the app; return true when it was taken. Untaken links stay in AppModel.pendingLink.
    func onLink(_ handler: @escaping @MainActor (DeepLink, DesignHost) -> Bool) { linkHandlers.append(handler) }

    func handleLink(_ link: DeepLink, host: DesignHost) -> Bool {
        for h in linkHandlers where h(link, host) { return true }
        return false
    }

    // MARK: entering the app (MainActivity.enterApp)

    /// After the unlock, route() shows the rooms (or the active room) and calls these: load the rooms, the
    /// duress reconcile, the notification permission, a pending room or share, the check-in.
    func onEnterApp(_ observer: @escaping @MainActor (DesignHost) -> Void) { enterObservers.append(observer) }

    func enteredApp(host: DesignHost) { for o in enterObservers { o(host) } }

    private var enterObservers: [@MainActor (DesignHost) -> Void] = []

    // MARK: profile.public (ActionGuard: only the person whose detail is open)

    /// The username of the person whose detail the app shows now (People), or nil.
    var shownUsername: (@MainActor () -> String?)?
}
