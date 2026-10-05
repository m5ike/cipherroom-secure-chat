// Contract for the parts (Core/README.md § Modely): one connected room as the
// chat, people and tools parts read it and act on it — the port of what
// android/…/chat/RoomSession.java gives its UI (messagesCopy, status, notice,
// restores, peopleScope, peersScope, usersScope, profileOf, safetyKeys,
// send / sendFile / markRead / touched / hide / deleteLocal / vanished,
// startFnCall, addModelAnswer, addNote…). The real implementation is
// Core/Engine's RoomController (M5Proto RoomSession over an M5Net hub socket);
// DEBUG builds have PreviewRoom (Core/Preview) with the console's sample data.
//
// Everything is main-actor and @Observable: a SwiftUI view that reads
// `messages` or `people` is drawn again when they change. Operations return at
// once; the protocol work happens on the room's actor and comes back as state.

import Foundation
import M5Core
import M5Design
import M5Proto
import Observation

/// One member of a room as the People widget, the user panel and the look-alike check see them
/// (RoomSession.peopleScope + trustFields + presence): me first, the peers, away and held members.
struct PersonItem: Identifiable, Equatable, Sendable {
    /// The peer id; an away member is "away:<account ref>".
    let id: String
    let name: String
    let me: Bool
    /// "open" | "connecting" | "closed" | "away" | "held".
    let channel: String
    let username: String
    let signedIn: Bool
    let since: Int64
    /// Call audio: "off" | "on" | "muted" | "text"…
    let audio: String
    /// A valid hello (the device key is known).
    let signed: Bool
    /// The identity changed and was not accepted (messages held, review P14).
    let changed: Bool
    let publicKey: String
    /// Trust (§ 12.1): "new" | "verified" | "account" | "changed", and its words.
    let trust: String
    let trustLabel: String
    /// "p4" | "legacy" | "" (no hello yet).
    let proto: String
    let legacy: Bool
    let held: Int
    /// Key transparency's word on an attested device ("" = nothing to say).
    let kt: String
    let connected: Bool
    let foreground: Bool
    let lastSeen: Int64
    /// The whole row as Android builds it ($user / $person of the design's templates) — every field above and more
    /// (verifiedAs, protocolLabel, downgrade, proven, unproven, ktLabel, app, rtt).
    let scope: DesignValue

    init(scope o: JSONObject) {
        id = o.optString("id"); name = o.optString("name"); me = o.bool("me") ?? false; channel = o.optString("channel")
        username = o.optString("username"); signedIn = o.bool("signedIn") ?? false; since = o.optInt64("since")
        audio = o.optString("audio", "off"); signed = o.bool("signed") ?? false; changed = o.bool("changed") ?? false
        publicKey = o.optString("publicKey"); trust = o.optString("trust"); trustLabel = o.optString("trustLabel")
        proto = o.optString("protocol"); legacy = o.bool("legacy") ?? false; held = o.optInt("held")
        kt = o.optString("kt"); connected = o.bool("connected") ?? false; foreground = o.bool("foreground") ?? false
        lastSeen = o.optInt64("lastSeen")
        scope = o.designValue
    }
}

/// A peer with an open data channel (recipients, mentions, forwarding to one person): RoomSession.peersScope.
struct PeerRef: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
}

/// The room's call as the screens read it ($call: active, mode, muted, peers).
struct CallInfo: Equatable, Sendable {
    /// Calls.state(): "off" | "connecting" | "on" | "muted"…
    var state = "off"
    var video = false
    var peers = 0
    var active: Bool { state != "off" }
    var muted: Bool { state == "muted" }
    var scope: DesignValue {
        ["active": .bool(active), "mode": .string(video ? "video" : "audio"), "muted": .bool(muted), "peers": .number(Double(peers))]
    }
}

/// The two keys a safety number is made of (§ 12.2): both account keys when both sides are attested, else both device keys.
struct SafetyKeys: Equatable, Sendable {
    let mine: String
    let theirs: String
}

@MainActor
protocol RoomModel: AnyObject, Observable {
    /// The saved room's key (its normalized name).
    var key: String { get }
    var room: String { get }
    /// The name as the user typed it.
    var label: String { get }
    /// "offline" | "connecting" | "joined" | "mismatch" (wrong passphrase) | "blocked" | "full"…
    var status: String { get }
    /// What the server or the connection says now (a notice, "reconnecting in…") — "" when nothing.
    var notice: String { get }
    var connected: Bool { get }
    /// Unread messages (the badge); 0 while the room is on screen.
    var unread: Int { get }
    var lastActivity: Int64 { get }

