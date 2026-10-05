// The relay for away members (P4Relay): the directory's cache and its
// questions, which devices a message is sealed for (pins, the directory, key
// transparency), the relay frame with `per` — which the hub reads as built
// (HubWire rules). And the ICE servers from /api/turn (never caching `pending`).

import Foundation
import Testing
@testable import M5Net
import M5Core

private func pk() -> String { Bytes.b64(SoftwareRequestSigner().key.publicKey.derRepresentation) }

@Suite struct RelayDirectoryTests {
    let now: Millis = 1_800_000_000_000
    /// Realistic mailbox items (what the hub's golden relay frame carried).
    let item: NetJSON

    init() throws {
        let relay = try #require(try Fixtures.hubFrames().arr("client")?.first { $0.str("name") == "relay-per" })
        item = try #require(relay.obj("input")?.obj("per")?.obj("ref-a"))
    }

    func bundle(_ id: String, exp: Millis) -> NetJSON { ["id": .string(id), "dh": "x", "kem": "y", "exp": .int(exp), "sig": "z"] }
    func device(_ pk: String, apk: String, bundleId: String, certExp: Millis) -> NetJSON {
        ["pk": .string(pk), "apk": .string(apk), "cert": ["v": 2, "exp": .int(certExp), "sig": "c2ln"], "bundle": bundle(bundleId, exp: now + 86_400_000)]
    }

    @Test func theDirectoryIsAskedOnceAndCached() {
        var r = RelayDirectory()
        let first = r.shouldAsk("ref", now: now), again = r.shouldAsk("ref", now: now + 1_000), later = r.shouldAsk("ref", now: now + 3_000)
        #expect(first && !again && later) // not twice within 3 s
        #expect(RelayDirectory.askFrame("ref") == .keyBundles(ref: "ref"))
        r.onKeyBundles(ref: "ref", devices: [], now: now, checker: TestRelayChecker())
        let cached = r.shouldAsk("ref", now: now + 60_000)
        #expect(r.known("ref", now: now + 60_000) && !cached)
        #expect(!r.known("ref", now: now + 5 * 60_000))
        let kt1 = r.shouldAskKt("ref", now: now), kt2 = r.shouldAskKt("ref", now: now + 10)
        #expect(kt1 && !kt2)
        #expect(RelayDirectory.ktFrame("ref") == .ktLookup(ref: "ref"))
    }

    @Test func onlyDevicesWhoseCertificateAndBundleCheckOutAreKept() {
        let (good, badCert, badBundle) = (pk(), pk(), pk())
        let checker = TestRelayChecker(certs: [good: "APK", badBundle: "APK"], bundles: ["b-good"])
        var r = RelayDirectory()
        r.onKeyBundles(ref: "ref", devices: [
            device(good, apk: "APK", bundleId: "b-good", certExp: now + 1000),
            device(badCert, apk: "APK", bundleId: "b-good", certExp: now + 1000),
            device(badBundle, apk: "APK", bundleId: "b-bad", certExp: now + 1000),
            device("not-a-key", apk: "APK", bundleId: "b-good", certExp: now + 1000),
        ], now: now, checker: checker)
        let ds = r.devices("ref", pinnedApk: "APK", remembered: [], ktOn: false, now: now, checker: checker)
        #expect(ds.map(\.pk) == [good])
        // Not the member's pinned account, or none pinned: no directory device at all (review P01).
        #expect(r.devices("ref", pinnedApk: "OTHER", remembered: [], ktOn: false, now: now, checker: checker).isEmpty)
        #expect(r.devices("ref", pinnedApk: nil, remembered: [], ktOn: false, now: now, checker: checker).isEmpty)
    }

