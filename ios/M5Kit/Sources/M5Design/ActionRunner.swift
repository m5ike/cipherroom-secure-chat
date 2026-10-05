// Runs the design's actions — the logic of android/…/ui/Actions.java and the
// value commits of Renderer.Bound: the guard first (ActionGuard: computed
// arguments, privacy settings, setting rules), libraries (no nesting, at most
// 60 steps, each step's `if`), $form, settings and the look, url.open's and
// copy / share's confirmation rules — and every other action handed to the
// app as a typed DesignAction (ActionHost.perform).

import Foundation

public enum FlashLevel: String, Sendable { case info, success, warn, error }

/// The source of an action on screen (an anchor for menus and popovers), opaque to the design.
public struct ActionSource: Sendable, Hashable {
    public var id: String
    public init(_ id: String) { self.id = id }
}

/// What a computed copy / share asks the person (DesignShare): the text exactly as it will go,
/// hidden characters made visible; only the confirm button passes it on.
public struct ShareConfirmation: Sendable, Hashable {
    public var share: Bool
    /// The text that goes (copy / share it on confirm).
    public var text: String
    /// What the dialog shows (DesignShare.shown).
    public var shown: String
    /// The dialog's title and buttons, already in the app's language.
    public var title: String
    public var confirm: String
    public var cancel: String
}

/// What url.open asks the person (DesignUrls): the whole address, host first.
public struct URLConfirmation: Sendable, Hashable {
    public var url: String
    public var title: String
    public var confirm: String
    public var cancel: String

    /// For the app's own parts (links in messages, function outputs) that ask the same question.
    public init(url: String, title: String, confirm: String, cancel: String) {
        self.url = url
        self.title = title
        self.confirm = confirm
        self.cancel = cancel
    }
}

/// The app's side of the design's actions. The SwiftUI app implements it (main actor).
@MainActor
public protocol ActionHost: AnyObject {
    /// The design in use (libraries, menus, texts).
    var design: Design { get }
    /// The design's texts in the app's language.
    var translator: Translator { get }
    /// The user's settings; the runner writes validated values (save them in the setter).
    var settings: SettingsModel { get set }
    /// $form (the values inputs and choices are bound to).
    var form: [String: DesignValue] { get set }
    /// Whether the screens are dark now (theme.toggle flips it).
    var isDark: Bool { get }
    /// profile.public: the username of the person whose detail the app shows, or nil.
    func shownUsername() -> String?

    /// A short notice (Parts.flash).
    func flash(title: String, text: String, level: FlashLevel)
    /// Bind the current screen again with fresh data (MainActivity.refresh).
    func refresh()
    /// A setting changed by a design action or an element (MainActivity.settingChanged: permissions, services…).
    func settingChanged(_ key: String)
    /// The look (look.* / appearance.*) changed: draw the screen again in place.
    func lookChanged()
    /// The language changed ("" = the phone's): apply it and draw again.
    func languageChanged(_ lang: String)
    /// Show the address and open it only when the person confirms.
    func confirmOpen(_ request: URLConfirmation)
    /// Show the computed text and copy / share it only when the person confirms.
    func confirmShare(_ request: ShareConfirmation)
    /// Copy (marked sensitive) / the share sheet — the design's own text, at once.
    func copy(_ text: String)
    func share(_ text: String)
    /// Every other action, its argument read (navigation, rooms, calls, NFC, people, profile…).
    func perform(_ action: DesignAction, source: ActionSource?)
    /// A line for the app's log (never the argument's value: the log reaches the console).
    func log(_ level: FlashLevel, _ message: String)
}

extension ActionHost {
    public func log(_ level: FlashLevel, _ message: String) {}
    public func languageChanged(_ lang: String) { perform(.langSet(lang), source: nil) }
}

/// What a run did (tests, logs).
public enum ActionOutcome: Sendable, Equatable {
    case refused(ActionGuard.Refusal)
    case refusedURL
    case refusedShareTooLong
    /// Handled by the runner itself (library, $form, settings, look, confirmation asked…).
    case handled
    /// Handed to the host as a typed action.
    case performed(DesignAction)
    /// The action did nothing with this argument (Android's no-op branches) or failed.
    case ignored
    case unknown(String)
}

@MainActor
public final class ActionRunner {
    public unowned let host: ActionHost
    /// Library steps run at most this many.
    public static let maxSteps = 60

