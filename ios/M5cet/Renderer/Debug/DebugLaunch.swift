// DEBUG only: launch arguments for screenshots and UI tests —
//   -M5Screen <screenId>   show that screen with the console's sample state (no splash, no route)
//   -M5Dark YES|NO         the tone (not saved)
//   -M5Sheet <screenId>    also open a screen of the design as a sheet
//   -M5Flash <text>        also show a flash message
//   -M5Menu <menu>@<node>  also open a menu of the design at an element ("main@root/bar/menu")
//   -M5Landscape YES       ask the window scene for landscape (iPhone; an iPad that multitasks ignores it)
// e.g. xcrun simctl launch <udid> cz.m5cet.app -M5Screen rooms -M5Dark YES
// Compiled out of Release.

#if DEBUG
import Foundation
import M5Design
import UIKit

@MainActor
enum DebugLaunch {
    private static var args: UserDefaults { .standard }

    static var screen: String? { args.string(forKey: "M5Screen").flatMap { $0.isEmpty ? nil : $0 } }
    static var dark: Bool? { args.object(forKey: "M5Dark") == nil ? nil : args.bool(forKey: "M5Dark") }
    static var sheet: String? { args.string(forKey: "M5Sheet").flatMap { $0.isEmpty ? nil : $0 } }
    static var landscape: Bool { args.bool(forKey: "M5Landscape") }
    static var flash: String? { args.string(forKey: "M5Flash").flatMap { $0.isEmpty ? nil : $0 } }
    static var menu: (id: String, anchor: String)? {
        guard let v = args.string(forKey: "M5Menu"), let at = v.firstIndex(of: "@") else { return nil }
        return (String(v[..<at]), String(v[v.index(after: at)...]))
    }

    /// Sample mode: true when it took the window over.
    static func start(_ host: DesignHost) -> Bool {
        if let d = dark { host.toneOverride = d }
        if landscape {
            for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight)) { _ in }
            }
        }
        guard let id = screen else { return false }
        let state = (host.services.state as? SampleScreenState) ?? SampleScreenState()
        host.services.state = state
        SampleSlots.register(into: host.services.slots, state: state)
        // The core's start (AppCore.routeChanged) routes every window: this one keeps the screen asked for.
        host.sampleMode = true
        host.showScreen(id, transition: false)
        if let s = sheet { host.showSheet(s) }
        if let f = flash { host.showFlash(title: "", text: f, level: .success) }
        if let m = menu {
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(600))
                host.showDesignMenu(m.id, anchor: ActionSource(m.anchor))
            }
        }
        return true
    }
}
#endif
