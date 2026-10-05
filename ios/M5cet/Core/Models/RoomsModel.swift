// Contract for the parts (Core/README.md § Modely): every room of the app — the
// port of android/…/chat/Rooms.java as its UI reads it: the saved rooms ($rooms,
// RoomList), the connected ones by activity (RoomTabs, the swipe between rooms,
// forwarding), which one is on screen, the counts, and the operations behind
// room.switch / room.toggle / rooms.connect / room.leave / room.forget / clone /
// edit / join. Real: Core/Engine RoomsController; DEBUG: PreviewRooms.

import Foundation
import M5Core
import M5Design
import M5Proto
import Observation

/// A saved room as the rooms screen sees it (Rooms.scope(): key, name, room, users, unread, active, connected,
/// status, selected) — `scope` is that object for the design's "rooms.item" template ($room).
struct RoomItem: Identifiable, Equatable, Sendable {
    var id: String { key }
    let key: String
    let name: String
    let room: String
    var users: Int
    var unread: Int
    var active: Bool
    var connected: Bool
    /// "saved" (not connected) | the session's status.
    var status: String
    var selected: Bool

    var scope: DesignValue {
        ["key": .string(key), "name": .string(name), "room": .string(room), "users": .number(Double(users)), "unread": .number(Double(unread)),
         "active": .bool(active), "connected": .bool(connected), "status": .string(status), "selected": .bool(selected)]
    }
}

@MainActor
protocol RoomsModel: AnyObject, Observable {
    /// The saved rooms are read (after an unlock; not while locked).
    var loaded: Bool { get }
    /// The saved rooms, latest activity first.
    var items: [RoomItem] { get }
    /// The room on screen ("" = none).
    var activeKey: String { get }
    /// The connected rooms (sessions), latest activity first — the room bar.
    var open: [any RoomModel] { get }
    /// Selected rooms not connected yet (the "connect selected" button).
    var selectedCount: Int { get }
    var connectedCount: Int { get }
    var unreadTotal: Int { get }
    /// The policy's limit of rooms at once (rooms.max, 1–16, default 8).
    var maxRooms: Int { get }
    /// Key transparency's persistent alert for the server ("" when none).
    var ktAlert: String { get }

    func room(_ key: String) -> (any RoomModel)?
    /// The open room the server knows by this id (a notification names it).
    func byServerId(_ id: String) -> (any RoomModel)?
    /// A copy of a saved room (the edit form: name, passphrase, nickname), nil when unknown.
    func saved(_ key: String) -> SavedRoom?
    /// A saved room as an NFC connection card ({v:1, room, passphrase, name}).
    func card(_ key: String) -> JSONObject?

    /// room.switch: the room on screen (connected if needed); its badge clears.
    func switchTo(_ key: String)
    /// room.toggle: selected / not.
    func toggleSelected(_ key: String)
    /// rooms.connect: every selected room (up to maxRooms); the first becomes active when none is.
    func connectSelected()
    /// room.leave: disconnects ("" = the active one); the most recently active other room takes its place.
    func leave(_ key: String)
    /// room.forget: leaves and removes the saved room and its history.
    func forget(_ key: String)
    /// The join form: saves (or updates) the room, connects it and makes it active. Returns its key.
    @discardableResult func join(room: String, passphrase: String, userName: String) -> String
    /// room.clone: a copy under the next free name, not connected. Its key, or nil.
    @discardableResult func clone(_ key: String) -> String?
    /// room.edit's save: a new name is a new room (it takes the old one's place); a connected one reconnects.
    @discardableResult func update(_ oldKey: String, room: String, passphrase: String, userName: String) -> String?
    /// The room screen is on screen (true) or not — unread counting and notifications follow.
    func setVisible(_ visible: Bool)
    /// kt.dismiss: the person saw the key-transparency alert.
    func dismissKtAlert()
}

extension RoomsModel {
    var active: (any RoomModel)? { activeKey.isEmpty ? nil : room(activeKey) }

    /// $rooms of the rooms screen.
    var scope: DesignValue { .array(items.map(\.scope)) }
}