    public init(host: ActionHost) { self.host = host }

    private var tr: Translator { host.translator }

    /// An event of a resolved element: its argument evaluated in its scope, then run.
    @discardableResult
    public func fire(_ event: RenderEvent, source: ActionSource? = nil) -> ActionOutcome {
        do {
            let value = try event.raw.map { try Expr.value($0, event.scope, tr) }
            return run(event.action, raw: event.raw, value: value, scope: event.scope, source: source)
        } catch {
            host.log(.error, "\(event.action) failed: an argument that does not evaluate")
            return .ignored
        }
    }

    /// A menu item (MainActivity.showMenu's click).
    @discardableResult
    public func fire(_ item: ResolvedMenuItem, source: ActionSource? = nil) -> ActionOutcome {
        fire(RenderEvent(action: item.action, raw: item.raw, scope: item.scope, haptic: .none), source: source)
    }

    /// A swipe row's tile.
    @discardableResult
    public func fire(_ action: SwipeAction, source: ActionSource? = nil) -> ActionOutcome {
        run(action.action, raw: action.raw, value: action.value, scope: action.scope, source: source)
    }

    /// An action of the app's own code: it carries no argument the design computed... unless a value is
    /// given without a raw text — then it counts as computed (ActionGuard).
    @discardableResult
    public func runFromApp(_ action: String, value: DesignValue?, scope: Scope = .empty, source: ActionSource? = nil) -> ActionOutcome {
        run(action, raw: nil, value: value, scope: scope, source: source)
    }

    /// Actions.run: an action of the design with its raw argument and its value now.
    @discardableResult
    public func run(_ action: String, raw: String?, value: DesignValue?, scope: Scope, source: ActionSource? = nil, depth: Int = 0) -> ActionOutcome {
        host.log(.info, "action \(action)")
        let own = action == "profile.public" ? host.shownUsername() : nil
        if let refused = ActionGuard.check(action, raw: raw, value: value, own: own) {
            host.log(.warn, "\(action) refused: \(refused)")
            host.flash(title: "", text: tr.t("security.refused"), level: .warn)
            return .refused(refused)
        }
        let computed = ActionGuard.computed(raw, value)
        guard let parsed = DesignAction.parse(action, value: value, computed: computed) else { return .ignored }
        switch parsed {
        case .unknown(let name):
            host.log(.warn, "unknown action \(name)")
            return .unknown(name)
        case .libRun(let name):
            runLibrary(name, scope: scope, source: source, depth: depth)
            return .handled
        case .setForm(let name, let v):
            host.form[name] = .string(v)
            host.refresh()
            return .handled
        case .settingSet(let key, let v):
            var s = host.settings
            if s.set(key, .string(v)) {
                host.settings = s
                settingChanged(key)
            }
            return .handled
        case .settingToggle(let key):
            var s = host.settings
            if s.toggle(key) {
                host.settings = s
                settingChanged(key)
            }
            return .handled
        case .lookSet(let key, let v):
            var s = host.settings
            if s.lookSet(key, v) {
                host.settings = s
                if !Look.silent(key) { host.lookChanged() }
            }
            return .handled
        case .lookReset, .appearanceReset:
            var s = host.settings
            s.lookReset()
            host.settings = s
            host.lookChanged()
            return .handled
        case .themeToggle:
            var s = host.settings
            s.set("appearance.tone", .string(host.isDark ? "light" : "dark"))
            host.settings = s
            host.lookChanged()
            return .handled
        case .langSet(let l):
            host.languageChanged(l)
            return .performed(parsed)
        case .nfcReader(let reader):
            var s = host.settings
            s.set("nfc.reader", .string(reader))
            host.settings = s
            host.refresh()
            return .handled
        case .callSpeaker:
            var s = host.settings
            s.toggle("calls.speaker")
            host.settings = s
            host.perform(parsed, source: source)
            host.refresh()
            return .performed(parsed)
        case .urlOpen(let url):
            // 6.7 (F-01) / 6.10 (G-20): the whole address is shown first; one that cannot be read in full is refused.
            guard DesignUrls.openable(url) else {
                host.log(.warn, "url.open refused: not an address the person could read in full")
                host.flash(title: "", text: tr.t("security.urlRefused"), level: .warn)
                return .refusedURL
            }
            host.confirmOpen(URLConfirmation(url: url, title: DesignUrls.host(url) ?? url, confirm: tr.t("msg.open"), cancel: tr.t("nav.close")))
            return .handled
        case .copy(let text, let isComputed), .share(let text, let isComputed):
            let share: Bool
            if case .share = parsed { share = true } else { share = false }
            return copyOrShare(share: share, text: text, computed: isComputed)
        default:
            host.perform(parsed, source: source)
            return .performed(parsed)
        }
    }

