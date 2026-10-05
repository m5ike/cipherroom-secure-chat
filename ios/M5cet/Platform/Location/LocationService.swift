// Where the phone is (6.1) — port of android/app/src/main/java/cz/m5cet/app/location/
// Where.java and LocationService.java on CoreLocation:
//  - current(): one fix for a message — "location.inHeader" puts it into every
//    message's header (headerLocation), "location.share" sends it as a message
//    (sharePosition: the web's text and the loc);
//  - tracking: with "location.track" (and the operator's signed policy allowing
//    it) positions go to the server — POST /api/ios/location (M5Net
//    DeviceAPIClient.location, through LocationReporting) — every
//    location.interval seconds (≥ 15, ≥ the policy's minSeconds), in batches, for
//    the device's track in the console.
//
// Permissions — only on the person's action, as Android asks on the setting's
// switch: requestPermission() for "when in use" (inHeader, share, track); "Always"
// is asked only when the person turns tracking on AND the signed policy allows
// tracking (contract § 5), because positions in the background need it.
//
// Background — Android keeps a foreground service (a notification says so).
// iOS: with the `location` background mode in Info.plist (UIBackgroundModes)
// updates continue in the background with the blue location indicator
// (showsBackgroundLocationIndicator) — the counterpart of that notification;
// without the mode (the shipped Info.plist has none yet) the foreground keeps
// interval updates and the background falls back to the significant-change
// service (Always only: ~500 m steps, the app is relaunched for them). Points
// collected in the background are sent when the app runs again.

import CoreLocation
import Foundation
import M5Core
import M5Net
import Observation
import UIKit

enum LocationAuthorization: String, Sendable {
    case notDetermined, denied, restricted, whenInUse, always

    var permitted: Bool { self == .whenInUse || self == .always }
}

/// What the location settings and the policy say (the app's Settings and the signed device policy).
@MainActor
protocol LocationSettings: AnyObject {
    func bool(_ key: String) -> Bool
    func number(_ key: String) -> Double
    /// The signed device policy (SignedDevicePolicy's JSON: its "location" object is read), nil when none.
    var policy: JSONObject? { get }
}

/// POST /api/ios/location: the integration sends the points with the device's signature
/// (DeviceAPIClient.location with the enrolled DeviceCredentials).
protocol LocationReporting: AnyObject, Sendable {
    /// Throws HTTPError 403 "location-off" when the server keeps no positions.
    func report(_ points: [LocationPoint]) async throws
}

/// M5Net's device API as the reporter (the integration supplies the credentials).
final class DeviceAPILocationReporter: LocationReporting {
    private let client: DeviceAPIClient
    private let credentials: @Sendable () -> DeviceCredentials?

    init(client: DeviceAPIClient = DeviceAPIClient(), credentials: @escaping @Sendable () -> DeviceCredentials?) {
        self.client = client
        self.credentials = credentials
    }

    func report(_ points: [LocationPoint]) async throws {
        guard let device = credentials() else { throw NetError.unavailable("not enrolled") }
        _ = try await client.location(device, points: points)
    }
}

/// CoreLocation as the service needs it (CLLocationManager; a fake in the tests).
@MainActor
protocol LocationProviding: AnyObject {
    var authorization: LocationAuthorization { get }
    /// "Precise Location" is off for the app (iOS 14+).
    var reducedAccuracy: Bool { get }
    var onAuthorizationChange: (() -> Void)? { get set }
    func requestWhenInUse()
    func requestAlways()
    /// The system's last fix (any age), nil when none.
    var lastKnown: WhereFix? { get }
    /// One new fix, waited for at most `timeout`; nil when none came.
    func oneFix(precise: Bool, timeout: TimeInterval) async -> WhereFix?
    /// Continuous updates (≥ `distance` m apart); `background`: keep them in the background when the app may.
    func startUpdates(precise: Bool, distance: Double, background: Bool, onFix: @escaping (WhereFix) -> Void)
    func stopUpdates()
}

@MainActor
@Observable
final class LocationService {
    static let shared = LocationService()

    @ObservationIgnored var provider: any LocationProviding
    @ObservationIgnored var settings: (any LocationSettings)?
    @ObservationIgnored var reporter: (any LocationReporting)?
    @ObservationIgnored private let clock: any Clock

