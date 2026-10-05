// The slots the renderer draws itself (Parts.create): splashLogo and logo
// (Logos.java), settingsList (SettingsList.java) and updateProgress
// (CallParts.Progress). Every other slot is registered by the parts' code.

import M5Design
import SwiftUI

@MainActor
enum RendererParts {
    static func register(into registry: SlotRegistry) {
        registry.register("splashLogo") { ctx in
            let spec = ctx.context.design.anim("splash")
            return AnyView(M5SplashLogo(style: spec.style ?? "orbit", period: max(300, spec.ms ?? 1400) / 1000,
                                        still: ctx.host.reducedMotion, primary: ctx.color("@primary", .red), onPrimary: ctx.color("@onPrimary", .white)))
        }
        registry.register("logo") { ctx in
            AnyView(M5MarkView(primary: ctx.color("@primary", .red), onPrimary: ctx.color("@onPrimary", .white)))
        }
        registry.register("settingsList") { ctx in AnyView(SettingsListPart(ctx: ctx)) }
        registry.register("updateProgress") { ctx in
            // CallParts.Progress: $update.progress (0–1) on a bar of 1000 steps.
            let p = Expr.num(ctx.scope["update"]["progress"])
            return AnyView(ProgressView(value: min(1, max(0, (p * 1000).rounded(.towardZero) / 1000)))
                .progressViewStyle(.linear)
                .tint(ctx.color("@primary", .blue))
                .frame(idealWidth: 160, idealHeight: 16)
                .accessibilityIdentifier(ctx.id))
        }
    }
}

extension DesignHost {
    /// The user's own tap on a setting (a privacy key too — SettingSchema allows only this and the app's code):
    /// saved, its side effects, the screen bound again; a look key redraws in place.
    @discardableResult
    func userSetSetting(_ key: String, _ value: DesignValue) -> Bool {
        var s = settings
        if key.hasPrefix("appearance.") || key.hasPrefix("look.") {
            guard s.lookSet(key, Expr.toText(value)) else { return false }
            settings = s
            if !Look.silent(key) { lookChanged() }
            return true
        }
        guard s.set(key, value) else { return false }
        settings = s
        settingChanged(key)
        refresh()
        return true
    }
}

/// SettingsList.java: lock, biometrics, PIN, notifications, the call log, the tone, the language, updates,
/// about, erase — the native list a design may place with the "settingsList" slot (the built-in design
/// draws its own settings screen). Biometrics show when the scope says so ($security.biometricAvailable,
/// $security.biometric — as on the settings.security screen).
struct SettingsListPart: View {
    let ctx: SlotContext
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let host = ctx.host
        let security = ctx.scope["security"]
        let lang = host.services.lang
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                section(ctx.t("settings.lock"), lang)
                if security["biometricAvailable"].boolValue == true {
                    toggle("fingerprint-pattern", ctx.t("settings.biometric"), on: security["biometric"].boolValue ?? false) { _ in ctx.run("biometric.toggle") }
                }
                row("key-round", ctx.t("settings.changePin"), id: "pin") { ctx.run("pin.change") }
                row("lock", ctx.t("menu.lock"), id: "lock") { ctx.run("lock.now") }
                section(ctx.t("settings.notifications"), lang)
                row("bell", ctx.t("settings.notifications"), id: "notifications") { ctx.run("system.settings", "notifications") }
                toggle("phone", ctx.t("settings.callLog"), on: host.settings.bool("callLog")) { on in host.userSetSetting("callLog", .bool(on)) }
                section(ctx.t("settings.theme"), lang)
                toggle("moon", ctx.t("settings.theme"), on: host.isDark) { on in host.userSetSetting("appearance.tone", .string(on ? "dark" : "light")) }
                row("languages", ctx.t("settings.language") + " · " + shownLanguage(host), id: "language") { languages(host) }
                section(ctx.t("settings.updates"), lang)
                row("refresh-cw", ctx.t("menu.update"), id: "update") { ctx.run("update.check") }
                row("info", ctx.t("settings.about"), id: "about") { host.showScreen("about") }
                section("", lang)
                row("trash", ctx.t("settings.wipe"), id: "wipe") { ctx.run("wipe.ask") }
            }
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .accessibilityIdentifier(ctx.id)
    }

    // MARK: rows

    private var family: FontFamily { ctx.context.look.family(ctx.context.design) }

    private func section(_ title: String, _ lang: String) -> some View {
        // 6.13: upper case by the app language's rules, not the phone's.
        Text(verbatim: title.uppercased(with: Locale(identifier: DesignLocales.tag(lang))))
            .font(DesignFonts.font(size: 12 * scale, weight: .bold, italic: false, family: family))
            .foregroundStyle(ctx.color("@primary", .red))
            .padding(EdgeInsets(top: 18, leading: 20, bottom: 6, trailing: 20))
            .accessibilityAddTraits(.isHeader)
    }

    private func line(_ icon: String, _ label: String) -> some View {
        HStack(spacing: 18) {
            DesignIcon(name: icon, size: 22, color: ctx.color("@muted", .gray))
            Text(verbatim: label)
                .font(DesignFonts.font(size: 16 * scale, weight: .regular, italic: false, family: family))
                .foregroundStyle(ctx.color("@onSurface", .black))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }

    private func row(_ icon: String, _ label: String, id: String, _ action: @escaping @MainActor () -> Void) -> some View {
        let anchor = ctx.id + "/" + id
        return Button(action: action) { line(icon, label) }
            .buttonStyle(NodeButtonStyle(box: BoxStyle(press: .ripple(ctx.context.color("@onSurface", .black).withAlpha(0.12))), reduceMotion: ctx.host.reducedMotion))
            .accessibilityIdentifier(anchor)
            .designMenuAnchor(anchor)
    }

    private func toggle(_ icon: String, _ label: String, on: Bool, _ change: @escaping @MainActor (Bool) -> Void) -> some View {
        Toggle(isOn: Binding(get: { on }, set: { change($0) })) { line(icon, label).padding(.trailing, -20) }
            .toggleStyle(.switch)
            .tint(ctx.color("@primary", .blue))
            .padding(.trailing, 16)
    }

    // MARK: the language (6.13: the nine by their own names, and "as the phone")

    private func shownLanguage(_ host: DesignHost) -> String {
        let chosen = host.services.langChoice
        if DesignLocales.isLocale(chosen) { return DesignLocales.info(chosen).nativeName }
        return ctx.t("settings.languageSystem") + " (" + DesignLocales.info(host.services.lang).nativeName + ")"
    }

    private func languages(_ host: DesignHost) {
        let chosen = host.services.langChoice
        var entries = [MenuEntry(id: 0, icon: "", label: ctx.t("settings.languageSystem") + " — " + DesignLocales.info(DesignServices.systemLang).nativeName,
                                 checked: !DesignLocales.isLocale(chosen)) { host.languageChanged("") }]
        for (i, code) in DesignLocales.codes.enumerated() {
            entries.append(MenuEntry(id: i + 1, icon: "", label: DesignLocales.info(code).nativeName, checked: code == chosen) { host.languageChanged(code) })
        }
        host.showMenu(entries, anchor: ctx.id + "/language")
    }
}
