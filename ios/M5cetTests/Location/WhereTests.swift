// The pure half of Android's location/Where.java on iOS (Where.swift): a fix as a message carries it,
// the map links, the position message's text and where a message points (ui/bubble/Kinds), the
// tracking plan from the policy and the settings, and the queue of points for /api/ios/location.

import XCTest
import M5Core
import M5Net
@testable import M5cet

final class WhereTests: XCTestCase {
    private let fix = WhereFix(lat: 50.08804123, lon: 14.42076456, acc: 12.4, at: 1_760_000_000_000, alt: 241.6, speed: 1.26, heading: 87.5)

    func testAFixAsAMessageCarriesIt() {
        let o = Where.json(fix)
        XCTAssertEqual(["lat", "lon", "acc", "at", "alt"], o.keys)
        XCTAssertEqual(50.088041, o.double("lat"))
        XCTAssertEqual(14.420765, o.double("lon"))
        XCTAssertEqual(12, o.int64("acc"))
        XCTAssertEqual(1_760_000_000_000, o.int64("at"))
        XCTAssertEqual(242, o.int64("alt"))
        XCTAssertEqual(#"{"lat":50.088041,"lon":14.420765,"acc":12,"at":1760000000000,"alt":242}"#, o.stringify())
        var noAlt = fix
        noAlt.alt = nil
        XCTAssertFalse(Where.json(noAlt).has("alt"))
    }

    func testTheMapLinks() {
        XCTAssertEqual("https://www.openstreetmap.org/?mlat=50.088041&mlon=14.420765#map=17/50.088041/14.420765", Where.mapUrl(fix.lat, fix.lon))
        XCTAssertEqual("https://www.openstreetmap.org/?mlat=50.088041&mlon=14.420765#map=15/50.088041/14.420765", Where.mapUrlWeb(fix.lat, fix.lon))
        XCTAssertEqual("geo:50.088041,14.420765?q=50.088041,14.420765(Jana%20Nov%C3%A1)", Where.geoUri(fix.lat, fix.lon, "Jana Nová"))
        XCTAssertEqual("maps://?ll=50.088041,14.420765&q=Jana%20Nov%C3%A1", Where.appleMapsPin(fix.lat, fix.lon, "Jana Nová"))
        XCTAssertEqual("https://maps.apple.com/?ll=50.088041,14.420765", Where.appleMapsPinWeb(fix.lat, fix.lon, nil))
        XCTAssertNotNil(URL(string: Where.appleMapsPin(fix.lat, fix.lon, "Jana (doma)")))
    }

    func testThePositionMessageIsTheWebsText() {
        XCTAssertEqual("📍 50.08804, 14.42076 (±12 m) https://www.openstreetmap.org/?mlat=50.088041&mlon=14.420765#map=15/50.088041/14.420765", Where.shareText(fix))
    }

    func testWhereAMessagePoints() {
        let text = Where.shareText(fix)
        XCTAssertTrue(Where.isPositionMessage(text: text, sealed: false))
        XCTAssertFalse(Where.isPositionMessage(text: text, sealed: true))
        XCTAssertFalse(Where.isPositionMessage(text: "hi 📍 50.1, 14.2", sealed: false))
        let p = Where.position(loc: nil, text: text, sealed: false)
        XCTAssertEqual(50.08804, p?.double("lat"))
        XCTAssertEqual(14.42076, p?.double("lon"))
        XCTAssertEqual(12, p?.int64("acc"))
        // The web's live sharing.
        XCTAssertEqual(-33.85, Where.position(loc: nil, text: "📍 live -33.85, 151.21", sealed: false)?.double("lat"))
        // The header's loc wins; a broken one does not count.
        let loc = Where.json(fix)
        XCTAssertEqual(loc, Where.position(loc: loc, text: "hello", sealed: false))
        XCTAssertNil(Where.position(loc: JSONObject([("lat", 95), ("lon", 0)]), text: "hello", sealed: false))
        XCTAssertNil(Where.position(loc: nil, text: "📍 95.0, 14.0", sealed: false))
        XCTAssertNil(Where.position(loc: nil, text: "📍 ٥٠, 14.0", sealed: false)) // only ASCII digits, as Java's \d
        XCTAssertTrue(Where.headerPosition(loc: loc, text: "hello", sealed: false))
        XCTAssertFalse(Where.headerPosition(loc: loc, text: text, sealed: false))
    }

    func testRecentForTwoMinutes() {
        XCTAssertTrue(Where.isRecent(fix, now: fix.at + 119_999))
        XCTAssertFalse(Where.isRecent(fix, now: fix.at + 120_000))
        XCTAssertFalse(Where.isRecent(nil, now: fix.at))
    }

    func testTheTrackingPlan() {
        let policy = JSONObject([("location", .object(JSONObject([("track", true), ("days", 30), ("minSeconds", 45)])))])
        let p = TrackingPlan.from(policy: policy, track: true, interval: 20, precise: true)
        XCTAssertTrue(p.wanted)
        XCTAssertEqual(45_000, p.everyMs) // the policy's minimum wins
        XCTAssertEqual(60_000, TrackingPlan.from(policy: policy, track: true, interval: 60, precise: true).everyMs)
        XCTAssertEqual(15_000, TrackingPlan.from(policy: nil, track: true, interval: 3, precise: true).everyMs) // at least 15 s
        XCTAssertTrue(TrackingPlan.from(policy: nil, track: true, interval: 60, precise: true).wanted) // no policy: allowed
        XCTAssertFalse(TrackingPlan.from(policy: JSONObject([("location", .object(JSONObject([("track", false)])))]), track: true, interval: 60, precise: true).wanted)
        XCTAssertFalse(TrackingPlan.from(policy: nil, track: false, interval: 60, precise: true).wanted)
    }

    func testTheQueueSendsInBatchesAndKeepsTheNewest() {
        var q = TrackQueue()
        let t0: Int64 = 1_760_000_000_000
        // The first point goes at once (a minute since nothing was sent), then 20 wait for a batch.
        XCTAssertTrue(q.add(TrackQueue.point(fix), now: t0))
        let first = q.takeBatch(now: t0)!
        XCTAssertEqual(1, first.count)
        q.sent(first)
        XCTAssertTrue(q.isEmpty)
        for i in 1..<20 {
            var f = fix
            f.at = t0 + Int64(i) * 1000
            XCTAssertFalse(q.add(TrackQueue.point(f), now: t0 + Int64(i) * 1000), "point \(i)")
        }
        var f = fix
        f.at = t0 + 20_000
        XCTAssertTrue(q.add(TrackQueue.point(f), now: t0 + 20_000)) // the 20th waiting
        // A minute later even one point goes.
        var q2 = TrackQueue()
        _ = q2.add(TrackQueue.point(fix), now: t0)
        _ = q2.takeBatch(now: t0)
        XCTAssertFalse(q2.add(TrackQueue.point(fix), now: t0 + 60_000))
        XCTAssertTrue(q2.add(TrackQueue.point(fix), now: t0 + 60_001))
        // At most 2000 are kept (the oldest go), at most 100 in a batch.
        var big = TrackQueue()
        for i in 0..<2100 {
            var g = fix
            g.at = Int64(i)
            _ = big.add(TrackQueue.point(g), now: 0)
        }
        XCTAssertEqual(2000, big.count)
        let batch = big.takeBatch(now: 1)!
        XCTAssertEqual(100, batch.count)
        XCTAssertEqual(100, batch[0].at)
        big.sent(batch)
        XCTAssertEqual(1900, big.count)
        big.clear()
        XCTAssertNil(big.takeBatch(now: 2))
    }

    func testATrackPointHasSpeedAndHeading() {
        let p = TrackQueue.point(fix)
        XCTAssertEqual(1.3, p.speed)
        XCTAssertEqual(88, p.heading)
        XCTAssertEqual(12, p.acc)
        XCTAssertEqual(242, p.alt)
        XCTAssertEqual(50.088041, p.lat)
        // The body /api/ios/location gets (M5Net's LocationPoint.json): Android's fields.
        XCTAssertEqual(1.3, p.json["speed"]?.doubleValue)
        XCTAssertEqual(88, p.json["heading"]?.doubleValue)
        XCTAssertEqual(1_760_000_000_000, p.json["at"]?.int64Value)
        XCTAssertEqual(Set(["at", "lat", "lon", "acc", "alt", "speed", "heading"]), Set(p.json.objectValue.map { Array($0.keys) } ?? []))
    }

    func testTheServerKeepingNoPositionsEmptiesTheQueue() {
        XCTAssertTrue(TrackQueue.serverRefuses(HTTPError(status: 403, code: "location-off")))
        XCTAssertTrue(TrackQueue.serverRefuses(HTTPError(status: 400, code: "location-off")))
        XCTAssertFalse(TrackQueue.serverRefuses(HTTPError(status: 503)))
        XCTAssertFalse(TrackQueue.serverRefuses(NetError.network("offline")))
    }
}