    private(set) var authorization: LocationAuthorization = .notDetermined
    private(set) var tracking = false
    /// The last fix this app got (fresh for a header for 2 minutes).
    private(set) var last: WhereFix?

    @ObservationIgnored private var queue = TrackQueue()
    @ObservationIgnored private var lastQueuedAt: Int64 = 0
    @ObservationIgnored private var flushing = false
    @ObservationIgnored private var plan: TrackingPlan?
    @ObservationIgnored private var inBackground = false
    /// Tracking was turned on by the person while only "when in use" was granted: ask for "Always" once.
    @ObservationIgnored private var alwaysAsked = false

    init(provider: (any LocationProviding)? = nil, clock: any Clock = SystemClock()) {
        self.provider = provider ?? CoreLocationProvider()
        self.clock = clock
        authorization = self.provider.authorization
        self.provider.onAuthorizationChange = { [weak self] in self?.authorizationChanged() }
    }

    /// Scene phases: points wait in the background and go when the app is back.
    func install(into model: AppModel) {
        model.onScenePhase { [weak self] phase in
            guard let self else { return }
            let bg = phase == .background
            guard bg != self.inBackground else { return }
            self.inBackground = bg
            if self.tracking { self.restartUpdates() }
            if !bg { Task { await self.flush() } }
        }
    }

    // MARK: permission

    /// Android's permitted(): fine or coarse location granted.
    var permitted: Bool { authorization.permitted }

    /// Asks for "when in use" (the person switched a location setting on, or shared a position).
    func requestPermission() {
        if authorization == .notDetermined { provider.requestWhenInUse() }
    }

    private func authorizationChanged() {
        authorization = provider.authorization
        if !permitted { stopTracking() } else { syncTracking() }
    }

    // MARK: one fix

    /// The last fix, when it is fresh enough for a message header (2 minutes).
    func recent() -> WhereFix? { Where.isRecent(last, now: clock.now()) ? last : nil }

    private var precise: Bool { settings?.bool("location.precise") ?? true }

    /// One fix (the recent one, or a new one — at most 20 s, else the last known); nil when there is none.
    func current() async -> WhereFix? {
        guard permitted else { return nil }
        if let r = recent() { return r }
        if let f = await provider.oneFix(precise: precise, timeout: Where.fixTimeout) {
            last = f
            return f
        }
        return provider.lastKnown
    }

    /// The header's position of a message being sent (location.inHeader): the recent fix, nil otherwise.
    func headerLocation() -> JSONObject? {
        guard settings?.bool("location.inHeader") == true, let r = recent() else { return nil }
        return Where.json(r)
    }

    /// A fix in the background so the header position is ready when the message goes (Composer.warmLocation).
    func warm() {
        guard settings?.bool("location.inHeader") == true, permitted else { return }
        Task { _ = await current() }
    }

    /// location.share: the position as a message — the web's text and the loc for a pin; nil when no fix
    /// (the composer says location.none) or no permission (it asks first: requestPermission).
    func sharePosition() async -> (text: String, loc: JSONObject)? {
        guard let l = await current() else { return nil }
        return (Where.shareText(l), Where.json(l))
    }

    // MARK: tracking

    func trackingPlan() -> TrackingPlan {
        TrackingPlan.from(policy: settings?.policy, track: settings?.bool("location.track") ?? false,
                          interval: settings?.number("location.interval") ?? 60, precise: precise)
    }

    /// The user's setting, and the operator's policy (tracking allowed; true when it says nothing).
    var trackingWanted: Bool { trackingPlan().wanted }

    /// $location of Settings › Location: {permitted, tracking, allowed}.
    func scope() -> JSONObject {
        JSONObject([("permitted", .bool(permitted)), ("tracking", .bool(tracking)), ("allowed", .bool(trackingPlan().policyAllows))])
    }

    /// Android's LocationService.sync: tracking runs when wanted and permitted, else stops.
    func syncTracking() {
        if trackingWanted && permitted { startTracking() } else { stopTracking() }
    }

