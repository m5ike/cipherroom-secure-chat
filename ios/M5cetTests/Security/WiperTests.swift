// The wipe leaves nothing: the tiers, wraps, the lock inbox, vault files, the App
// Group side, caches, every Keychain item and key — only the signed report, which
// holds no secret, until it is delivered (Android pending-wipe.json). Quiet for the
// duress PIN; delivered or dropped by the server's answer.

import M5Core
import XCTest
@testable import M5cet

/// Signs nothing real: a fixed request (M5Net's part).
private struct StubSigner: WipeReportSigner {
    let enrolled: Bool
    func signedEventsRequest(body: Data) throws -> PendingRequest? {
        guard enrolled else { return nil }
        return PendingRequest(url: "https://chat.example.com/api/ios/events", headers: ["X-M5-Device": "ios_test1", "X-M5-Signature": "sig"],
                              body: Bytes.b64(body), quiet: nil)
    }
}

private final class StubTransport: WipeTransport, @unchecked Sendable {
    var status = 200
    var thrown = false
    private(set) var sent: [PendingRequest] = []
    func send(_ request: PendingRequest) async throws -> Int {
        sent.append(request)
        if thrown { throw URLError(.notConnectedToInternet) }
        return status
    }
}

@MainActor
final class WiperTests: XCTestCase {
    func testAWipeLeavesNothingButTheReport() async throws {
        let f = try Fixture(enclave: EnclaveKeyMaker.available)
        f.center.wiper.signer = StubSigner(enrolled: true)
        try await f.lock.setUp(pin: "482915")
        // Something everywhere.
        try f.vault.put(.user, "rooms", Data("[]".utf8))
        try f.vault.put(.sys, "config", Data("{}".utf8))
        try f.lock.enrollBiometrics()
        _ = try f.center.signer()
        _ = try f.center.agreement()
        try FileVault(vault: f.vault).write("file:1", Data(repeating: 1, count: 70_000))
        try f.center.secrets.write("account.session", Data("token".utf8), access: .foreground)
        let caches = f.dir.url.appendingPathComponent("caches", isDirectory: true)
        try FileManager.default.createDirectory(at: caches.appendingPathComponent("img"), withIntermediateDirectories: true)
        try Data([1]).write(to: caches.appendingPathComponent("img/a.png"))
        f.lock.lockNow(remote: false) // a lock inbox generation on the disk too
        XCTAssertTrue(f.center.inbox.hasPending)
        XCTAssertGreaterThan(f.dir.files().count, 8)

        f.center.wipe(reason: "attempts", remote: false, attempts: 8)

        let left = f.dir.files().filter { $0 != "group/m5/lock-state.json" }
        XCTAssertEqual(left, ["app/pending-wipe.json"])
        XCTAssertEqual(try f.keychainNames(), [], "Keychain items and Secure Enclave key blobs")
        XCTAssertFalse(f.vault.unlocked)
        XCTAssertFalse(f.lock.isSetUp)
        XCTAssertFalse(f.center.inbox.isActive)
        XCTAssertTrue(FileManager.default.fileExists(atPath: caches.path), "the caches folder stays, empty")
        // The report: Android's body, signed by M5Net's signer, no secret in it.
        let pending = try XCTUnwrap(f.center.wiper.pending)
        let body = try XCTUnwrap(SecData.json(XCTUnwrap(Bytes.unb64(pending.body))))
        let event = try XCTUnwrap(body.array("events")?.first?.objectValue)
        XCTAssertEqual(event.optString("type"), "wipe")
        XCTAssertEqual(event.object("detail")?.optString("reason"), "attempts")
        XCTAssertEqual(event.object("detail")?.optInt("attempts"), 8)
        XCTAssertNil(pending.quiet)
        XCTAssertFalse(f.center.wiper.pendingQuiet)
    }

    func testTheReportIsDeliveredOrDropped() async throws {
        let f = try Fixture()
        let wiper = f.center.wiper
        wiper.signer = StubSigner(enrolled: true)
        let transport = StubTransport()
        wiper.transport = transport
        wiper.wipe(reason: "duress", remote: false, attempts: 0, quiet: true)
        XCTAssertTrue(wiper.pendingQuiet)
        transport.thrown = true
        isFalse(await wiper.sendPending(), "no network: kept for the next start")
        XCTAssertTrue(wiper.hasPending)
        transport.thrown = false
        transport.status = 503
        isFalse(await wiper.sendPending())
        transport.status = 429
        isFalse(await wiper.sendPending(), "rate limited: again later")
        transport.status = 404
        isTrue(await wiper.sendPending(), "refused for good (an unknown device): dropped")
        XCTAssertFalse(wiper.hasPending)
        XCTAssertEqual(transport.sent.count, 4)
        XCTAssertEqual(transport.sent[0].headers["X-M5-Device"], "ios_test1")
    }

    func testNotEnrolledNoReportAndRemoteType() throws {
        let f = try Fixture()
        f.center.wiper.signer = StubSigner(enrolled: false)
        f.center.wiper.wipe(reason: "remote", remote: true, attempts: 0)
        XCTAssertFalse(f.center.wiper.hasPending)
        let body = SecData.json(Wiper.eventBody(reason: "remote", remote: true, attempts: 0, at: 5))
        let event = body?.array("events")?.first?.objectValue
        XCTAssertEqual(event?.optString("type"), "remote-wipe")
        XCTAssertEqual(event?.optInt64("at"), 5)
        XCTAssertEqual(event?.optString("id").count, 16)
    }

    func testTeardownsRun() throws {
        let f = try Fixture()
        var ran: [String] = []
        f.center.wiper.addTeardown("calls") { ran.append("calls") }
        f.center.wiper.addTeardown("location") { ran.append("location") }
        f.center.wiper.wipe(reason: "attempts", remote: false, attempts: 3)
        XCTAssertEqual(ran, ["calls", "location"])
    }

    func testARemoteWipeEndsAfterItsReport() async throws {
        let f = try Fixture()
        f.center.wiper.signer = StubSigner(enrolled: true)
        let transport = StubTransport()
        f.center.wiper.transport = transport
        var ended = false
        f.center.afterRemoteWipe = { ended = true }
        f.center.wipe(reason: "remote", remote: true, attempts: 0)
        XCTAssertFalse(f.center.wipedNotice, "a remote wipe shows no notice")
        for _ in 0..<100 where !ended { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(ended)
        XCTAssertEqual(transport.sent.count, 1)
        XCTAssertFalse(f.center.wiper.hasPending)
    }
}
