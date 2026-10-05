// The seams between Platform/Calls and the code other agents write — the
// room session (M5Kit M5Proto/M5Net, wired in the app), the network
// (/api/turn, the VoIP token), Platform/Push (opening a sealed VoIP payload),
// Platform/Security (the vault, the app lock) and the settings / design.
// Everything here is small on purpose: the room session drives RoomRtc and
// answers RoomRtcLink; see README.md (in this folder) for the whole picture.

import Foundation

// MARK: - the room session ↔ RoomRtc

/// What a room's WebRTC side (RoomRtc) needs from its room session. The room session owns
/// the hub socket, the keys and the chat protocol; RoomRtc owns the peer connections.
/// Called on the main actor, in the order things happened.
@MainActor
protocol RoomRtcLink: AnyObject {
    /// Seal `signal` for `peerId` (Envelopes.sealSignal) and send {type:"signal", target, payload}.
    func rtc(_ room: RoomRtc, sendSignal signal: RtcSignal, to peerId: String)
    /// The peer's data channel opened: send our hello now (then RoomRtc announces the audio status).
    func rtc(_ room: RoomRtc, channelOpenedWith peerId: String)
    /// The peer's data channel or connection closed.
    func rtc(_ room: RoomRtc, channelClosedWith peerId: String)
    /// A data channel message: text → the chat protocol (onPeerText), binary → file chunks (files.onBinary).
    func rtc(_ room: RoomRtc, received frame: RtcDataFrame, from peerId: String)
    /// Send {kind:"audio-status", status} to everyone, sealed like a message ("live" / "muted" / "off").
    func rtc(_ room: RoomRtc, broadcastAudioStatus status: CallAudioState)
}

/// The room's own state of a call (and the "status" of an audio-status message).
enum CallAudioState: String, Sendable {
    case off, live, muted
}

/// A peer connection as the room and the call screen see it (Android Peer.status).
enum RtcPeerStatus: String, Sendable {
    case connecting, open, closed
}

// MARK: - rooms, for CallKit

/// The rooms as the call center needs them (implemented by the app's room list / navigation).
/// A connected room's WebRTC side is not asked here: the room session attaches it to
/// CallSystem (attach / detach) as it connects and goes.
@MainActor
protocol CallRoomDirectory: AnyObject {
    /// Connect the room's hub socket (a VoIP push or an answer while it was not connected); the
    /// room session then attaches the room to CallSystem.
    func connect(roomKey: String)
    /// The room is on screen in the foreground (its own call controls show the call — no ring).
    func isOnScreen(roomKey: String) -> Bool
    /// Show the room (an answered call, a call-back from Recents or the History).
    func open(roomKey: String)
    /// The room's name as this device saved it ("" when unknown).
    func label(ofRoom roomKey: String) -> String
    /// The saved rooms' keys (mapping a Recents handle back to its room).
    func savedRoomKeys() -> [String]
}

// MARK: - the History's messages

/// A saved room as the History lists it.
struct CallLogRoom: Sendable {
    var key: String
    /// The room's name (its label, or the room).
    var label: String
}

/// A room's message for the History, and whether the room's view hides it now (Android ui/bubble/Hides).
struct CallLogRoomMessage: Sendable {
    var message: CallLogItems.Message
    var hidden: Bool
}

/// The rooms' own histories (a connected room's messages in memory, the others' from the vault) —
/// the room session implements it; nothing is copied for the History.
@MainActor
protocol CallLogMessageSource: AnyObject {
    func savedRooms() -> [CallLogRoom]
    func messages(ofRoom roomKey: String) -> [CallLogRoomMessage]
}

// MARK: - settings and privacy

