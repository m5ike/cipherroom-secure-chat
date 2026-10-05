// A peer connection's statistics as People and the call screen read them
// (the shapes libwebrtc reports). Android's RtcStatsTest.

import XCTest
@testable import M5cet

final class RtcStatsTests: XCTestCase {
    private func report(relay: Bool) -> [String: RtcStatsEntry] {
        var all: [String: RtcStatsEntry] = [:]
        all["T01"] = RtcStatsEntry("transport", ["selectedCandidatePairId": .string("CP1"), "dtlsState": .string("connected"),
                                                 "tlsVersion": .string("FEFD"), "srtpCipher": .string("AES_CM_128_HMAC_SHA1_80"),
                                                 "bytesSent": .number(86_220), "bytesReceived": .number(93_800), "remoteCertificateId": .string("CFr")])
        all["CFr"] = RtcStatsEntry("certificate", ["fingerprint": .string("3A:5F:00"), "fingerprintAlgorithm": .string("sha-256")])
        all["CP0"] = RtcStatsEntry("candidate-pair", ["localCandidateId": .string("Lx"), "remoteCandidateId": .string("Rx"),
                                                      "state": .string("failed"), "currentRoundTripTime": .number(0.9)])
        all["CP1"] = RtcStatsEntry("candidate-pair", ["localCandidateId": .string("L1"), "remoteCandidateId": .string("R1"),
                                                      "state": .string("succeeded"), "nominated": .bool(true),
                                                      "currentRoundTripTime": .number(0.0384), "bytesSent": .number(1), "bytesReceived": .number(2)])
        var local: [String: RtcStatValue] = ["candidateType": .string(relay ? "relay" : "host"), "protocol": .string("udp")]
        if relay { local["relayProtocol"] = .string("tls") }
        all["L1"] = RtcStatsEntry("local-candidate", local)
        all["R1"] = RtcStatsEntry("remote-candidate", ["candidateType": .string("srflx"), "address": .string("203.0.113.7"), "port": .number(51234)])
        all["IA"] = RtcStatsEntry("inbound-rtp", ["kind": .string("audio"), "codecId": .string("C111")])
        all["OV"] = RtcStatsEntry("outbound-rtp", ["kind": .string("video"), "codecId": .string("C96")])
        all["C111"] = RtcStatsEntry("codec", ["mimeType": .string("audio/opus")])
        all["C96"] = RtcStatsEntry("codec", ["mimeType": .string("video/VP8")])
        return all
    }

    func testTheSelectedPair() {
        let s = RtcStatsSummary.parse(report(relay: false), now: 7)
        XCTAssertEqual(s.rttMs, 38)
        XCTAssertEqual(s.localType, "host")
        XCTAssertEqual(s.remoteType, "srflx")
        XCTAssertEqual(s.transport, "direct")
        XCTAssertEqual(s.proto, "udp")
        XCTAssertEqual(s.remoteAddress, "203.0.113.7:51234")
        XCTAssertEqual(s.bytesSent, 86_220)
        XCTAssertEqual(s.bytesReceived, 93_800)
        XCTAssertEqual(s.dtlsVersion, "DTLS 1.2")
        XCTAssertEqual(s.srtpCipher, "AES_CM_128_HMAC_SHA1_80")
        XCTAssertEqual(s.dtlsFingerprint, "sha-256 3A:5F:00")
        XCTAssertEqual(s.codecs, "opus · VP8")
        XCTAssertEqual(s.at, 7)
    }

    func testThroughTurn() {
        let s = RtcStatsSummary.parse(report(relay: true), now: 0)
        XCTAssertEqual(s.transport, "relay")
        XCTAssertEqual(s.relayProtocol, "tls")
    }

    func testWithoutTransportStatsTheNominatedWorkingPair() {
        var all = report(relay: false)
        all["T01"] = nil
        let s = RtcStatsSummary.parse(all, now: 0)
        XCTAssertEqual(s.rttMs, 38)
        XCTAssertEqual(s.bytesSent, 1)
        XCTAssertEqual(s.dtlsState, "")
    }

    func testTheAverageWhenNoCurrentRoundTrip() {
        let all = ["CP": RtcStatsEntry("candidate-pair", ["state": .string("succeeded"), "nominated": .bool(true),
                                                          "totalRoundTripTime": .number(0.3), "responsesReceived": .number(3)])]
        XCTAssertEqual(RtcStatsSummary.parse(all, now: 0).rttMs, 100)
    }

    func testNothingYet() {
        let s = RtcStatsSummary.parse([:], now: 0)
        XCTAssertEqual(s.rttMs, -1)
        XCTAssertEqual(s.transport, "")
        XCTAssertEqual(s.dtlsVersion, "")
        XCTAssertEqual(s.codecs, "")
    }

    func testValuesAsWebRTCHandsThem() {
        XCTAssertEqual(RtcStatValue(NSNumber(value: true)), .bool(true))
        XCTAssertEqual(RtcStatValue(NSNumber(value: 51234)), .number(51234))
        XCTAssertEqual(RtcStatValue("host" as NSString), .string("host"))
        XCTAssertNil(RtcStatValue([1, 2] as NSArray))
        XCTAssertEqual(RtcStatsEntry("x", ["port": .number(51234)]).str("port"), "51234")
    }
}