    @Test func keyTransparencyDecidesForDirectoryDevices() {
        let d = pk()
        let checker = TestRelayChecker(certs: [d: "APK"], bundles: ["b"])
        var r = RelayDirectory()
        r.onKeyBundles(ref: "ref", devices: [device(d, apk: "APK", bundleId: "b", certExp: now + 1000)], now: now, checker: checker)
        // KT on: a directory device needs a verified lookup that includes it.
        #expect(r.devices("ref", pinnedApk: "APK", remembered: [], ktOn: true, now: now, checker: checker).isEmpty)
        #expect(r.ktStatus("ref", apk: "APK", dpk: d, now: now) == "unknown")
        r.onKt(ref: "ref", verifiedEntries: nil, now: now)
        #expect(r.ktStatus("ref", apk: "APK", dpk: d, now: now) == "unverified")
        let acct = KtLogEntry(entry: ["t": "acct", "u": "u", "apk": "APK", "ts": 1], index: 0)
        let dev = KtLogEntry(entry: ["t": "dev", "u": "u", "apk": "APK", "dpk": .string(d), "exp": .int(now + 1000), "ts": 2], index: 1)
        r.onKt(ref: "ref", verifiedEntries: [acct, dev], now: now)
        #expect(r.devices("ref", pinnedApk: "APK", remembered: [], ktOn: true, now: now, checker: checker).count == 1)
        let rev = KtLogEntry(entry: ["t": "rev", "u": "u", "apk": "APK", "dpk": .string(d), "ts": 3], index: 2)
        r.onKt(ref: "ref", verifiedEntries: [acct, dev, rev], now: now)
        #expect(r.ktStatus("ref", apk: "APK", dpk: d, now: now) == "revoked")
        #expect(r.devices("ref", pinnedApk: "APK", remembered: [], ktOn: false, now: now, checker: checker).isEmpty)
    }

    @Test func pinnedDevicesComeFirstAndMustBeCertifiedByThePinnedAccount() {
        let (a, b, c) = (pk(), pk(), pk())
        let checker = TestRelayChecker(certs: [a: "APK", b: "OTHER"], bundles: ["ba", "bb", "bc"])
        let r = RelayDirectory()
        let remembered = [
            RelayRememberedDevice(pk: a, bundle: bundle("ba", exp: now + 1), acc: ["apk": "APK", "exp": .int(now + 1)]),
            RelayRememberedDevice(pk: b, bundle: bundle("bb", exp: now + 1), acc: ["apk": "OTHER", "exp": .int(now + 1)]),
            RelayRememberedDevice(pk: c, bundle: bundle("bc", exp: now + 1), acc: nil),
        ]
        #expect(r.devices("ref", pinnedApk: "APK", remembered: remembered, ktOn: false, now: now, checker: checker).map(\.pk) == [a])
        // No account pinned for the member: every pinned device with a valid bundle.
        #expect(r.devices("ref", pinnedApk: nil, remembered: remembered, ktOn: false, now: now, checker: checker).map(\.pk) == [a, b, c])
    }

    @Test func theFrameSealsPerDeviceAndFallsBackToTheRoomEnvelope() throws {
        let p3: NetJSON = ["iv": "aXYtYmFzZTY0aXYt", "ciphertext": "Y2lwaGVydGV4dA=="]
        let one = RelayDevice(pk: "p1", apk: "A", bundle: .object([:])), two = RelayDevice(pk: "p2", apk: "A", bundle: .object([:]))
        let mid = item.str("id")
        var made = 0
        let f = try #require(RelayDirectory.frame(messageId: mid, refs: ["ref-a", "ref-b", "ref-c"], devices: ["ref-a": [one], "ref-b": [one, two]],
                                                  seal: { _ in made += 1; return item }, roomEnvelope: { p3 }, mention: ["ref-c", "ref-x"]))
        #expect(made == 3)
        #expect(f.sealed == ["ref-a", "ref-b"])
        #expect(f.relay.to == ["ref-a", "ref-b", "ref-c"])
        #expect(f.relay.per?["ref-a"] == item)
        #expect(f.relay.per?["ref-b"]?.str("kind") == "mb-set")
        #expect(f.relay.envelope == p3)
        #expect(f.relay.mention == ["ref-c"])
        let frame = HubClientFrame.relay(f.relay)
        try frame.validate() // the hub reads it as built
        // Everyone sealed: no room envelope is made.
        let sealedOnly = try #require(RelayDirectory.frame(messageId: mid, refs: ["ref-a"], devices: ["ref-a": [one]], seal: { _ in item }, roomEnvelope: {
            Issue.record("made a room envelope"); return p3
        }, mention: nil))
        #expect(sealedOnly.relay.envelope == nil)
        try HubClientFrame.relay(sealedOnly.relay).validate()
        // Without a room envelope a recipient without devices cannot be addressed; nobody: no frame.
        let partial = try #require(RelayDirectory.frame(messageId: mid, refs: ["ref-a", "ref-b"], devices: ["ref-a": [one]], seal: { _ in item }, roomEnvelope: { nil }, mention: nil))
        #expect(partial.relay.to == ["ref-a"])
        #expect(RelayDirectory.frame(messageId: mid, refs: ["ref-b"], devices: [:], seal: { _ in item }, roomEnvelope: { nil }, mention: nil) == nil)
        // A device that fails to seal is left out.
        let failing = try #require(RelayDirectory.frame(messageId: mid, refs: ["ref-a"], devices: ["ref-a": [one]], seal: { _ in throw NetError.invalid("x") }, roomEnvelope: { p3 }, mention: nil))
        #expect(failing.sealed.isEmpty && failing.relay.envelope == p3)
        #expect(throws: NetError.self) { _ = try RelayDirectory.mailboxSet(id: "other-id", items: [item]) }
        #expect(RelayDirectory.isP4(item) && !RelayDirectory.isP4(p3))
    }
}

