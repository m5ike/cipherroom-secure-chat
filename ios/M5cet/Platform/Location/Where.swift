// The pure half of Android's location/Where.java (6.1) — no CoreLocation here:
//  - a fix as a message carries it (the header's "loc", a position message),
//  - the links that open a pin (OpenStreetMap, geo:, Apple Maps),
//  - the text of a position message (Composer.sharePosition) and where a message
//    points (ui/bubble/Kinds.position — the in-app map bubble's data),
//  - the tracking queue: points kept for the server (≤ 2000), sent in batches of
//    100 when a minute passed or 20 wait, dropped when the server keeps none.
// LocationService (CoreLocation) uses it; LocationTests pin it down.

import Foundation
import M5Core
import M5Net

/// One position (CLLocation's facts, as Android's Location carries them).
struct WhereFix: Sendable, Equatable {
    var lat: Double
    var lon: Double
    /// Horizontal accuracy, metres (≥ 0).
    var acc: Double
    /// When it was measured (ms since 1970).
    var at: Int64
    /// Altitude (m) when known.
    var alt: Double?
    /// m/s when known.
    var speed: Double?
    /// Degrees from north when known.
    var heading: Double?
}

enum Where {
    /// A fix is recent enough for a message header for 2 minutes.
    static let recentMs: Int64 = 120_000
    /// A new fix is waited for at most 20 s.
    static let fixTimeout: TimeInterval = 20

    static func isRecent(_ fix: WhereFix?, now: Int64) -> Bool {
        guard let fix else { return false }
        return now - fix.at < recentMs
    }

    /// The position as a message carries it (the header's "loc" and a location message).
    static func json(_ l: WhereFix) -> JSONObject {
        var o = JSONObject()
        o["lat"] = .double(round(l.lat))
        o["lon"] = .double(round(l.lon))
        o["acc"] = .int(Int64(JavaFormat.round(Float(l.acc))))
        o["at"] = .int(l.at)
        if let alt = l.alt { o["alt"] = .int(JavaFormat.round(alt)) }
        return o
    }

    /// Six decimals (≈ 0.1 m), Java's Math.round(v·1e6)/1e6.
    static func round(_ v: Double) -> Double { Double(JavaFormat.round(v * 1e6)) / 1e6 }

    /// An https link that opens the pin on a map (OpenStreetMap, zoom 17).
    static func mapUrl(_ lat: Double, _ lon: Double) -> String {
        let a = JavaFormat.fixed(lat, 6), o = JavaFormat.fixed(lon, 6)
        return "https://www.openstreetmap.org/?mlat=\(a)&mlon=\(o)#map=17/\(a)/\(o)"
    }

    /// The web's link for a shared position (maps.ts osmLink, zoom 15) — the same text on every side.
    static func mapUrlWeb(_ lat: Double, _ lon: Double) -> String {
        let a = JavaFormat.fixed(lat, 6), o = JavaFormat.fixed(lon, 6)
        return "https://www.openstreetmap.org/?mlat=\(a)&mlon=\(o)#map=15/\(a)/\(o)"
    }

    /// Android's geo: URI with a pin and a label (Where.geoUri — Uri.encode of the label).
    static func geoUri(_ lat: Double, _ lon: Double, _ label: String?) -> String {
        let a = JavaFormat.fixed(lat, 6), o = JavaFormat.fixed(lon, 6)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return "geo:\(a),\(o)?q=\(a),\(o)(\((label ?? "").addingPercentEncoding(withAllowedCharacters: allowed) ?? ""))"
    }

    /// iOS's "the phone's map app" for a pin (Android: geo: in the map app): Apple Maps with the pin and
    /// its label. The maps: scheme opens the app directly; https://maps.apple.com is the browser fallback.
    static func appleMapsPin(_ lat: Double, _ lon: Double, _ label: String?) -> String {
        let a = JavaFormat.fixed(lat, 6), o = JavaFormat.fixed(lon, 6)
        let q = (label ?? "").isEmpty ? "" : "&q=" + GeoLinks.enc(label)
        return "maps://?ll=\(a),\(o)" + q
    }

    static func appleMapsPinWeb(_ lat: Double, _ lon: Double, _ label: String?) -> String {
        let a = JavaFormat.fixed(lat, 6), o = JavaFormat.fixed(lon, 6)
        let q = (label ?? "").isEmpty ? "" : "&q=" + GeoLinks.enc(label)
        return "https://maps.apple.com/?ll=\(a),\(o)" + q
    }

    /// location.share: the web's text of a position message ("📍 50.08804, 14.42076 (±12 m) https://…").
    static func shareText(_ l: WhereFix) -> String {
        "📍 \(JavaFormat.fixed(l.lat, 5)), \(JavaFormat.fixed(l.lon, 5)) (±\(JavaFormat.round(Float(l.acc))) m) " + mapUrlWeb(l.lat, l.lon)
    }

    // MARK: where a message points (ui/bubble/Kinds)

    /// The web's and the apps' position message: "📍 50.08804, 14.42076 (±12 m) https://…" ("📍 live …" while sharing).
    nonisolated(unsafe) private static let positionPattern = /^\s*📍\s*(?:live\s+)?(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)(?:\s*\(±\s*(\d+)\s*m\))?/.asciiOnlyDigits().asciiOnlyWhitespace()

