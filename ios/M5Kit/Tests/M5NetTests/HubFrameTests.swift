// The hub frame codec against golden frames made by the server's own code
// (fixtures/hub-frames.json, generate-fixtures.ts): every client frame the
// Swift encoder writes is what the hub's parseFrame reads, the frames the hub
// refuses are refused here before they go out, and every frame a live hub
// sent decodes into its typed value.

import Foundation
import Testing
@testable import M5Net

/// A Swift frame built through the public API from a client frame's JSON.
func swiftFrame(_ j: NetJSON) -> HubClientFrame? {
    switch j.str("type") {
    case "join":
        let proof = j.obj("proof").map { HubJoinProof(pub: $0.str("pub"), sig: $0.str("sig")) }
        return .join(HubJoin(room: j.str("room"), name: j.str("name"), peerId: j["peerId"]?.stringValue, resume: j["resume"]?.stringValue,
                             auth: j["auth"]?.stringValue, away: j.bool("away"), features: j.arr("features")?.compactMap(\.stringValue) ?? [],
                             foreground: j["foreground"]?.boolValue, proof: proof, protocolVersion: Int(j.int("protocol", 2))))
    case "auth": return .auth(token: j["token"]?.stringValue, away: j.bool("away"))
    case "leave": return .leave(away: j.bool("away"))
    case "signal": return .signal(target: j.str("target"), payload: j["payload"] ?? .null)
    case "ping": return .ping(t: j.int("t"))
    case "presence": return .presence(away: j.bool("away"), foreground: j["foreground"]?.boolValue)
    case "relay":
        return .relay(HubRelay(messageId: j.str("messageId"), to: j.arr("to")?.compactMap(\.stringValue) ?? [], envelope: j.obj("envelope"),
                               per: j.obj("per")?.objectValue, expiresAt: j["expiresAt"]?.int64Value, mention: j.arr("mention")?.compactMap(\.stringValue),
                               call: j.bool("call")))
    case "relay-ack": return .relayAck(ids: j.arr("ids")?.compactMap(\.stringValue) ?? [])
    case "receipt": return .receipt(messageIds: j.arr("messageIds")?.compactMap(\.stringValue) ?? [], state: HubReceiptState(rawValue: j.str("state")) ?? .read)
    case "command-poll": return .commandPoll(deviceId: j.str("deviceId"))
    case "command-ack": return .commandAck(commandId: j.str("commandId"), result: j["result"]?.stringValue)
    case "storage": return .storage(id: j.str("id"), op: j.str("op"), payload: j["payload"] ?? .object([:]), auth: j["auth"]?.stringValue, session: j["session"]?.stringValue)
    case "proxy-meta": return .proxyMeta(transferId: j.str("transferId"), iv: j.str("iv"), ciphertext: j.str("ciphertext"), v: j["v"]?.intValue)
    case "proxy-chunk": return .proxyChunk(transferId: j.str("transferId"), seq: Int(j.int("seq")), iv: j.str("iv"), ciphertext: j.str("ciphertext"), v: j["v"]?.intValue)
    case "proxy-end": return .proxyEnd(transferId: j.str("transferId"), v: j["v"]?.intValue, iv: j["iv"]?.stringValue, ciphertext: j["ciphertext"]?.stringValue)
    case "proxy-cancel": return .proxyCancel(transferId: j.str("transferId"))
    case "proxy-need": return .proxyNeed(transferId: j.str("transferId"), seqs: j.arr("seqs")?.compactMap(\.intValue) ?? [])
    case "key-bundles": return .keyBundles(ref: j.str("ref"))
    case "kt-lookup": return .ktLookup(ref: j.str("ref"))
    default: return nil
    }
}

@Suite struct HubClientFrameTests {
    @Test func everyClientFrameIsWhatTheHubReads() throws {
        let cases = try #require(try Fixtures.hubFrames().arr("client"))
        #expect(cases.count >= 26)
        for c in cases {
            let name = c.str("name")
            let input = try #require(c["input"])
            let frame = try #require(swiftFrame(input), "\(name)")
            #expect(throws: Never.self, "\(name)") { try frame.validate() }
            #expect(frame.json == c["parsed"], "\(name): \(frame.text)")
            #expect(frame.type == c["parsed"]?.str("type"))
        }
    }

