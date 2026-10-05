// Contract 3 (Renderer/README.md): where the app is (MainActivity.route's inputs)
// and each screen's own variables (MainActivity.scopeFor's switch — the common
// ones, $app $form $settings $define $account, the renderer adds itself through
// M5Design ScreenScope). The real chat/app state comes from the integration;
// until then the app runs on UnconfiguredScreenState (not enrolled), and DEBUG
// builds can show any screen with SampleScreenState (the console's sample data).
//
// Make the conformer @Observable: the renderer resolves the screen again whenever
// something read in `routeState` / `variables(for:context:)` changes. Anything
// else calls `host.refresh()` (or `host.route()` when the lock state changed).

import M5Design

/// MainActivity.route: wiped, not enrolled, no PIN yet, locked, or in.
struct AppRouteState: Sendable, Equatable {
    var enrolled: Bool
    /// The PIN is set up (AppLock.isSetUp).
    var lockSetUp: Bool
    var locked: Bool
    /// A room is active: entering the app shows "room", else "rooms".
    var hasActiveRoom: Bool
    /// The data was wiped and the app is not enrolled: the renderer flashes lock.wiped once.
    var wipedNotice: Bool

    init(enrolled: Bool, lockSetUp: Bool, locked: Bool, hasActiveRoom: Bool = false, wipedNotice: Bool = false) {
        self.enrolled = enrolled; self.lockSetUp = lockSetUp; self.locked = locked
        self.hasActiveRoom = hasActiveRoom; self.wipedNotice = wipedNotice
    }
}

/// What the renderer knows of the window when it asks for a screen's variables.
struct ScreenContext: Sendable, Equatable {
    /// The screen's box is wider than tall (landscape, side by side) — $lock.wide.
    var wide: Bool
    /// iPad / a regular-width window.
    var regularWidth: Bool
    /// The app's language now ("en", "cs"…).
    var lang: String
}

@MainActor
protocol ScreenStateProvider: AnyObject {
    /// Where the app is (route() decides the screen from it).
    var routeState: AppRouteState { get }
    /// The screen's own variables (ScreenScope.screens lists them): "lock" → ["lock": …], "rooms" → ["rooms": …,
    /// "selectedCount": …], "room" → ["room", "rooms", "me", "users", "call"]… They win over the common ones.
    /// The renderer adds $lock.wide and, when missing, $presets (settings.appearance).
    func variables(for screen: String, context: ScreenContext) -> [String: DesignValue]
    /// The same for one window (6.14 core: the parts' providers read that window's $form — `$profile`). The default
    /// is the window-less one above.
    func variables(for screen: String, context: ScreenContext, host: DesignHost?) -> [String: DesignValue]
    /// $define (m5mobile.define) and $account.
    var define: DesignValue { get }
    var account: DesignValue { get }
}

extension ScreenStateProvider {
    func variables(for screen: String, context: ScreenContext, host: DesignHost?) -> [String: DesignValue] {
        variables(for: screen, context: context)
    }
}

/// The state before the integration: nothing enrolled, so the app shows the design's enrolment screen.
@MainActor
final class UnconfiguredScreenState: ScreenStateProvider {
    var routeState: AppRouteState { AppRouteState(enrolled: false, lockSetUp: false, locked: false) }
    func variables(for screen: String, context: ScreenContext) -> [String: DesignValue] {
        switch screen {
        case "enroll": return ["enroll": ["server": "", "error": ""]]
        case "splash": return ["status": "", "busy": true]
        default: return [:]
        }
    }
    var define: DesignValue { .object([:]) }
    var account: DesignValue { ["signedIn": false] }
}
