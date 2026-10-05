// The core as the other Platform areas need it — the seams each area left for
// "the room session / the integration" (their READMEs): Calls (rooms for
// CallKit, settings and privacy, the history's vault, /api/turn, the History's
// messages), Notifications (rooms for replies and taps, the account), Location
// (settings, the device's reporter), Contacts (the reach host), Voice
// (settings, environment, the server's speech module, client config).

import Foundation
import M5Core
import M5Design
import M5Net
import M5Proto
import UIKit

// MARK: - Calls

/// The rooms for CallKit (connect on a VoIP push, on screen, open, labels, saved keys).
@MainActor
final class CoreCallRooms: CallRoomDirectory, CallLogMessageSource {
    unowned let core: AppCore
    init(core: AppCore) { self.core = core }

    func connect(roomKey: String) { core.rooms.connect(roomKey) }
    func isOnScreen(roomKey: String) -> Bool { core.rooms.onScreen(roomKey) }

    func open(roomKey: String) {
        guard let host = core.hosts.first else { core.pendingRoom = roomKey; return }
        if core.security.isLocked { core.pendingRoom = roomKey; return }
        core.rooms.switchTo(roomKey)
        if host.screen != "room" { host.showScreen("room") } else { host.reshow() }
    }

    func label(ofRoom roomKey: String) -> String { core.rooms.saved(roomKey)?.label ?? core.rooms.controller(roomKey)?.label ?? "" }
    func savedRoomKeys() -> [String] { core.rooms.savedRooms.map(\.key) }

    // CallLogMessageSource: a connected room's messages in memory, the others' from the vault.
    func savedRooms() -> [CallLogRoom] { core.rooms.savedRooms.map { CallLogRoom(key: $0.key, label: $0.label.isEmpty ? $0.room : $0.label) } }

    func messages(ofRoom roomKey: String) -> [CallLogRoomMessage] {
        let list = core.rooms.controller(roomKey)?.messages ?? (core.security.unlocked ? History.load(core.security.userRecords, roomKey) : [])
        let now = EpochMs.now
        return list.map { m in
            var x = CallLogItems.Message(id: m.id, createdAt: m.createdAt, mine: m.mine, senderName: m.senderName, text: m.visibleText)
            x.to = m.to
            x.kind = m.kind == "note" ? "text" : m.kind
            x.deleted = m.deleted
            x.expired = m.vanished || m.expired(now)
            x.sealed = m.sealed != nil
            x.tap = m.tap
            x.vanishing = m.vanishSeconds > 0
            x.fileName = m.fileName
            x.fnKeyword = m.fn?.string("keyword")
            let hidden = m.hiddenUntil == ChatMessage.untilSignIn || (m.hiddenUntil > 0 && m.hiddenUntil > now)
            return CallLogRoomMessage(message: x, hidden: hidden)
        }
    }
}

/// Settings › Calls, the notification privacy of calls, the lock, the design's texts.
@MainActor
final class CoreCallEnvironment: CallEnvironment {
    unowned let core: AppCore
    init(core: AppCore) { self.core = core }

    var callSettings: CallSettings {
        let s = core.settings
        var c = CallSettings()
        c.speaker = s.get("calls.speaker") != .bool(false)
        c.recents = s.bool("callLog")
        let name = s.str("calls.logName")
        if !name.isEmpty { c.logName = name }
        c.history = s.get("calls.history") != .bool(false)
        c.hideIp = s.bool("hideIp")
        return c
    }

    var callPrivacy: CallPrivacy {
        var p = CallPrivacy()
        p.locked = core.security.isLocked
        let level = core.settings.get("notify.privacy.call").numberValue ?? core.settings.get("notify.privacy").numberValue
        if let level { p.level = Int(level) }
        p.allowsRing = core.settings.get("notify.calls") != .bool(false)
        p.appName = core.services.design.appName
        return p
    }

    func text(_ key: String) -> String? {
        let s = core.t(key)
        return s == key ? nil : s
    }
}

/// The call history's vault record ("calls", the user tier).
@MainActor
final class CoreCallVault: CallHistoryVault {
    let security: any CoreSecurity
    init(security: any CoreSecurity) { self.security = security }
    var isUnlocked: Bool { security.unlocked }
    func readCalls() -> Data? { security.userRecords.record(CallHistory.record).flatMap { $0.isEmpty ? nil : Data($0.stringify().utf8) } }
    func writeCalls(_ data: Data) throws {
        guard let o = JSON.parseObject(String(decoding: data, as: UTF8.self)), security.userRecords.put(CallHistory.record, o) else {
            throw CocoaError(.fileWriteNoPermission)
        }
    }
    func deleteCalls() { security.userRecords.delete(CallHistory.record) }
}