    @Test func framesTheHubRefusesAreRefusedHere() throws {
        let cases = try #require(try Fixtures.hubFrames().arr("invalid"))
        for c in cases {
            let input = try #require(c["input"])
            let frame = try #require(swiftFrame(input), "\(c.str("name"))")
            #expect(throws: HubFrameInvalid.self, "\(c.str("name")) — the hub says: \(c.str("error"))") { try frame.validate() }
        }
    }

    @Test func theEncoderWritesTheHubsNormalizedRelay() {
        let p3: NetJSON = ["iv": "aXY=", "ciphertext": "Y3Q="]
        let f = HubClientFrame.relay(HubRelay(messageId: "m-1", to: ["a", "b", "a"], envelope: p3, per: ["a": p3, "x": p3], mention: ["b", "z"]))
        #expect(f.json == ["type": "relay", "messageId": "m-1", "to": ["a", "b"], "envelope": p3, "per": ["a": p3], "mention": ["b"]])
        // A recipient without an envelope of its own needs `envelope`.
        #expect(throws: HubFrameInvalid.self) { try HubClientFrame.relay(HubRelay(messageId: "m-1", to: ["a", "b"], per: ["a": p3])).validate() }
        // 51 recipients is one too many.
        #expect(throws: HubFrameInvalid.self) { try HubClientFrame.relay(HubRelay(messageId: "m", to: (0...50).map { "r\($0)" }, envelope: p3)).validate() }
    }

    @Test func limitClassesAreTheHubs() {
        #expect(HubClientFrame.ping(t: 1).limitClass == .heartbeat)
        #expect(HubClientFrame.keyBundles(ref: "r").limitClass == .directory)
        #expect(HubClientFrame.relayAck(ids: []).limitClass == .relay)
        #expect(HubClientFrame.proxyNeed(transferId: "t", seqs: [1]).limitClass == .proxy)
        #expect(HubClientFrame.join(HubJoin(room: "r", name: "n")).limitClass == .signaling)
        #expect(HubLimitClass.of("whatever") == .other)
    }

    @Test func roomsAndNamesAreCleanedAsTheHubDoes() {
        #expect(HubWire.cleanRoom("  \u{0001}room\u{007F} ") == "room")
        #expect(HubWire.cleanRoom("   ") == nil)
        #expect(HubWire.cleanRoom(String(repeating: "x", count: 80))?.count == 64)
        #expect(HubWire.cleanName("  \u{200B}Ali\u{202E}ce  ") == "Alice")
        #expect(HubWire.cleanName("") == "Anonymous")
        #expect(HubWire.cleanName(String(repeating: "😀", count: 30)).unicodeScalars.count == 24) // 48 UTF-16 units, pairs never split
    }

    @Test func aFrameOverTheHubsSizeIsRefused() {
        let big = String(repeating: "a", count: hubMaxFrameBytes)
        #expect(throws: HubFrameInvalid.self) { try HubClientFrame.signal(target: "p", payload: ["type": "offer", "sdp": .string(big)]).validate() }
    }
}

@Suite struct HubServerFrameTests {
    let live: NetJSON

