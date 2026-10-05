// The signals' JSON (what the room session seals) and the data channel's frames.

import XCTest
@testable import M5cet

final class RtcWireTests: XCTestCase {
    func testDescriptionsRoundTripAsTheWebSendsThem() throws {
        let offer = RtcSignal.description(type: .offer, sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n")
        XCTAssertEqual(RtcSignal(jsonData: offer.jsonData), offer)
        XCTAssertEqual(offer.json["type"] as? String, "offer")
        // RTCSessionDescription.toJSON() of a browser.
        let web = RtcSignal(json: ["type": "answer", "sdp": "v=0\r\n"])
        XCTAssertEqual(web, .description(type: .answer, sdp: "v=0\r\n"))
    }

    func testCandidatesAsTheWebAndAndroidSendThem() {
        // RTCIceCandidate.toJSON() (with usernameFragment) and Android's Peer (no fragment).
        let web = RtcSignal(json: ["candidate": "candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host", "sdpMid": "0",
                                   "sdpMLineIndex": 0, "usernameFragment": "abcd"])
        XCTAssertEqual(web, .candidate(candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host", sdpMid: "0", sdpMLineIndex: 0))
        let noMid = RtcSignal(json: ["candidate": "candidate:2 1 udp 1 192.0.2.2 1 typ host"])
        XCTAssertEqual(noMid, .candidate(candidate: "candidate:2 1 udp 1 192.0.2.2 1 typ host", sdpMid: "0", sdpMLineIndex: 0),
                       "Android reads a missing mid as 0")
        let c = RtcSignal.candidate(candidate: "candidate:x", sdpMid: "1", sdpMLineIndex: 1)
        XCTAssertEqual(RtcSignal(jsonData: c.jsonData), c)
        XCTAssertEqual(c.json["sdpMLineIndex"] as? Int, 1)
    }

    func testJunkIsNoSignal() {
        XCTAssertNil(RtcSignal(json: ["candidate": ""]), "end of candidates")
        XCTAssertNil(RtcSignal(json: ["type": "rollback", "sdp": ""]))
        XCTAssertNil(RtcSignal(json: ["type": "offer"]), "an offer without SDP")
        XCTAssertNil(RtcSignal(json: ["p4": "fk", "transferId": "t"]), "a file key is the room session's")
        XCTAssertNil(RtcSignal(jsonData: Data("[1,2]".utf8)))
    }

    func testFramesKeepTextAndBinaryApart() {
        let text = RtcDataFrame.text(#"{"type":"hello","caps":["bin"]}"#)
        XCTAssertEqual(text.wire.isBinary, false)
        XCTAssertEqual(RtcDataFrame(data: text.wire.data, isBinary: false), text)
        var chunk = Data(count: 32_768 + 64)
        for i in chunk.indices { chunk[i] = UInt8(truncatingIfNeeded: i &* 31) }
        let binary = RtcDataFrame.binary(chunk)
        XCTAssertEqual(binary.wire.isBinary, true)
        XCTAssertEqual(binary.byteCount, 32_832)
        XCTAssertEqual(RtcDataFrame(data: chunk, isBinary: true), binary)
        XCTAssertNil(RtcDataFrame(data: Data([0xC3, 0x28]), isBinary: false), "a text frame that is not UTF-8")
        XCTAssertEqual(RtcDataFrame(data: Data("čau 👋".utf8), isBinary: false), .text("čau 👋"))
        XCTAssertEqual(RtcChannelSpec.label, "m5cet")
        XCTAssertTrue(RtcChannelSpec.ordered)
        XCTAssertEqual(RtcChannelSpec.highWater, 1_048_576)
    }
}
