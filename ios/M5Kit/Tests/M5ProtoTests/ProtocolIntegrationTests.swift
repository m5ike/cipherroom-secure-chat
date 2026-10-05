// The app's side of the protocol against the Android tests: ParityTest (the
// web's own fixture: sealed messages, the NFC card, the binary chunk frame, a
// payload with every 6.1 field), P4IntegrationTest (trust states, pins, the
// relay frame, the hub proof, the account key, the stores) and Review612Test
// (the 6.12 security review: P01, P03, P04, P07, P08, P09, P10, S14).

import Foundation
import M5Core
import M5Crypto
@testable import M5Proto
import Testing

enum ProtoRepo {
    static let root: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static func json(_ relative: String) throws -> JSON { try JSON.parse(Array(try Data(contentsOf: root.appendingPathComponent(relative)))) }
}

@Suite struct ParityTests {
    static let v: JSON = try! ProtoRepo.json("test/fixtures/android-interop.json")

    @Test func opensTheWebsSealedMessage() throws {
        let s = ParityTests.v["sealed"]!.objectValue!
        #expect(Sealed.open(s.optString("ciphertext"), meta: s.object("meta")!, code: s.optString("code")) == s.optString("plain"))
        #expect(Sealed.open(s.optString("ciphertext"), meta: s.object("meta")!, code: s.optString("wrong")) == nil)
    }

    @Test func sealsWhatTheWebCanOpenAgain() throws {
        let sealed = try Sealed.seal("zpráva", code: "WXYZ-2345-6789")
        #expect(sealed.meta.int("v") == 2 && sealed.meta.int("it") == 600_000)
        #expect(Sealed.open(sealed.ciphertext, meta: sealed.meta, code: "wxyz 2345 6789") == "zpráva")
        let code = Sealed.newCode()
        let allowed = Set("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
        #expect(code.count == 14 && code.split(separator: "-").count == 3 && code.replacingOccurrences(of: "-", with: "").allSatisfy { allowed.contains($0) })
    }

    @Test func readsAndWritesTheWebsNfcCard() throws {
        let n = ParityTests.v["nfc"]!.objectValue!
        let card = try #require(ConnTagV1.open(n.optString("blob"), pin: n.optString("pin")))
        #expect(card.string("room") == "team")
        #expect(card.string("passphrase") == n.object("card")?.string("passphrase"))
        #expect(ConnTagV1.open(n.optString("blob"), pin: "000000") == nil)
        let mine = try ConnTagV1.seal(card, pin: "1234")
        #expect(mine.hasPrefix("m5cet:nfc:v1:"))
        #expect(ConnTagV1.open(mine, pin: "1234")?.string("room") == "team")
        #expect(!ConnTagV1.validPin("12a4"))
    }

    @Test func buildsTheWebsBinaryChunkFrame() throws {
        let c = ParityTests.v["binaryChunk"]!.objectValue!
        let frame = FileTransfer.binaryFrame(id: c.optString("transferId"), seq: c.int("seq")!, iv: B64.decode(c.optString("iv"))!, ciphertext: B64.decode(c.optString("ct"))!, type: 0x01)
        #expect(frame == B64.decode(c.optString("frame"))!)
        let parsed = try #require(FileTransfer.parseBinary(frame))
        #expect(parsed.id == c.optString("transferId") && parsed.seq == c.int("seq") && !parsed.proxy)
    }

    @Test func checksAPayloadLikeTheWeb() throws {
        let p = ParityTests.v["payload"]!.objectValue!
        let web = p.object("web")!
        let m = try #require(Payloads.validate(p.object("input"), transportSender: "p-alice", myId: "p-me", now: SystemClock().now()))
        #expect(m.text == web.optString("text"))
        #expect(m.ttlMinutes == web.int("ttlMinutes"))
        #expect(m.expiresAt == web.optInt64("createdAt") + Int64(web.int("ttlMinutes")!) * 60_000)
        let flags = web.object("flags")!
        #expect(m.tap == flags.bool("tap"))
        #expect(m.vanishSeconds == flags.int("vanishSeconds"))
        #expect(m.sealed?.string("salt") == flags.object("sealed")?.string("salt"))
        #expect(m.to.count == 2)
        #expect(m.forwardedFrom == web.string("forwardedFrom"))
        #expect(m.replyToText == web.object("replyTo")?.string("text"))
        let loc = web.object("loc")!
        #expect(abs((m.loc?.double("lat") ?? 0) - loc.double("lat")!) < 1e-9)
        #expect(abs((m.loc?.double("lon") ?? 0) - loc.double("lon")!) < 1e-9)
        #expect(m.loc?.int64("acc") == loc.int64("acc"))
        let att = web.object("attachment")!
        #expect(m.fileName == att.string("name") && m.fileMime == att.string("mime") && m.fileDataUrl == att.string("dataUrl"))
        #expect(m.fileImage == (att.string("kind") == "image"))
    }

    @Test func receiptsAreBoundedAndBoundToTheirSender() {
        var r = JSONObject([("kind", "receipt"), ("id", "rcpt-1"), ("senderId", "p-a"), ("state", "read"), ("ids", .array(["msg-1", 7, "", "msg-2"]))])
        #expect(Payloads.receipt(r, transportSender: "p-a", myId: "p-me")?.ids.count == 2)
        #expect(Payloads.receipt(r, transportSender: "p-b", myId: "p-me") == nil)
        r["state"] = "seen"
        #expect(Payloads.receipt(r, transportSender: "p-a", myId: "p-me") == nil)
    }

    @Test func payloadChecks() {
        let now: Int64 = 1_800_000_000_000
        let base = JSONObject([("id", "m1"), ("senderId", "p-a"), ("senderName", "Al\u{7}ice"), ("text", "hi"), ("createdAt", .int(now + 3_600_000))])
        let m = Payloads.validate(base, transportSender: "p-a", myId: "p-me", now: now)!
        #expect(m.senderName == "Alice")
        #expect(m.createdAt == now + Payloads.futureSkew) // a clock far ahead is bounded
        #expect(Payloads.validate(base, transportSender: "p-b", myId: "p-me", now: now) == nil) // another channel's sender
        #expect(Payloads.validate(base.with("senderId", "system"), transportSender: nil, myId: "p-me", now: now) == nil)
        #expect(Payloads.validate(base.with("senderId", "system-messenger"), transportSender: nil, myId: "p-me", now: now) == nil)
        #expect(Payloads.validate(base.with("senderId", "p-me"), transportSender: nil, myId: "p-me", now: now) == nil)
        #expect(Payloads.validate(base.with("kind", "poll"), transportSender: "p-a", myId: "p-me", now: now) == nil)
        #expect(Payloads.validate(base.with("text", ""), transportSender: "p-a", myId: "p-me", now: now) == nil)
        let a = base.with("attachment", .object(JSONObject([("kind", "image"), ("name", "..evil<>.svg"), ("mime", "image/svg+xml"), ("size", 10), ("dataUrl", "data:image/svg+xml;base64,PHN2Zy8+")])))
        let f = Payloads.validate(a, transportSender: "p-a", myId: "p-me", now: now)!
        #expect(f.fileMime == "application/octet-stream" && !f.fileImage)
        #expect(f.fileDataUrl == "data:application/octet-stream;base64,PHN2Zy8+")
        #expect(f.fileName == "_evil__.svg")
        #expect(Payloads.validate(base.with("loc", .object(JSONObject([("lat", 91), ("lon", 0)]))), transportSender: "p-a", myId: "p-me", now: now)?.loc == nil)
        let audio = JSONObject([("id", "a1"), ("senderId", "p-a"), ("kind", "audio-status"), ("status", "live")])
        #expect(Payloads.validate(audio, transportSender: "p-a", myId: "p-me", now: now)?.kind == "audio-status")
        #expect(Payloads.safeFileName(.string("")) == "file")
    }
}

/* ----------------------------------------------------------- P4 integration */

final class TestAccount: P4AccountProvider, @unchecked Sendable {
    var signedIn = true
    var username: String
    var token = "tok"
    let seed: Bytes
    init(_ username: String, seed: Bytes) { self.username = username; self.seed = seed }
    func accountSeed() -> Bytes? { seed }
}

@Suite struct P4IntegrationTests {
    @Test func trustStates() {
        #expect(Trust.of(attested: false, accountPin: nil, namePin: "new", deviceVerified: false, accountVerified: false, ktRevoked: false) == Trust.new)
        #expect(Trust.of(attested: false, accountPin: nil, namePin: "match", deviceVerified: false, accountVerified: false, ktRevoked: false) == Trust.new)
        #expect(Trust.of(attested: false, accountPin: nil, namePin: "match", deviceVerified: true, accountVerified: false, ktRevoked: false) == Trust.verified)
        #expect(Trust.of(attested: false, accountPin: nil, namePin: "changed", deviceVerified: true, accountVerified: false, ktRevoked: false) == Trust.changed)
        #expect(Trust.of(attested: true, accountPin: "new", namePin: "new", deviceVerified: false, accountVerified: false, ktRevoked: false) == Trust.account)
        #expect(Trust.of(attested: true, accountPin: "match", namePin: "changed", deviceVerified: false, accountVerified: false, ktRevoked: false) == Trust.account)
        #expect(Trust.of(attested: true, accountPin: "match", namePin: "match", deviceVerified: false, accountVerified: true, ktRevoked: false) == Trust.verified)
        #expect(Trust.of(attested: true, accountPin: "changed", namePin: "match", deviceVerified: true, accountVerified: true, ktRevoked: false) == Trust.changed)
        #expect(Trust.of(attested: true, accountPin: "new", namePin: "changed", deviceVerified: false, accountVerified: false, ktRevoked: false) == Trust.changed)
        #expect(Trust.of(attested: true, accountPin: "match", namePin: "match", deviceVerified: true, accountVerified: true, ktRevoked: true) == Trust.changed)
    }

