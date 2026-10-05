// New versions of the app (Android update/Releases + InstallReceiver). iOS
// installs nothing itself: a release is a version record the operator publishes
// (signed "m5iosrelease/1|…", M5Net ReleaseWatcher) with an App Store or
// TestFlight link, notes per language and a minimum build. The check-in brings
// the newest record for this device and the oldest build the server still serves
// (`minBuild`, `updateRequired`); below it the app asks for the update before
// anything else. Here: that state for the screens (the design's "update" screen
// and its updateProgress slot) — the record is verified (GET /releases/:id) once
// before its link is offered.

import Foundation
import M5Net
import Observation

@MainActor
@Observable
final class UpdateNotice {
    enum State: String, Sendable {
        /// Nothing newer than this build.
        case none
        /// A newer version (the record is not verified yet).
        case available
        /// Verified by the pinned server key: its link may be opened.
        case ready
        /// The record did not verify (not shown as installable).
        case failed
    }

    /// This app's build (CFBundleVersion, major·10000 + minor·100 + patch).
    let currentBuild: Int
    /// The newest release for this device, nil when none.
    private(set) var release: ReleaseRecord?
    private(set) var state: State = .none
    /// The oldest build the server serves (check-in / enrolment / info), 0 = none.
    private(set) var minBuild: Int64 = 0
    /// The server said this device must update (check-in `updateRequired`).
    private(set) var serverRequired = false

    @ObservationIgnored private var watcher = ReleaseWatcher()
    /// Called once per new release (Android: the update notification and the update-available event).
    @ObservationIgnored var onNewRelease: [(ReleaseRecord) -> Void] = []

    init(currentBuild: Int) { self.currentBuild = currentBuild }

    /// A newer version exists.
    var available: Bool { release != nil }

    /// Must update before anything else: below the server's minimum, or a mandatory release for this build.
    var mandatory: Bool {
        serverRequired || ReleaseWatcher.mustUpdate(appCode: currentBuild, serverMinBuild: minBuild, release: release)
    }

    /// The App Store / TestFlight link to open ("update.install"), only once verified.
    var storeURL: URL? {
        guard state == .ready, let r = release, let u = URL(string: r.url), u.scheme == "https",
              let host = u.host?.lowercased(), ["apps.apple.com", "itunes.apple.com", "testflight.apple.com"].contains(host) else { return nil }
        return u
    }

    /// The check-in's release, minimum and verdict.
    func onCheckin(release: ReleaseRecord?, minBuild: Int64, updateRequired: Bool) {
        self.minBuild = minBuild
        serverRequired = updateRequired
        switch watcher.onCheckin(release, appCode: currentBuild) {
        case .none:
            self.release = nil
            state = .none
        case .available(let r, let isNew):
            if isNew || self.release?.id != r.id { state = .available }
            self.release = r
            if isNew { for o in onNewRelease { o(r) } }
        }
    }

    /// The server's minimum from /info or the enrolment.
    func noteMinBuild(_ value: Int64) { minBuild = max(minBuild, value) }

    /// GET /releases/:id checked against the pinned key (ReleaseWatcher.verify).
    func verified(_ record: ReleaseRecord) {
        guard record.id == release?.id else { return }
        release = record
        state = .ready
    }

    func verificationFailed() { if release != nil { state = .failed } }

    func reset() {
        watcher = ReleaseWatcher()
        release = nil
        state = .none
        minBuild = 0
        serverRequired = false
    }

    /// The design's $update for a release (Android Parts.updateScope): kind, version, size, notes, progress,
    /// state — iOS adds url, store and mandatory. `lang`: the notes' language.
    func scope(lang: String) -> [String: Any] {
        guard let r = release else {
            return ["kind": "release", "version": "", "size": 0.0, "notes": "", "progress": 0.0, "state": "none", "mandatory": mandatory]
        }
        return ["kind": "release", "version": r.version, "build": Double(r.build), "size": 0.0, "notes": r.notes(lang), "progress": 0.0,
                "state": state == .ready ? "ready" : state == .failed ? "failed" : "available", "url": storeURL?.absoluteString ?? "",
                "store": r.store, "channel": r.channel, "mandatory": mandatory]
    }
}
