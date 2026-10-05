// LocationService (Android location/Where + LocationService) with CoreLocation faked: permission
// prompts only on the person's action, "Always" only when tracking is switched on and the signed
// policy allows it, one fix for a message (recent, new, last known), the header's loc, the tracking
// interval and the queue for /api/ios/location (batches, 403 location-off, offline), and CLLocation's
// facts as Android's Location carries them.

import CoreLocation
import XCTest
import M5Core
import M5Net
@testable import M5cet

@MainActor
private final class FakeLocation: LocationProviding {
    var authorization: LocationAuthorization = .notDetermined
    var reducedAccuracy = false
    var onAuthorizationChange: (() -> Void)?
    var lastKnown: WhereFix?
    var next: WhereFix?
    var log: [String] = []
    var onFix: ((WhereFix) -> Void)?

    func requestWhenInUse() { log.append("ask when in use") }
    func requestAlways() { log.append("ask always") }
    func oneFix(precise: Bool, timeout: TimeInterval) async -> WhereFix? { log.append("fix \(precise ? "precise" : "coarse")"); return next }
    func startUpdates(precise: Bool, distance: Double, background: Bool, onFix: @escaping (WhereFix) -> Void) {
        log.append("updates \(distance) m\(background ? " background" : "")")
        self.onFix = onFix
    }
    func stopUpdates() { if onFix != nil { log.append("stop") }; onFix = nil }

    func grant(_ a: LocationAuthorization) { authorization = a; onAuthorizationChange?() }
}

@MainActor
private final class Settings: LocationSettings {
    var values: [String: JSON] = ["location.inHeader": false, "location.track": false, "location.interval": 60, "location.precise": true]
    var policy: JSONObject?
    func bool(_ key: String) -> Bool { values[key]?.boolValue ?? false }
    func number(_ key: String) -> Double { values[key]?.doubleValue ?? 0 }
}

/// On the main actor: a report completes within the service's task (no hop to wait for).
@MainActor
private final class Reporter: LocationReporting {
    var batches: [[LocationPoint]] = []
    var error: (any Error)?
    func report(_ points: [LocationPoint]) async throws {
        if let error { throw error }
        batches.append(points)
    }
}

@MainActor
final class LocationServiceTests: XCTestCase {
    private let t0: Int64 = 1_760_000_000_000

    private func make() -> (LocationService, FakeLocation, Settings, Reporter, ManualClock) {
        let p = FakeLocation(), s = Settings(), r = Reporter(), clock = ManualClock(t0)
        let svc = LocationService(provider: p, clock: clock)
        svc.settings = s
        svc.reporter = r
        return (svc, p, s, r, clock)
    }

    private func fix(_ at: Int64, lat: Double = 50.08) -> WhereFix { WhereFix(lat: lat, lon: 14.42, acc: 8, at: at, alt: nil, speed: nil, heading: nil) }

    func testNothingIsAskedUntilThePersonActs() async {
        let (svc, p, s, _, _) = make()
        XCTAssertTrue(p.log.isEmpty)
        let none = await svc.current()
        XCTAssertNil(none) // no permission: no fix, no question
        XCTAssertTrue(p.log.isEmpty)
        s.values["location.inHeader"] = true
        svc.settingChanged("location.inHeader")
        XCTAssertEqual(["ask when in use"], p.log)
        svc.requestPermission()
        XCTAssertEqual(2, p.log.count)
        p.grant(.whenInUse)
        svc.requestPermission() // already granted: not asked again
        XCTAssertEqual(2, p.log.count)
    }

    func testOneFixForAMessage() async {
        let (svc, p, s, _, clock) = make()
        p.grant(.whenInUse)
        p.next = fix(t0)
        let f = await svc.current()
        XCTAssertEqual(f, p.next)
        XCTAssertEqual(["fix precise"], p.log)
        // Recent for two minutes: no new fix.
        clock.advance(60_000)
        _ = await svc.current()
        XCTAssertEqual(1, p.log.count)
        // The header's position only with location.inHeader.
        XCTAssertNil(svc.headerLocation())
        s.values["location.inHeader"] = true
        XCTAssertEqual(Where.json(f!), svc.headerLocation())
        // Later: no new fix comes → the system's last one.
        clock.advance(120_000)
        XCTAssertNil(svc.headerLocation())
        p.next = nil
        p.lastKnown = fix(t0 - 3_600_000, lat: 49)
        s.values["location.precise"] = false
        let old = await svc.current()
        XCTAssertEqual(49, old?.lat)
        XCTAssertEqual("fix coarse", p.log.last)
        // A position message: the web's text and the loc.
        p.next = fix(clock.now())
        clock.advance(200_000)
        let share = await svc.sharePosition()
        XCTAssertTrue(share?.text.hasPrefix("📍 50.08000, 14.42000 (±8 m) https://www.openstreetmap.org/") == true)
        XCTAssertEqual(50.08, share?.loc.double("lat"))
    }