    @Test func accountPinsAcrossRooms() {
        let store = P4Store(backend: MemoryRecordVault())
        let apk1 = Prim.b64(Bytes(repeating: 0, count: 32)), apk2 = Prim.b64(Prim.H([1]))
        let d1 = Prim.generateP256().spki, d2 = Prim.generateP256().spki
        #expect(store.pinAccount(apk1, devicePk: d1, username: "Alice") == "new")
        #expect(store.pinAccount(apk1, devicePk: d2, username: "alice") == "match")
        #expect(store.pinAccount(apk2, devicePk: d1, username: "alice") == "changed")
        #expect(!store.accountAllowed(apk2, username: "alice"))
        #expect(store.accountAllowed(apk1, username: "alice"))
        #expect(store.accountAllowed(apk2, username: "bob"))
        #expect(!store.accountVerified(apk1))
        store.setAccountVerified(apk1, true)
        #expect(store.accountVerified(apk1))
        store.acceptAccount(apk2, devicePk: d1, username: "alice")
        #expect(store.pinAccount(apk2, devicePk: d1, username: "alice") == "match")
        #expect(store.accountAllowed(apk2, username: "alice"))
    }

    @Test func downgradeMarkBundlesAndMailboxPersist() throws {
        let backend = MemoryRecordVault()
        let store = P4Store(backend: backend)
        let peer = ChatIdentity.generate()
        #expect(!store.p4Seen(peer.publicKey))
        store.markP4(peer.publicKey)
        let now = SystemClock().now()
        let b = try Mailbox.createBundle(IdentitySigner(peer), now, SystemRng())
        store.rememberDevice(roomId: "r3.room", pk: peer.publicKey, bundle: b.bundle, acc: nil, accApk: nil, ref: "ref-1")
        let again = P4Store(backend: backend)
        #expect(again.p4Seen(peer.publicKey))
        #expect(again.devicesOfRef("ref-1").count == 1)
        #expect(again.devicesOfRef("ref-1")[0].bundle == b.bundle)
        let mine = Mailbox(store: store.mailbox, signer: IdentitySigner(peer))
        let id = try mine.current(now)!.bundle.id
        #expect(try Mailbox(store: P4Store(backend: backend).mailbox, signer: IdentitySigner(peer)).current(now)!.bundle.id == id)
    }