    init() throws { live = try #require(try Fixtures.hubFrames().obj("live")?.obj("frames")) }

    func frame(_ name: String) throws -> HubServerFrame {
        let raw = try #require(live[name], "fixture \(name)")
        return try #require(HubServerFrame.decode(raw.text)?.frame)
    }

    @Test func helloCarriesTheNonce() throws {
        guard case .hello(let h) = try frame("hello") else { Issue.record("not a hello"); return }
        #expect(h.protocolVersion == 2)
        #expect(h.maxFrameBytes == 262_144)
        #expect(h.features == ["bin"])
        let nonce = try #require(h.nonce)
        #expect(Bytes.unb64url(nonce)?.count == 24)
        #expect(!h.peerId.isEmpty && !h.connId.isEmpty)
    }

    @Test func joinedFramesDecode() throws {
        guard case .joined(let first) = try frame("joinedFirst") else { Issue.record("not joined"); return }
        #expect(first.proven == true)
        #expect(first.resume.count == 32)
        #expect(first.room.hasPrefix("r3."))
        guard case .joined(let second) = try frame("joinedSecond") else { Issue.record("not joined"); return }
        #expect(second.proven == false)
        #expect(second.peers.count == 1)
        #expect(second.peers[0].name == "Alice")
        #expect(second.peers[0].proven)
        #expect(second.peers[0].account != nil)
        #expect(second.account != nil)
        #expect(second.accountAway)
        guard case .joined(let legacy) = try frame("joinedLegacy") else { Issue.record("not joined"); return }
        #expect(legacy.proven == false)
    }

    @Test func membersPresenceAndRelayDecode() throws {
        guard case .peerJoined(let m) = try frame("peerJoined") else { Issue.record("peer-joined"); return }
        #expect(m.name == "Bob" && !m.proven && m.foreground && m.account != nil)
        guard case .peerPresence(let pid, let fg, let seen) = try frame("peerPresence") else { Issue.record("peer-presence"); return }
        #expect(pid == m.peerId && !fg && seen > 0)
        guard case .peerAway(let away) = try frame("peerAway") else { Issue.record("peer-away"); return }
        #expect(away.account == m.account && away.name == "Bob")
        guard case .peerBack(let account, let peerId, let name) = try frame("peerBack") else { Issue.record("peer-back"); return }
        #expect(account == m.account && peerId == m.peerId && name == "Bob")
        guard case .relayStatus(let stored) = try frame("relayStatusStored") else { Issue.record("relay-status"); return }
        #expect(stored.state == "stored" && stored.messageId == "m-relay-1" && stored.recipientName == "Bob" && stored.recipientAccount == m.account)
        guard case .relayStatus(let delivered) = try frame("relayStatusDelivered") else { Issue.record("relay-status"); return }
        #expect(delivered.state == "delivered")
        guard case .relayDeliver(let items) = try frame("relayDeliver") else { Issue.record("relay-deliver"); return }
        #expect(items.count == 1)
        #expect(items[0].kind == "message" && items[0].messageId == "m-relay-1" && items[0].fromName == "Alice" && items[0].fromAccount != nil)
        #expect(items[0].isP4)
        #expect(items[0].envelope?.str("kind") == "mb")
        guard case .peerLeft(_, let held) = try frame("peerLeftHeld") else { Issue.record("peer-left"); return }
        #expect(held?.name == "Bob" && held?.account == m.account)
        guard case .peerLeft(_, let gone) = try frame("peerLeft") else { Issue.record("peer-left"); return }
        #expect(gone == nil)
    }

    @Test func signalsPongsAndAcks() throws {
        guard case .signal(_, let payload) = try frame("signal") else { Issue.record("signal"); return }
        #expect(payload.obj("sealed")?.int("v") == 2)
        guard case .signalUndeliverable(let target) = try frame("signalUndeliverable") else { Issue.record("undeliverable"); return }
        #expect(target == "peer-nobody")
        guard case .pong(let t, let ts) = try frame("pong") else { Issue.record("pong"); return }
        #expect(t == 1_800_000_000_000 && ts > 0)
        guard case .presenceAck(let away) = try frame("presenceAck") else { Issue.record("presence-ack"); return }
        #expect(!away)
        guard case .authResult(let ok, let account, let aw, let invalid) = try frame("authResult") else { Issue.record("auth-result"); return }
        #expect(ok && account != nil && aw && !invalid)
    }

    @Test func directoryAnswersDecode() throws {
        guard case .keyBundles(let ref, let devices) = try frame("keyBundles") else { Issue.record("key-bundles"); return }
        #expect(!ref.isEmpty && devices.count == 1 && devices[0].obj("cert")?.int("v") == 2)
        guard case .keyBundles(_, let none) = try frame("keyBundlesUnknown") else { Issue.record("key-bundles"); return }
        #expect(none.isEmpty)
        guard case .ktLookup(_, let lookup) = try frame("ktLookup") else { Issue.record("kt-lookup"); return }
        #expect(lookup?.obj("sth")?.int("size") == 7)
        #expect(lookup?.arr("entries")?.count == 1)
    }

    @Test func refusalsAndTheOperator() throws {
        guard case .error(let proof) = try frame("errorRoomProof") else { Issue.record("error"); return }
        #expect(proof.code == "room-proof" && proof.legacyAllowed == true)
        #expect(HubProof.refusal(code: proof.code, legacyAllowed: proof.legacyAllowed, retried: false) == .legacy)
        #expect(HubProof.refusal(code: proof.code, legacyAllowed: proof.legacyAllowed, retried: true) == .refuse)
        #expect(HubProof.refusal(code: "room-proof-required", legacyAllowed: false, retried: false) == .refuse)
        #expect(HubProof.refusal(code: "room-full", legacyAllowed: nil, retried: false) == .none)
        guard case .error(let invalid) = try frame("errorInvalid") else { Issue.record("error"); return }
        #expect(invalid.code == "invalid-frame")
        guard case .rateLimited(let type, let ms) = try frame("rateLimited") else { Issue.record("rate-limited"); return }
        #expect(type == "presence" && ms > 0)
        guard case .serverNotice(let n) = try frame("serverNotice") else { Issue.record("server-notice"); return }
        #expect(n.kind == "wall" && n.level == "warning" && n.text == "Maintenance at 22:00")
        guard case .replaced = try frame("replaced") else { Issue.record("replaced"); return }
        #expect(live["replacedCloseCode"]?.int64Value == 4001)
        guard case .closedByServer(let reason) = try frame("closedByServer") else { Issue.record("closed-by-server"); return }
        #expect(reason == "closed by the operator")
        #expect(live["closedByServerCloseCode"]?.int64Value == 4003)
    }

    @Test func unknownFramesKeepTheirJSON() {
        let d = HubServerFrame.decode(#"{"type":"phone-bridge","event":"incoming","number":"+420"}"#)
        guard case .phoneBridge(let j)? = d?.frame else { Issue.record("phone-bridge"); return }
        #expect(j.str("number") == "+420")
        guard case .other(let t, let raw)? = HubServerFrame.decode(#"{"type":"future-frame","x":1}"#)?.frame else { Issue.record("other"); return }
        #expect(t == "future-frame" && raw.int("x") == 1)
        #expect(HubServerFrame.decode("not json") == nil)
        #expect(HubServerFrame.decode(#"{"no":"type"}"#) == nil)
    }

    @Test func binaryChunksRoundTrip() throws {
        let chunk = BinaryChunkFrame(type: BinaryChunkFrame.proxy, version: 4, transferId: "t-1", seq: 0x01020304, iv: Data(repeating: 9, count: 12), data: Data(repeating: 1, count: 40))
        let bytes = try chunk.encode()
        #expect(bytes.prefix(4) == Data([0x4D, 0x11, 4, 3]))
        #expect(BinaryChunkFrame.decode(bytes) == chunk)
        #expect(BinaryChunkFrame.decode(bytes.prefix(30)) == nil)
        #expect(throws: NetError.self) { try BinaryChunkFrame(version: 1, transferId: "t", seq: 0, iv: Data(count: 11), data: Data()).encode() }
    }
}

@Suite struct NetJSONTests {
    @Test func parsesAndWritesLikeJavaScript() throws {
        let j = try NetJSON.parse(#"{"b":[1,2.5,-0.25,1e3,true,null],"a":"x\u00e9\n\/","big":9007199254740991,"neg":-12}"#)
        #expect(j.int("big") == 9_007_199_254_740_991)
        #expect(j["b"]?[3] == .double(1000))
        #expect(j.str("a") == "xé\n/")
        #expect(j.text == #"{"a":"xé\n/","b":[1,2.5,-0.25,1000,true,null],"big":9007199254740991,"neg":-12}"#)
        #expect(NetJSON.format(1e21) == "1e+21")
        #expect(NetJSON.format(1e-7) == "1e-7")
        #expect(NetJSON.format(5.0) == "5")
        #expect(NetJSON.string("\u{1}").text == #""\u0001""#)
    }

    @Test func refusesWhatJSONParseRefuses() {
        for bad in ["", "{", "[1,]", "{\"a\":1,}", "01", "1.", "NaN", "{a:1}", "\"\u{1}\"", "[1] x", "\"\\x\""] {
            #expect(throws: NetJSONError.self, "\(bad)") { try NetJSON.parse(bad) }
        }
        let deep = String(repeating: "[", count: 200) + String(repeating: "]", count: 200)
        #expect(throws: NetJSONError.self) { try NetJSON.parse(deep) }
    }

    @Test func surrogatePairs() throws {
        #expect(try NetJSON.parse(#""\ud83d\ude00""#).stringValue == "😀")
        #expect(try NetJSON.parse(#""\ud83d""#).stringValue == "\u{FFFD}")
    }

    @Test func codableRoundTrip() throws {
        let j: NetJSON = ["a": [1, "b", nil, true, 2.5], "o": ["k": "v"]]
        let data = try JSONEncoder().encode(j)
        #expect(try JSONDecoder().decode(NetJSON.self, from: data) == j)
    }
}