    /// A message whose point is the position (Tools › send position), not one that only carries it in the header.
    static func isPositionMessage(text: String?, sealed: Bool) -> Bool {
        guard !sealed, let text else { return false }
        return (try? positionPattern.prefixMatch(in: text)) != nil
    }

    /// Where a message points: {lat, lon, acc?, at?} from loc, else from a position message's text; nil when nowhere.
    static func position(loc: JSONObject?, text: String?, sealed: Bool) -> JSONObject? {
        if let loc, let lat = loc["lat"]?.doubleValue, let lon = loc["lon"]?.doubleValue, abs(lat) <= 90, abs(lon) <= 180 { return loc }
        guard !sealed, let text, let m = try? positionPattern.prefixMatch(in: text),
              let lat = Double(m.1), let lon = Double(m.2), abs(lat) <= 90, abs(lon) <= 180 else { return nil }
        var o = JSONObject([("lat", .double(lat)), ("lon", .double(lon))])
        if let acc = m.3, let a = Int64(acc) { o["acc"] = .int(a) }
        return o
    }

    /// Only the header's position (location.inHeader): the small corner pin, not a map in the bubble.
    static func headerPosition(loc: JSONObject?, text: String?, sealed: Bool) -> Bool {
        loc != nil && !isPositionMessage(text: text, sealed: sealed)
    }
}

// MARK: - tracking

/// The tracking settings and the operator's policy (Where.trackingWanted / startTracking).
struct TrackingPlan: Sendable, Equatable {
    /// Settings › Location › Tracking (location.track).
    var userWants: Bool
    /// The signed policy's location.track (absent: allowed).
    var policyAllows: Bool
    /// location.interval, seconds (≥ 15).
    var intervalSeconds: Double
    /// The policy's location.minSeconds (absent: 15).
    var policyMinSeconds: Int64
    /// location.precise.
    var precise: Bool

    /// The user's setting, and the operator's policy (tracking allowed; true when it says nothing).
    var wanted: Bool { userWants && policyAllows }

    /// Milliseconds between two points: max(15 s, the setting), at least the policy's minimum.
    var everyMs: Int64 {
        let mine = Int64(max(15, intervalSeconds.isFinite ? intervalSeconds.rounded(.towardZero) : 15)) * 1000
        return max(mine, policyMinSeconds * 1000)
    }

    /// Android asks for updates of at least 10 m.
    static let distanceMeters = 10.0

    /// From the signed policy (its "location" object) and the settings.
    static func from(policy: JSONObject?, track: Bool, interval: Double, precise: Bool) -> TrackingPlan {
        let loc = policy?.object("location")
        let allows = loc?.bool("track") ?? true
        let minSeconds = loc.flatMap { $0["minSeconds"]?.doubleValue }.map { Int64($0) } ?? 15
        return TrackingPlan(userWants: track, policyAllows: allows, intervalSeconds: interval, policyMinSeconds: minSeconds, precise: precise)
    }
}

/// The points waiting for the server (Where.queue / flush), in order.
struct TrackQueue: Sendable, Equatable {
    static let capacity = 2000
    static let batchSize = 100
    static let flushEveryMs: Int64 = 60_000
    static let flushCount = 20

    private(set) var points: [LocationPoint] = []
    /// When a batch last went (ms).
    private(set) var lastSent: Int64 = 0

    var isEmpty: Bool { points.isEmpty }
    var count: Int { points.count }

    /// A tracking point: the header's values plus speed (one decimal) and heading (whole degrees).
    static func point(_ l: WhereFix) -> LocationPoint {
        LocationPoint(at: l.at, lat: Where.round(l.lat), lon: Where.round(l.lon), acc: Double(JavaFormat.round(Float(l.acc))),
                      alt: l.alt.map { Double(JavaFormat.round($0)) },
                      speed: l.speed.map { Double(JavaFormat.round(Float($0) * 10)) / 10.0 },
                      heading: l.heading.map { Double(JavaFormat.round(Float($0))) })
    }

    /// Adds a point (the oldest go past 2000); true when a batch should go now.
    mutating func add(_ p: LocationPoint, now: Int64) -> Bool {
        points.append(p)
        if points.count > Self.capacity { points.removeFirst(points.count - Self.capacity) }
        return now - lastSent > Self.flushEveryMs || points.count >= Self.flushCount
    }

    /// The next batch (up to 100), noting the time; nil when nothing waits.
    mutating func takeBatch(now: Int64) -> [LocationPoint]? {
        guard !points.isEmpty else { return nil }
        lastSent = now
        return Array(points.prefix(Self.batchSize))
    }

    /// The server took the batch.
    mutating func sent(_ batch: [LocationPoint]) {
        var left = batch
        points.removeAll { p in
            if let i = left.firstIndex(of: p) { left.remove(at: i); return true }
            return false
        }
    }

    /// The server keeps no positions (403 location-off): nothing waits any more.
    mutating func clear() { points.removeAll() }

    /// Whether a failure means the server keeps no positions (Android: "location-off" or 403).
    static func serverRefuses(_ error: any Error) -> Bool {
        if let h = error as? HTTPError { return h.status == 403 || h.code == "location-off" }
        let m = String(describing: error)
        return m.contains("location-off") || m.contains("403")
    }
}