    @Test func replayWindowPersists() {
        let backend = MemoryRecordVault()
        let store = P4Store(backend: backend)
        let now = SystemClock().now()
        let window = store.replay("r3.room")
        #expect(ReplayGuard(store: window, pruneEvery: 0).check("r3.room", "m1", createdAt: now, now: now) == "ok")
        store.saveReplay("r3.room", window)
        let after = ReplayGuard(store: P4Store(backend: backend).replay("r3.room"), pruneEvery: 0)
        #expect(after.check("r3.room", "m1", createdAt: now, now: now) == "replay")
        #expect(after.check("r3.room", "m2", createdAt: now, now: now) == "ok")
        #expect(after.checkId("r3.room", "m3", now: now) == "ok")
        #expect(after.checkId("r3.room", "m3", now: now) == "replay")
        #expect(after.checkId("r3.room", "m1", now: now) == "replay")
        #expect(!(backend.record(P4Store.replayName("r3.room"))?.stringify().contains("m1") ?? true))
    }

    static func directoryDevice(_ pk: String, _ apk: String, _ seed: Bytes, _ bundle: Mailbox.Bundle, _ now: Int64) throws -> JSON {
        let exp = now + P4.deviceCertLifetimeMs - 1000
        let cert = try Handshake.certifyDeviceV2(accountSeed: seed, devicePk: pk, exp: exp, now: now)
        return .object(JSONObject([("pk", .string(pk)), ("apk", .string(apk)), ("cert", .object(cert)), ("bundle", .object(bundle.json))]))
    }

