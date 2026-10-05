// The saved rooms (android chat/Rooms.java, its storage and pure parts): the
// user-tier record "rooms" = {list: [{key, room, label, passphrase, userName,
// selected, lastActive}], active}. Which rooms are connected, switching and
// unread counts are the app's (it owns the RoomSession actors).

import Foundation
import M5Core
import M5Crypto

/// One saved room (its passphrase lives only in the vault's user tier).
public struct SavedRoom: Sendable, Equatable {
    /// The room's key: its normalized name (RoomKeys.normalizeRoom).
    public var key: String
    public var room: String
    /// The name as the user typed it.
    public var label: String
    public var passphrase: String
    public var userName: String
    /// Connected when the app starts (it was connected before).
    public var selected: Bool
    public var lastActive: Int64

    public init(key: String, room: String, label: String, passphrase: String, userName: String, selected: Bool = false, lastActive: Int64 = 0) {
        self.key = key; self.room = room; self.label = label; self.passphrase = passphrase; self.userName = userName
        self.selected = selected; self.lastActive = lastActive
    }

    public var json: JSONObject {
        JSONObject([("key", .string(key)), ("room", .string(room)), ("label", .string(label)), ("passphrase", .string(passphrase)),
                    ("userName", .string(userName)), ("selected", .bool(selected)), ("lastActive", .int(lastActive))])
    }

    public static func of(_ o: JSONObject) -> SavedRoom {
        let room = o.optString("room")
        return SavedRoom(key: o.optString("key"), room: room, label: o.optString("label", room), passphrase: o.optString("passphrase"),
                         userName: o.optString("userName"), selected: o.bool("selected") ?? false, lastActive: o.optInt64("lastActive"))
    }

    /// The room as a connection card ({v: 1, room, passphrase, name}) for NFC (ConnTag).
    public var card: JSONObject {
        JSONObject([("v", 1), ("room", .string(room)), ("passphrase", .string(passphrase)), ("name", .string(userName))])
    }
}

public enum SavedRooms {
    public static let recordName = "rooms"

    /// The saved rooms (in their stored order, without a keyless one) and the room on screen.
    public static func load(_ vault: any RecordVault) -> (rooms: [SavedRoom], active: String) {
        let record = vault.record(recordName) ?? JSONObject()
        var seen = Set<String>(), rooms = [SavedRoom]()
        for item in record.array("list") ?? [] {
            guard let o = item.objectValue else { continue }
            let s = SavedRoom.of(o)
            if s.key.isEmpty { continue }
            if seen.insert(s.key).inserted { rooms.append(s) } else if let i = rooms.firstIndex(where: { $0.key == s.key }) { rooms[i] = s }
        }
        return (rooms, record.optString("active"))
    }

    /// False while the vault cannot be written (locked).
    @discardableResult
    public static func save(_ vault: any RecordVault, rooms: [SavedRoom], active: String) -> Bool {
        vault.put(recordName, JSONObject([("list", .array(rooms.map { .object($0.json) })), ("active", .string(active))]))
    }

    /// A new saved room from what the join form has (its key is the normalized name).
    public static func make(roomName: String, passphrase: String, userName: String, now: Int64) -> SavedRoom {
        let room = RoomKeys.normalizeRoom(roomName)
        let label = roomName.javaTrimmed.isEmpty ? room : roomName.javaTrimmed
        return SavedRoom(key: room, room: room, label: label, passphrase: passphrase, userName: userName, selected: true, lastActive: now)
    }

    /// A copy of a saved room under the next free name ("Team" → "Team 2"): the same passphrase and nickname, not selected (6.7 Clone).
    public static func copy(_ s: SavedRoom, keys: Set<String>, now: Int64) -> SavedRoom {
        let label = cloneName(s.label.isEmpty ? s.room : s.label, keys)
        let room = RoomKeys.normalizeRoom(label)
        return SavedRoom(key: room, room: room, label: label, passphrase: s.passphrase, userName: s.userName, selected: false, lastActive: now)
    }

    /// The name of a copy: the label with the next number no saved room has (a room's name is its key).
    public static func cloneName(_ label: String?, _ keys: Set<String>) -> String {
        var base = (label ?? "").javaTrimmed
        var next = 2
        let scalars = Array(base.unicodeScalars)
        // "^(.*\S)\s+(\d{1,4})$"
        var end = scalars.count, digits = 0
        while end > 0 && ("0"..."9").contains(scalars[end - 1]) { end -= 1; digits += 1 }
        if digits >= 1 && digits <= 4 && end > 0 && scalars[end - 1].properties.isWhitespace {
            var head = end
            while head > 0 && scalars[head - 1].properties.isWhitespace { head -= 1 }
            if head > 0 {
                var u = String.UnicodeScalarView()
                u.append(contentsOf: scalars[0..<head])
                var n = String.UnicodeScalarView()
                n.append(contentsOf: scalars[end...])
                base = String(u)
                next = (Int(String(n)) ?? 1) + 1
            }
        }
        if base.isEmpty { base = "room" }
        // A room's key keeps 48 characters: room for the number.
        if base.count > 40 { base = String(base.prefix(40)).javaTrimmed }
        for i in next..<(next + 10_000) {
            let name = base + " " + String(i)
            if !keys.contains(RoomKeys.normalizeRoom(name)) { return name }
        }
        return base + " " + String(Int64(Date().timeIntervalSince1970 * 1000) % 100_000)
    }
}