/// Settings › Calls and Settings › Notifications as the calls read them (Android Settings keys in comments).
struct CallSettings: Equatable, Sendable {
    /// calls.speaker — speaker (default) or earpiece; video calls always use the speaker.
    var speaker = true
    /// callLog — calls in the Phone app's Recents (CXProviderConfiguration.includesCallsInRecents).
    var recents = false
    /// calls.logName — what a Recents entry is named: app | room | people.
    var logName = CallNaming.nameApp
    /// calls.history — keep the app's own call history.
    var history = true
    /// hideIp — relay-only peer connections when the server offers TURN (the web's 6.12 F-15).
    var hideIp = false
}

/// What a ringing call may show and whether it may ring (Android CallRing.level / NotifyPrefs.allows("call")).
struct CallPrivacy: Equatable, Sendable {
    /// The app lock is on: only the app's name.
    var locked = false
    /// Notification privacy for calls: 0 nothing, 1 the person, 2 the room too.
    var level = 2
    /// The "Calls" notification switch and quiet hours allow a ring now.
    var allowsRing = true
    /// The app's name from the design (CallKit's provider name and the neutral caller).
    var appName = "M5cet"
}

/// Where the call code reads settings, privacy and texts (the settings store and the design implement it).
@MainActor
protocol CallEnvironment: AnyObject {
    var callSettings: CallSettings { get }
    var callPrivacy: CallPrivacy { get }
    /// A design string ("ring.call", "log.today"…), nil when the design has none.
    func text(_ key: String) -> String?
}

/// The defaults until the settings and the design are wired (and in tests).
@MainActor
final class DefaultCallEnvironment: CallEnvironment {
    var callSettings = CallSettings()
    var callPrivacy = CallPrivacy()
    func text(_ key: String) -> String? { nil }
}

// MARK: - VoIP pushes

/// A call a VoIP push announces, opened (the server's signature checked, ECIES-opened with this
/// device's key, deduplicated, not expired) — the same checks as Android's push/Control.
struct VoIPCallInvite: Equatable, Sendable {
    enum Kind: String, Sendable {
        /// Someone's audio went live in a room I am away from: ring.
        case ring = "call"
        /// That call ended before I answered: stop ringing.
        case end = "call-end"
    }

    var kind: Kind
    /// The control message id (deduplication).
    var id: String
    /// The room (its hub key as the device saved it).
    var roomKey: String
    /// Who started the call ("" when the server does not say).
    var who = ""
    var video = false
    /// When the call started, ms since 1970 (0 = unknown).
    var at: Int64 = 0
}

/// Opens a VoIP push payload — Platform/Push implements it with the same wire form as the
/// FCM control messages ({"m5":{i,e,iv,ct,s}}, kind "call" / "call-end"). Must be synchronous
/// and fast: every VoIP push is reported to CallKit before PushKit's handler returns.
@MainActor
protocol VoIPPayloadOpening: AnyObject {
    /// The invite, or nil when the payload cannot be opened (forged, another device's, expired, seen).
    func openCallInvite(_ payload: [AnyHashable: Any]) -> VoIPCallInvite?
}

// MARK: - media frame encryption (a hook, off)

/// Frame encryption of the call's media on top of DTLS-SRTP (the browsers' "media" cap with
/// protocol-4 media keys). Android has none and neither does this app (the WebRTC build in use,
/// stasel/WebRTC 150.0.0 = Google M150, ships no RTCFrameCryptor). A build with a frame cryptor
/// (e.g. the webrtc-sdk fork's RTCFrameCryptor + RTCFrameCryptorKeyProvider) implements this
/// protocol and is set on RtcEngine.frameProtection; only then may the room session announce
/// "media" in its hello caps. Until then the app never announces it, so browsers talk to it
/// without frame encryption — exactly as with Android.
@MainActor
protocol MediaFrameProtection: AnyObject {
    /// A sender to `peerId` was added (protect what it sends with our media key for that peer).
    func protect(sender: AnyObject, peerId: String)
    /// A receiver from `peerId` started (open what it receives with that peer's media key).
    func protect(receiver: AnyObject, peerId: String)
    /// The peer is gone (drop its keys and cryptors).
    func forget(peerId: String)
}