    @Test func relayFrameSealsPerDeviceAndFallsBack() throws {
        let now = SystemClock().now()
        let roomId = "r3.relayRoom"
        let me = ChatIdentity.generate(), bob1 = ChatIdentity.generate(), bob2 = ChatIdentity.generate()
        var seed = Bytes(repeating: 0, count: 32)
        seed[5] = 3
        let apk = Prim.b64(try Prim.ed25519Public(seed))
        let k1 = try Mailbox.createBundle(IdentitySigner(bob1), now, SystemRng()), k2 = try Mailbox.createBundle(IdentitySigner(bob2), now, SystemRng())
        let devices: [JSON] = [try Self.directoryDevice(bob1.publicKey, apk, seed, k1.bundle, now), try Self.directoryDevice(bob2.publicKey, apk, seed, k2.bundle, now),
                               try Self.directoryDevice(bob2.publicKey, apk, Bytes(repeating: 0, count: 32), k2.bundle, now)]
        var relay = P4Relay()
        do { let v = relay.shouldAsk("ref-bob", now: now); #expect(v) }
        do { let v = !relay.shouldAsk("ref-bob", now: now); #expect(v) }
        relay.onKeyBundles(JSONObject([("type", "key-bundles"), ("ref", "ref-bob"), ("devices", .array(devices))]), now: now)
        #expect(relay.known("ref-bob", now: now))
        let bobs = relay.devices("ref-bob", pinnedApk: apk, remembered: [], ktOn: false, now: now)
        #expect(bobs.count == 2)
        let all: [String: [P4Relay.Device]] = ["ref-bob": bobs, "ref-carol": []]
        let box = Mailbox(store: MemoryMailboxStore(), signer: IdentitySigner(me))
        let json = JSONObject([("id", "msg-1"), ("text", "for later"), ("createdAt", .int(now))]).stringify()
        let roomEnv = JSONObject([("v", 3), ("id", "msg-1"), ("iv", "x"), ("ciphertext", "y")])
        let built = try #require(try P4Relay.frame(messageId: "msg-1", refs: ["ref-bob", "ref-carol"], devices: all,
                                                   seal: { try box.seal(roomId: roomId, id: "msg-1", payloadJson: json, recipientPk: $0.pk, recipient: $0.bundle, sacc: nil, now: now) },
                                                   roomEnvelope: { roomEnv }, mention: ["ref-carol"]))
        let frame = built.frame
        #expect(frame.string("type") == "relay")
        #expect(frame.array("to")?.count == 2)
        let set = frame.object("per")!.object("ref-bob")!
        #expect(set.string("kind") == "mb-set" && set.array("items")?.count == 2)
        #expect(!frame.object("per")!.has("ref-carol"))
        #expect(frame.object("envelope") == roomEnv)
        #expect(frame.array("mention")?.first?.stringValue == "ref-carol")
        #expect(built.sealed == ["ref-bob"])
        let s1 = MemoryMailboxStore()
        s1.put(k1)
        let o = try #require(try Mailbox(store: s1, signer: IdentitySigner(bob1)).open(set, roomId: roomId, now: now))
        #expect(o.payload.string("text") == "for later" && o.spk == me.publicKey)
        let noFallback = try #require(try P4Relay.frame(messageId: "msg-1", refs: ["ref-bob", "ref-carol"], devices: all,
                                                        seal: { try box.seal(roomId: roomId, id: "msg-1", payloadJson: json, recipientPk: $0.pk, recipient: $0.bundle, sacc: nil, now: now) },
                                                        roomEnvelope: { nil }, mention: nil))
        #expect(noFallback.frame.array("to")?.count == 1 && !noFallback.frame.has("envelope"))
        var pinned = P4Relay()
        pinned.onKeyBundles(JSONObject([("ref", "ref-bob"), ("devices", .array(devices))]), now: now)
        #expect(pinned.devices("ref-bob", pinnedApk: Prim.b64(Bytes(repeating: 0, count: 32)), remembered: [], ktOn: false, now: now).isEmpty)
        #expect(pinned.devices("ref-bob", pinnedApk: "", remembered: [], ktOn: false, now: now).isEmpty)
    }

    @Test func hubProofFromTheRoomKeys() throws {
        let keys = try RoomKeys.derive(room: "proof-room", passphrase: "a passphrase", memoryKiB: 64, passes: 1)
        let nonce = Prim.b64url(Bytes(repeating: 0, count: 24))
        let proof = try #require(RoomCore.hubProof(keys, nonce: nonce))
        #expect(HubProof.verify(pub: proof.optString("pub"), sig: proof.optString("sig"), roomId: keys.roomId, nonce: nonce))
        let again = try RoomKeys.derive(room: "proof-room", passphrase: "a passphrase", memoryKiB: 64, passes: 1)
        #expect(RoomCore.hubProof(again, nonce: nonce)?.string("pub") == proof.string("pub"))
        #expect(RoomCore.hubProof(keys, nonce: "") == nil)
    }

    @Test func accountKeyIsTheWebsOne() throws {
        let root = (0..<32).map { UInt8(truncatingIfNeeded: $0 * 3 + 1) }
        let seed = AccountKeys.accountSeed(root: root)
        #expect(Prim.b64(seed) == "yNIp/cOZHnL7VzZuTTBrZ3jAUMEv+MwMCyocab4D+1M=")
        #expect(Prim.b64(try Prim.ed25519Public(seed)) == "WKVhp7dubTZvwu6+N52As3eDfiQanV4o9bnmFpe70WM=")
        #expect(try AccountKeys.accountKey(root: root) == "WKVhp7dubTZvwu6+N52As3eDfiQanV4o9bnmFpe70WM=")
    }

    @Test func oldEnvelopeVersionsAreNotOpened() throws {
        let keys = try RoomKeys.derive(room: "v2-room", passphrase: "pass", memoryKiB: 64, passes: 1)
        let me = ChatIdentity.generate()
        let v3 = try Envelopes.sealMessage(keys, id: "id-1", payload: JSONObject([("id", "id-1"), ("text", "x")]), identity: me)
        #expect(try Envelopes.openMessage(keys, v3).payload.string("id") == "id-1")
        for v in [1, 2] { #expect(throws: (any Error).self) { try Envelopes.openMessage(keys, v3.with("v", .int(v))) } }
    }

    @Test func deviceCertificateV1AndMentions() throws {
        var seed = Bytes(repeating: 0, count: 32)
        seed[0] = 1
        let apk = Prim.b64(try Prim.ed25519Public(seed))
        let device = ChatIdentity.generate().publicKey
        let cert = try Handshake.certifyDeviceV1(accountSeed: seed, devicePk: device)
        #expect(Handshake.verifyDeviceCertV1(apk, cert, device))
        #expect(!Handshake.verifyDeviceCertV1(apk, cert, ChatIdentity.generate().publicKey))
        #expect(Ec.kid(device).count == 16)
        #expect(RoomCore.mentionNames("hi @alice and @Bob_2!") == ["alice", "Bob_2"])
        #expect(P4Room.isRoomEnvelope(JSONObject([("v", 4), ("id", "a"), ("sk", "k"), ("n", 0), ("c", "x"), ("s", "y")])))
        #expect(!P4Room.isRoomEnvelope(JSONObject([("v", 3), ("id", "a"), ("sk", "k"), ("n", 0)])))
        #expect(!P4Room.isRoomEnvelope(JSONObject([("kind", "p4"), ("v", 4), ("sk", "k"), ("s", "y")])))
    }

    @Test func deviceCertificateRenewalAndUpload() async throws {
        let store = P4Store(backend: MemoryRecordVault())
        let clock = ManualClock(1_800_000_000_000)
        let seed = Bytes(repeating: 7, count: 32)
        let device = P4Device(store: store, origin: "https://chat.example.org", account: TestAccount("bob", seed: seed), clock: clock)
        let id = ChatIdentity.generate()
        let acc = try #require(device.account(id))
        #expect(Handshake.verifyAccount(.object(acc), pk: id.publicKey, now: clock.now())?.valid == true)
        #expect(device.myAccountKey(id) == acc.string("apk"))
        // The same certificate until a third of its lifetime is left.
        clock.advance(P4.deviceCertLifetimeMs / 2)
        #expect(device.account(id)?.int64("exp") == acc.int64("exp"))
        clock.advance(P4.deviceCertLifetimeMs / 3)
        #expect(device.account(id)?.int64("exp") != acc.int64("exp"))
        let up = try #require(device.uploadBody(id, unlocked: true))
        #expect(up.body.object("cert")?.int64("v") == 2 && up.body.object("bundle") != nil)
        device.uploaded(up.mark)
        #expect(device.uploadBody(id, unlocked: true) == nil)
        #expect(await device.ktOn() == false)
    }
}

@Suite struct Review612Tests {
    static let day: Int64 = 24 * 3600_000
    static let room = "r3.review612Room"

    /// A device certified (v2) by account `accountSeed`, with a mailbox bundle made at `at`.
    struct Certified {
        let dev = ChatIdentity.generate()
        let seed: Bytes
        let apk: String
        let keys: Mailbox.Keys
        let acc: JSONObject
        let directory: JSON
        init(_ accountSeed: UInt8, _ at: Int64) throws {
            seed = Bytes(repeating: accountSeed, count: 32)
            apk = Prim.b64(try Prim.ed25519Public(seed))
            keys = try Mailbox.createBundle(IdentitySigner(dev), at, SystemRng())
            let exp = at + P4.deviceCertLifetimeMs - 1000
            let cert = try Handshake.certifyDeviceV2(accountSeed: seed, devicePk: dev.publicKey, exp: exp, now: at)
            acc = JSONObject([("apk", .string(apk)), ("ac", cert["sig"]!), ("cv", 2), ("exp", .int(exp))])
            directory = .object(JSONObject([("pk", .string(dev.publicKey)), ("apk", .string(apk)), ("cert", .object(cert)), ("bundle", .object(keys.bundle.json))]))
        }
        func opens(_ frame: JSONObject, _ ref: String, _ now: Int64) throws -> Bool {
            guard let item = frame.object("per")?.object(ref) else { return false }
            let s = MemoryMailboxStore()
            s.put(keys)
            return try Mailbox(store: s, signer: IdentitySigner(dev)).open(item, roomId: Review612Tests.room, now: now) != nil
        }
    }