    func testTrackingAsksForAlwaysOnlyWhenThePolicyAllows() async {
        let (svc, p, s, _, _) = make()
        p.grant(.whenInUse)
        s.policy = JSONObject([("location", .object(JSONObject([("track", false)])))])
        s.values["location.track"] = true
        svc.settingChanged("location.track")
        XCTAssertFalse(svc.tracking) // the operator does not allow it
        XCTAssertFalse(p.log.contains("ask always"))
        XCTAssertEqual(false, svc.scope().bool("allowed"))
        s.policy = JSONObject([("location", .object(JSONObject([("track", true), ("minSeconds", 30)])))])
        svc.settingChanged("location.track")
        XCTAssertTrue(svc.tracking)
        XCTAssertEqual(["updates 10.0 m", "ask always"], p.log)
        svc.settingChanged("location.track")
        XCTAssertEqual(1, p.log.filter { $0 == "ask always" }.count) // once
        // Always granted: the updates go on in the background.
        p.grant(.always)
        svc.stopTracking()
        svc.startTracking()
        XCTAssertEqual("updates 10.0 m background", p.log.last)
        // Permission taken away: tracking stops.
        p.grant(.denied)
        XCTAssertFalse(svc.tracking)
    }

    func testTrackedPointsGoAtTheIntervalInBatches() async throws {
        let (svc, p, s, r, clock) = make()
        p.grant(.whenInUse)
        s.values["location.track"] = true
        s.values["location.interval"] = 20
        svc.settingChanged("location.track")
        XCTAssertTrue(svc.tracking)
        // Updates every 5 s; a point every 20 s is kept; a batch goes when a minute passed since the last.
        for i in 0..<40 {
            clock.set(t0 + Int64(i) * 5000)
            p.onFix?(fix(t0 + Int64(i) * 5000))
            await settle()
        }
        XCTAssertEqual([1, 4, 4], r.batches.map(\.count)) // at 0 s (nothing sent before), 80 s, 160 s
        XCTAssertEqual(1, svc.waiting) // the point of 180 s waits
        // Tracking off: what waits goes.
        svc.stopTracking()
        await settle()
        XCTAssertEqual(0, svc.waiting)
        XCTAssertEqual(stride(from: t0, to: t0 + 200_000, by: 20_000).map { $0 }, r.batches.flatMap { $0 }.map(\.at))
    }

    func testTheServerKeepingNoPositionsAndBeingAway() async {
        let (svc, p, s, r, clock) = make()
        p.grant(.whenInUse)
        s.values["location.track"] = true
        svc.settingChanged("location.track")
        r.error = NetError.network("offline")
        p.onFix?(fix(t0))
        await settle()
        XCTAssertEqual(1, svc.waiting) // kept for later
        r.error = HTTPError(status: 403, code: "location-off")
        clock.advance(61_000)
        p.onFix?(fix(t0 + 61_000))
        await settle()
        XCTAssertEqual(0, svc.waiting) // the server keeps none: nothing waits
        svc.wipe()
        XCTAssertFalse(svc.tracking)
        XCTAssertNil(svc.recent())
    }

    func testTheCoresPositionSource() async {
        let (svc, p, _, _, _) = make()
        let source = LocationPositionSource(service: svc)
        XCTAssertFalse(source.permitted)
        XCTAssertNil(source.recent())
        let none = await source.current() // the person tapped "share position": asked, nothing yet
        XCTAssertNil(none)
        XCTAssertEqual(["ask when in use"], p.log)
        p.grant(.whenInUse)
        p.next = fix(t0)
        let f = await source.current()
        XCTAssertEqual(Where.json(fix(t0)), f)
        XCTAssertEqual(f, source.recent())
    }

    func testCLLocationAsAndroidsLocation() {
        let l = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 50.1, longitude: 14.4), altitude: 250, horizontalAccuracy: 12,
                           verticalAccuracy: 3, course: 90, speed: 1.5, timestamp: Date(timeIntervalSince1970: 1_760_000_000.5))
        let f = CoreLocationProvider.fix(l)
        XCTAssertEqual(WhereFix(lat: 50.1, lon: 14.4, acc: 12, at: 1_760_000_000_500, alt: 250, speed: 1.5, heading: 90), f)
        let unknown = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 50.1, longitude: 14.4), altitude: 0, horizontalAccuracy: 12,
                                 verticalAccuracy: -1, course: -1, speed: -1, timestamp: Date())
        XCTAssertNil(CoreLocationProvider.fix(unknown)?.alt)
        XCTAssertNil(CoreLocationProvider.fix(unknown)?.speed)
        XCTAssertNil(CoreLocationProvider.fix(unknown)?.heading)
        XCTAssertNil(CoreLocationProvider.fix(CLLocation(coordinate: CLLocationCoordinate2D(latitude: 1, longitude: 1), altitude: 0,
                                                          horizontalAccuracy: -1, verticalAccuracy: -1, timestamp: Date())))
    }

    func testTheShippedInfoPlist() {
        // The prompts' texts exist (CoreLocation would refuse to ask without them).
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSLocationWhenInUseUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSLocationAlwaysAndWhenInUseUsageDescription"))
    }
}
