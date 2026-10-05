// The rooms while the app is locked (6.12, F-16; android chat/LockedRooms.java).
// At the lock the vault's data key goes but the open rooms stay connected;
// what would be written into the encrypted stores goes into the lock inbox
// instead (M5Crypto LockBox: sealed to a key pair made at the lock — only its
// public key stays in memory). Item kinds:
//
//   msg     a message of a room as the history keeps it — merged by its id
//   state   a receipt / relay state for a message of mine from before the lock
//   pin     a key pinned on first sight of a name
//   resume  the room's peer id and resume secret
//   call    an ended call (CallHistory), callUri its row in the system's log
//   file    a received file, kept encrypted under its transfer key (the key in the item)
//
// At the unlock every generation is opened with the data key and merged (by
// id — merging twice is harmless). The files and their durability are the
// app's (Platform); the item format, the generation's sealing and the merge are here.

import Foundation
import M5Core
import M5Crypto
import Synchronization

public enum LockedRooms {
    /// The longest message id kept (Payloads.idMax).
    static let idMax = 96

    static func item(_ type: String, _ kv: [(String, JSON)]) -> JSONObject { JSONObject([("t", .string(type))] + kv) }

    public static func message(roomKey: String, _ m: ChatMessage) -> JSONObject { item("msg", [("room", .string(roomKey)), ("m", .object(m.json))]) }

    public static func state(roomKey: String, id: String, who: String?, name: String?, state: String) -> JSONObject {
        item("state", [("room", .string(roomKey)), ("id", .string(id)), ("who", .string(who ?? "")), ("name", .string(name ?? "")), ("state", .string(state))])
    }

    public static func pin(slot: String, kid: String) -> JSONObject { item("pin", [("slot", .string(slot)), ("kid", .string(kid))]) }

    public static func resume(roomKey: String, peerId: String, secret: String) -> JSONObject {
        item("resume", [("room", .string(roomKey)), ("peerId", .string(peerId)), ("secret", .string(secret))])
    }

    public static func call(_ entry: JSONObject) -> JSONObject { item("call", [("e", .object(entry))]) }

    public static func callUri(id: String, uri: String) -> JSONObject { item("callUri", [("id", .string(id)), ("uri", .string(uri))]) }

    /// A received file kept for the unlock: its slots file (the app moved it) and the transfer key.
    public static func file(roomKey: String, id: String, key: Bytes, chunkSize: Int, total: Int, size: Int64, lengths: [Int], root: String, p4: Bool) -> JSONObject {
        item("file", [("room", .string(roomKey)), ("id", .string(id)), ("key", .string(Crypto.b64(key))), ("chunkSize", .int(chunkSize)), ("total", .int(total)),
                      ("size", .int(size)), ("lengths", .array(lengths.map { .int($0) })), ("root", .string(root)), ("p4", .bool(p4))])
    }

    /// The file name a kept file's slots go under (android partName).
    public static func partName(_ id: String) -> String {
        var s = ""
        for u in id.unicodeScalars {
            let ok = ("A"..."Z").contains(u) || ("a"..."z").contains(u) || ("0"..."9").contains(u) || u == "_" || u == "." || u == "-"
            s += ok ? String(u) : "_"
        }
        return s + ".part"
    }

    /* ======================================================== the unlock */

    /// What a drain does with the items, grouped (pure).
    public struct Parsed: Sendable {
        public var rooms = OrderedMap<String, [JSONObject]>()
        public var pins = OrderedMap<String, String>()
        public var resumes = OrderedMap<String, [String]>()
        public var calls = [JSONObject]()
        public var callUris = OrderedMap<String, String>()
        public var files = [JSONObject]()
        public var unknown = 0
    }

    public static func parse(_ opened: [Bytes]) -> Parsed {
        var p = Parsed()
        for b in opened {
            guard let o = JSON.parseObject(Crypto.str(b)) else { p.unknown += 1; continue }
            switch o.optString("t") {
            case "msg", "state":
                let room = o.optString("room")
                if room.isEmpty { p.unknown += 1; break }
                p.rooms[room] = (p.rooms[room] ?? []) + [o]
            case "pin":
                let slot = o.optString("slot"), kid = o.optString("kid")
                if !slot.isEmpty && !kid.isEmpty && p.pins[slot] == nil { p.pins[slot] = kid }
            case "resume": p.resumes[o.optString("room")] = [o.optString("peerId"), o.optString("secret")]
            case "call": if let e = o.object("e") { p.calls.append(e) }
            case "callUri": p.callUris[o.optString("id")] = o.optString("uri")
            case "file": p.files.append(o)
            default: p.unknown += 1
            }
        }
        return p
    }