/// GET /api/turn (the server's ICE servers; "pending" until the hub sees the room joined).
final class CoreTurn: TurnFetching {
    let server: @Sendable () async -> String
    init(server: @escaping @Sendable () async -> String) { self.server = server }

    func fetchTurn() async throws -> Data {
        let base = await server()
        guard !base.isEmpty, let url = URL(string: base + "/api/turn") else { throw URLError(.badURL) }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        r.httpShouldHandleCookies = false
        let (data, response) = try await URLSession.shared.data(for: r)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return data
    }
}

// MARK: - Notifications

/// The rooms for the notifier (a reply or a tap only ever goes into a room the app is in) and the account.
@MainActor
final class CoreNotificationRooms: NotificationRooms, NotifyAccount {
    unowned let core: AppCore
    init(core: AppCore) { self.core = core }

    var joinedRoomKeys: [String] { core.rooms.connectedSessions.map(\.key) }
    func roomKey(forServerId id: String) -> String? { (core.rooms.byServerId(id) as? RoomController)?.key }
    func label(ofRoom roomKey: String) -> String? { core.rooms.controller(roomKey)?.label ?? core.rooms.saved(roomKey)?.label }

    func reply(roomKey: String, text: String) async -> Bool {
        guard !core.security.isLocked, let r = core.rooms.controller(roomKey), r.connected || r.session != nil else { return false }
        r.sendText(text)
        return true
    }

    func markRead(roomKey: String) {
        guard let r = core.rooms.controller(roomKey) else { return }
        r.markRead(r.messages.filter { !$0.mine }.map(\.id))
        r.unread = 0
        core.rooms.changed()
    }

    func open(roomKey: String) { CoreCallRooms(core: core).open(roomKey: roomKey) }

    var signedIn: Bool { core.account.signedIn }
    var sessionToken: String? { core.account.signedIn ? core.account.token : nil }
}

/// The core's notification calls onto Platform/Notifications' Notifier.
@MainActor
final class NotifierBridge: CoreNotifying {
    let notifier: Notifier
    init(notifier: Notifier) { self.notifier = notifier }

    func message(room: RoomController, _ m: ChatMessage, locked: Bool) {
        if let id = room.keys?.roomId { notifier.conversations.noteServerRoom(roomKey: room.key, serverId: id) }
        notifier.message(roomKey: room.key, roomName: room.label, sender: m.senderName, text: m.notifyText, hideContent: locked)
    }

    func clearRoom(_ key: String) { notifier.clearRoom(key) }
    func neutralizeAll() { Task { await notifier.neutralizeAll() } }
}

// MARK: - Location

@MainActor
final class CoreLocationSettings: LocationSettings {
    unowned let core: AppCore
    init(core: AppCore) { self.core = core }
    func bool(_ key: String) -> Bool { core.settings.bool(key) }
    func number(_ key: String) -> Double { core.settings.num(key) }
    var policy: JSONObject? { core.device.state.flatMap { JSON.parseObject($0.policy.text) } }
}

/// The device service's location side: the policy's location part after a check-in, the server's "locate now".
@MainActor
final class CoreLocationControl: DeviceLocationControl {
    let service: LocationService
    init(service: LocationService) { self.service = service }
    /// The policy is read through CoreLocationSettings.policy; tracking follows it (on, off, its interval).
    func locationPolicyChanged(_ location: [String: Any]?) { service.syncTracking() }
    func locateNow(reason: String) async -> Bool { await service.current() != nil }
}

// MARK: - Contacts

@MainActor
final class CoreReachHost: ContactReachHost {
    unowned let core: AppCore
    init(core: AppCore) { self.core = core }

    var ready: Bool {
        guard let h = core.hosts.first else { return false }
        return !core.security.isLocked && !["splash", "lock", "enroll"].contains(h.screen)
    }
    var contactsEnabled: Bool { core.settings.bool("people.contacts") }
    var activeRoom: String? { core.rooms.activeKey.isEmpty ? nil : core.rooms.activeKey }

    func connectedRooms() -> [ContactReachRoom] {
        core.rooms.connectedSessions.map { r in
            ContactReachRoom(key: r.key, label: r.label, settling: !r.connected || r.people.contains { $0.channel == "connecting" },
                             lastActivity: r.lastActivity, people: r.people.compactMap { p in p.scope.objectValue.map { DesignValue.object($0).json.objectValue ?? JSONObject() } })
        }
    }

    func text(_ key: String) -> String { core.t(key) }
    func notice(_ text: String, level: String) { core.flash(text, level: FlashLevel(rawValue: level) ?? .info) }