    /// 6.1: what a changed setting sets off (Android MainActivity.settingChanged) — call it after the
    /// person changed location.inHeader / location.track / location.interval / location.precise.
    func settingChanged(_ key: String) {
        switch key {
        case "location.inHeader":
            if settings?.bool(key) == true && !permitted { requestPermission() } else if settings?.bool(key) == true { warm() }
        case "location.track", "location.interval", "location.precise":
            if settings?.bool("location.track") == true && !permitted { requestPermission(); return }
            stopTracking()
            syncTracking()
            // Positions in the background need "Always": asked only now, on the person's switch, and only when
            // the signed policy allows tracking.
            if key == "location.track", trackingWanted, authorization == .whenInUse, !alwaysAsked {
                alwaysAsked = true
                provider.requestAlways()
            }
        default: break
        }
    }

    /// Whether updates may continue in the background (Info.plist has the location background mode).
    nonisolated static var backgroundModeDeclared: Bool {
        (Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []).contains("location")
    }

    func startTracking() {
        guard !tracking, permitted else { return }
        let p = trackingPlan()
        guard p.wanted else { return }
        plan = p
        tracking = true
        restartUpdates()
        M5Log.shared.info("where", "tracking every \(p.everyMs / 1000) s")
    }

    private func restartUpdates() {
        guard let p = plan else { return }
        provider.stopUpdates()
        provider.startUpdates(precise: p.precise, distance: TrackingPlan.distanceMeters,
                              background: authorization == .always) { [weak self] fix in self?.tracked(fix) }
    }

    func stopTracking() {
        guard tracking else { return }
        provider.stopUpdates()
        tracking = false
        plan = nil
        Task { await flush() }
    }

    /// A tracked fix: kept as the last one; queued for the server at most once per interval.
    private func tracked(_ fix: WhereFix) {
        last = fix
        guard let p = plan, fix.at - lastQueuedAt >= p.everyMs || lastQueuedAt == 0 else { return }
        lastQueuedAt = fix.at
        if queue.add(TrackQueue.point(fix), now: clock.now()) { Task { await flush() } }
    }

    /// Points waiting for the server.
    var waiting: Int { queue.count }

    /// Sends the waiting points (a signed request); they stay queued when the server is not reachable,
    /// and go when the server keeps no positions (403 location-off).
    func flush() async {
        guard !flushing, let reporter, let batch = queue.takeBatch(now: clock.now()) else { return }
        flushing = true
        defer { flushing = false }
        do {
            try await reporter.report(batch)
            queue.sent(batch)
        } catch {
            if TrackQueue.serverRefuses(error) {
                queue.clear()
                M5Log.shared.info("where", "the server does not keep positions")
            } else {
                M5Log.shared.warn("where", "points not sent: \(error)")
            }
        }
    }

    /// The app is wiped (Android Wiper): tracking stops, nothing waits.
    func wipe() {
        provider.stopUpdates()
        tracking = false
        plan = nil
        queue.clear()
        last = nil
    }

    // MARK: maps and navigation

    /// The picker's lines for a place (PlaceSheet): Apple Maps, the installed apps, the web.
    func mapChoices(_ kind: String, lat: Double, lon: Double, label: String?) -> [GeoLinks.Choice] {
        GeoLinks.iosChoices(kind, lat, lon, label) { scheme in
            guard let url = URL(string: scheme + "://") else { return false }
            return UIApplication.shared.canOpenURL(url)
        }
    }

    /// Opens a picker line: its link, else its fallback (Android: geo: in the same app, then the browser).
    /// For an app that cannot take the destination, the caller copies GeoLinks.destinationText first.
    func open(_ c: GeoLinks.Choice) async -> Bool {
        if let u = c.uri.flatMap(URL.init(string:)), await UIApplication.shared.open(u) { return true }
        if let f = c.fallback.flatMap(URL.init(string:)) { return await UIApplication.shared.open(f) }
        return false
    }

    /// The pin of a message in the phone's map app (Apple Maps), else OpenStreetMap in the browser (Parts.openMap).
    func openPin(lat: Double, lon: Double, label: String?) async -> Bool {
        if let u = URL(string: Where.appleMapsPin(lat, lon, label)), await UIApplication.shared.open(u) { return true }
        guard let web = URL(string: Where.mapUrl(lat, lon)) else { return false }
        return await UIApplication.shared.open(web)
    }
}

// MARK: - CoreLocation