    /// A message of the inbox as the history would keep it — or nil when it is not one.
    public static func valid(_ o: JSONObject?, roomKey: String, now: Int64) -> ChatMessage? {
        guard let o else { return nil }
        var m = ChatMessage.from(o)
        if m.id.isEmpty || m.id.utf16.count > idMax { return nil }
        if m.kind != "text" && m.kind != "note" { return nil } // a system line is not kept in a history
        if m.text.utf16.count > 200_000 { return nil }
        m.roomKey = roomKey
        if m.createdAt > now + Payloads.futureSkew { m.createdAt = now + Payloads.futureSkew }
        return m
    }

    /// A room's history with the inbox's items for it, in their order: a message by its id (a new one appended,
    /// a known one replaced in its place by its newer state); a state raises a message of mine. Pure.
    public static func merge(history: [ChatMessage], roomKey: String, items: [JSONObject], now: Int64) -> [ChatMessage] {
        var byId = OrderedMap<String, ChatMessage>()
        for m in history where byId[m.id] == nil { byId[m.id] = m }
        for it in items {
            if it.optString("t") == "msg" {
                if let m = valid(it.object("m"), roomKey: roomKey, now: now) { byId[m.id] = m } // keeps a known id's place
            } else if it.optString("t") == "state" {
                guard var m = byId[it.optString("id")], m.mine else { continue }
                let state = it.optString("state"), who = it.optString("who")
                if ChatMessage.rank(state) < 0 { continue }
                let key = who.isEmpty ? "relay" : who
                if ChatMessage.rank(state) > ChatMessage.rank(m.receipts.optString(key)) { m.receipts[key] = .string(state) }
                m.raise(state, who: it.optString("name").isEmpty ? key : it.optString("name"), at: now)
                byId[m.id] = m
            }
        }
        return byId.orderedValues
    }

    /// Messages whose kept file could not be stored say so.
    public static func markLostFiles(_ list: inout [ChatMessage], _ badFiles: Set<String>) {
        if badFiles.isEmpty { return }
        for i in list.indices where !list[i].mine {
            if let p = list[i].filePath, badFiles.contains(p) { list[i].filePath = nil; list[i].fileProgress = -2 }
        }
    }
}

/// The open generation of the lock inbox (android LockedRooms begin / seal / close): a P-256 key pair made at
/// the lock, its private key sealed by the vault's data key (the app writes `wrappedKey` durably before the
/// data key goes); then every item is sealed to the public key as one log line the app appends.
public final class LockInbox: Sendable {
    private struct Generation: Sendable { let publicKey: String; let kid: String; var seq: Int64 }
    private let open = Mutex<Generation?>(nil)

    public init() {}

    /// Locked in the receiving mode: what would be stored goes into the inbox.
    public var active: Bool { open.withLock { $0 != nil } }

    /// A new generation, with the data key still there: its kid and its private key (PKCS#8) sealed by the data key.
    public func begin(dataKey: Bytes) throws -> (kid: String, wrappedKey: Bytes) {
        let pair = LockBox.newKeyPair()
        let kid = LockBox.kid(pair)
        let wrapped = try LockBox.wrapKey(dek: dataKey, kid: kid, pkcs8: Crypto.unb64(pair.pkcs8))
        open.withLock { $0 = Generation(publicKey: pair.spki, kid: kid, seq: 0) }
        return (kid, wrapped)
    }

    /// At the unlock (and a wipe): nothing more is sealed.
    public func close() { open.withLock { $0 = nil } }

    /// One item sealed into the open generation, as its log line; nil when none is open.
    public func seal(_ item: JSONObject) -> (kid: String, line: Bytes)? {
        open.withLock { g -> (String, Bytes)? in
            guard var gen = g else { return nil }
            gen.seq += 1
            guard let rec = try? LockBox.seal(publicKey: gen.publicKey, kid: gen.kid, seq: gen.seq, Crypto.utf8(item.stringify())) else { return nil }
            g = gen
            return (gen.kid, LockBox.line(rec))
        }
    }

    /// One generation's log opened with the data key: its items parsed (and how many did not open).
    public static func drain(dataKey: Bytes, kid: String, wrappedKey: Bytes, log: Bytes) throws -> (parsed: LockedRooms.Parsed, failed: Int) {
        let priv = try LockBox.unwrapKey(dek: dataKey, kid: kid, wrappedKey)
        let opened = LockBox.openAll(priv, kid: kid, LockBox.read(log))
        return (LockedRooms.parse(opened.items), opened.failed)
    }
}
