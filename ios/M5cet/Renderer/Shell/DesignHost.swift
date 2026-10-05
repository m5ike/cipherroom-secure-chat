// One window's side of the design — the port of MainActivity as Renderer.Host and
// M5Design's ActionHost: the screen on show and its back stack, route(), each
// screen's scope (MainActivity.scopeFor), $form, the overlay (sheets, menus, flash
// messages, the confirmations ActionGuard asks for), and the actions the renderer
// carries out itself (navigation, menus, sheets, flash, copy / share, url.open).
// Every other action goes to AppActionRouter (contract 2).

import M5Design
import Observation
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import os

/// A menu on screen (ui/look/Menus.Item): its icon, label, danger, check and what it does.
struct MenuEntry: Identifiable {
    let id: Int
    let icon: String
    let label: String
    var danger = false
    var checked = false
    let run: @MainActor () -> Void
}

struct MenuRequest: Identifiable {
    let id = UUID()
    /// The RenderNode id (or a part's own anchor id) the menu hangs from.
    let anchor: String
    let entries: [MenuEntry]
}

/// A sheet over the screen: a screen of the design (join, update, tools, attach…) in a card or a dock.
struct SheetState: Identifiable, Equatable {
    let id = UUID()
    let screen: String
}

/// A flash message (Parts.flash): the design's "flash" screen with $flash.
struct FlashItem: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let text: String
    let level: FlashLevel
}

@MainActor
@Observable
final class DesignHost: ActionHost {
    @ObservationIgnored let services: DesignServices
    @ObservationIgnored private(set) var runner: ActionRunner!
    let router = ScreenRouter()

    /// $form — what inputs and choices hold. Not observed: typing does not redraw the screen (Android's TextWatcher).
    @ObservationIgnored var form: [String: DesignValue] = [:]
    /// Bumped by refresh(): the screen is resolved again with fresh data.
    private(set) var revision = 0

    // The window, as the shell sees it.
    /// The system's tone (when neither the user nor a one-tone template decides).
    var systemDark = false
    /// The screen's box is wider than tall ($lock.wide).
    var wide = false
    var regularWidth = false
    @ObservationIgnored var reducedMotion = false
    /// DEBUG launch argument -M5Dark (a tone for screenshots, not saved).
    var toneOverride: Bool?

    // The overlay.
    private(set) var sheet: SheetState?
    private(set) var menu: MenuRequest?
    private(set) var flashes: [FlashItem] = []
    var urlConfirmation: URLConfirmation?
    var shareConfirmation: ShareConfirmation?
    /// The swipe row that is open (one at a time).
    var openSwipeRow: String?
    /// Where the Tools dock is (the shell's coordinates): a tap outside closes it.
    @ObservationIgnored var dockFrame: CGRect?

    @ObservationIgnored private var splashSince = Date()
    @ObservationIgnored private var sheetClosedByTap: (screen: String, at: Date)?
    @ObservationIgnored private var reportedFailure: Int = -1
    @ObservationIgnored private var routeTask: Task<Void, Never>?

    static let log = Logger(subsystem: "cz.m5cet.app", category: "ui")
    static let actionLog = Logger(subsystem: "cz.m5cet.app", category: "actions")

    init(services: DesignServices) {
        self.services = services
        runner = ActionRunner(host: self)
    }

    // MARK: ActionHost

    var design: Design { services.design }
    var translator: Translator { Translator(design: design, lang: services.lang) }
    var settings: SettingsModel {
        get { services.settings }
        set { services.settings = newValue }
    }

    /// The tone someone decided (a one-tone template, the user's Light / Dark, -M5Dark), or nil: the system's.
    var explicitDark: Bool? {
        if let toneOverride { return toneOverride }
        let a = Appearance(settings: settings, templates: services.templates)
        if let forced = a.forcedDark() { return forced }
        switch settings.str("appearance.tone") {
        case "dark": return true
        case "light": return false
        default: return nil
        }
    }

    /// Ui.dark.
    var isDark: Bool { explicitDark ?? systemDark }

    func shownUsername() -> String? { services.actions.shownUsername?() }

    func flash(title: String, text: String, level: FlashLevel) { _ = showFlash(title: title, text: text, level: level) }

    /// MainActivity.refresh: the screen (and an open sheet) bound again with fresh data.
    func refresh() { revision &+= 1 }

    func settingChanged(_ key: String) { services.actions.settingChanged(key, host: self) }

