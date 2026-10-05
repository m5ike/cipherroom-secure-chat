// LocationService as the core's PositionSource (M5cet/Core/Models/ComposerModel.swift):
// `CoreModels.shared.position = LocationPositionSource()` — the composer's header
// loc (location.inHeader) and its "share position" action read the fixes as the
// message carries them ({lat, lon, acc, at, alt?} — Where.json).

import Foundation
import M5Core

@MainActor
final class LocationPositionSource: PositionSource {
    let service: LocationService

    init(service: LocationService = .shared) { self.service = service }

    var permitted: Bool { service.permitted }

    /// The latest fix without waiting (fresh for 2 minutes, as Android's Where.recent).
    func recent() -> JSONObject? { service.recent().map(Where.json) }

    /// A fresh fix; without the permission the system is asked (the person tapped "share position") and
    /// nil comes back — the composer says location.none, the next tap has the answer.
    func current() async -> JSONObject? {
        guard service.permitted else { service.requestPermission(); return nil }
        return await service.current().map(Where.json)
    }
}