    /// The room's messages, oldest first (≤ 600; expired ones already gone). Equal ids = the same message.
    var messages: [ChatMessage] { get }
    /// How many times the history came into the list (a lock and unlock reload it — the list starts over).
    var restores: Int { get }
    /// The history is in the list (after the start or an unlock).
    var historyReady: Bool { get }
    /// The id of the latest message that arrived live or that I sent (scroll to it, its enter animation).
    var freshId: String? { get }
    /// A message the list should scroll to and flash (History › an entry, a notification) — the list clears it.
    var revealRequest: String? { get set }

    /// My peer id in the room ("" before the hub's hello).
    var myId: String { get }
    var myName: String { get }
    /// This device's key in the room (half of a safety number).
    var myPublicKey: String { get }
    /// Everyone of the room for People / the user panel (me first, peers, away and held members).
    var people: [PersonItem] { get }
    /// The peers with an open channel (recipients, mentions).
    var peers: [PeerRef] { get }
    /// Me (when joined) and every peer not gone.
    var userCount: Int { get }
    var call: CallInfo { get }
    /// Key transparency's alert for this server ("" when none, § 14.4).
    var ktAlert: String { get }
    /// $room of the screens (MainActivity.roomScope): key, name, users, unread, status, connected, notice, active.
    var scope: DesignValue { get }

    // MARK: lookups

    func message(_ id: String) -> ChatMessage?
    func peerName(_ peerId: String) -> String?
    /// A message from a changed identity not accepted yet (review P14: its text is not shown, not quoted).
    func isHeld(_ messageId: String?) -> Bool
    func heldCount(_ peerId: String) -> Int
    /// What a member shares with the room (ProfileRoom cache: avatar data URL, nickname, about…), nil when nothing.
    func profile(of peerId: String) -> JSONObject?
    /// The member's account key from their profile exchange ("" when unknown).
    func accountKey(of peerId: String) -> String
    func safetyKeys(_ peerId: String) -> SafetyKeys
    /// The safety number to compare (groups of digits).
    func safetyNumber(_ peerId: String) -> String
    /// A private message can go to this peer (an open channel with a pair or protocol-4 session).
    func canPrivate(_ peerId: String) -> Bool

    // MARK: messages

    /// Sends a message (Outgoing: text, reply, inline attachment, kinds, recipients, ttl, position, forwardedFrom, fn).
    /// The bubble appears at once ("sending"); returns its id.
    @discardableResult func send(_ o: Outgoing) -> String
    /// A file from the vault (FileVault id) by chunked transfer (data channels, the server's proxy for the away);
    /// `o` carries the caption, kinds and recipients.
    func sendFile(vaultId: String, name: String, mime: String, size: Int64, _ o: Outgoing)
    /// These messages were on screen: read receipts go, the badge clears.
    func markRead(_ ids: [String])
    /// A step only this device keeps (displayed, revealed, opened a seal, a tap read): changed and stored.
    func touch(_ id: String, _ change: @escaping @Sendable (inout ChatMessage) -> Void)
    /// Hidden in this view until `until` (ms) or until the next unlock (ChatMessage.untilSignIn).
    func hide(_ id: String, until: Int64, unlock: String?, why: String?)
    /// Deleted on this device (its file too when nothing else uses it).
    func deleteLocal(_ id: String)
    /// A vanishing message's time ran out (the list counts it while shown).
    func vanished(_ id: String)
    /// People › verify: the person compared the safety number (on) or took it back.
    func identityVerified(_ peerId: String, _ on: Bool)
    /// 6.10: a note to myself in this room (never sent) — text, optionally a file (inline or vault).
    func addNote(text: String, fileName: String?, fileMime: String?, dataUrl: String?, filePath: String?, fileSize: Int64, toLabel: String?)

    // MARK: functions (fn/*) — the Fn engine drives these

    /// A command's own bubble (its query, then loading, then a status); nil when the room is gone.
    func startFnCall(keyword: String, name: String, query: String, icon: String) -> ChatMessage?
    /// The command finished: kind "ok" | "error" | "cancelled"…, a label, an error code.
    func fnCallStatus(_ id: String, kind: String, label: String, code: String)
    func fnCallProgress(_ id: String, progress: Double, text: String)
    /// 6.11: a model's answer as a message of the room (shared part to everyone, local part kept here).
    @discardableResult
    func addModelAnswer(identity: JSONObject, text: String, share: JSONObject?, local: JSONObject?, replyTo: ChatMessage?) -> ChatMessage?

    /// Reads each open peer connection's statistics into `people` (rtt) — People asks every few seconds while open.
    func refreshStats()
}

extension RoomModel {
    /// Text with an optional reply — the shortest send (Rooms.send).
    @discardableResult
    func sendText(_ text: String, replyTo: ChatMessage? = nil) -> String {
        var o = Outgoing(text: text)
        o.replyTo = replyTo
        return send(o)
    }

    /// The peers in the order the list shows (me excluded) as {id, name} for the design.
    var peersScope: DesignValue { .array(peers.map { ["id": .string($0.id), "name": .string($0.name)] }) }
}