    static func frameFor(_ relay: P4Relay, _ store: P4Store, _ ref: String, ktOn: Bool, _ now: Int64) throws -> JSONObject {
        let all = [ref: relay.devices(ref, pinnedApk: store.refAccount(ref), remembered: store.devicesOfRef(ref), ktOn: ktOn, now: now)]
        let box = Mailbox(store: MemoryMailboxStore(), signer: IdentitySigner(ChatIdentity.generate()))
        let json = JSONObject([("id", "away-1"), ("text", "for the member only"), ("createdAt", .int(now))]).stringify()
        let roomEnv = JSONObject([("v", 3), ("id", "away-1"), ("iv", "x"), ("ciphertext", "y")])
        return try P4Relay.frame(messageId: "away-1", refs: [ref], devices: all,
                                 seal: { try box.seal(roomId: room, id: "away-1", payloadJson: json, recipientPk: $0.pk, recipient: $0.bundle, sacc: nil, now: now) },
                                 roomEnvelope: { roomEnv }, mention: nil)!.frame
    }

    @Test func p01_aPinnedMembersExpiredBundleDoesNotLetTheServerChooseTheDevice() throws {
        let now = SystemClock().now()
        let bob = try Certified(0x0b, now - 8 * Self.day)
        let store = P4Store(backend: MemoryRecordVault())
        #expect(store.pinRef("ref-bob", bob.apk) == "new")
        store.rememberDevice(roomId: Self.room, pk: bob.dev.publicKey, bundle: bob.keys.bundle, acc: bob.acc, accApk: bob.apk, ref: "ref-bob")
        #expect(bob.keys.bundle.exp < now)
        #expect(store.refAccount("ref-bob") == bob.apk)
        let server = try Certified(0x5e, now)
        var relay = P4Relay()
        relay.onKeyBundles(JSONObject([("ref", "ref-bob"), ("devices", .array([server.directory]))]), now: now)
        let frame = try Self.frameFor(relay, store, "ref-bob", ktOn: false, now)
        #expect(try !server.opens(frame, "ref-bob", now))
        #expect(!frame.has("per") && frame.has("envelope"))
    }

    @Test func p01_aDevicePlantedBehindAMembersReferenceIsNotSealedTo() throws {
        let now = SystemClock().now()
        let bob = try Certified(0x0b, now), planted = try Certified(0x5e, now), planted2 = try Certified(0x5f, now)
        let store = P4Store(backend: MemoryRecordVault())
        _ = store.pinRef("ref-bob", bob.apk)
        store.rememberDevice(roomId: Self.room, pk: bob.dev.publicKey, bundle: bob.keys.bundle, acc: bob.acc, accApk: bob.apk, ref: "ref-bob")
        store.rememberDevice(roomId: "r3.otherRoom", pk: planted.dev.publicKey, bundle: planted.keys.bundle, acc: nil, accApk: nil, ref: "ref-bob")
        store.rememberDevice(roomId: "r3.third", pk: planted2.dev.publicKey, bundle: planted2.keys.bundle, acc: planted2.acc, accApk: planted2.apk, ref: "ref-bob")
        #expect(store.devicesOfRef("ref-bob").count == 1)
        store.updateBundle(planted.dev.publicKey, planted.keys.bundle)
        #expect(store.devicesOfRef("ref-bob").count == 1)
        let frame = try Self.frameFor(P4Relay(), store, "ref-bob", ktOn: false, now)
        #expect(try bob.opens(frame, "ref-bob", now))
        #expect(try !planted.opens(frame, "ref-bob", now))
        #expect(Mailbox.isItem(frame.object("per")?["ref-bob"]))
    }

    @Test func p01_aNeverMetMemberGetsTheRoomEnvelope() throws {
        let now = SystemClock().now()
        let server = try Certified(0x5e, now)
        var relay = P4Relay()
        relay.onKeyBundles(JSONObject([("ref", "ref-carol"), ("devices", .array([server.directory]))]), now: now)
        let frame = try Self.frameFor(relay, P4Store(backend: MemoryRecordVault()), "ref-carol", ktOn: false, now)
        #expect(try !server.opens(frame, "ref-carol", now))
        #expect(frame.has("envelope"))
    }

    /// A lookup of these entries, verified against a log of exactly them.
    static func checked(_ entries: [JSONObject]) throws -> Kt.Checked {
        var seed = Bytes(repeating: 0, count: 32)
        seed[0] = 0x17
        let key = Prim.b64(try Prim.ed25519Public(seed))
        let leaves = try entries.map { try Kt.entryLeafHash(.object($0)) }
        let sth = try Kt.signSth(seed, Int64(entries.count), Merkle.treeHash(leaves, 0, entries.count), 1)
        let items: [JSON] = entries.enumerated().map { i, e in
            .object(JSONObject([("entry", .object(e)), ("index", .int(i)), ("proof", .array(Merkle.inclusionProof(leaves, i, entries.count).map { .string(Prim.b64($0)) }))]))
        }
        let c = Kt.verifyLookup(.object(JSONObject([("sth", .object(sth)), ("entries", .array(items))])), key, nil)
        #expect(c.ok, "\(c.why ?? "")")
        return c
    }

