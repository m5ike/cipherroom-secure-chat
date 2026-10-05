// DeviceService against the server's own recording of a device session
// (ios-api.json): enrolment with the QR code's pin, a signed check-in, the
// sealed lock command carried out and acknowledged, the design bundle downloaded
// and staged, the release verified — and the control messages of Android's
// push/Control one by one with a test server key.

import CryptoKit
import Foundation
import M5Net
import XCTest
@testable import M5cet

@MainActor
final class DeviceServiceTests: XCTestCase {
    func testEnrolsChecksInAndCarriesOutWhatTheServerSent() async throws {
        let rig = DeviceRig()
        let ok = await rig.enroll()
        XCTAssertTrue(ok, rig.device.enrollError ?? "")
        let st = try XCTUnwrap(rig.device.state)
        XCTAssertEqual(st.deviceId, PushFixtures.deviceId)
        XCTAssertEqual(st.serverKey, PushFixtures.serverKey)
        XCTAssertEqual(st.serverKid, PushFixtures.serverKid)
        XCTAssertEqual(st.server, PushFixtures.base)
        XCTAssertEqual(st.lockPolicy.int("pinLength"), 6)
        XCTAssertNil(rig.device.prefill, "the link's values are used up")
        // The enrolment's body: the fields the server read, the proof by the device key.
        let enroll = try XCTUnwrap(rig.server.requests("/api/ios/enroll").first?.json)
        XCTAssertEqual(Set(enroll.objectValue!.keys).subtracting(["apnsToken", "voipToken", "apnsEnv"]),
                       Set(PushFixtures.ios.obj("enrollRequest")!.objectValue!.keys).subtracting(["apnsToken", "voipToken", "apnsEnv"]))
        let spki = try FixtureSigner().publicKeySPKI()
        XCTAssertTrue(P256Keys.verify(spki: spki, text: DeviceSigning.enrollString(signKey: spki, encKey: spki, time: enroll.int("time")),
                                      signature: enroll.str("proof")))
        // The policy goes to Platform/Security as the server signed it (enrolment and check-in).
        XCTAssertEqual(rig.applied.count, 2)
        XCTAssertNotNil(rig.applied[0].obj("policySigned"))

        // The check-in right after: signed as the server checks it.
        let checkin = try XCTUnwrap(rig.server.requests("/api/ios/checkin").first)
        let canonical = DeviceSigning.requestString(method: "POST", pathAndQuery: "/api/ios/checkin", time: checkin.headers["X-M5-Time"]!,
                                                    nonce: checkin.headers["X-M5-Nonce"]!, body: checkin.body!)
        XCTAssertTrue(P256Keys.verify(spki: spki, text: canonical, signature: checkin.headers["X-M5-Signature"]!))
        XCTAssertEqual(checkin.headers["X-M5-Device"], st.deviceId)
        XCTAssertEqual(Set(checkin.json!.obj("state")!.objectValue!.keys), Set(PushFixtures.ios.obj("checkinRequest")!.obj("state")!.objectValue!.keys))

        // The sealed lock command: carried out, then acknowledged.
        XCTAssertEqual(rig.host.calls, ["lock"])
        let ack = try XCTUnwrap(rig.server.requests("/api/ios/ack").first?.json)
        XCTAssertEqual(ack.str("id"), PushFixtures.ios.str("commandId"))
        XCTAssertEqual(ack.bool("ok"), true)
        XCTAssertEqual(ack.obj("result")?.bool("locked"), true)

        // The bundle: downloaded, verified by the pinned key, opened with the device key, staged.
        XCTAssertEqual(rig.device.bundles.download, .ready)
        XCTAssertEqual(rig.device.bundles.state.staged, PushFixtures.ios.str("buildId"))
        XCTAssertNotNil(rig.storage.files[PushFixtures.ios.str("buildId")])

        // The release record: newer, verified, its App Store link offered.
        XCTAssertEqual(rig.device.update.release?.version, "6.15.0")
        XCTAssertEqual(rig.device.update.state, .ready)
        XCTAssertEqual(rig.device.update.storeURL?.host, "apps.apple.com")
        XCTAssertFalse(rig.device.updateRequired)

        // The events (enrolment, the bundle and release offers) reached the server and left the queue.
        XCTAssertFalse(rig.server.requests("/api/ios/events").isEmpty)
        XCTAssertTrue(rig.device.events.queued.isEmpty)
        let types = rig.server.requests("/api/ios/events").flatMap { $0.json?.arr("events") ?? [] }.map { $0.str("type") }
        XCTAssertTrue(types.contains("unlock") && types.contains("update-available"), "\(types)")
        XCTAssertGreaterThan(rig.device.lastCheckinAt, 0)
        XCTAssertNil(rig.device.lastError)
    }

