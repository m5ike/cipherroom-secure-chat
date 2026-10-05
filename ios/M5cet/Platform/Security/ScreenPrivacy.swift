// FLAG_SECURE's substitute (docs/ios-architecture.md § 5). iOS lets no app forbid
// screenshots; what it can do, while the signed policy's `screenshots` is false
// (the default):
//
//   - the app switcher's snapshot shows the privacy cover, not the app (a cover
//     window on every scene as it resigns active, removed when it is active again);
//   - while the screen is recorded, mirrored or shared (the scene's capture state,
//     UITraitCollection.sceneCaptureState) the cover stays over the app;
//   - a screenshot (UIApplication.userDidTakeScreenshotNotification — it is taken
//     already) is reported as the event "screenshot" and, with
//     security.screenshotFlash, the cover flashes briefly as a visible notice.
//
// With `screenshots` true nothing is covered (Android: no FLAG_SECURE).

import SwiftUI
import UIKit

@MainActor
final class ScreenPrivacy {
    /// The policy allows screenshots (no cover, no shield).
    var screenshotsAllowed: @MainActor () -> Bool = { false }
    /// A screenshot was taken while they are not allowed.
    var onScreenshot: @MainActor () -> Void = {}
    /// Flash the cover at a screenshot.
    var flashOnScreenshot: @MainActor () -> Bool = { false }

    private var covers: [ObjectIdentifier: UIWindow] = [:]
    private var inactive: Set<ObjectIdentifier> = []
    private var watched: Set<ObjectIdentifier> = []
    private var flashing = false
    private var observers: [any NSObjectProtocol] = []

    init() {}

    func install() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { [weak self] n in
            let scene = n.object as? UIWindowScene
            MainActor.assumeIsolated { if let scene { self?.deactivated(scene) } }
        })
        observers.append(nc.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] n in
            let scene = n.object as? UIWindowScene
            MainActor.assumeIsolated { if let scene { self?.activated(scene) } }
        })
        observers.append(nc.addObserver(forName: UIScene.willConnectNotification, object: nil, queue: .main) { [weak self] n in
            let scene = n.object as? UIWindowScene
            MainActor.assumeIsolated { if let scene { self?.watch(scene) } }
        })
        observers.append(nc.addObserver(forName: UIApplication.userDidTakeScreenshotNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screenshot() }
        })
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) { watch(scene) }
    }

    /// Recording / mirroring changes come as the scene's trait.
    private func watch(_ scene: UIWindowScene) {
        let id = ObjectIdentifier(scene)
        guard !watched.contains(id) else { return }
        watched.insert(id)
        scene.registerForTraitChanges([UITraitSceneCaptureState.self]) { [weak self] (s: UIWindowScene, _: UITraitCollection) in
            self?.refresh(s)
        }
        refresh(scene)
    }

    private func deactivated(_ scene: UIWindowScene) {
        inactive.insert(ObjectIdentifier(scene))
        refresh(scene)
    }

    private func activated(_ scene: UIWindowScene) {
        inactive.remove(ObjectIdentifier(scene))
        watch(scene)
        refresh(scene)
    }

    /// Whether the scene's screen is being recorded, mirrored or shared.
    static func captured(_ scene: UIWindowScene) -> Bool { scene.traitCollection.sceneCaptureState == .active }

    /// Whether the cover belongs over this scene now.
    func wantsCover(_ scene: UIWindowScene) -> Bool {
        guard !screenshotsAllowed() else { return false }
        return flashing || inactive.contains(ObjectIdentifier(scene)) || Self.captured(scene)
    }

    /// Re-reads the policy and the scenes (a new policy, a scene's change).
    func refreshAll() {
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) { refresh(scene) }
    }

    private func refresh(_ scene: UIWindowScene) {
        let id = ObjectIdentifier(scene)
        if wantsCover(scene) {
            guard covers[id] == nil else { return }
            let w = UIWindow(windowScene: scene)
            w.windowLevel = .alert + 2
            w.rootViewController = UIHostingController(rootView: PrivacyCoverView())
            w.isHidden = false
            covers[id] = w
        } else if let w = covers.removeValue(forKey: id) {
            w.isHidden = true
            w.rootViewController = nil
        }
    }

    private func screenshot() {
        guard !screenshotsAllowed() else { return }
        onScreenshot()
        guard flashOnScreenshot(), !flashing else { return }
        flashing = true
        refreshAll()
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            self?.flashing = false
            self?.refreshAll()
        }
    }

    /// Whether a cover is up (tests, diagnostics).
    var coveredScenes: Int { covers.count }
}
