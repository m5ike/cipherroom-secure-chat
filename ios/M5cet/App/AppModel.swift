// The app's state the shell keeps (Android: the fields of A/M5.java that are not yet
// ported) and the handlers wave 2 installs (AppHooks.swift, Bootstrap.swift).

import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class AppModel {
    /// The scene phase of the app's most active scene (several windows on iPad).
    private(set) var phase: ScenePhase = .inactive
    /// A link opened and not yet taken by a screen (Android MainActivity: the enrolment link, pendingRoom).
    private(set) var pendingLink: DeepLink?
    /// The APNs device token (hex), once iOS gave one.
    private(set) var apnsToken: String?
    /// Why there is no APNs token (simulator without the push entitlement, no network…).
    private(set) var apnsError: String?
    /// The PushKit (VoIP) token (hex), while a VoIP handler is installed.
    private(set) var voipToken: String?

    /// The design's side shared by every window (Renderer/README.md): the design, settings, language, and the
    /// contracts the other code installs into — `design.slots` (parts), `design.actions` (the app's actions),
    /// `design.state` (where the app is, each screen's variables).
    @ObservationIgnored let design = DesignServices()

    /// The app's core (Core/: rooms, account, device, the screens' state and actions) — CoreInstall makes it at launch.
    @ObservationIgnored var core: AppCore?

    /// Silent pushes and the APNs token — installed by Platform/Push.
    @ObservationIgnored var push: (any RemotePushHandling)?
    /// VoIP pushes — installed by Platform/Calls. PushKit is registered only while one is set
    /// (a VoIP push nobody reports to CallKit would get the app terminated).
    @ObservationIgnored var voip: (any VoIPPushHandling)?

    @ObservationIgnored private var phaseObservers: [(ScenePhase) -> Void] = []
    @ObservationIgnored private var linkObservers: [(DeepLink) -> Bool] = []

    // MARK: links

    /// A URL the system opened the app with (onOpenURL). Other schemes are ignored.
    func open(_ url: URL) {
        guard let link = DeepLink(url: url) else { return }
        for observer in linkObservers where observer(link) { return }
        pendingLink = link
    }

    /// Takes the pending link (once), for the screen that handles it.
    func takePendingLink() -> DeepLink? {
        defer { pendingLink = nil }
        return pendingLink
    }

    /// A screen that handles links as they come; return true when it took the link.
    func onLink(_ observer: @escaping (DeepLink) -> Bool) { linkObservers.append(observer) }

    // MARK: life cycle

    /// Foreground, background, inactive — the app lock and the socket follow this (Platform/Security, M5Net).
    func onScenePhase(_ observer: @escaping (ScenePhase) -> Void) { phaseObservers.append(observer) }

    func scenePhaseChanged(_ phase: ScenePhase) {
        guard phase != self.phase else { return }
        self.phase = phase
        for observer in phaseObservers { observer(phase) }
    }

    // MARK: push

    func didRegister(apnsToken token: Data) {
        apnsToken = token.hexString
        apnsError = nil
        push?.didRegister(apnsToken: token)
    }

    func didFailToRegister(_ error: any Error) {
        apnsError = error.localizedDescription
        push?.didFailToRegister(error)
    }

    func didUpdate(voipToken token: Data?) {
        voipToken = token?.hexString
        voip?.didUpdate(voipToken: token)
    }
}
