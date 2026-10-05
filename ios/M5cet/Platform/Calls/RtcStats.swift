// 6.2 People: what a peer connection's statistics (WebRTC getStats) say about
// the link — the round trip of the pair in use, the candidates (direct or
// through TURN), the codecs of a call, the bytes and the DTLS state. Read from
// plain maps (type + members per stats id) so it is testable without WebRTC;
// RtcPeer turns an RTCStatisticsReport into them.
//
// Port of android/app/src/main/java/cz/m5cet/app/contacts/RtcStats.java.

import Foundation

enum RtcStatValue: Equatable, Sendable {
    case number(Double)
    case string(String)
    case bool(Bool)

    /// An RTCStatistics value (NSNumber, NSString; arrays and maps are not read here).
    init?(_ v: Any) {
        switch v {
        case let n as NSNumber where CallJSON.isBool(n): self = .bool(n.boolValue)
        case let n as NSNumber: self = .number(n.doubleValue)
        case let s as String: self = .string(s)
        default: return nil
        }
    }
}

struct RtcStatsEntry: Sendable {
    var type: String
    var members: [String: RtcStatValue]

    init(_ type: String, _ members: [String: RtcStatValue]) { self.type = type; self.members = members }

    func str(_ k: String) -> String {
        switch members[k] {
        case let .string(s): return s
        case let .number(n): return n == n.rounded() ? String(Int64(n)) : String(n)
        case let .bool(b): return b ? "true" : "false"
        case nil: return ""
        }
    }

    func num(_ k: String, _ d: Double) -> Double {
        if case let .number(n) = members[k] { return n }
        return d
    }

    func bool(_ k: String) -> Bool {
        if case let .bool(b) = members[k] { return b }
        return false
    }
}

/// What the People widget, the person's detail and the call screen show.
struct RtcStatsSummary: Equatable, Sendable {
    /// The round trip of the pair in use, ms; -1 when not measured yet.
    var rttMs: Int64 = -1
    /// host / srflx / prflx / relay
    var localType = "", remoteType = ""
    /// udp / tcp (and the relay's own protocol when relayed)
    var proto = "", relayProtocol = ""
    var remoteAddress = ""
    var audioCodec = "", videoCodec = ""
    var bytesSent: Int64 = 0, bytesReceived: Int64 = 0
    var dtlsState = "", srtpCipher = "", tlsVersion = ""
    /// The peer's DTLS certificate fingerprint ("sha-256 AB:CD:…").
    var dtlsFingerprint = ""
    var at: Int64

    /// "direct", "relay" or "" (Presence.transport).
    var transport: String {
        if localType.isEmpty && remoteType.isEmpty { return "" }
        return localType == "relay" || remoteType == "relay" ? "relay" : "direct"
    }

    /// The DTLS version from the stats' hex form ("FEFD" = DTLS 1.2), "" when unknown.
    var dtlsVersion: String {
        switch tlsVersion.uppercased() {
        case "FEFC": return "DTLS 1.3"
        case "FEFD": return "DTLS 1.2"
        case "FEFF": return "DTLS 1.0"
        default: return tlsVersion.isEmpty ? "" : "DTLS " + tlsVersion
        }
    }

    /// The codecs of a call ("opus", "opus · VP8"), "" without one.
    var codecs: String {
        if audioCodec.isEmpty { return videoCodec }
        return videoCodec.isEmpty ? audioCodec : audioCodec + " · " + videoCodec
    }

    static func parse(_ all: [String: RtcStatsEntry], now: Int64) -> RtcStatsSummary {
        var s = RtcStatsSummary(at: now)
        // Sorted ids: the same report gives the same summary (Java's HashMap order is not specified either).
        let ids = all.keys.sorted()
        var transport: RtcStatsEntry?
        for id in ids {
            let e = all[id]!
            if e.type == "transport" && (transport == nil || !e.str("selectedCandidatePairId").isEmpty) { transport = e }
        }
        var pair = transport.flatMap { all[$0.str("selectedCandidatePairId")] }
        if pair == nil {
            // No transport stats: the nominated, working pair (the "selected" flag of older libraries wins).
            for id in ids {
                let e = all[id]!
                guard e.type == "candidate-pair" else { continue }
                let ok = e.bool("selected") || (e.bool("nominated") && e.str("state") == "succeeded")
                if ok && (pair == nil || e.bool("selected")) { pair = e }
            }
        }
        if let pair {
            var rtt = pair.num("currentRoundTripTime", -1)
            if rtt < 0 {
                let total = pair.num("totalRoundTripTime", -1), n = pair.num("responsesReceived", 0)
                if total >= 0 && n > 0 { rtt = total / n }
            }
            if rtt >= 0 { s.rttMs = Int64((rtt * 1000).rounded()) }
            if let local = all[pair.str("localCandidateId")] {
                s.localType = local.str("candidateType")
                s.proto = local.str("protocol")
                s.relayProtocol = local.str("relayProtocol")
            }
            if let remote = all[pair.str("remoteCandidateId")] {
                s.remoteType = remote.str("candidateType")
                let addr = remote.str("address").isEmpty ? remote.str("ip") : remote.str("address")
                let port = remote.num("port", -1)
                s.remoteAddress = addr.isEmpty ? "" : port > 0 ? (addr.contains(":") ? "[\(addr)]" : addr) + ":\(Int64(port))" : addr
            }
            s.bytesSent = Int64(pair.num("bytesSent", 0))
            s.bytesReceived = Int64(pair.num("bytesReceived", 0))
        }
        if let transport {
            s.dtlsState = transport.str("dtlsState")
            s.srtpCipher = transport.str("srtpCipher")
            s.tlsVersion = transport.str("tlsVersion")
            if transport.num("bytesSent", -1) >= 0 { s.bytesSent = Int64(transport.num("bytesSent", 0)) }
            if transport.num("bytesReceived", -1) >= 0 { s.bytesReceived = Int64(transport.num("bytesReceived", 0)) }
            if let cert = all[transport.str("remoteCertificateId")], !cert.str("fingerprint").isEmpty {
                s.dtlsFingerprint = (cert.str("fingerprintAlgorithm") + " " + cert.str("fingerprint")).trimmingCharacters(in: .whitespaces)
            }
        }
        for id in ids {
            let e = all[id]!
            guard e.type == "inbound-rtp" || e.type == "outbound-rtp", let codec = all[e.str("codecId")] else { continue }
            let mime = codec.str("mimeType")
            let name = mime.firstIndex(of: "/").map { String(mime[mime.index(after: $0)...]) } ?? mime
            if name.isEmpty { continue }
            let kind = e.str("kind").isEmpty ? e.str("mediaType") : e.str("kind")
            if kind == "audio" && s.audioCodec.isEmpty { s.audioCodec = name.lowercased() == "opus" ? "opus" : name }
            if kind == "video" && s.videoCodec.isEmpty { s.videoCodec = name }
        }
        return s
    }
}