    @Test func p01_directoryDevicesOfThePinnedAccountNeedKeyTransparency() throws {
        let now = SystemClock().now()
        let bob = try Certified(0x0b, now)
        let store = P4Store(backend: MemoryRecordVault())
        _ = store.pinRef("ref-bob", bob.apk)
        var relay = P4Relay()
        relay.onKeyBundles(JSONObject([("ref", "ref-bob"), ("devices", .array([bob.directory]))]), now: now)
        #expect(try bob.opens(Self.frameFor(relay, store, "ref-bob", ktOn: false, now), "ref-bob", now))
        #expect(try !bob.opens(Self.frameFor(relay, store, "ref-bob", ktOn: true, now), "ref-bob", now))
        relay.onKt("ref-bob", nil, now: now)
        #expect(relay.ktStatus("ref-bob", apk: bob.apk, dpk: bob.dev.publicKey, now: now) == "unverified")
        #expect(try !bob.opens(Self.frameFor(relay, store, "ref-bob", ktOn: true, now), "ref-bob", now))
        let u = Kt.user("bob")
        var entries = [JSONObject([("t", "acct"), ("u", .string(u)), ("apk", .string(bob.apk)), ("ts", 1)]),
                       JSONObject([("t", "dev"), ("u", .string(u)), ("apk", .string(bob.apk)), ("dpk", .string(bob.dev.publicKey)), ("exp", .int(now + Self.day)), ("ts", 2)])]
        relay.onKt("ref-bob", try Self.checked(entries), now: now)
        #expect(relay.ktStatus("ref-bob", apk: bob.apk, dpk: bob.dev.publicKey, now: now) == "ok")
        #expect(try bob.opens(Self.frameFor(relay, store, "ref-bob", ktOn: true, now), "ref-bob", now))
        entries.append(JSONObject([("t", "rev"), ("u", .string(u)), ("apk", .string(bob.apk)), ("dpk", .string(bob.dev.publicKey)), ("ts", 3)]))
        relay.onKt("ref-bob", try Self.checked(entries), now: now)
        #expect(relay.ktStatus("ref-bob", apk: bob.apk, dpk: bob.dev.publicKey, now: now) == "revoked")
        #expect(try !bob.opens(Self.frameFor(relay, store, "ref-bob", ktOn: false, now), "ref-bob", now))
    }

    @Test func p01_aDeviceStaysUnderTheReferenceItWasFirstSeenWith() throws {
        let now = SystemClock().now()
        let bob = try Certified(0x0b, now)
        let store = P4Store(backend: MemoryRecordVault())
        store.rememberDevice(roomId: Self.room, pk: bob.dev.publicKey, bundle: bob.keys.bundle, acc: bob.acc, accApk: bob.apk, ref: "ref-bob")
        store.rememberDevice(roomId: Self.room, pk: bob.dev.publicKey, bundle: bob.keys.bundle, acc: bob.acc, accApk: bob.apk, ref: "ref-mallory")
        #expect(store.devicesOfRef("ref-bob").count == 1)
        #expect(store.devicesOfRef("ref-mallory").isEmpty)
        store.rememberDevice(roomId: "r3.room2", pk: bob.dev.publicKey, bundle: bob.keys.bundle, acc: bob.acc, accApk: bob.apk, ref: "ref-bob-2")
        #expect(store.devicesOfRef("ref-bob-2").count == 1)
        #expect(store.pinRef("ref-bob", bob.apk) == "new")
        #expect(store.pinRef("ref-bob", bob.apk) == "match")
        let zero = Prim.b64(Bytes(repeating: 0, count: 32))
        #expect(store.pinRef("ref-bob", zero) == "changed")
        #expect(store.refAccount("ref-bob") == bob.apk)
        store.repinRef("ref-bob", zero)
        #expect(store.refAccount("ref-bob") == zero)
    }

    @Test func p03_noRoomKeyForPrivateMessagesOrADeviceThatSpokeProtocol4() {
        #expect(RoomCore.envelopeFor(v4: true, priv: true, hasPair: false, p4Seen: true) == "p4")
        #expect(RoomCore.envelopeFor(v4: true, priv: false, hasPair: true, p4Seen: true) == "p4")
        #expect(RoomCore.envelopeFor(v4: false, priv: true, hasPair: true, p4Seen: false) == "pair")
        #expect(RoomCore.envelopeFor(v4: false, priv: false, hasPair: true, p4Seen: false) == "sender-key")
        #expect(RoomCore.envelopeFor(v4: false, priv: false, hasPair: false, p4Seen: false) == "room")
        #expect(RoomCore.envelopeFor(v4: false, priv: true, hasPair: false, p4Seen: false) == "none")
        #expect(RoomCore.envelopeFor(v4: false, priv: false, hasPair: false, p4Seen: true) == "none")
    }

    @Test func p04_anAttestedDeviceIsAccountOrVerifiedOnlyWithKeyTransparency() {
        func t(_ dv: Bool, _ av: Bool, _ rev: Bool, _ kt: Bool, _ pin: String = "match") -> String {
            Trust.of(attested: true, accountPin: pin, namePin: "match", deviceVerified: dv, accountVerified: av, ktRevoked: rev, ktConfirmed: kt)
        }
        #expect(t(false, false, false, true) == Trust.account)
        #expect(t(false, false, false, false) == Trust.new)
        #expect(t(false, true, false, false) == Trust.new)
        #expect(t(true, false, false, false) == Trust.verified)
        #expect(t(false, false, false, false, "changed") == Trust.changed)
        #expect(t(false, true, true, true) == Trust.changed)
        #expect(t(false, true, false, true) == Trust.verified)
    }