    /// The look changed (look.set, theme.toggle…): drawn again in place (ui/look/Look.redraw).
    func lookChanged() { revision &+= 1 }

    /// lang.set: the new language at once (Android recreates the activity), then whoever cares (notification texts).
    func languageChanged(_ lang: String) {
        services.setLang(lang)
        revision &+= 1
        if services.actions.handles("lang.set") {
            services.actions.dispatch(.langSet(lang), context: ActionContext(host: self, source: nil))
        }
    }

    func confirmOpen(_ request: URLConfirmation) { urlConfirmation = request }

    func confirmShare(_ request: ShareConfirmation) { shareConfirmation = request }

    /// Copy: kept on this device (not handed to Universal Clipboard) — Android marks it sensitive.
    func copy(_ text: String) {
        UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: text]], options: [.localOnly: true])
    }

    func share(_ text: String) { SharePresenter.present([text]) }

    func log(_ level: FlashLevel, _ message: String) {
        switch level {
        case .error: Self.actionLog.error("\(message, privacy: .public)")
        case .warn: Self.actionLog.warning("\(message, privacy: .public)")
        default: Self.actionLog.debug("\(message, privacy: .public)")
        }
    }

    /// Actions.run's switch: what the renderer does itself; everything else to the app's router.
    func perform(_ action: DesignAction, source: ActionSource?) {
        switch action {
        case .screenOpen(let id): showScreen(id)
        case .back: back()
        case .menuOpen(let id): showDesignMenu(id, anchor: source)
        case .sheetOpen(let id): showSheet(id)
        case .sheetClose: closeOverlay()
        case .flash(let text): flash(title: "", text: text, level: .info)
        case .nfcWorkbench: showScreen("nfc")
        case .nfcBuilder: showScreen("nfc.builder")
        case .updateLater:
            // Parts.closeOverlay; the update code may remember the "later".
            closeOverlay()
            if services.actions.handles("update.later") { services.actions.dispatch(action, context: ActionContext(host: self, source: source)) }
        default:
            services.actions.dispatch(action, context: ActionContext(host: self, source: source))
        }
    }

    // MARK: screens

    var screen: String { router.screen }

    /// MainActivity.showScreen: a screen of the design (an id it does not have is ignored — and not logged by name).
    func showScreen(_ id: String, transition: Bool = true) {
        guard design.screen(id) != nil else {
            Self.log.warning("a screen the design does not have was asked for")
            return
        }
        // 6.14: until the app is enrolled, has its PIN and is unlocked, only the splash, enrolment and lock screens
        // show — a design's screen.open (or anything else) cannot step past the lock; route() decides instead.
        if id != "splash", id != "enroll", id != "lock" {
            let st = services.state.routeState
            if !st.enrolled || !st.lockSetUp || st.locked {
                Self.log.warning("a screen was asked for while the app is locked")
                route()
                return
            }
        }
        let animate = transition && !reducedMotion && !Look(settings: settings).still
        if animate, router.generation > 0, router.screen != id {
            withAnimation(screenAnimation) { router.show(id, transition: true) }
        } else {
            router.show(id, transition: false)
        }
    }

    /// The current screen drawn anew without a transition (goRoom on the room screen, a new design).
    func reshow() { router.reshow() }

    /// The design's screen transition (animations.screen) as the user likes motion.
    var screenAnimation: Animation {
        let spec = design.anim("screen")
        let look = Look(settings: settings, reducedMotion: reducedMotion)
        let ms = look.ms(spec.ms ?? 240)
        return look.easing(spec.easing).animation(ms / 1000)
    }

    /// Android's Back: the menu, then the sheet, then the back stack.
    @discardableResult
    func back() -> Bool {
        if menu != nil { menu = nil; return true }
        if closeOverlay() { return true }
        let wasAnimated = !reducedMotion && !Look(settings: settings).still
        var outcome = ScreenRouter.BackOutcome.leave
        if wasAnimated {
            withAnimation(screenAnimation) { outcome = router.back() }
        } else {
            outcome = router.back()
        }
        return outcome != .leave
    }

    /// MainActivity.route: wiped, not enrolled, no PIN yet, locked — or the app (after the splash's minimum time).
    func route() {
        routeTask?.cancel()
        let minMs = design.anim("splash").values["minMs"]?.numberValue ?? 700
        let wait = minMs / 1000 - Date().timeIntervalSince(splashSince)
        if router.screen == "splash", wait > 0 {
            routeTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(wait))
                guard !Task.isCancelled else { return }
                self?.route()
            }
            return
        }
        let st = services.state.routeState
        if st.wipedNotice && !st.enrolled { flash(title: "", text: translator.t("lock.wiped"), level: .error) }
        if !st.enrolled { router.clearStack(); showScreen("enroll"); return }
        if !st.lockSetUp || st.locked { router.clearStack(); showScreen("lock"); return }
        router.clearStack()
        showScreen(st.hasActiveRoom ? "room" : "rooms")
        services.actions.enteredApp(host: self)
    }

    /// The splash first (MainActivity.onCreate), then route().
    func start() {
        splashSince = Date()
        router.clearStack()
        showScreen("splash", transition: false)
        route()
    }

    /// onResume: back from the background with the app locked meanwhile → the lock screen.
    func resumed() {
        let s = router.screen
        guard s != "splash", s != "lock", s != "enroll" else { return }
        let st = services.state.routeState
        if st.locked && st.lockSetUp { route() }
    }

    /// 6.12 (F-16): the app locked — what the screen holds of the open app leaves the memory.
    func forgetUi() {
        form.removeAll()
        sheet = nil
        menu = nil
    }

    // MARK: scopes (MainActivity.scopeFor)

    var screenContext: ScreenContext { ScreenContext(wide: wide, regularWidth: regularWidth, lang: services.lang) }

    var appScope: DesignValue { ScreenScope.app(design: design, version: AppInfo.version, code: Int(AppInfo.build) ?? 0) }

    /// The scope of a screen: $app $form $settings $define $account and the screen's own variables.
    func scope(for screen: String) -> Scope {
        let state = services.state
        var own = state.variables(for: screen, context: screenContext, host: self)
        if screen == "lock" {
            var lock = own["lock"]?.objectValue ?? [:]
            lock["wide"] = .bool(wide)
            own["lock"] = .object(lock)
        }
        if screen == "settings.appearance", own["presets"] == nil {
            own["presets"] = appearance.presets(lang: services.lang, designLabel: design.appName, design: design, systemDark: systemDark, translator: translator)
        }
        return ScreenScope.scope(screen: screen, app: appScope, form: form, settings: settings, define: state.define, account: state.account, own: own)
    }

    var appearance: Appearance { Appearance(settings: settings, templates: services.templates) }

    /// What a tree is resolved against now.
    func renderContext(animateEnter: Bool = false) -> RenderContext {
        RenderContext(design: design, dark: isDark, translator: translator, settings: settings, templates: services.templates,
                      form: form, reducedMotion: reducedMotion, animateEnter: animateEnter)
    }

    /// resolveOrFallback: the design's screen, or the built-in one when it fails (reported once per screen shown).
    func resolve(_ screen: String, scope: Scope, context: RenderContext? = nil) -> RenderNode? {
        let (node, failure) = ScreenResolver(context ?? renderContext()).resolveOrFallback(screen: screen, scope: scope, builtIn: services.builtIn)
        if let failure, reportedFailure != router.generation {
            reportedFailure = router.generation
            Self.log.error("screen \(screen, privacy: .public) failed: \(String(describing: failure), privacy: .public)")
            services.onRenderFailure?(screen, failure)
        }
        return node
    }

    // MARK: menus (MainActivity.showMenu, ui/look/Menus)

    /// A menu of the design at the element that asked for it (no anchor, no menu — as on Android).
    func showDesignMenu(_ id: String, anchor: ActionSource?) {
        guard let anchor else { Self.log.notice("a menu without an anchor"); return }
        let items: [ResolvedMenuItem]
        do { items = try ScreenResolver(renderContext()).menu(id, scope: scope(for: router.screen)) } catch {
            Self.log.error("menu failed: \(String(describing: error), privacy: .public)")
            return
        }
        let entries = items.enumerated().map { i, item in
            MenuEntry(id: i, icon: item.icon, label: item.label, danger: item.dangerous) { [weak self] in
                self?.runner.fire(item, source: anchor)
            }
        }
        showMenu(entries, anchor: anchor.id)
    }

    /// A menu at an element (its RenderNode id, or a part's anchor id with `.designMenuAnchor(_:)`).
    func showMenu(_ entries: [MenuEntry], anchor: String) {
        guard !entries.isEmpty else { return }
        menu = MenuRequest(anchor: anchor, entries: entries)
    }

    func dismissMenu() { menu = nil }

    /// A menu item was picked: the menu goes first, then the item runs (Menus: after the popup is gone).
    func pick(_ entry: MenuEntry) {
        menu = nil
        Task { @MainActor in entry.run() }
    }

    func menuBinding(_ anchor: String) -> Binding<Bool> {
        Binding(get: { [weak self] in self?.menu?.anchor == anchor },
                set: { [weak self] shown in if !shown, self?.menu?.anchor == anchor { self?.menu = nil } })
    }

    // MARK: sheets (Parts.showSheet, ui/look/Sheets)

    /// A screen of the design as a sheet (or the Tools dock). The dock a tap outside just closed stays closed.
    func showSheet(_ screen: String) {
        if let closed = sheetClosedByTap, closed.screen == screen, Date().timeIntervalSince(closed.at) < 0.4 { return }
        _ = closeOverlay()
        guard design.screen(screen) != nil else { return }
        let still = reducedMotion || Look(settings: settings).still
        withAnimation(still ? nil : .easeOut(duration: Look(settings: settings).ms(design.anim("dialog").ms ?? 220) / 1000)) {
            sheet = SheetState(screen: screen)
        }
    }

    /// Parts.closeOverlay: true when a sheet was open.
    @discardableResult
    func closeOverlay() -> Bool {
        guard sheet != nil else { return false }
        let still = reducedMotion || Look(settings: settings).still
        withAnimation(still ? nil : .easeIn(duration: Look(settings: settings).ms(160) / 1000)) { sheet = nil }
        // 6.8: what a sheet changed (a code typed in send.options) shows once it is gone.
        revision &+= 1
        return true
    }

    /// The dock was closed by a tap outside it (that tap must not open it again).
    func dockClosedByTap() {
        if let s = sheet { sheetClosedByTap = (s.screen, Date()) }
        dockFrame = nil
        closeOverlay()
    }

    // MARK: flash (Parts.flash)

    /// A flash message: the design's "flash" screen at the top, gone after animations.flash.stay (3.5 s) or a tap.
    @discardableResult
    func showFlash(title: String, text: String, level: FlashLevel) -> Bool {
        guard design.screen("flash") != nil, !text.isEmpty else { return false }
        let item = FlashItem(title: title, text: text, level: level)
        let still = reducedMotion || Look(settings: settings).still
        withAnimation(still ? nil : .easeOut(duration: 0.22)) { flashes.append(item) }
        let stay = (design.anim("flash").stay ?? 3500) / 1000
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(stay))
            self?.dismissFlash(item.id)
        }
        return true
    }

    func dismissFlash(_ id: UUID) {
        let still = reducedMotion || Look(settings: settings).still
        withAnimation(still ? nil : .easeIn(duration: 0.2)) { flashes.removeAll { $0.id == id } }
    }

    // MARK: confirmations

    func confirmURL() {
        guard let req = urlConfirmation else { return }
        urlConfirmation = nil
        // Only an address DesignUrls let through (https, readable in full) reaches here.
        if req.url.hasPrefix("https://"), let url = URL(string: req.url) { UIApplication.shared.open(url) }
    }

    func confirmShareRequest() {
        guard let req = shareConfirmation else { return }
        shareConfirmation = nil
        runner.confirmed(req)
    }

    // MARK: links (MainActivity.handleIntent)

    /// An m5cet:// link: whoever registered takes it; an enrolment link brings the enrolment screen forward
    /// while not enrolled and stays pending for its form. Returns whether it was taken.
    func handleLink(_ link: DeepLink) -> Bool {
        if services.actions.handleLink(link, host: self) { return true }
        if case .enroll = link, !services.state.routeState.enrolled, router.screen != "splash", router.screen != "enroll" {
            router.clearStack()
            showScreen("enroll")
        }
        return false
    }
}

/// The system's share sheet for a text (Android's ACTION_SEND chooser), from the active window.
@MainActor
enum SharePresenter {
    static func present(_ items: [Any]) {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.keyWindow ?? scene.windows.first,
              var top = window.rootViewController else { return }
        while let next = top.presentedViewController { top = next }
        let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let pop = vc.popoverPresentationController {
            pop.sourceView = window
            pop.sourceRect = CGRect(x: window.bounds.midX, y: window.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        top.present(vc, animated: true)
    }
}