@Suite struct IceServerTests {
    /// Rtc.cacheUntil (Android RtcTurnTest).
    @Test func pendingAnswersAreNeverCached() {
        let now: Millis = 1_800_000_000_000
        #expect(TurnAnswer.cacheUntil(["pending": true, "ttlSeconds": 0, "expiresAt": .int(now)], now: now) == 0)
        #expect(TurnAnswer.cacheUntil(["pending": true, "ttlSeconds": 3600], now: now) == 0)
        #expect(TurnAnswer.cacheUntil(nil, now: now) == 0)
        #expect(TurnAnswer.cacheUntil(["ttlSeconds": 3600], now: now) == now + (3600 - 60) * 1000)
        #expect(TurnAnswer.cacheUntil(["ttlSeconds": 0], now: now) == now + 10 * 60_000)
        #expect(TurnAnswer.cacheUntil(["pending": false], now: now) == now + 10 * 60_000)
    }

    @Test func theCacheAsksAgainWhilePendingAndKeepsAFullAnswer() async {
        let pending = Mutexed(true)
        let http = StubHTTP { _ in
            if pending.value {
                return StubHTTP.json(["ok": true, "configured": true, "mode": "ephemeral", "pending": true, "iceServers": [["urls": ["stun:stun.example:3478"]]], "ttlSeconds": 0])
            }
            return StubHTTP.json(["ok": true, "configured": true, "mode": "ephemeral", "ttlSeconds": 3600,
                                  "iceServers": [["urls": "stun:stun.example:3478"], ["urls": ["turn:turn.example:3478?transport=udp", "turns:turn.example:5349"], "username": "u", "credential": "c"]]])
        }
        let cache = IceServerCache(base: "https://h", http: HTTPClient(transport: http))
        #expect(await cache.iceServers() == [IceServer(urls: ["stun:stun.example:3478"])])
        _ = await cache.iceServers()
        #expect(http.requests.count == 2) // pending: asked again
        pending.value = false
        await cache.hubConnected()
        let full = await cache.iceServers()
        #expect(full.count == 2 && full[1].username == "u" && full[1].urls.count == 2)
        _ = await cache.iceServers()
        #expect(http.requests.count == 3) // cached
        #expect(await cache.count == 2)
        // No answer at all: the public STUN server.
        let down = IceServerCache(base: "https://h", http: HTTPClient(transport: StubHTTP { _ in throw NetError.network("down") }))
        #expect(await down.iceServers() == IceServerCache.fallback)
    }
}

/// A value tests change across closures.
final class Mutexed<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T {
        get { lock.withLock { v } }
        set { lock.withLock { v = newValue } }
    }
}