    func testAPinThatIsNotTheServersKeyStopsTheEnrolment() async {
        let rig = DeviceRig()
        rig.device.takeEnrollLink(URL(string: "m5cet://enroll?server=chat.example.com&kid=DbEdmBPXJKyqeplx")!)
        let ok = await rig.device.enroll(code: "", name: "x")
        XCTAssertFalse(ok)
        XCTAssertNil(rig.device.state)
        XCTAssertTrue(rig.device.enrollError?.contains("not the pinned key") == true, rig.device.enrollError ?? "")
        XCTAssertTrue(rig.server.requests("/api/ios/enroll").isEmpty, "nothing is sent to a server whose key does not match")
    }

    func testTheServerChangingItsKeyDuringTheEnrolmentStopsIt() async {
        let rig = DeviceRig()
        let other = b64(P256.Signing.PrivateKey().publicKey.derRepresentation)
        rig.server.override = { req in
            guard req.url.path == "/api/ios/enroll" else { return nil }
            let e = PushFixtures.ios.obj("enroll")!
            return FixtureServer.json(200, e.with("server", e.obj("server")!.with("publicKey", .string(other))))
        }
        let ok = await rig.device.enroll(server: PushFixtures.base, code: "", name: "x")
        XCTAssertFalse(ok)
        XCTAssertNil(rig.device.state)
    }

    func testEnrolmentLinks() async {
        let rig = DeviceRig()
        rig.device.takeEnrollLink(URL(string: "m5cet://enroll?code=AB-12")!)
        XCTAssertEqual(rig.device.enrollNotice, .invalid)
        rig.device.takeEnrollLink(URL(string: "m5cet://enroll?server=chat.example.com&code=ab-12&kid=\(PushFixtures.serverKid)")!)
        XCTAssertEqual(rig.device.prefill, EnrollPrefill(server: "https://chat.example.com", code: "AB-12", kid: PushFixtures.serverKid, seq: 1))
        XCTAssertEqual(rig.device.enrollNotice, .applied(noCode: false))
        XCTAssertEqual(rig.device.suggestedServer, "https://chat.example.com")
        _ = await rig.enroll()
        rig.device.takeEnrollLink(URL(string: "m5cet://enroll?server=chat.example.com")!)
        XCTAssertEqual(rig.device.enrollNotice, .already(server: "https://chat.example.com"))
        rig.device.takeEnrollLink(URL(string: "m5cet://enroll?server=other.example.com")!)
        XCTAssertEqual(rig.device.enrollNotice, .otherServer(current: "https://chat.example.com", link: "https://other.example.com"))
        XCTAssertNil(rig.device.prefill, "an enrolled device never takes another server's values")
    }

    func testAWipedDeviceIsToldSo() async {
        let rig = DeviceRig()
        _ = await rig.enroll()
        rig.server.override = { req in
            req.url.path == "/api/ios/checkin" ? FixtureServer.json(403, ["ok": false, "code": "device-wiped", "message": "This device is wiped."]) : nil
        }
        let ok = await rig.device.checkin("test", force: true)
        XCTAssertFalse(ok)
        XCTAssertEqual(rig.device.deviceStatus, "wiped")
    }

    func testTheForegroundChecksInAtMostEveryFiveMinutes() async {
        let rig = DeviceRig()
        _ = await rig.enroll()
        let before = rig.server.requests("/api/ios/checkin").count
        let again = await rig.device.checkin("foreground")
        XCTAssertFalse(again, "the enrolment's check-in was just now")
        XCTAssertEqual(rig.server.requests("/api/ios/checkin").count, before)
        let forced = await rig.device.checkin("push", force: true)
        XCTAssertTrue(forced)
    }

    // MARK: control messages (Android push/Control), with a test server key

