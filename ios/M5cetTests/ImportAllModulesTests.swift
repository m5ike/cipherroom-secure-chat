// The six M5Kit modules imported together, with the app: the names they share
// resolve to one declaration each, unqualified — no "ambiguous" errors (Bytes,
// Hex, TagV2, ShareInvite, ConnTag, HubProof, CallTrack). That this file
// compiles is the test; the asserts check each name is the one owner's.
// ios/scripts/check-duplicate-types.sh and M5CoreTests' ModuleNamesTests keep
// two modules from declaring the same public type again.

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5NFC
import M5Net
import M5Proto
import XCTest
@testable import M5cet

final class ImportAllModulesTests: XCTestCase {
    func testTheModulesLinkTogether() {
        XCTAssertEqual(AppInfo.modules, [M5CoreModule.name, M5CryptoModule.name, M5ProtoModule.name, M5NetModule.name, M5DesignModule.name, M5NFCModule.name])
    }

    /// `Bytes` is M5Core's alias of [UInt8]; its helpers (M5Core, SHA-256 / random for Data from M5Crypto) and `Hex`.
    func testBytesAndHex() {
        let b: Bytes = Bytes.u8(0x00, 0xA4, 0x1FF)
        XCTAssertEqual(b, [0x00, 0xA4, 0xFF])
        XCTAssertEqual(Bytes.slice(b, 1), [0xA4, 0xFF])
        XCTAssertEqual(Bytes.concat(b, [1]), [0x00, 0xA4, 0xFF, 0x01])
        XCTAssertEqual(Hex.encode(b), "00a4ff")
        XCTAssertEqual(Hex.upper(b), "00A4FF")
        XCTAssertEqual(Hex.decode("00a4FF"), b)
        XCTAssertEqual(Hex.decodeLenient("0x00 A4 ff"), b)
        XCTAssertEqual(Bytes.b64(Data(b)), "AKT/")
        XCTAssertEqual(Bytes.unb64("AKT/"), Data(b))
        XCTAssertEqual(Bytes.hex(Data(b)), "00a4ff")
        XCTAssertEqual(Bytes.sha256("").count, 32)
        XCTAssertEqual(Bytes.random(16).count, 16)
    }

    /// The NFC connection tag's format and crypto are M5Crypto's (`TagV2`, `ShareInvite`, `ConnTag`); M5NFC's
    /// `NfcTagV2` / `NfcShareInvite` / `NfcConnTag` are its face with the KDF and HTTP seams.
    func testTheTagNamesAreM5Cryptos() async throws {
        XCTAssertEqual(TagV2.format("ABCDEFGHJK"), "ABCDE-FGHJK")
        XCTAssertEqual(NfcTagV2.prefix, TagV2.prefix)
        let invite = try TagV2.newInvite("https://chat.example.org/")
        XCTAssertEqual(try TagV2.parse(TagV2.serialize(invite)), invite)
        let id = "QEFCQ0RFRkdISUpLTE1OTw"
        let keys = try TagV2.inviteKeys(id: id, k: "0123456789ABCDEFGHJKMNPQRS")
        XCTAssertEqual(keys.code, "752592939447")
        XCTAssertEqual(ShareInvite.proof(code: keys.code, id: id), "-CygMqG2SOyIRHk4g4XR2HWNgzHOjNePieK-7EJxSpU")
        XCTAssertEqual(try NfcShareInvite.proof(code: keys.code, id: id), ShareInvite.proof(code: keys.code, id: id))
        let read: ConnTag.Read = await ConnTag.open(TagV2.serialize(invite), secret: "", trustedOrigin: "https://chat.example.org", redeem: nil)
        XCTAssertEqual(read.format, "v2-inv")
        XCTAssertEqual(read.need, "redeem")
        XCTAssertEqual(read.json.optString("need"), "redeem")
    }

    /// The hub proof's bytes are M5Crypto's `HubProof`; M5Net's `HubProofFrames` puts them in the join frame.
    func testHubProofIsM5Cryptos() async throws {
        let seed = Bytes(repeating: 7, count: 32)
        let nonce = B64.url(Bytes(repeating: 1, count: 24))
        let proof = try HubProof.build(seed: seed, roomId: "r3.room", nonce: nonce)
        let built = await HubProofFrames.build(signer: HubSeedSigner(seed: seed), roomId: "r3.room", nonce: nonce)
        let frame = try XCTUnwrap(built)
        XCTAssertEqual(frame.pub, proof.string("pub"))
        XCTAssertEqual(frame.sig, proof.string("sig"))
        XCTAssertTrue(HubProof.verify(pub: frame.pub, sig: frame.sig, roomId: "r3.room", nonce: nonce))
    }

    /// `CallTrack` is M5Proto's; the app's name for it is the same type.
    func testCallTrackIsM5Protos() {
        var track = CallTrack()
        _ = track.update(now: 1_000, meOn: true, myVideo: false, live: [], peerVideo: false)
        let step = track.update(now: 3_000, meOn: false, myVideo: false, live: [], peerVideo: false)
        XCTAssertEqual(step.records, [CallTrack.Record(kind: .outgoing, at: 1_000, seconds: 2, video: false, people: [])])
        let same: M5Proto.CallTrack = track
        XCTAssertFalse(same.ringing)
        XCTAssertEqual(CallHistory.Entry.of(id: "x", roomKey: "k", room: "R", step.records[0]).kind, CallTrack.out)
    }
}