    func reach(_ kind: ContactReachKind, roomKey: String, peerId: String, username: String) {
        guard let host = core.hosts.first else { return }
        core.rooms.switchTo(roomKey)
        if host.screen != "room" { host.showScreen("room") } else { host.reshow() }
        switch kind {
        case .message:
            let c = core.models.composer(for: host)
            c.setRecipients([peerId])
            c.focus()
        case .call:
            Task {
                guard await CoreDialogs.confirm(title: "", message: core.t("people.callAsk").replacingOccurrences(of: "{name}", with: username),
                                                yes: core.t("people.call"), no: core.t("nav.close")) else { return }
                if await CallSystem.shared.startCall(roomKey: roomKey, video: false) { host.showScreen("call") }
            }
        }
    }
}

// MARK: - Voice

@MainActor
final class CoreVoiceSettings: VoiceSettings {
    unowned let core: AppCore
    init(core: AppCore) { self.core = core }
    func string(_ key: String) -> String { core.settings.str(key) }
    func number(_ key: String) -> Double { core.settings.num(key) }
    func bool(_ key: String) -> Bool { core.settings.bool(key) }
    func value(_ key: String) -> JSON? { let v = core.settings.get(key); return v.isNull ? nil : v.json }
    var appLanguage: String { core.services.lang }
}

@MainActor
final class CoreVoiceEnvironment: VoiceEnvironment, CoreVoice {
    unowned let core: AppCore
    init(core: AppCore) { self.core = core }
    var server: String { core.device.server }
    var signedIn: Bool { core.account.signedIn }
    var accountGroups: [String] { (core.account.summary.array("groups") ?? []).compactMap(\.stringValue) }
    func text(_ key: String) -> String? { let s = core.t(key); return s == key ? nil : s }

    func speak(_ text: String) { VoiceService.shared.say(text) }
    func stopSpeaking() { VoiceService.shared.stopSpeaking() }
}

/// The server's speech module (/api/speech/*, Android fn/SpeechApi) with the account's bearer.
final class CoreSpeechServer: VoiceSpeechServer, ClientConfigFetching {
    let base: @Sendable () async -> (server: String, token: String)
    init(base: @escaping @Sendable () async -> (server: String, token: String)) { self.base = base }

    private func request(_ method: String, _ path: String, body: Data?, contentType: String?, timeout: TimeInterval = 30) async throws -> Data {
        let b = await base()
        guard !b.server.isEmpty, let url = URL(string: b.server + path) else { throw URLError(.badURL) }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpMethod = method
        r.httpShouldHandleCookies = false
        if !b.token.isEmpty { r.setValue("Bearer " + b.token, forHTTPHeaderField: "Authorization") }
        if let contentType { r.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        r.httpBody = body
        let (data, response) = try await URLSession.shared.data(for: r)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        return data
    }

    func status() async -> SpeechServerStatus {
        guard let d = try? await request("GET", "/api/speech/status", body: nil, contentType: nil),
              let o = JSON.parseObject(String(decoding: d, as: UTF8.self)) else { return .none }
        return SpeechServerStatus.parse(o)
    }

    func tts(text: String, connector: String?, voice: String?) async throws -> (bytes: Data, mime: String) {
        var body = JSONObject([("text", .string(text))])
        if let connector { body["connector"] = .string(connector) }
        if let voice { body["voice"] = .string(voice) }
        let d = try await request("POST", "/api/speech/tts", body: Data(body.stringify().utf8), contentType: "application/json")
        guard let o = JSON.parseObject(String(decoding: d, as: UTF8.self)), let audio = Data(base64Encoded: o.optString("audioBase64")) else { throw URLError(.cannotDecodeContentData) }
        return (audio, o.optString("mime", "audio/mpeg"))
    }

    func stt(wav: Data, connector: String?) async throws -> String {
        let q = connector.map { "?connector=" + ($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "") } ?? ""
        let d = try await request("POST", "/api/speech/stt" + q, body: wav, contentType: "audio/wav", timeout: 120)
        guard let o = JSON.parseObject(String(decoding: d, as: UTF8.self)) else { throw URLError(.cannotDecodeContentData) }
        return o.optString("text")
    }

    func clientConfig(server: String) async throws -> JSONObject {
        guard let url = URL(string: server + "/api/client-config") else { throw URLError(.badURL) }
        let (data, _) = try await URLSession.shared.data(from: url)
        guard let o = JSON.parseObject(String(decoding: data, as: UTF8.self)) else { throw URLError(.cannotDecodeContentData) }
        return o
    }
}