    @Test func p04_aPeersDeviceAgainstItsLookupAndOwnEntries() throws {
        let now = SystemClock().now()
        let u = Kt.user("bob"), apk = Prim.b64(Bytes(repeating: 0, count: 32)), other = Prim.b64(Prim.H([9]))
        let pk = ChatIdentity.generate().publicKey
        var entries = [JSONObject([("t", "acct"), ("u", .string(u)), ("apk", .string(apk)), ("ts", 1)])]
        #expect(RoomCore.ktState(try Self.checked(entries), apk: apk, pk: pk, now: now) == "missing")
        entries.append(JSONObject([("t", "dev"), ("u", .string(u)), ("apk", .string(apk)), ("dpk", .string(pk)), ("exp", .int(now + Self.day)), ("ts", 2)]))
        let ok = try Self.checked(entries)
        #expect(RoomCore.ktState(ok, apk: apk, pk: pk, now: now) == "ok")
        #expect(RoomCore.ktState(nil, apk: apk, pk: pk, now: now) == "unverifiable")
        entries.append(JSONObject([("t", "acct"), ("u", .string(u)), ("apk", .string(other)), ("ts", 3)]))
        #expect(RoomCore.ktState(try Self.checked(entries), apk: apk, pk: pk, now: now) == "revoked")
        #expect(RoomCore.userShown(ok.entries, "bob"))
        #expect(!RoomCore.userShown(ok.entries, "alice"))

        let me = Kt.user("me"), mine = ChatIdentity.generate().publicKey, laptop = ChatIdentity.generate().publicKey, added = ChatIdentity.generate().publicKey
        var log = [JSONObject([("t", "acct"), ("u", .string(me)), ("apk", .string(apk)), ("ts", 1)]),
                   JSONObject([("t", "dev"), ("u", .string(me)), ("apk", .string(apk)), ("dpk", .string(laptop)), ("exp", .int(now + Self.day)), ("ts", 2)]),
                   JSONObject([("t", "dev"), ("u", .string(me)), ("apk", .string(apk)), ("dpk", .string(mine)), ("exp", .int(now + Self.day)), ("ts", 3)])]
        let one = P4Device.ownCheck(JSONObject(), u: me, entries: try Self.checked(log).entries, apk: apk, myPk: mine, now: now)
        #expect(one.unknown == 0 && !one.accountChanged)
        log.append(JSONObject([("t", "dev"), ("u", .string(me)), ("apk", .string(apk)), ("dpk", .string(added)), ("exp", .int(now + Self.day)), ("ts", 4)]))
        let two = P4Device.ownCheck(one.state, u: me, entries: try Self.checked(log).entries, apk: apk, myPk: mine, now: now)
        #expect(two.unknown == 1)
        #expect(two.state.array("pending")?.first?.stringValue == added)
        log.append(JSONObject([("t", "rev"), ("u", .string(me)), ("apk", .string(apk)), ("dpk", .string(added)), ("ts", 5)]))
        log.append(JSONObject([("t", "acct"), ("u", .string(me)), ("apk", .string(Prim.b64(Prim.H([1])))), ("ts", 6)]))
        let three = P4Device.ownCheck(two.state, u: me, entries: try Self.checked(log).entries, apk: apk, myPk: mine, now: now)
        #expect(three.unknown == 0 && three.accountChanged)
    }

    @Test func p08_aVerifiedAccountIsVerifiedUnderTheNameItWasVerifiedUnder() {
        let store = P4Store(backend: MemoryRecordVault())
        let apk = Prim.b64(Bytes(repeating: 0, count: 32))
        _ = store.pinAccount(apk, devicePk: ChatIdentity.generate().publicKey, username: "mallory")
        store.setAccountVerified(apk, true, name: "Mallory")
        #expect(store.accountVerifiedName(apk) == "Mallory")
        #expect(Trust.verifiedUnder(store.accountVerifiedName(apk), "mallory "))
        #expect(!Trust.verifiedUnder(store.accountVerifiedName(apk), "Alice"))
        let accVerified = store.accountVerified(apk) && Trust.verifiedUnder(store.accountVerifiedName(apk), "Alice")
        #expect(Trust.of(attested: true, accountPin: "match", namePin: "new", deviceVerified: false, accountVerified: accVerified, ktRevoked: false, ktConfirmed: true) == Trust.account)
        store.setAccountVerified(apk, false)
        #expect(store.accountVerifiedName(apk) == "")
        #expect(Trust.verifiedUnder("", "anyone"))
    }

    func m(_ id: String, _ senderId: String, _ name: String, _ text: String, _ kid: String) -> ChatMessage {
        var x = ChatMessage()
        x.id = id; x.senderId = senderId; x.senderName = name; x.text = text; x.senderKid = kid
        return x
    }

    @Test func p09_aForwardIsVerifiedByTheKeyNotTheName() {
        let bobKid = "bob-kid-000000000", malKid = "mal-kid-000000000"
        var fwd = m("f1", "p-mallory", "Mallory", "pay 100 to X", malKid)
        fwd.forwardedFrom = "Bob"
        #expect(!Verified.forward(fwd, [m("m1", "p-mallory-2", "Bob", "pay 100 to X", malKid), fwd], pinnedKid: bobKid, myName: "Me"))
        var held = m("m2", "p-bob", "Bob", "pay 100 to X", bobKid)
        held.changed = true
        #expect(!Verified.forward(fwd, [held, fwd], pinnedKid: bobKid, myName: "Me"))
        #expect(!Verified.forward(fwd, [m("m3", "p-mallory", "Bob", "pay 100 to X", bobKid), fwd], pinnedKid: bobKid, myName: "Me"))
        #expect(Verified.forward(fwd, [m("m4", "p-bob", "Bob", "pay 100 to X", bobKid), fwd], pinnedKid: bobKid, myName: "Me"))
        var mine = m("m5", "p-me", "Me", "pay 100 to X", "")
        mine.mine = true
        var fwdMe = m("f2", "p-mallory", "Mallory", "pay 100 to X", malKid)
        fwdMe.forwardedFrom = "Me"
        #expect(Verified.forward(fwdMe, [mine, fwdMe], pinnedKid: "", myName: "Me"))
    }

