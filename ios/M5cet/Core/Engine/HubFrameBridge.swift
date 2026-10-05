// The room protocol (M5Proto, M5Core JSON) and the hub client (M5Net, typed
// frames, NetJSON) speak the same wire (server/signaling/frames.ts) in two Swift
// shapes. HubConnection owns the socket's own frames — join (with the proof),
// auth, presence, ping, leave — so the room's copies of those are dropped; the
// rest is converted 1:1. Android had one class (RoomSession) for both halves.

import Foundation
import M5Core
import M5Net

enum HubFrameBridge {
    /// Frames the connection itself sends (the room core's would be a second join / auth / presence).
    static let connectionOwned: Set<String> = ["join", "auth", "presence", "leave", "ping"]

    /// A frame of the room core as the hub client's typed frame; nil for one the connection owns or does not know.
    static func clientFrame(_ f: JSONObject) -> HubClientFrame? {
        let type = f.optString("type")
        if connectionOwned.contains(type) { return nil }
        switch type {
        case "signal":
            guard let payload = f["payload"] else { return nil }
            return .signal(target: f.optString("target"), payload: net(payload))
        case "relay":
            var per: [String: NetJSON]?
            if let p = f.object("per") {
                var d = [String: NetJSON]()
                for (k, v) in p { d[k] = net(v) }
                per = d
            }
            let relay = HubRelay(messageId: f.optString("messageId"), to: strings(f.array("to")), envelope: f["envelope"].map(net), per: per,
                                 expiresAt: f.int64("expiresAt"), mention: f.array("mention").map(strings), call: f.bool("call") ?? false,
                                 // 6.14 call wake (CallWake.relayFields).
                                 callEnd: f.bool("callEnd") ?? false, callId: f.string("callId"), video: f.bool("video") ?? false)
            return .relay(relay)
        case "relay-ack": return .relayAck(ids: strings(f.array("ids")))
        case "receipt":
            guard let state = HubReceiptState(rawValue: f.optString("state")) else { return nil }
            return .receipt(messageIds: strings(f.array("messageIds")), state: state)
        case "key-bundles": return .keyBundles(ref: f.optString("ref"))
        case "kt-lookup": return .ktLookup(ref: f.optString("ref"))
        case "proxy-meta":
            return .proxyMeta(transferId: f.optString("transferId"), iv: f.optString("iv"), ciphertext: f.optString("ciphertext"), v: f.int("v"))
        case "proxy-chunk":
            return .proxyChunk(transferId: f.optString("transferId"), seq: f.optInt("seq"), iv: f.optString("iv"), ciphertext: f.optString("ciphertext"), v: f.int("v"))
        case "proxy-end":
            return .proxyEnd(transferId: f.optString("transferId"), v: f.int("v"), iv: f.string("iv"), ciphertext: f.string("ciphertext"))
        case "proxy-cancel": return .proxyCancel(transferId: f.optString("transferId"))
        case "proxy-need": return .proxyNeed(transferId: f.optString("transferId"), seqs: (f.array("seqs") ?? []).compactMap { $0.int64Value.map { Int($0) } })
        default: return nil
        }
    }

    /// A server frame's raw JSON as the room core reads it.
    static func object(_ raw: NetJSON) -> JSONObject? { JSON.parseObject(raw.text) }

    static func net(_ j: JSON) -> NetJSON { (try? NetJSON.parse(j.stringify())) ?? .null }

    static func json(_ n: NetJSON) -> JSON { (try? JSON.parse(n.text)) ?? .null }

    private static func strings(_ a: [JSON]?) -> [String] { (a ?? []).compactMap(\.stringValue) }
}