    func testEachKindIsCarriedOutAndAnswered() async throws {
        let server = TestControlServer()
        let rig = DeviceRig(clock: 1_800_000_000_000)
        let st = DeviceState(server: PushFixtures.base, deviceId: "ios_test0001", serverKey: server.spki, serverKid: server.kid)
        rig.store.saveNow("config", st.json)
        let device = DeviceService(rig.device.deps, bundles: rig.device.bundles, events: rig.device.events)
        device.host = rig.host
        let enc = try FixtureAgreement().publicKeySPKI()
        func wire(_ id: String, _ kind: String, _ p: [String: Any] = [:], exp: Int64 = 0) -> NetJSON {
            server.netWire(id: id, kind: kind, payload: p, exp: exp, device: enc, deviceId: "ios_test0001")
        }
        XCTAssertTrue(device.isEnrolled)

        var r = await device.handle(wire: wire("c1", "ping"), via: "apns")
        XCTAssertEqual(r, .done(kind: "ping"))
        var ack = try XCTUnwrap(rig.server.requests("/api/ios/ack").last?.json)
        XCTAssertEqual(ack.str("id"), "c1")
        XCTAssertEqual(ack.obj("result")?.str("via"), "apns")
        XCTAssertEqual(ack.obj("result")?.obj("state")?.int("battery"), 80)

        r = await device.handle(wire: wire("c2", "status", ["logs": true]), via: "apns")
        ack = try XCTUnwrap(rig.server.requests("/api/ios/ack").last?.json)
        XCTAssertNotNil(ack.obj("result")?.obj("bundle"))
        XCTAssertEqual(ack.obj("result")?.arr("log")?.first?.stringValue, "a log line")
        XCTAssertTrue(rig.host.calls.contains("logs:true"), "the policy's default: errors only")

        r = await device.handle(wire: wire("c3", "flash", ["title": "T", "text": "Hello", "level": "info"]), via: "apns")
        XCTAssertEqual(rig.server.requests("/api/ios/ack").last?.json?.obj("result")?.str("shown"), "notification")
        r = await device.handle(wire: wire("c4", "push", ["title": "Pushed", "body": "B"]), via: "apns")
        r = await device.handle(wire: wire("c5", "notify", ["kind": "message", "tpl": ["title": "{app}", "body": "x"]]), via: "apns")
        XCTAssertEqual(rig.server.requests("/api/ios/ack").last?.json?.obj("result")?.bool("shown"), true)
        // The extension already showed it: answered, not shown twice.
        r = await device.handle(wire: wire("c6", "notify", ["kind": "message"]), via: "apns", alreadyShown: true)
        XCTAssertEqual(r, .done(kind: "notify"))

        r = await device.handle(wire: wire("c7", "lock", ["reason": "lost"]), via: "apns")
        XCTAssertEqual(rig.server.requests("/api/ios/ack").last?.json?.obj("result")?.bool("locked"), true)

        // Unknown kinds are refused with an answer.
        r = await device.handle(wire: wire("c8", "dance"), via: "apns")
        ack = try XCTUnwrap(rig.server.requests("/api/ios/ack").last?.json)
        XCTAssertEqual(ack.bool("ok", true), false)
        XCTAssertEqual(ack.str("error"), "unknown kind dance")

        // The wipe: acknowledged first (afterwards the device key is gone), then done.
        let acksBefore = rig.server.requests("/api/ios/ack").count
        r = await device.handle(wire: wire("c9", "wipe", ["reason": "stolen"]), via: "apns")
        XCTAssertEqual(rig.server.requests("/api/ios/ack").count, acksBefore + 1)
        XCTAssertEqual(rig.server.requests("/api/ios/ack").last?.json?.obj("result")?.bool("wiping"), true)

        XCTAssertEqual(rig.host.calls.filter { !$0.hasPrefix("logs") },
                       ["flash:Hello", "push:Pushed", "notify:message", "lock", "wipe:remote: stolen"])
    }

