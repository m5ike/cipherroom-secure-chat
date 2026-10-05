// What the Renderer tests share: a window host over the built-in design with its own
// settings store (never the app's), a state provider the tests drive, hosting a view.

import M5Design
import SwiftUI
import UIKit
import XCTest
@testable import M5cet

/// A provider the routing tests set by hand.
@MainActor
final class StubScreenState: ScreenStateProvider {
    var routeState: AppRouteState
    var vars: [String: [String: DesignValue]] = [:]
    var define: DesignValue = .object([:])
    var account: DesignValue = ["signedIn": false]

    init(_ route: AppRouteState) { routeState = route }

    func variables(for screen: String, context: ScreenContext) -> [String: DesignValue] { vars[screen] ?? [:] }
}

@MainActor
enum RendererTestSupport {
    /// Settings in a suite of their own, emptied first.
    static func store(_ name: String = "cz.m5cet.tests.renderer") -> SettingsStore {
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return SettingsStore(defaults: d)
    }

    static func services(state: (any ScreenStateProvider)? = nil, slots: SlotRegistry? = nil, actions: AppActionRouter? = nil) -> DesignServices {
        DesignServices(store: store(), slots: slots, actions: actions, state: state ?? SampleScreenState())
    }

    static func host(state: (any ScreenStateProvider)? = nil, actions: AppActionRouter? = nil) -> DesignHost {
        let h = DesignHost(services: services(state: state, actions: actions))
        h.reducedMotion = true
        return h
    }

    /// A view in a window of this size, laid out (and the run loop turned so SwiftUI draws it).
    @discardableResult
    static func layOut<V: View>(_ view: V, size: CGSize, regular: Bool = false, dark: Bool = false) -> UIHostingController<V> {
        let (vc, window) = show(view, size: size, regular: regular, dark: dark)
        window.isHidden = true
        return vc
    }

    /// The view in a visible window (hide it when done).
    static func show<V: View>(_ view: V, size: CGSize, regular: Bool = false, dark: Bool = false) -> (UIHostingController<V>, UIWindow) {
        let vc = UIHostingController(rootView: view)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
        window.frame = CGRect(origin: .zero, size: size)
        window.traitOverrides.horizontalSizeClass = regular ? .regular : .compact
        window.traitOverrides.userInterfaceStyle = dark ? .dark : .light
        window.rootViewController = vc
        window.isHidden = false
        vc.view.frame = window.bounds
        vc.view.setNeedsLayout()
        vc.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        vc.view.layoutIfNeeded()
        return (vc, window)
    }

    /// Lets SwiftUI update and draws the view into an image (the drawing path runs).
    static func draw(_ view: UIView) -> UIImage {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        view.layoutIfNeeded()
        return UIGraphicsImageRenderer(bounds: view.bounds).image { _ in _ = view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
    }

    /// The size SwiftUI gives a view that sizes itself (its ideal size).
    static func idealSize<V: View>(_ view: V) -> CGSize {
        let vc = UIHostingController(rootView: view.fixedSize())
        return vc.sizeThatFits(in: CGSize(width: 10_000, height: 10_000))
    }

    static let iPhone = CGSize(width: 402, height: 874)
    static let iPadLandscape = CGSize(width: 1376, height: 1032)
}