@MainActor
final class CoreLocationProvider: NSObject, LocationProviding, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var waiting: [UUID: CheckedContinuation<WhereFix?, Never>] = [:]
    private var onFix: ((WhereFix) -> Void)?
    private var updating = false
    private var significant = false
    private var session: CLServiceSession?
    var onAuthorizationChange: (() -> Void)?

    override init() {
        super.init()
        manager.delegate = self
    }

    var authorization: LocationAuthorization {
        switch manager.authorizationStatus {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .restricted: .restricted
        case .authorizedAlways: .always
        case .authorizedWhenInUse: .whenInUse
        @unknown default: .denied
        }
    }

    var reducedAccuracy: Bool { manager.accuracyAuthorization == .reducedAccuracy }

    func requestWhenInUse() { manager.requestWhenInUseAuthorization() }
    func requestAlways() { manager.requestAlwaysAuthorization() }

    var lastKnown: WhereFix? { manager.location.flatMap(Self.fix) }

    nonisolated static func fix(_ l: CLLocation) -> WhereFix? {
        guard l.horizontalAccuracy >= 0, CLLocationCoordinate2DIsValid(l.coordinate) else { return nil }
        return WhereFix(lat: l.coordinate.latitude, lon: l.coordinate.longitude, acc: l.horizontalAccuracy,
                        at: Int64((l.timestamp.timeIntervalSince1970 * 1000).rounded(.down)),
                        alt: l.verticalAccuracy >= 0 ? l.altitude : nil,
                        speed: l.speed >= 0 ? l.speed : nil,
                        heading: l.course >= 0 ? l.course : nil)
    }

    /// Keeps the app's location authorization in effect while it works (iOS 18 service sessions).
    private func holdSession(always: Bool) {
        guard authorization.permitted else { return }
        session?.invalidate()
        session = CLServiceSession(authorization: always ? .always : .whenInUse)
    }

    private func dropSessionIfIdle() {
        if waiting.isEmpty && !updating && !significant { session?.invalidate(); session = nil }
    }

    func oneFix(precise: Bool, timeout: TimeInterval) async -> WhereFix? {
        guard authorization.permitted else { return nil }
        if session == nil { holdSession(always: false) }
        if !updating { manager.desiredAccuracy = precise ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters }
        let id = UUID()
        return await withCheckedContinuation { k in
            waiting[id] = k
            manager.requestLocation()
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                MainActor.assumeIsolated { self?.answer(id, nil) }
            }
        }
    }

    private func answer(_ id: UUID, _ fix: WhereFix?) {
        guard let k = waiting.removeValue(forKey: id) else { return }
        k.resume(returning: fix)
        dropSessionIfIdle()
    }

    func startUpdates(precise: Bool, distance: Double, background: Bool, onFix: @escaping (WhereFix) -> Void) {
        self.onFix = onFix
        let app = UIApplication.shared.applicationState
        let inBackground = app == .background
        let mayContinue = LocationService.backgroundModeDeclared
        holdSession(always: background)
        manager.desiredAccuracy = precise ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
        manager.distanceFilter = distance
        manager.pausesLocationUpdatesAutomatically = false
        if mayContinue {
            // Only with the background mode — setting it without the mode raises an exception.
            manager.allowsBackgroundLocationUpdates = background
            manager.showsBackgroundLocationIndicator = background
        }
        if inBackground && !mayContinue {
            // No background mode: the significant-change service (Always only) keeps a coarse track.
            if background {
                manager.startMonitoringSignificantLocationChanges()
                significant = true
            }
            return
        }
        manager.startUpdatingLocation()
        updating = true
    }

    func stopUpdates() {
        if updating { manager.stopUpdatingLocation(); updating = false }
        if significant { manager.stopMonitoringSignificantLocationChanges(); significant = false }
        onFix = nil
        dropSessionIfIdle()
    }

    // MARK: CLLocationManagerDelegate (on the main thread: the manager was made there)

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated { onAuthorizationChange?() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let fixes = locations.compactMap(Self.fix)
        MainActor.assumeIsolated {
            guard let newest = fixes.last else { return }
            for id in Array(waiting.keys) { answer(id, newest) }
            for f in fixes { onFix?(f) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        let code = (error as? CLError)?.code
        MainActor.assumeIsolated {
            // locationUnknown: it keeps trying — the one-shot waits for its timeout; others end the waits now.
            if code == .locationUnknown { return }
            for id in Array(waiting.keys) { answer(id, nil) }
        }
    }
}