    func testForgedExpiredForeignAndRepeatedMessagesAreNotCarriedOut() async throws {
        let server = TestControlServer()
        let rig = DeviceRig(clock: 1_800_000_000_000)
        rig.store.saveNow("config", DeviceState(server: PushFixtures.base, deviceId: "ios_test0001", serverKey: server.spki, serverKid: server.kid).json)
        let device = DeviceService(rig.device.deps, bundles: rig.device.bundles, events: rig.device.events)
        device.host = rig.host
        let enc = try FixtureAgreement().publicKeySPKI()

        // Signed by another key.
        let forger = TestControlServer()
        var r = await device.handle(wire: forger.netWire(id: "f1", kind: "lock", device: enc, deviceId: "ios_test0001"), via: "apns")
        guard case .dropped = r else { return XCTFail("forged: \(r)") }
        // For another device.
        r = await device.handle(wire: server.netWire(id: "f2", kind: "lock", device: enc, deviceId: "ios_other"), via: "apns")
        guard case .dropped = r else { return XCTFail("foreign: \(r)") }
        // Expired.
        r = await device.handle(wire: server.netWire(id: "f3", kind: "lock", exp: 1_000, device: enc, deviceId: "ios_test0001"), via: "apns")
        guard case .dropped = r else { return XCTFail("expired: \(r)") }
        // Sealed for another key.
        let otherKey = b64(P256.KeyAgreement.PrivateKey().publicKey.derRepresentation)
        r = await device.handle(wire: server.netWire(id: "f4", kind: "lock", device: otherKey, deviceId: "ios_test0001"), via: "apns")
        guard case .dropped = r else { return XCTFail("other key: \(r)") }
        XCTAssertTrue(rig.host.calls.isEmpty)
        XCTAssertTrue(rig.server.requests("/api/ios/ack").isEmpty, "nothing that does not check out is answered")

        // The same message twice (APNs and the check-in): once.
        let w = server.netWire(id: "d1", kind: "lock", device: enc, deviceId: "ios_test0001")
        r = await device.handle(wire: w, via: "apns")
        XCTAssertEqual(r, .done(kind: "lock"))
        r = await device.handle(wire: w, via: "checkin")
        XCTAssertEqual(r, .duplicate)
        XCTAssertEqual(rig.host.calls, ["lock"])
    }

    func testAnAnswerThatCannotGoNowWaitsForTheNextCheckin() async throws {
        let server = TestControlServer()
        let rig = DeviceRig(clock: 1_800_000_000_000)
        rig.store.saveNow("config", DeviceState(server: PushFixtures.base, deviceId: "ios_test0001", serverKey: server.spki, serverKid: server.kid).json)
        let device = DeviceService(rig.device.deps, bundles: rig.device.bundles, events: rig.device.events)
        device.host = rig.host
        let enc = try FixtureAgreement().publicKeySPKI()
        rig.server.override = { req in req.url.path == "/api/ios/ack" ? HTTPResponse(status: 503) : nil }
        _ = await device.handle(wire: server.netWire(id: "a1", kind: "lock", device: enc, deviceId: "ios_test0001"), via: "apns")
        XCTAssertEqual(rig.store.loadNow("acks")?.arr("list")?.first?.str("id"), "a1")
        rig.server.override = { req in
            req.url.path == "/api/ios/checkin" ? FixtureServer.json(200, ["ok": true, "time": 1, "commands": [], "push": "poll", "minBuild": 0]) : nil
        }
        let ok = await device.checkin("test", force: true)
        XCTAssertTrue(ok)
        XCTAssertEqual(rig.server.requests("/api/ios/ack").last?.json?.str("id"), "a1")
        XCTAssertNil(rig.store.loadNow("acks"))
    }

    func testWhatTheExtensionSawIsCarriedOutWhenTheAppRuns() async throws {
        let server = TestControlServer()
        let rig = DeviceRig(clock: 1_800_000_000_000)
        rig.store.saveNow("config", DeviceState(server: PushFixtures.base, deviceId: "ios_test0001", serverKey: server.spki, serverKid: server.kid).json)
        let dir = TempDir()
        let handoff = PushHandoff(shared: dir.url)
        var deps = rig.device.deps
        deps.handoff = handoff
        let device = DeviceService(deps, bundles: rig.device.bundles, events: rig.device.events)
        device.host = rig.host
        let enc = try FixtureAgreement().publicKeySPKI()
        // The extension saw a wipe (its wire kept as it came) and showed a message.
        handoff.record(.init(id: "w1", kind: "wipe", shown: true, wire: server.wire(id: "w1", kind: "wipe", payload: ["reason": ""], device: enc,
                                                                                       deviceId: "ios_test0001"), at: 1_800_000_000_000))
        handoff.record(.init(id: "n1", kind: "notify", shown: true, wire: nil, at: 1_800_000_000_000))
        await device.processHandoff()
        XCTAssertEqual(rig.host.calls, ["wipe:remote"])
        XCTAssertNil(handoff.entry("w1"))
        // The message arrives with the check-in: answered, not shown again.
        let r = await device.handle(wire: server.netWire(id: "n1", kind: "notify", payload: ["kind": "message"], device: enc, deviceId: "ios_test0001"),
                                    via: "checkin")
        XCTAssertEqual(r, .done(kind: "notify"))
        XCTAssertEqual(rig.host.calls, ["wipe:remote"])
        XCTAssertNil(handoff.entry("n1"))
        // An old note goes.
        handoff.record(.init(id: "old", kind: "notify", shown: true, wire: nil, at: 1))
        await device.processHandoff()
        XCTAssertNil(handoff.entry("old"))
    }