    /// MainActivity.settingChanged + refresh; a look key also redraws (Look's settings watch).
    private func settingChanged(_ key: String) {
        host.settingChanged(key)
        host.refresh()
        if (key.hasPrefix("look.") || key.hasPrefix("appearance.")) && !Look.silent(key) { host.lookChanged() }
    }

    /// DesignShare.run: the design's own text goes at once; a computed one is shown and confirmed,
    /// and refused when it is too long to read.
    private func copyOrShare(share: Bool, text: String, computed: Bool) -> ActionOutcome {
        if !computed {
            if share { host.share(text) } else { host.copy(text); host.flash(title: "", text: "✓", level: .success) }
            return .handled
        }
        if text.isEmpty { return .ignored }
        if !DesignShare.fits(text) {
            host.log(.warn, "\(share ? "share" : "copy") refused: a computed text too long to show")
            host.flash(title: "", text: tr.t("security.shareTooLong"), level: .warn)
            return .refusedShareTooLong
        }
        host.confirmShare(ShareConfirmation(share: share, text: text, shown: DesignShare.shown(text),
                                            title: tr.t(share ? "security.shareAsk" : "security.copyAsk"),
                                            confirm: tr.t(share ? "security.shareGo" : "msg.copy"), cancel: tr.t("nav.close")))
        return .handled
    }

    /// The person confirmed a ShareConfirmation: pass the text on.
    public func confirmed(_ request: ShareConfirmation) {
        if request.share { host.share(request.text) } else { host.copy(request.text); host.flash(title: "", text: "✓", level: .success) }
    }

    /// Actions.runLibrary: a library's steps in the caller's scope; it cannot run another library.
    func runLibrary(_ name: String, scope: Scope, source: ActionSource?, depth: Int) {
        if depth > 0 { host.log(.warn, "a library cannot run another library"); return }
        guard let lib = host.design.library(name) else { host.log(.warn, "no library \(name)"); return }
        guard let steps = lib.steps else { return }
        for (i, st) in steps.prefix(Self.maxSteps).enumerated() {
            guard st.isObject else { continue }
            do {
                if let cond = st.condition, !cond.isEmpty, !Expr.truthy(try Expr.eval(cond, scope, tr)) { continue }
                guard let action = st.action else { throw DesignLoadError("a step without an action") }
                let value = try st.arg.map { try Expr.value($0, scope, tr) }
                run(action, raw: st.arg, value: value, scope: scope, source: source, depth: depth + 1)
            } catch {
                host.log(.error, "library \(name) step \(i) failed")
                return
            }
        }
    }

    // MARK: - elements bound to a value (Renderer.Bound.commit)

    /// A new value from the user on an element bound to a setting or a form value: into the setting
    /// (appearance.* through the look) / $form, then the element's `change` event with $value.
    /// The user's own tap: a privacy setting may change here (only the schema's rule applies).
    public func commit(_ binding: ValueBinding, value: DesignValue, source: ActionSource? = nil) {
        if let key = binding.setting {
            var s = host.settings
            if key.hasPrefix("appearance.") {
                if s.lookSet(key, Expr.toText(value)) { host.settings = s; if !Look.silent(key) { host.lookChanged() } }
            } else if s.set(key, value) {
                host.settings = s
                settingChanged(key)
            }
        }
        if let bind = binding.bind { host.form[bind] = value }
        if let change = binding.change {
            let sc = binding.scope.with("value", value)
            do {
                let arg = try change.arg.map { try Expr.value($0, sc, tr) }
                run(change.action, raw: change.arg, value: arg, scope: sc, source: source)
            } catch {
                host.log(.error, "\(change.action) failed: an argument that does not evaluate")
            }
        }
    }

    /// An input's text changed: $form[bind] (no redraw, as Android's TextWatcher).
    public func inputChanged(bind: String, text: String) { host.form[bind] = .string(text) }
}
