// What goes over the wire around a peer connection, as plain values:
//
//  * RtcSignal — the WebRTC signals between two peers (an SDP description or
//    an ICE candidate). The room session seals each one (Envelopes.sealSignal)
//    into the hub's {type:"signal", target, payload:{sealed}} and opens the
//    ones that come; this file only says what is inside: {type, sdp} or
//    {candidate, sdpMid, sdpMLineIndex} — the JSON the web (RTCSessionDescription /
//    RTCIceCandidate .toJSON()) and Android (rtc/Peer.java) send.
//  * RtcDataFrame — one message of the ordered, reliable data channel "m5cet":
//    text (UTF-8 JSON of the chat protocol) or binary (file chunks to peers that
//    announced "bin"). The room session encodes and decodes the frames.

import Foundation

enum RtcSignal: Equatable, Sendable {
    enum SdpType: String, Sendable { case offer, answer }

    case description(type: SdpType, sdp: String)
    case candidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int32)

    /// A signal's JSON as the room session opened it; nil for anything else (an end-of-candidates
    /// marker with an empty candidate, a rollback, junk).
    init?(json d: [String: Any]) {
        let type = CallJSON.string(d["type"])
        if let t = SdpType(rawValue: type) {
            guard let sdp = d["sdp"] as? String, !sdp.isEmpty else { return nil }
            self = .description(type: t, sdp: sdp)
            return
        }
        let candidate = CallJSON.string(d["candidate"])
        guard !candidate.isEmpty else { return nil }
        let mid = d["sdpMid"] as? String
        let index = Int32(clamping: CallJSON.int64(d["sdpMLineIndex"]))
        // Android reads a missing mid as "0", a missing index as 0 (Peer.onSignal).
        self = .candidate(candidate: candidate, sdpMid: mid ?? "0", sdpMLineIndex: index)
    }

    init?(jsonData: Data) {
        guard let o = (try? JSONSerialization.jsonObject(with: jsonData)) as? [String: Any] else { return nil }
        self.init(json: o)
    }

    var json: [String: Any] {
        switch self {
        case let .description(type, sdp): return ["type": type.rawValue, "sdp": sdp]
        case let .candidate(candidate, mid, index):
            var o: [String: Any] = ["candidate": candidate, "sdpMLineIndex": Int(index)]
            o["sdpMid"] = mid ?? "0"
            return o
        }
    }

    var jsonData: Data { (try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])) ?? Data() }
}

enum RtcDataFrame: Equatable, Sendable {
    case text(String)
    case binary(Data)

    /// A data channel message; nil for a text frame that is not UTF-8 (dropped, as a browser would fail it).
    init?(data: Data, isBinary: Bool) {
        if isBinary { self = .binary(data); return }
        guard let s = String(data: data, encoding: .utf8) else { return nil }
        self = .text(s)
    }

    /// The bytes and the binary flag the channel sends.
    var wire: (data: Data, isBinary: Bool) {
        switch self {
        case let .text(s): return (Data(s.utf8), false)
        case let .binary(d): return (d, true)
        }
    }

    var byteCount: Int { wire.data.count }
}

/// The data channel every room uses (the web and Android create the same).
enum RtcChannelSpec {
    static let label = "m5cet"
    static let ordered = true
    /// The sender waits while more than this is buffered (Android Files: 1 MiB, polling every 20 ms, up to 10 s).
    static let highWater: UInt64 = 1_048_576
}