    func testEventsWaitForTheServer() async {
        let rig = DeviceRig()
        _ = await rig.enroll()
        rig.server.override = { req in req.url.path == "/api/ios/events" ? HTTPResponse(status: 502) : nil }
        rig.device.events.add("screenshot")
        let sent = await rig.device.events.flush()
        XCTAssertFalse(sent)
        XCTAssertEqual(rig.device.events.queued.map(\.type), ["screenshot"])
        rig.server.override = nil
        let again = await rig.device.events.flush()
        XCTAssertTrue(again)
        XCTAssertTrue(rig.device.events.queued.isEmpty)
        // The queue keeps the last 500.
        for i in 0..<510 { rig.device.events.add("log", detail: ["n": .int(Int64(i))]) }
        XCTAssertEqual(rig.device.events.queued.count, 500)
        XCTAssertEqual(rig.device.events.queued.first?.detail.int("n"), 10)
    }

    func testTheSignedCallsForOtherParts() async throws {
        let rig = DeviceRig()
        await XCTAssertThrowsAsync { _ = try await rig.device.messageAudit(actions: [], account: nil) }
        _ = await rig.enroll()
        rig.server.override = { req in
            switch req.url.path {
            case "/api/ios/message-audit": FixtureServer.json(200, ["ok": true, "recorded": 1])
            case "/api/ios/location": FixtureServer.json(200, ["ok": true, "stored": 2, "minSeconds": 15])
            default: nil
            }
        }
        let n = try await rig.device.messageAudit(actions: [["action": "hide", "messageId": "m1", "room": "r"]], account: "alice")
        XCTAssertEqual(n, 1)
        let loc = try await rig.device.uploadLocation(points: [LocationPoint(at: 1, lat: 50, lon: 14, acc: 5), LocationPoint(at: 2, lat: 50, lon: 14, acc: 5)])
        XCTAssertEqual(loc.stored, 2)
        XCTAssertEqual(loc.minSeconds, 15)
        let audit = try XCTUnwrap(rig.server.requests("/api/ios/message-audit").first)
        XCTAssertNotNil(audit.headers["X-M5-Signature"])
        XCTAssertEqual(audit.json?.str("account"), "alice")
        // The account link: refused without a session (the recording's 401 signed-out).
        let outcome = await rig.device.linkNotifications(token: "not-a-session", wanted: true)
        guard case .failed = outcome else { return XCTFail("\(outcome)") }
    }

    func testTheWipeReportIsSignedForLater() throws {
        let reporter = DeviceWipeReporter()
        reporter.signer = FixtureSigner()
        reporter.update(DeviceState(server: "https://chat.example.com/m5", deviceId: "ios_x", serverKey: "k", serverKid: "k"))
        let body = Wiper.eventBody(reason: "remote", remote: true, attempts: 0, at: 5)
        let req = try XCTUnwrap(try reporter.signedEventsRequest(body: body))
        XCTAssertEqual(req.url, "https://chat.example.com/m5/api/ios/events")
        XCTAssertEqual(Data(base64Encoded: req.body), body)
        let canonical = DeviceSigning.requestString(method: "POST", pathAndQuery: "/m5/api/ios/events", time: req.headers["X-M5-Time"]!,
                                                    nonce: req.headers["X-M5-Nonce"]!, body: body)
        XCTAssertTrue(P256Keys.verify(spki: try FixtureSigner().publicKeySPKI(), text: canonical, signature: req.headers["X-M5-Signature"]!))
        reporter.update(nil)
        XCTAssertNil(try reporter.signedEventsRequest(body: body), "not enrolled: nothing to report")
    }

    func testForgettingTheDevice() async {
        let rig = DeviceRig()
        _ = await rig.enroll()
        rig.device.forgetAll()
        XCTAssertFalse(rig.device.isEnrolled)
        XCTAssertEqual(rig.device.update.state, .none)
        XCTAssertEqual(rig.device.bundles.state, .init())
        XCTAssertTrue(rig.storage.files.isEmpty)
    }
}

@MainActor
func XCTAssertThrowsAsync(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
    do {
        try await body()
        XCTFail("no error", file: file, line: line)
    } catch {}
}