    @Test func p10_theReplayWindowFailsClosedOnAReadError() {
        let backend = MemoryRecordVault()
        let now = SystemClock().now()
        let store = P4Store(backend: backend)
        let window = store.replay(Self.room)
        _ = ReplayGuard(store: window, pruneEvery: 0).check(Self.room, "m1", createdAt: now, now: now)
        store.saveReplay(Self.room, window)
        backend.setFailing(true)
        let again = P4Store(backend: backend)
        let standIn = again.replay(Self.room)
        #expect(!standIn.persistent)
        #expect(!again.reloadReplay(Self.room, standIn))
        _ = ReplayGuard(store: standIn, pruneEvery: 0).check(Self.room, "m2", createdAt: now, now: now)
        again.saveReplay(Self.room, standIn)
        backend.setFailing(false)
        #expect(again.reloadReplay(Self.room, standIn))
        #expect(standIn.persistent)
        let g = ReplayGuard(store: standIn, pruneEvery: 0)
        #expect(g.check(Self.room, "m1", createdAt: now, now: now) == "replay")
        #expect(g.check(Self.room, "m2", createdAt: now, now: now) == "replay")
        again.saveReplay(Self.room, standIn)
        let after = ReplayGuard(store: P4Store(backend: backend).replay(Self.room), pruneEvery: 0)
        #expect(after.check(Self.room, "m1", createdAt: now, now: now) == "replay")
        #expect(after.check(Self.room, "m2", createdAt: now, now: now) == "replay")
    }

    @Test func p07_aProxiedFilesKeyOpensFromItsSealedItemAndTheMetaWaitsForIt() throws {
        let now = SystemClock().now()
        let sender = try Certified(0x0c, now), me = try Certified(0x0d, now)
        let tx = "xfer-1f0c8a2e-1111-4222-8333-944455556666"
        var fk = Bytes(repeating: 0, count: 32)
        fk[0] = 42
        let payload = JSONObject([("id", .string(tx)), ("t", "fk"), ("fk", .string(Prim.b64(fk)))]).stringify()
        let item = try Mailbox.seal(roomId: Self.room, id: tx, payloadJson: payload, recipientPk: me.dev.publicKey, recipient: me.keys.bundle,
                                    senderPk: sender.dev.publicKey, sacc: sender.acc, sender: sender.keys, now: now, rng: SystemRng())
        let mine = MemoryMailboxStore()
        mine.put(me.keys)
        let o = try Mailbox(store: mine, signer: IdentitySigner(me.dev)).open(item, roomId: Self.room, now: now)
        #expect(ProxyKeys.fkOf(o, transferId: tx, expectedPk: sender.dev.publicKey) == fk)
        #expect(ProxyKeys.fkOf(o, transferId: tx, expectedPk: nil) == fk)
        #expect(ProxyKeys.fkOf(o, transferId: "xfer-other", expectedPk: nil) == nil)
        #expect(ProxyKeys.fkOf(o, transferId: tx, expectedPk: me.dev.publicKey) == nil)
        let key = try Files4.fileKey(fk, tx)
        let meta = try Files4.sealBody(key, try Files4.metaAad(tx), "{\"transferId\":\"\(tx)\"}", SystemRng())
        #expect(try Files4.openBody(key, try Files4.metaAad(tx), iv: meta.optString("iv"), ciphertext: meta.optString("ciphertext")).contains(tx))

        var keys = ProxyKeys()
        let metaFrame = JSONObject([("kind", "proxy-meta"), ("transferId", .string(tx)), ("v", 4), ("from", "p-sender")])
        do { let v = keys.park(from: "p-sender", transferId: tx, meta: metaFrame) != nil; #expect(v) }
        do { let v = keys.park(from: "p-sender", transferId: tx, meta: metaFrame) == nil; #expect(v) }
        do { let v = keys.park(from: "", transferId: "xfer-2", meta: metaFrame) == nil; #expect(v) }
        let chunk = JSONObject([("kind", "proxy-chunk"), ("transferId", .string(tx)), ("seq", 0)])
        do { let v = keys.queue(tx, .json(chunk)); #expect(v) }
        do { let v = keys.queue(tx, .binary([0x4D, 0x11])); #expect(v) }
        do { let v = !keys.queue("xfer-other", .json(chunk)); #expect(v) }
        do { let v = keys.put(from: "p-mallory", transferId: tx, fk: Bytes(repeating: 0, count: 32), spk: "x") == nil; #expect(v) }
        let frames = keys.put(from: "p-sender", transferId: tx, fk: fk, spk: sender.dev.publicKey)
        #expect(frames == [.json(metaFrame), .json(chunk), .binary([0x4D, 0x11])])
        #expect(!keys.isWaiting(tx))
        do { let v = keys.take(from: "p-sender", transferId: tx)?.spk == sender.dev.publicKey; #expect(v) }
        do { let v = keys.take(from: "p-sender", transferId: tx) == nil; #expect(v) }
        let w = keys.park(from: "p-sender", transferId: "xfer-late", meta: metaFrame)!
        do { let v = keys.expire("xfer-late", token: w.token); #expect(v) }
        do { let v = !keys.expire("xfer-late", token: w.token); #expect(v) }
        do { let v = !keys.queue("xfer-late", .json(chunk)); #expect(v) }
    }

    @Test func s14_aSquattedRoomIsJoinedWithoutTheProofUnlessProofsAreRequired() {
        #expect(RoomCore.proofRefusal(code: "room-proof", legacyAllowed: true, retried: false) == "legacy")
        #expect(RoomCore.proofRefusal(code: "room-proof-required", legacyAllowed: true, retried: false) == "legacy")
        #expect(RoomCore.proofRefusal(code: "room-proof", legacyAllowed: nil, retried: false) == "refuse")
        #expect(RoomCore.proofRefusal(code: "room-proof", legacyAllowed: false, retried: false) == "refuse")
        #expect(RoomCore.proofRefusal(code: "room-proof", legacyAllowed: true, retried: true) == "refuse")
        #expect(RoomCore.proofRefusal(code: "room-proof-required", legacyAllowed: false, retried: false) == "refuse")
        #expect(RoomCore.proofRefusal(code: "room-full", legacyAllowed: nil, retried: false) == "")
    }
}
