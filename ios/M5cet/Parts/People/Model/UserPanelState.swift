// The user panel's state (android/…/ui/parts/UserPanel.java + Config.usersPanel):
// open or not, docked to the left / right / bottom edge or floating ("none", at
// x / y), pinned or hiding itself into its edge — kept on this device (a UI
// preference, not a secret: UserDefaults, as Android keeps it in its config). The
// panel's "revealed" (out of its edge for a few seconds) is the view's moment.

import Foundation
import M5Core
import M5Design
import Observation

@MainActor
@Observable
final class UserPanelState {
    static var shared = UserPanelState()

    /// The panel tucks itself away after this long without a touch (UserPanel.HIDE_AFTER).
    static let hideAfter: Duration = .seconds(5)

    private(set) var open = false
    private(set) var dock = "right"
    private(set) var autoHide = false
    /// The floating panel's position (points; -1 = not placed yet).
    private(set) var x: Double = -1
    private(set) var y: Double = -1
    /// Out of its edge now (auto-hide), or shown (pinned).
    private(set) var revealed = false

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let key: String
    @ObservationIgnored private var hideGeneration = 0

    init(defaults: UserDefaults = .standard, key: String = "m5.usersPanel") {
        self.defaults = defaults
        self.key = key
        load()
    }

    private func load() {
        guard let text = defaults.string(forKey: key), let o = JSON.parseObject(text) else { return }
        open = o.bool("open") ?? false
        let d = o.optString("dock", "right")
        dock = ["left", "right", "bottom", "none"].contains(d) ? d : "right"
        autoHide = o.bool("autoHide") ?? false
        x = o.double("x") ?? -1
        y = o.double("y") ?? -1
    }

    private func save() {
        let o = JSONObject([("dock", .string(dock)), ("autoHide", .bool(autoHide)), ("open", .bool(open)), ("x", .double(x)), ("y", .double(y))])
        defaults.set(o.stringify(), forKey: key)
    }

    /// The edge the panel hides into (auto-hide never applies to the floating panel).
    var hides: Bool { autoHide && dock != "none" }

    /// users.toggle.
    func toggle() {
        open.toggle()
        revealed = true
        save()
    }

    /// users.dock: left | right | bottom | none (floating — never hides itself).
    func dock(_ edge: String) {
        dock = ["left", "right", "bottom", "none"].contains(edge) ? edge : "right"
        if dock == "none" { autoHide = false }
        open = true
        revealed = true
        save()
    }

    /// users.autoHide: on, off, or toggled (nil). Tucks away shortly after it is switched on.
    func setAutoHide(_ on: Bool?) {
        var v = on ?? !autoHide
        if dock == "none" { v = false }
        autoHide = v
        // Switched on: it goes into its edge a moment later (animated); off: it stays out.
        revealed = true
        save()
        if v { scheduleTuck(after: .milliseconds(800)) }
    }

    #if DEBUG
    /// Sample mode (-M5Screen): the panel open, docked as asked (-M5UsersDock), nothing saved.
    static func sample(dock: String?, autoHide: Bool) -> UserPanelState {
        let suite = "cz.m5cet.sample.people"
        let d = UserDefaults(suiteName: suite) ?? .standard
        d.removePersistentDomain(forName: suite)
        let s = UserPanelState(defaults: d)
        s.open = true
        s.revealed = true
        s.dock = ["left", "right", "bottom", "none"].contains(dock ?? "") ? dock! : "right"
        s.autoHide = autoHide && s.dock != "none"
        return s
    }
    #endif

    /// The floating panel was dropped here (points in the panel's area).
    func place(x: Double, y: Double) {
        self.x = x
        self.y = y
        save()
    }

    /// The handle was tapped: out for a few seconds.
    func reveal() {
        revealed = true
        scheduleTuck(after: Self.hideAfter)
    }

    /// A touch inside the panel: the time starts again.
    func touchedInside() { if hides && revealed { scheduleTuck(after: Self.hideAfter) } }

    /// Back into its edge (only an auto-hiding docked panel).
    func tuck() {
        hideGeneration &+= 1
        guard hides else { return }
        revealed = false
    }

    private func scheduleTuck(after delay: Duration) {
        hideGeneration &+= 1
        let g = hideGeneration
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, g == self.hideGeneration else { return }
            self.tuck()
        }
    }

    /// $users of the room and call screens: open, dock, autoHide, count.
    func scope(count: Int) -> DesignValue {
        ["open": .bool(open), "dock": .string(dock), "autoHide": .bool(autoHide), "count": .number(Double(count))]
    }
}
